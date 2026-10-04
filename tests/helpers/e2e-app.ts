/**
 * 真窗口 E2E 的公共驱动层（B08 建立，B11 复用）。
 *
 * ## 为什么抽出来
 *
 * B08 的 DoD 与 B11 的 DoD 都需要"真的起一个 Electron 窗口、用 CDP 从外部点按钮"。
 * 这套东西有 200 多行（起进程 / 连 CDP / 等条件 / 杀进程树 / 清临时目录），
 * 每批次抄一份的代价是：**踩过的坑要重新踩一遍**（`ELECTRON_RUN_AS_NODE`、
 * 调试开关的位置、WM_CLOSE 与 `window.close()` 的区别…）。
 *
 * ## 驱动方式（不变的约定）
 *
 * 1. 启动**构建产物**（`out/`，即 `electron .`），带 `--remote-debugging-port`；
 * 2. 从 `/json/list` 拿渲染进程的 WebSocket 调试地址；
 * 3. 用 `Runtime.evaluate` 在页面里点按钮、采样 DOM —— **不做任何测试专用后门**。
 *    `contextIsolation` 下 `window.sfvm` 在隔离世界，主世界的 `evaluate` 也拿不到它，
 *    这本身就保证了下不了后门。
 *
 * 用独立 `--user-data-dir`（临时目录）启动：绝不碰用户真实的 `sfvm.db` 台账。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* --------------------------------------------------------------- CDP 客户端 */

interface CdpReply {
  id?: number
  result?: { result?: { value?: unknown }; exceptionDetails?: unknown }
  error?: { message?: string }
}

/** 极简 CDP 客户端：只需要 `Runtime.evaluate`，不值得为此引依赖。 */
export class Cdp {
  private nextId = 1
  private readonly pending = new Map<number, (m: CdpReply) => void>()

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => {
      const text = typeof ev.data === 'string' ? ev.data : ''
      if (!text) return
      const msg = JSON.parse(text) as CdpReply
      if (msg.id !== undefined) {
        this.pending.get(msg.id)?.(msg)
        this.pending.delete(msg.id)
      }
    })
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15000)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(t)
          resolve()
        },
        { once: true }
      )
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(t)
          reject(new Error(`CDP WebSocket 出错：${url}`))
        },
        { once: true }
      )
    })
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    return cdp
  }

  send(method: string, params?: Record<string, unknown>): Promise<CdpReply> {
    const id = this.nextId++
    return new Promise<CdpReply>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 30000)
      this.pending.set(id, (m) => {
        clearTimeout(t)
        resolve(m)
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面主世界求值；表达式里可以用 `await`（只在 async IIFE 内）。 */
  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (reply.error) throw new Error(`CDP 错误：${reply.error.message}`)
    const res = reply.result as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (res.exceptionDetails) {
      throw new Error(`页面内求值抛错：${JSON.stringify(res.exceptionDetails)}`)
    }
    return res.result?.value as T
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* 已关闭 */
    }
  }

  /**
   * 只发不等回包。
   *
   * 用于 `window.close()`：原生模态确认框弹出时渲染进程可能整段时间不回 CDP，
   * 等回包会把 30s 超时白等掉。这里只负责"把动作发出去"，
   * 之后用 `/json/list`（由浏览器进程提供，不依赖渲染进程）判断窗口是否还活着。
   */
  evaluateNoWait(expression: string): void {
    const id = this.nextId++
    this.ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      })
    )
  }
}

/* -------------------------------------------------------------- 启动 / 等待 */

/** 从 `node_modules/electron/path.txt` 取真实可执行文件（node 侧 require('electron') 只会拿到路径字符串）。 */
export function electronBinary(projectRoot: string): string {
  const dir = join(projectRoot, 'node_modules', 'electron')
  const rel = readFileSync(join(dir, 'path.txt'), 'utf8').trim()
  // path.txt 在不同安装方式下可能是 `dist/electron.exe` 也可能只是 `electron.exe`
  const candidates = [
    join(dir, rel),
    join(dir, 'dist', rel),
    join(dir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  ]
  const bin = candidates.find((p) => existsSync(p))
  if (!bin) throw new Error(`找不到 Electron 可执行文件，试过：${candidates.join(' | ')}`)
  return bin
}

/** 轮询 `/json/list` 直到渲染进程页面出现。 */
export async function waitForPage(debugPort: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const list = (await res.json()) as Array<{
        type: string
        url: string
        webSocketDebuggerUrl?: string
      }>
      const page = list.find(
        (t) => t.type === 'page' && t.url.includes('index.html') && t.webSocketDebuggerUrl
      )
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch (e) {
      lastErr = (e as Error).message
    }
    await sleep(200)
  }
  throw new Error(`等待渲染进程页面超时（${lastErr}）`)
}

export interface LaunchedProcess {
  child: ChildProcess
  userDataDir: string
  logs: string[]
  /** 渲染进程的 WebSocket 调试地址；`spawnOnly` 启动时为**空串**。 */
  wsUrl: string
}

export interface LaunchedApp extends LaunchedProcess {
  cdp: Cdp
}

export interface LaunchOptions {
  projectRoot: string
  debugPort: number
  /**
   * 额外的环境变量。常用于：
   * - `SFVM_NO_SANDBOX` / `SFVM_DISABLE_GPU`（本机起窗口必须）
   * - `SFVM_E2E_SEED`（把测试用的 userData 路径传进去，供主进程判断模式）
   */
  env?: Record<string, string>
  /** 等页面出现后还要等的条件（默认等 Vue 挂载） */
  readyExpr?: string
  /**
   * 指定 userData 目录（默认新建一个临时目录）。
   *
   * B11 的 E2E 需要在启动**之前**把测试数据写进 `sfvm.db`（连接 / 环境 / 目标），
   * 否则就得先驱动界面建一遍连接 —— 那会把"发布"这条被测链路淹在一堆
   * 与它无关的操作里。由调用方给目录，才能"先造数据、再起窗口"。
   */
  userDataDir?: string
  /**
   * 启动**打包后的可执行文件**（如 `dist/win-unpacked/SFVM.exe`）而不是
   * `node_modules/electron` 里的 dev 运行时。
   *
   * 给了它就**不能再传应用路径 `.`** —— 打包产物自己就是入口；
   * 传 `.` 会被当成"要打开的路径参数"。T16.10 的冒烟要验的正是
   * "asar 里的原生模块能不能加载、产物里有没有混进 `--no-sandbox`"，
   * 那些只有跑打包产物才看得见。
   */
  binPath?: string
  /**
   * 子进程的工作目录（默认 `projectRoot`）。
   *
   * 跑打包产物时**必须**显式给产物所在目录。否则 `process.cwd()` 是项目根，
   * 而主进程解析迁移目录的第三个候选恰好是 `process.cwd()/src/main/db/migrations`
   * —— 产物于是"看起来"能找到迁移脚本，其实用的是**源码**里那份，
   * "打包漏拷 migrations"这种致命问题会被完全掩盖（真实事故，见 HANDOFF §1.13）。
   */
  cwd?: string
  /**
   * 追加到启动命令最后的 **Chromium 开关**（排在调试开关之后）。
   *
   * 为什么需要它：本机（B16 受控实测）**GPU 进程的沙箱**会被拦住，
   * 表现为 `GPU process exited unexpectedly: exit_code=-1073741819` 反复出现，
   * 最后 `gpu_data_manager_impl_private.cc` 判定 GPU 不可用并 FATAL 退出
   * （`GPU process isn't usable. Goodbye.`），窗口永远出不来。
   *
   * 开发期有 `SFVM_DISABLE_GPU=1` 兜底 —— 但那个开关在 B16 之后带 `is.dev` 门控，
   * **打包产物里彻底失效**（这正是 T16.10 要验的事），所以跑产物的冒烟必须由
   * **测试壳自己**把这几个开关递进去。实测结论（`--disable-gpu` 远远不够）：
   *
   * - `--disable-gpu --disable-gpu-compositing` → 仍崩；
   * - 再加 **`--disable-gpu-sandbox`** → 正常起窗口（渲染进程沙箱**不受影响**，
   *   产物进程里依然看得到 `--enable-sandbox`）；
   * - `--no-sandbox`（整条链路关沙箱）与 `--in-process-gpu` 也能起，但都比上一条
   *   削弱得更多 —— 冒烟要证明的正是"没有 `--no-sandbox`"，故不采用。
   */
  extraArgs?: string[]
  /**
   * **只把进程起起来**，不等渲染进程的调试目标出现、也不连 CDP。
   *
   * 用途（T16.10）：有些断言根本不需要一个活着的界面 —— 比如"产物的命令行里
   * 有没有 `--no-sandbox`""启动日志里有没有 dev 开关记录"。这类断言**必须**在
   * 一个"没有被动过手脚"的产物实例上做，而本机恰恰又拦渲染进程沙箱
   * （见 `extraArgs` 的注释），一个不含 `--no-sandbox` 的实例渲染进程必然崩 ——
   * 于是"能不能取到界面"和"命令行干不干净"这两件事必须拆到两次启动里做。
   *
   * 开了它就只能等到 `child`（外加 `userDataDir` / `logs`），`wsUrl` 是空串。
   */
  spawnOnly?: boolean
}

/**
 * 启动一个真实的应用进程（跑 dev 运行时或打包产物都行）。
 *
 * 失败的路径上**一定要**把进程与临时目录清掉：否则一次失败会在
 * `%TEMP%` 里攒下一堆 `sfvm-e2e-*` 与孤儿 electron 进程。
 *
 * `spawnOnly: true` 时**只**保证"进程起来了"（不碰调试协议）——
 * 见 `LaunchOptions.spawnOnly`。
 */
export async function launchProcess(opts: LaunchOptions): Promise<LaunchedProcess> {
  const { projectRoot, debugPort } = opts
  // 跑 dev 运行时（`electron .`）时才需要 `out/`；跑打包产物不需要
  if (!opts.binPath && !existsSync(join(projectRoot, 'out', 'main', 'index.js'))) {
    throw new Error('未找到 out/main/index.js —— 请先执行 `npm run build`')
  }
  if (opts.binPath && !existsSync(opts.binPath)) {
    throw new Error(`找不到要启动的可执行文件：${opts.binPath}`)
  }
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'sfvm-e2e-'))
  const logs: string[] = []
  const env = {
    ...process.env,
    // 本机必须带这两个开关才能起窗口（见 .tools/HANDOFF.md §2）。
    // 注意：B16 之后它们带 `is.dev` 门控，**跑打包产物时是空操作** ——
    // 这正是 T16.10 要验的事实之一，别以为这里设了就等于产物里生效了。
    SFVM_NO_SANDBOX: '1',
    SFVM_DISABLE_GPU: '1',
    ...(opts.env ?? {})
  } as Record<string, string | undefined>
  // **必须清掉**：本机执行环境预置了 ELECTRON_RUN_AS_NODE=1，
  // 它会让 electron.exe 退化成"纯 Node"启动 —— 表现为
  //   SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'
  // （因为此时 'electron' 解析到了 npm 包，那个包只导出一个路径字符串）。
  // 这个报错极具误导性，看起来像"ESM/CJS 互操作问题"，
  // 所以这里显式删除，而不是依赖调用方环境干净。
  delete env['ELECTRON_RUN_AS_NODE']

  const baseArgs = opts.binPath
    ? [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`]
    : ['.', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`]

  const child = spawn(
    opts.binPath ?? electronBinary(projectRoot),
    // 顺序有讲究：Electron 只把**应用路径之后**的未知开关透给 Chromium。
    // 写成 `.` 在前、调试开关在后，否则会报 `bad option: --remote-debugging-port`。
    // 打包产物**没有那个 `.`**：它自己就是入口，多一个参数会被当成"要打开的路径"。
    [...baseArgs, ...(opts.extraArgs ?? [])],
    { cwd: opts.cwd ?? projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout?.on('data', (d: Buffer) => logs.push(`[out] ${d.toString().trim()}`))
  child.stderr?.on('data', (d: Buffer) => logs.push(`[err] ${d.toString().trim()}`))

  // **只起进程**：不碰调试协议（见 `LaunchOptions.spawnOnly`）。
  // 调用方自己等它写出日志/文件，判据不要依赖界面。
  if (opts.spawnOnly) return { child, userDataDir, logs, wsUrl: '' }

  let wsUrl: string
  try {
    wsUrl = await waitForPage(debugPort, 90000)
  } catch (e) {
    await killTree(child)
    await rmTempDir(userDataDir)
    throw new Error(`${(e as Error).message}\n--- 应用输出 ---\n${logs.join('\n')}`, { cause: e })
  }
  return { child, userDataDir, logs, wsUrl }
}

/**
 * 启动一个真实的应用窗口并连上 CDP（`launchProcess` + 连接 + 等界面就绪）。
 *
 * "CDP 连上了但页面是空的"是个非常有误导性的现象（目标还挂在 `/json/list` 上，
 * 可渲染进程早就崩了），所以两条失败路径都必须把**应用输出**带出来，
 * 否则只能看到一个"CDP 超时"，白猜一轮（T16.10 先踩过一次）。
 */
export async function launchApp(opts: LaunchOptions): Promise<LaunchedApp> {
  const proc = await launchProcess(opts)
  const { logs } = proc
  let cdp: Cdp
  try {
    cdp = await Cdp.connect(proc.wsUrl)
  } catch (e) {
    await closeProcess(proc)
    throw new Error(`${(e as Error).message}\n--- 应用输出 ---\n${logs.join('\n')}`, { cause: e })
  }
  const launched: LaunchedApp = { ...proc, cdp }

  // 等 Vue 挂载（页面根节点出现即可，具体内容由各用例自己等）。
  // 这里失败也要带上应用输出 + 页面自述的状态（`readyState` / `location`）。
  try {
    await waitFor(cdp, opts.readyExpr ?? '!!document.querySelector("#app > *")', 30000)
  } catch (e) {
    const state = await cdp
      .evaluate<string>(
        "JSON.stringify({ readyState: document.readyState, href: location.href, " +
          "title: document.title, appHtml: (document.querySelector('#app')||{}).innerHTML?.slice(0,200) })"
      )
      .catch((err: Error) => `<页面状态也取不到：${err.message}>`)
    await closeProcess(proc)
    throw new Error(
      `${(e as Error).message}\n--- 页面状态 ---\n${state}\n--- 应用输出 ---\n${logs.join('\n')}`,
      { cause: e }
    )
  }
  return launched
}

/** 轮询页面内的布尔表达式，直到为真。 */
export async function waitFor(
  cdp: Cdp,
  expr: string,
  timeoutMs: number,
  label = expr
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expr)
      if (last) return
    } catch {
      /* 页面还在切换，继续等 */
    }
    await sleep(50)
  }
  throw new Error(`等待条件超时：${label}（最后一次结果 ${JSON.stringify(last)}）`)
}

/** 渲染进程的页面目标是否仍在（`/json/list` 由浏览器进程提供，不受渲染进程卡顿影响）。 */
export async function pageTargetAlive(debugPort: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    const list = (await res.json()) as Array<{ type: string; url: string }>
    return list.some((t) => t.type === 'page' && t.url.includes('index.html'))
  } catch {
    return false
  }
}

/* ---------------------------------------------------------- PowerShell 辅助 */

/** 跑一段 PowerShell，返回 stdout（失败返回空串）。 */
export async function ps(script: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.stderr.on('data', (d: Buffer) => (out += d.toString()))
    p.on('close', () => resolve(out.trim()))
    p.on('error', () => resolve(''))
  })
}

/**
 * 模拟用户**点窗口右上角的关闭按钮**（Windows 上就是给主窗口发 WM_CLOSE）。
 *
 * 为什么必须用它而不是 `window.close()`：后者是**渲染进程自发**的关闭请求，
 * 走的是另一条代码路径（实测会把渲染进程拆掉），并不能代表用户的真实操作。
 * 退出保护要挡的正是"用户点 X / Alt+F4 / 菜单退出"这条路径。
 * `.NET` 的 `CloseMainWindow()` 发的就是标准的 WM_CLOSE。
 */
export const PS_CLOSE_MAIN_WINDOW =
  "$p = Get-Process -Name electron -ErrorAction SilentlyContinue | " +
  "Where-Object { $_.MainWindowTitle -eq 'SFVM' } | Select-Object -First 1; " +
  "if ($p) { [void]$p.CloseMainWindow(); 'SENT' } else { 'NOTFOUND' }"

/** 是否还存在标题为 SFVM 的主窗口。 */
export const PS_WINDOW_ALIVE =
  '$p = Get-Process -Name electron -ErrorAction SilentlyContinue | ' +
  "Where-Object { $_.MainWindowTitle -eq 'SFVM' }; if ($p) { 'YES' } else { 'NO' }"

/* --------------------------------------------------------------- 收尾 */

export function killTree(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return Promise.resolve()
  return new Promise<void>((resolve) => {
    if (process.platform === 'win32') {
      // Windows 上必须连子进程一起杀（GPU / 渲染进程会各自占着 userData 里的文件句柄），
      // 而且**要等 taskkill 返回**再删目录，否则删除会因为句柄未释放而失败。
      const k = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
      k.on('close', () => resolve())
      k.on('error', () => resolve())
      return
    }
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
    resolve()
  })
}

/** 删临时目录，带重试（进程刚退出时文件句柄可能还没释放）。 */
export async function rmTempDir(dir: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await sleep(250)
    }
  }
  console.warn(`[e2e] 临时目录未能删除（可手工清理）：${dir}`)
}

/** 关掉一个进程级启动（`spawnOnly` 用的就是它）并清理临时目录。 */
export async function closeProcess(proc: LaunchedProcess | undefined): Promise<void> {
  if (!proc) return
  await killTree(proc.child)
  await rmTempDir(proc.userDataDir)
}

/** 关闭应用并清理（供 afterAll 调用）。 */
export async function closeApp(app: LaunchedApp | undefined): Promise<void> {
  if (!app) return
  app.cdp.close()
  await closeProcess(app)
}
