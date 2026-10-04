/**
 * B16 / T16.10 的**打包产物冒烟**：拿 `dist/win-unpacked/SFVM.exe`（真产物、
 * 真 asar）走一遍"起窗口 → 发布一次 → 服务器上的内容换了"。
 *
 * ## 为什么不能拿 `electron .` 代替
 *
 * 前面所有 E2E 跑的都是 `out/` 目录里的**松散文件**。打包把它们塞进 `app.asar`
 * 之后有三件事只有真产物才暴露：
 *
 * 1. **原生模块**（`better-sqlite3`）能不能从 asar 加载 —— 装不上就是"应用一起就崩"；
 * 2. **启动开关**：`SFVM_NO_SANDBOX` / `SFVM_DISABLE_GPU` 现在带 `is.dev` 门控，
 *    `app.isPackaged === true` 时应当彻底失效。HANDOFF §2.4 把"产物里不许带
 *    `--no-sandbox`"写成了硬约束，这条**只有跑打包产物才验得了**（E2E 跑 dev 运行时，
 *    `is.dev` 为真，开关照旧生效，验不出来）；
 * 3. 入口路径变了：产物不带 `.`（见 `e2e-app.ts` 的 `binPath`）。
 *
 * ## 为什么是**两次启动**
 *
 * 本机（B16 复测，见下）**拦住了渲染进程的沙箱**：只要沙箱是开的，渲染进程必然
 * `render-process-gone {"reason":"crashed","exitCode":-2147483645}`（STATUS_BREAKPOINT），
 * 窗口永远出不来；dev 运行时与打包产物**完全一样**，与调试口、工作区完整性级别无关。
 * 而产物**按设计**没有逃生开关（正是本用例要证明的那条 `is.dev` 门控！），
 * 于是"取到界面"与"命令行干不干净"这两件事在本机**不可能在同一次启动里兼得**，
 * 只能拆成两次：
 *
 * | 启动 | 参数 | 验什么 |
 * | --- | --- | --- |
 * | ① `spawnOnly` | 只有测试壳补的 GPU 开关 | 命令行里**没有** `--no-sandbox`；启动日志里**没有** dev 开关记录；asar 原生模块可用 |
 * | ② 完整启动 | 再加 `--no-sandbox`（**测试壳**为了本机环境补的） | 界面能起来、能真发一次、服务器内容真的换了 |
 *
 * ①里那个实例**没被我们关过沙箱**，所以它对"产物自身干不干净"是有效证据；
 * ②里的 `--no-sandbox` 是**启动参数**，不是产物行为 —— 别把两者混起来。
 *
 * ## 门控
 *
 * `SFVM_SMOKE=1` + 真机凭据。**不并进 `npm run test:e2e`**：
 * 它依赖 `npm run build:win` 的产物，而那个产物不是每次跑测试都存在。
 *
 * 运行：`npm run test:smoke`
 *
 * 远端只写 `/tmp/sfvm-b16-smoke/<随机>/`，`afterAll` 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'ssh2'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  closeApp,
  closeProcess,
  launchApp,
  launchProcess,
  ps,
  waitFor,
  type LaunchedApp
} from '../helpers/e2e-app'
import { confirmPublish, openPublishDialog, selectTarget, waitPublishDone } from '../helpers/e2e-ui'
import { openDatabase } from '@main/db/client'
import { createRepositories } from '@main/db/repositories'
import { fingerprintOf } from '@main/services/ssh-client'

const PROJECT_ROOT = process.cwd()
const HOST = process.env['SFVM_IT_HOST'] ?? ''
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER'] ?? ''
const KEY_PATH = process.env['SFVM_IT_KEY'] ?? ''

const ENABLED =
  process.env['SFVM_SMOKE'] === '1' && Boolean(HOST && USER && KEY_PATH) && process.platform === 'win32'
const describeIf = ENABLED ? describe : describe.skip

/** ① 只起进程（看命令行与日志） */
const DEBUG_PORT = 9342
/** ② 连 CDP 走真流程 */
const DEBUG_PORT_UI = 9343

/** 打包产物的位置（`electron-builder.yml` 里 `directories.output: dist`）。 */
const PACKAGED_EXE = join(PROJECT_ROOT, 'dist', 'win-unpacked', 'SFVM.exe')

/**
 * 产物的**工作目录**：子进程必须从这里启动，**不能**用 `PROJECT_ROOT`。
 *
 * 主进程解析迁移目录的第三个候选是 `process.cwd()/src/main/db/migrations`；
 * 从项目根启动会让它**命中源码**里的迁移脚本，于是"产物其实没带 migrations"
 * 这种致命问题被完全掩盖 —— B16 出包时就是这么漏过去的：产物双击打不开，
 * 冒烟却全绿（复盘见 .tools/HANDOFF.md §1.13）。
 */
const PACKAGED_CWD = dirname(PACKAGED_EXE)

const REMOTE_ROOT = `/tmp/sfvm-b16-smoke/${Math.random().toString(36).slice(2, 10)}`
const REMOTE_TARGET = `${REMOTE_ROOT}/web/dist`

const localDirs: string[] = []
const tempDirs: string[] = []

/**
 * 测试壳侧补的 Chromium 开关（**不是产物自带的**）。
 * 本机 GPU 进程沙箱被拦，不补这几个浏览器进程就 FATAL 退出（详见文件头）。
 */
const GPU_SANDBOX_WORKAROUND = [
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-gpu-sandbox'
]

function makeLocalArtifact(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sfvm-b16-smoke-'))
  localDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    const idx = rel.lastIndexOf('/')
    if (idx > 0) mkdirSync(join(root, rel.slice(0, idx)), { recursive: true })
    writeFileSync(p, content)
  }
  return root
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 轮询等一个文件出现且满足条件（①里只能这样等主进程干完活，界面不可用）。 */
async function waitForFile(
  path: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  label: string
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      last = readFileSync(path, 'utf8')
      if (predicate(last)) return last
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`等待文件条件超时：${label}（${path}）\n当前内容：\n${last}`)
}

interface RemoteConn {
  client: Client
  sftp: import('ssh2').SFTPWrapper
}

async function connectRemote(): Promise<RemoteConn> {
  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.on('ready', resolve).on('error', reject)
    client.connect({ host: HOST, port: PORT, username: USER, privateKey: readFileSync(KEY_PATH) })
  })
  const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) =>
    client.sftp((e, s) => (e ? reject(e) : resolve(s)))
  )
  return { client, sftp }
}

function readRemoteText(conn: RemoteConn, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.sftp.readFile(path, (e, data) => (e ? reject(e) : resolve(data.toString('utf8'))))
  })
}

function removeRemoteDir(conn: RemoteConn, dir: string): Promise<void> {
  return new Promise((resolve) => {
    conn.sftp.readdir(dir, (e, list) => {
      if (e) return resolve()
      let pending = list.length
      if (pending === 0) return conn.sftp.rmdir(dir, () => resolve())
      for (const it of list) {
        const p = `${dir}/${it.filename}`
        const done = (): void => {
          if (--pending === 0) conn.sftp.rmdir(dir, () => resolve())
        }
        if (it.attrs.isDirectory()) void removeRemoteDir(conn, p).then(done)
        else conn.sftp.unlink(p, () => done())
      }
    })
  })
}

/** 打包产物所有进程的命令行（用来证明没混进 `--no-sandbox`）。 */
function packagedCommandLines(): Promise<string> {
  return ps(
    "Get-CimInstance Win32_Process -Filter \"name='SFVM.exe'\" | " +
      'Select-Object -ExpandProperty CommandLine'
  )
}

describeIf('B16 / T16.10：打包产物冒烟（真 asar + 真发布的完整链路）', () => {
  let app: LaunchedApp | undefined
  let remote: RemoteConn
  let userDataDir = ''
  let localDir = ''

  beforeAll(async () => {
    expect(existsSync(PACKAGED_EXE), `没有打包产物：${PACKAGED_EXE}（先跑 npm run build:dir）`).toBe(
      true
    )
    // 迁移脚本必须在**包内**：这是产物能不能起来的前提（HANDOFF §1.13）。
    // 放在这里是为了"缺文件"能立刻失败，而不是等到启动后看日志才发现。
    expect(
      existsSync(join(dirname(PACKAGED_EXE), 'resources', 'migrations', 'meta', '_journal.json')),
      '产物里没有 resources/migrations —— electron-builder.yml 的 extraResources 没生效'
    ).toBe(true)
    remote = await connectRemote()

    // 先造数据（连接 / 环境 / 目标），再起窗口 —— 与 B11 起的其它 E2E 同一套做法
    userDataDir = makeTempDir('sfvm-b16-smoke-userdata-')
    const db = openDatabase({
      dataDir: userDataDir,
      migrationsFolder: join(PROJECT_ROOT, 'src', 'main', 'db', 'migrations'),
      schemaVersion: 'smoke'
    })
    const repo = createRepositories(db.db)

    const keyBlob = await new Promise<Buffer>((resolve, reject) => {
      const c = new Client()
      c.on('ready', () => c.end())
      c.on('error', reject)
      c.connect({
        host: HOST,
        port: PORT,
        username: USER,
        privateKey: readFileSync(KEY_PATH),
        hostVerifier: ((key: Buffer) => {
          resolve(key)
          return true
        }) as never
      })
    })
    const fp = fingerprintOf(keyBlob)

    const conn = repo.connections.create({
      name: 'B16 冒烟测试机',
      host: HOST,
      port: PORT,
      username: USER,
      authType: 'privateKey',
      privateKeyPath: KEY_PATH,
      autoConnect: true
    })
    repo.knownHosts.trust(HOST, PORT, fp.keyType, fp.fingerprint)
    const env = repo.environments.create({
      name: 'B16 冒烟环境',
      envType: 'test',
      connectionId: conn.id
    })
    localDir = makeLocalArtifact({ 'index.html': 'smoke-index', 'assets/app.js': 'smoke-js' })
    repo.targets.create({
      environmentId: env.id,
      name: '冒烟用前端产物',
      kind: 'dir',
      remotePath: REMOTE_TARGET,
      localPath: localDir
    })

    db.close()
  }, 120000)

  afterAll(async () => {
    await closeApp(app)
    try {
      await removeRemoteDir(remote, REMOTE_ROOT)
      await removeRemoteDir(remote, '/tmp/sfvm-b16-smoke')
      remote.client.end()
    } catch (e) {
      console.warn(`清理远端失败（需手工检查）：${(e as Error).message}`)
    }
    for (const d of [...localDirs.splice(0), ...tempDirs.splice(0)]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* 尽力而为 */
      }
    }
  }, 90000)

  it('① 产物内没有任何启动开关：命令行没有 `--no-sandbox`、日志里没有 dev 开关记录', async () => {
    // 这一次**不传 `--no-sandbox`** —— 本机渲染进程会因此崩掉（环境限制），
    // 所以走 `spawnOnly`，只等主进程把库打开，不去取界面。
    const probeDir = makeTempDir('sfvm-b16-smoke-probe-')
    const proc = await launchProcess({
      projectRoot: PROJECT_ROOT,
      debugPort: DEBUG_PORT,
      userDataDir: probeDir,
      binPath: PACKAGED_EXE,
      // **从产物目录启动**：只有这样才能证明迁移来自包内（见 `PACKAGED_CWD`）
      cwd: PACKAGED_CWD,
      extraArgs: GPU_SANDBOX_WORKAROUND,
      spawnOnly: true
    })
    try {
      // 主进程起来并把库打开 ⇒ asar 里的 better-sqlite3 加载成功（原生模块过 asar 的第一关）。
      // 这一次用的是**全新目录**，所以迁移会真跑 —— 于是顺带证明迁移脚本也在包里。
      //
      // 路径是 `log/` 不是 `logs/`：B18 起日志固定落在 `<数据目录>/log`，
      // 而本次启动没有配置自定义数据目录，数据目录就是 userData。
      const mainLog = await waitForFile(
        join(probeDir, 'log', 'main.log'),
        (t) => t.includes('db ready:'),
        30000,
        '主进程打开数据库'
      )
      expect(mainLog).toContain('db: opening')
      // **打包完整性的真守卫**：迁移必须来自产物的 resources 目录。
      // 只断言 `db: migrations applied` 是不够的 —— 从项目根启动时它会命中源码目录，
      // 于是"包里根本没有 migrations"也能绿（B16 正是这么漏的，见 HANDOFF §1.13）。
      expect(
        mainLog,
        `迁移不是从产物的 resources 目录读的 —— extraResources 没生效：\n${mainLog}`
      ).toMatch(/db: migrations from .*resources[\\/]migrations/)
      expect(mainLog, '迁移脚本没被打进产物？').toContain('db: migrations applied')
      expect(mainLog, '原生模块/数据库初始化失败').not.toContain('database init failed')

      // `is.dev` 门控：`launchApp`/`launchProcess` **默认就会设** SFVM_NO_SANDBOX / SFVM_DISABLE_GPU，
      // 产物里应当**一条开关记录都没有**（`logStartup` 把它写进 startup.log）。
      const startupLog = readFileSync(join(probeDir, 'log', 'startup.log'), 'utf8')
      expect(startupLog).toContain('app ready')
      expect(startupLog, `产物里 dev 开关居然生效了：\n${startupLog}`).not.toMatch(
        /SFVM_NO_SANDBOX|SFVM_DISABLE_GPU/
      )

      // 进程命令行：**不允许**出现 `--no-sandbox`（HANDOFF §2.4 的硬约束）
      const cmdlines = await packagedCommandLines()
      expect(cmdlines.length, '没有找到 SFVM.exe 进程').toBeGreaterThan(0)
      expect(cmdlines, `产物进程里混进了 --no-sandbox：\n${cmdlines}`).not.toContain('--no-sandbox')

      console.info('[B16/T16.10] ① 产物内无启动开关：asar 原生模块可用、命令行干净')
    } finally {
      await closeProcess(proc)
    }
  }, 120000)

  it('② 产物能干活：从界面发布一次，服务器上的内容真的换了', async () => {
    // 这一次由**测试壳**补 `--no-sandbox`：本机拦渲染进程沙箱，不补就起不来界面。
    // 它是启动参数、不是产物行为（①已经证明产物自己不带这个开关）。
    app = await launchApp({
      projectRoot: PROJECT_ROOT,
      debugPort: DEBUG_PORT_UI,
      userDataDir,
      binPath: PACKAGED_EXE,
      // 同①：必须从产物目录启动，别把源码目录暴露给 `process.cwd()`
      cwd: PACKAGED_CWD,
      extraArgs: [...GPU_SANDBOX_WORKAROUND, '--no-sandbox']
    })
    const cdp = app.cdp

    // 界面真的起来了（Vue 挂载 ⇒ 渲染进程、preload、asar 里的前端资源都正常）
    expect(await cdp.evaluate<string>('document.title')).toBe('SFVM')

    // `--user-data-dir` 真的生效了：数据库在我们给的那个目录里（不是用户的真实台账）
    expect(existsSync(join(userDataDir, 'sfvm.db'))).toBe(true)

    // 连接/环境/目标都被读了出来 —— 这三样都要过 SQLite
    await selectTarget(cdp)
    await waitFor(
      cdp,
      "[...document.querySelectorAll('.artifact')].some((e) => (e.textContent || '').includes('2 个文件'))",
      30000,
      '本地产物被探测到'
    )

    await openPublishDialog(cdp)
    await confirmPublish(cdp, 'B16 T16.10 冒烟发布')
    expect(await waitPublishDone(cdp, 240000)).toBe('success')

    // 硬证据：不看界面自述，用独立 SFTP 连接核对服务器上的内容
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/index.html`)).toBe('smoke-index')
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/assets/app.js`)).toBe('smoke-js')

    const current = await cdp.evaluate<string>(
      "(() => { const e = document.querySelector('[data-test=current-version]'); return e ? e.textContent.trim() : '' })()"
    )
    expect(current).toMatch(/^\d{8}-\d{6}_[0-9a-f]{7}(-\d+)?$/)
    console.info(`[B16/T16.10] ② 产物发布成功，当前版本 ${current}`)
  }, 300000)
})
