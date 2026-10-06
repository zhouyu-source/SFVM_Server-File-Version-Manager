/**
 * B20 DoD：脚本执行底座（**真窗口**）。
 *
 * ## 为什么这一批必须进真窗口
 *
 * | 要验的事 | 单测为什么测不到 |
 * | --- | --- |
 * | 总闸关着时面板**不给表单**，只给"怎么打开" | 纯组件行为 |
 * | 打开总闸那一下要过**危险确认的第三档**文案 | 文案由 `ElMessageBox` 渲染，还有"Markdown 星号"这种只肉眼可见的坑 |
 * | 解释器下拉里**没有 cmd** | 界面呈现；单测只能钉住候选表 |
 * | 真跑一条本机脚本，输出**实时**进任务台、中文不乱码 | 跨进程：渲染 → IPC → 任务框架 → 子进程 → 回事件 |
 * | 运行记录**重启后还在** | 单测每次都是新库 |
 *
 * ## 与单测的分工（不重复）
 *
 * `tests/unit/b20-script.test.ts` 已经把"退出码怎么记、尾部怎么截、取消写成什么状态"
 * 钉死了（用假通道，可穷举）。这里只验**接线**与**用户看得见的那一层**：
 * 所以本文件**不重跑**超时/取消这类用例（那要真等 5 分钟或真点取消，
 * 而它们的行为已经由单测覆盖）。
 *
 * ## 前置
 *
 * 1. `npm run build`（E2E 跑的是 `out/` 里的产物）；
 * 2. `npm run test:e2e -t b20-dod`（远端那条用例需要 `.env.it` 里的凭据）。
 *
 * 远端只写 `/tmp/sfvm-b20-script/`，`afterAll` 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'ssh2'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeApp,
  killTree,
  launchApp,
  sleep,
  waitFor,
  type Cdp,
  type LaunchedApp
} from '../helpers/e2e-app'
import { dumpUi, installUiProbe, readUiProbe, selectTarget } from '../helpers/e2e-ui'
import { openDatabase } from '@main/db/client'
import { createRepositories, type Repositories } from '@main/db/repositories'
import { fingerprintOf } from '@main/services/ssh-client'

const PROJECT_ROOT = process.cwd()
/** 端口按批次错开：B12=9336 / B13=9337 / B14=9338 / B15=9339 / B16=9340~9343 / **B20=9344** */
const DEBUG_PORT = 9344

const HOST = process.env['SFVM_IT_HOST'] ?? ''
const USER = process.env['SFVM_IT_USER'] ?? ''
const KEY_PATH = process.env['SFVM_IT_KEY'] ?? ''
const HAS_REMOTE = Boolean(HOST && USER && KEY_PATH)

const describeE2E = process.env['SFVM_E2E'] === '1' ? describe : describe.skip
const remoteIt = it.skipIf(!HAS_REMOTE)

/**
 * 清掉远端脚本写过的东西。
 *
 * 这里直接用 ssh2 连（与 B16 的做法一致），**不经应用**：清理失败不该让用例变红，
 * 而且此刻应用可能已经被关掉了。删的路径是测试自己写下的那一个。
 */
async function cleanupRemote(): Promise<void> {
  await new Promise<void>((resolve) => {
    const c = new Client()
    const done = (): void => {
      c.end()
      resolve()
    }
    c.on('ready', () => {
      c.exec(`rm -rf ${REMOTE_ROOT}`, () => done())
    })
    c.on('error', done)
    c.connect({
      host: HOST,
      port: Number(process.env['SFVM_IT_PORT'] ?? 22),
      username: USER,
      privateKey: readFileSync(KEY_PATH)
    })
  })
}

const CONNECTION_NAME = 'B20 脚本测试机'
const TARGET_NAME = 'B20 脚本目标'

/** 远端脚本写东西的根目录（与项目约定一致：只碰 `/tmp/sfvm-b*`，且收尾必清）。 */
const REMOTE_ROOT = '/tmp/sfvm-b20-script'

/** 本机脚本的输出标记（挑中文是为了顺带验 UTF-8 不被切坏）。 */
const LOCAL_MARKER = 'b20-本机输出-ok'
/** 远端脚本写下的文件名（跑完要独立核一遍服务器上真的有它）。 */
const REMOTE_MARKER = 'b20-remote-ok'

describeE2E('B20 DoD：脚本执行底座', () => {
  let app: LaunchedApp | null = null
  let userDataDir = ''
  let repo: Repositories
  /** 关库要留着：中途要趁应用开着读一次台账（WAL 允许多进程读） */
  let db: ReturnType<typeof openDatabase> | null = null

  beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'sfvm-e2e-b20-'))

    db = openDatabase({
      dataDir: userDataDir,
      migrationsFolder: join(PROJECT_ROOT, 'src', 'main', 'db', 'migrations'),
      schemaVersion: 'e2e'
    })
    repo = createRepositories(db.db)

    /**
     * 连接凭据这样选：
     * - 有真机凭据就用真机 —— 顺带把"远端脚本"那条路也跑通（DoD 要求）；
     * - 没有就写一个连不上的假地址。本机那几条用例**不需要**真连接，
     *   而"远端执行"用例会自己 `skipIf` 掉。
     * 这样一份文件在两种环境下都能跑，不会因为缺凭据整体变红。
     */
    const conn = repo.connections.create({
      name: CONNECTION_NAME,
      host: HAS_REMOTE ? HOST : '192.0.2.10',
      port: Number(process.env['SFVM_IT_PORT'] ?? 22),
      username: HAS_REMOTE ? USER : 'deploy',
      authType: HAS_REMOTE ? 'privateKey' : 'password',
      ...(HAS_REMOTE ? { privateKeyPath: KEY_PATH, autoConnect: true } : {}),
      remark: 'B20 脚本执行 E2E'
    })
    const env = repo.environments.create({
      name: 'B20 脚本环境',
      envType: 'test',
      connectionId: conn.id
    })
    repo.targets.create({
      environmentId: env.id,
      name: TARGET_NAME,
      kind: 'dir',
      remotePath: HAS_REMOTE ? '/tmp/sfvm-b20-script/dist' : '/opt/b20/dist'
    })

    /**
     * 有真机凭据时，顺手把主机指纹写进 TOFU 表。
     *
     * 不写的话，应用启动时那次自动连接会撞上"未知主机指纹"，
     * 弹出信任弹窗并**挂在那里等用户点**——而窗口是测试在驱动，没人会点。
     * 表现就是"远端脚本点了没反应"。信任弹窗那条路径由 T16.3 覆盖，这里不重复。
     */
    if (HAS_REMOTE) {
      const keyBlob = await new Promise<Buffer>((resolve, reject) => {
        const c = new Client()
        c.on('ready', () => c.end())
        c.on('error', reject)
        c.connect({
          host: HOST,
          port: Number(process.env['SFVM_IT_PORT'] ?? 22),
          username: USER,
          privateKey: readFileSync(KEY_PATH),
          hostVerifier: ((key: Buffer) => {
            resolve(key)
            return true
          }) as never
        })
      })
      const fp = fingerprintOf(keyBlob)
      repo.knownHosts.trust(HOST, Number(process.env['SFVM_IT_PORT'] ?? 22), fp.keyType, fp.fingerprint)
    }

    // WAL 锁不允许两个进程同时写 → 先关库再起窗口
    db.close()
    db = null

    app = await launchApp({ projectRoot: PROJECT_ROOT, debugPort: DEBUG_PORT, userDataDir })
    // 探针从一开始就装上：`ElMessage` 只活 3 秒，出问题再装就晚了
    await installUiProbe(app.cdp)
  }, 180000)

  afterAll(async () => {
    try {
      db?.close()
    } catch {
      /* 已关闭 */
    }
    if (app) await closeApp(app)
    if (existsSync(userDataDir)) rmSync(userDataDir, { recursive: true, force: true })

    // 远端只碰 /tmp/sfvm-b*，收尾必清（与其余批次同一条约定）
    if (HAS_REMOTE) await cleanupRemote()
  }, 120000)

  /* ------------------------------------------------------------ 小工具 */

  /** 切到某个 hash 路由，等一个"只有该页面才有"的标志元素。设一次不生效就再设（见 B15 的注释）。 */
  async function goto(cdp: Cdp, hash: string, marker: string, what: string): Promise<void> {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      await cdp.evaluate<boolean>(`(location.hash = ${JSON.stringify(hash)}, true)`)
      const inner = Date.now() + 1500
      while (Date.now() < inner) {
        if (await cdp.evaluate<boolean>(marker)) return
        await sleep(100)
      }
    }
    throw new Error(`导航到 ${what}（${hash}）失败：标志元素始终没出现`)
  }

  async function clickTest(cdp: Cdp, testId: string, what: string): Promise<void> {
    const ok = await cdp.evaluate<boolean>(`(() => {
      const el = document.querySelector('[data-test=${testId}]')
      if (!el) return false
      el.click()
      return true
    })()`)
    if (!ok) throw new Error(`没找到「${what}」（[data-test=${testId}]）`)
  }

  /** 开关状态：Element Plus 的 `el-switch` 根元素带 `is-checked`，同时也写 aria-checked。 */
  const switchOn = (cdp: Cdp, testId: string): Promise<boolean> =>
    cdp.evaluate<boolean>(`(() => {
      const el = document.querySelector('[data-test=${testId}]')
      if (!el) return false
      if (el.getAttribute('aria-checked') === 'true') return true
      return el.classList.contains('is-checked')
    })()`)

  /** 往 `<textarea>` 写值（原生 setter + 派发 input，才走得到 Vue 的 v-model）。 */
  async function setTextarea(cdp: Cdp, testId: string, value: string): Promise<boolean> {
    return cdp.evaluate<boolean>(`(() => {
      const el = document.querySelector('[data-test=${testId}]')
      if (!el) return false
      const ta = el.tagName === 'TEXTAREA' ? el : el.querySelector('textarea')
      if (!ta) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(value)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  }

  const isVisible = (testId: string): string =>
    `(() => { const e = document.querySelector('[data-test=${testId}]'); return !!e && e.offsetParent !== null })()`

  /** 读某元素（或其内部输入框）的显示文本。 */
  const textOf = (cdp: Cdp, testId: string): Promise<string> =>
    cdp.evaluate<string>(
      `((document.querySelector('[data-test=${testId}]') || {}).textContent || '').trim()`
    )

  async function openSettings(cdp: Cdp): Promise<void> {
    await goto(cdp, '#/settings', "!!document.querySelector('[data-test=about-data-dir]')", '设置页')
  }

  /** 点保存并等 dirty 提示消失（判据与 B15 一致：不是看按钮文案）。 */
  async function saveSettings(cdp: Cdp): Promise<void> {
    const enabled = await cdp.evaluate<boolean>(
      "!document.querySelector('[data-test=settings-save]').disabled"
    )
    expect(
      enabled,
      '保存按钮是禁用的 —— 说明刚才的改动**没有进入 Vue 的模型**（dirty 仍为 false）'
    ).toBe(true)

    await clickTest(cdp, 'settings-save', '保存设置')

    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const r = await cdp.evaluate<{ dirty: boolean; err: string }>(`(() => ({
        dirty: !!document.querySelector('[data-test=settings-dirty]'),
        err: [...document.querySelectorAll('.el-message--error')]
          .map((e) => e.textContent || '').join(' | ')
      }))()`)
      if (r.err) throw new Error(`保存设置报错：${r.err}`)
      if (!r.dirty) return
      await sleep(200)
    }
    throw new Error('保存设置超时（dirty 提示一直没消失）')
  }

  /** 运行记录表的行选择器（`el-table` 的数据行带 `el-table__row`）。 */
  const ROWS = '[data-test=script-runs-table] tbody tr.el-table__row'

  /** 读运行记录表第一行的各列文本。 */
  async function firstRunRow(cdp: Cdp): Promise<string[] | null> {
    return cdp.evaluate<string[] | null>(`(() => {
      const rows = [...document.querySelectorAll('${ROWS}')]
      if (!rows.length) return null
      return [...rows[0].querySelectorAll('td')].map((td) =>
        td.textContent.replace(/\\s+/g, ' ').trim()
      )
    })()`)
  }

  const runRowCount = (cdp: Cdp): Promise<number> =>
    cdp.evaluate<number>(`document.querySelectorAll('${ROWS}').length`)

  /**
   * 从**应用自己**的任务列表里读一眼（排查用）。
   *
   * 走桥接层而不是读库：要回答的是"任务到底有没有被建起来、卡在哪条车道"，
   * 那是主进程内存里的事实，库里看不到。包在 try 里 —— 它是诊断代码，
   * 自己出错不该把原始失败盖掉。
   */
  async function readAppJobs(cdp: Cdp): Promise<string> {
    return cdp.evaluate<string>(`(async () => {
      try {
        const r = await window.sfvm.jobs.list()
        const list = r && r.ok ? r.data : r
        return JSON.stringify((list || []).map((j) => ({
          type: j.type, status: j.status, title: j.title, target: j.targetId
        })))
      } catch (e) {
        return '读取失败：' + String(e)
      }
    })()`)
  }

  /**
   * 等**新的一条**运行记录跑完。
   *
   * ## 为什么要先记条数
   *
   * 只看"第一行不再是执行中"会**立刻返回上一条记录** —— 它本来就是终态。
   * 第一次跑 E2E 就是这么错的：远端那条用例断言的是上一轮本机跑出来的行，
   * 于是报"步骤列应标出这是服务器执行，实际是本机 · PowerShell"，
   * 而真正的问题是"新记录还没出现就断言了"。
   *
   * 顺序：条数变多 → 这一行不是"执行中" → 才返回。
   */
  async function waitNewRunRow(cdp: Cdp, before: number, timeoutMs: number): Promise<string[]> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await runRowCount(cdp)) > before) {
        const tds = await firstRunRow(cdp)
        if (tds && !/执行中/.test(tds[2] ?? '')) return tds
      }
      await sleep(400)
    }
    throw new Error(
      `没有等到新的运行记录（点击前 ${before} 条，现在 ${await runRowCount(cdp)} 条，` +
        `第一行=${JSON.stringify(await firstRunRow(cdp))}）`
    )
  }

  /** 打开第一行的「详情」，读出输出尾部，然后关掉弹窗。 */
  async function readFirstRunOutput(cdp: Cdp): Promise<string> {
    await cdp.evaluate<boolean>(
      "([...document.querySelectorAll('[data-test=script-run-detail]')][0].click(), true)"
    )
    await waitFor(
      cdp,
      "!!document.querySelector('[data-test=script-output-tail]')",
      20000,
      '执行详情里的输出'
    )
    const text = await cdp.evaluate<string>(
      "(document.querySelector('[data-test=script-output-tail]') || {}).textContent || ''"
    )
    // 按"能滚的那个 dialog"定位关闭按钮，别点到别的弹窗上
    await cdp.evaluate<boolean>(`(() => {
      const pre = document.querySelector('[data-test=script-output-tail]')
      const dlg = pre && pre.closest('.el-dialog')
      if (!dlg) return false
      const close = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '关闭')
      if (!close) return false
      close.click()
      return true
    })()`)
    return text
  }

  /* ------------------------------------------------ ① 总闸关着的样子 */

  it('总闸默认关闭：面板只给"怎么打开"，不给表单；设置页开关是关的', async () => {
    const cdp = app!.cdp

    // 设置页：开关默认必须是关的（这是本功能唯一的安全前提）
    await openSettings(cdp)
    expect(
      await switchOn(cdp, 'settings-allow-user-scripts'),
      '「开启自定义脚本」默认必须是关闭的'
    ).toBe(false)
    // Git Bash 路径默认留空（走自动探测）
    const gitPath = await cdp.evaluate<string>(`(() => {
      const host = document.querySelector('[data-test=settings-git-bash-path]')
      const input = host && (host.tagName === 'INPUT' ? host : host.querySelector('input'))
      return input ? input.value : ''
    })()`)
    expect(gitPath, 'Git Bash 路径默认应为空（自动探测）').toBe('')

    // 目标页：面板在，表单不在
    await selectTarget(cdp)
    await waitFor(cdp, isVisible('script-panel'), 30000, '脚本面板出现')
    expect(await cdp.evaluate<boolean>(isVisible('script-gate-off')), '应显示"功能未开启"').toBe(
      true
    )
    expect(
      await cdp.evaluate<boolean>("!!document.querySelector('[data-test=script-text]')"),
      '总闸关着时不该渲染脚本输入框'
    ).toBe(false)
    expect(
      await cdp.evaluate<boolean>("!!document.querySelector('[data-test=script-run]')"),
      '总闸关着时不该有执行按钮'
    ).toBe(false)

    const gate = await textOf(cdp, 'script-gate-off')
    expect(gate).toContain('开启自定义脚本')
    // 关着的时候也要说清"开启后会发生什么"，而不是一句"未开启"了事
    expect(gate).toContain('任意命令')
    console.info('[B20 DoD] 总闸默认关闭：面板只显示开启指引，未渲染表单')
  }, 120000)

  /* ------------------------------------- ② 打开总闸要走第三档危险确认 */

  it('打开总闸：弹危险确认，文案是第三档「会在服务器上执行你填写的命令」', async () => {
    const cdp = app!.cdp
    await openSettings(cdp)

    await clickTest(cdp, 'settings-allow-user-scripts', '自定义脚本开关')

    await waitFor(cdp, "!!document.querySelector('.el-message-box')", 15000, '危险确认弹窗')
    const body = await cdp.evaluate<string>(
      "(document.querySelector('.el-message-box__message') || {}).textContent || ''"
    )
    expect(body).toContain('【对服务器的影响】')
    // 第三档的关键差异：不承诺"只删文件"，而是"跑你写的命令"
    expect(body).toContain('会在服务器上执行你填写的命令')
    // MessageBox 不渲染 Markdown：出现字面量星号说明有人又用 ** 写加粗了
    expect(body).not.toContain('**')

    // 确认
    const confirmed = await cdp.evaluate<boolean>(`(() => {
      const btns = [...document.querySelectorAll('.el-message-box__btns button')]
      const ok = btns.find((b) => /我明白/.test(b.textContent || ''))
      if (!ok) return false
      ok.click()
      return true
    })()`)
    expect(confirmed, '危险确认弹窗里没找到「我明白，打开」按钮').toBe(true)

    await waitFor(
      cdp,
      switchSelectorOn('settings-allow-user-scripts'),
      15000,
      '开关已打开（危险确认通过后 el-switch 才会真的切过去）'
    )
    await saveSettings(cdp)
    expect(await switchOn(cdp, 'settings-allow-user-scripts')).toBe(true)
    console.info('[B20 DoD] 危险确认第三档文案正确，总闸已打开并落库')
  }, 120000)

  /** 开关"当前是开的"这个条件（写成页内表达式，供 waitFor 用）。 */
  function switchSelectorOn(testId: string): string {
    return `(() => {
      const el = document.querySelector('[data-test=${testId}]')
      return !!el && (el.getAttribute('aria-checked') === 'true' || el.classList.contains('is-checked'))
    })()`
  }

  /* ---------------------------------------------- ③ 表单与权限提示就绪 */

  it('总闸打开后：表单出现、常驻权限提示在、解释器只有 PowerShell / Git Bash', async () => {
    const cdp = app!.cdp
    await selectTarget(cdp)

    await waitFor(cdp, isVisible('script-text'), 30000, '脚本输入框出现')
    expect(await cdp.evaluate<boolean>(isVisible('script-run')), '执行按钮应出现').toBe(true)
    expect(await cdp.evaluate<boolean>(isVisible('script-kind')), '执行位置单选应出现').toBe(true)
    expect(await cdp.evaluate<boolean>(isVisible('script-timeout')), '超时输入应出现').toBe(true)

    // 用户明确要求的那句提醒必须**常驻**（不做成一次性气泡）
    const perm = await textOf(cdp, 'script-permission-hint')
    expect(perm, '权限提示缺失').toContain('权限')
    expect(perm, '应说明用的是登录服务器时那个账户').toContain('登录服务器时用的那个账户')

    // 打开解释器下拉，逐个读选项：只能有 PowerShell 与 Git Bash（**没有 cmd**）
    const opened = await cdp.evaluate<boolean>(`(() => {
      const host = document.querySelector('[data-test=script-shell]')
      if (!host) return false
      const trigger =
        host.querySelector('.el-select__wrapper') ||
        host.querySelector('.el-select__caret') ||
        host.querySelector('input') ||
        host
      ;(trigger).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      trigger.click()
      return true
    })()`)
    expect(opened, '没找到解释器下拉').toBe(true)

    const labels = await (async (): Promise<string[]> => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const items = await cdp.evaluate<string[]>(
          `[...document.querySelectorAll('.el-select-dropdown__item')].map((e) => e.textContent.trim())`
        )
        if (items.length) return items
        await sleep(150)
      }
      return []
    })()

    expect(
      labels.length,
      `解释器下拉里没有选项。当前界面：\n${await dumpUi(cdp)}`
    ).toBeGreaterThan(0)
    expect(labels.some((l) => l.includes('PowerShell'))).toBe(true)
    expect(labels.some((l) => l.includes('Git Bash'))).toBe(true)
    // 用户明确要求：只用 PowerShell 或 Git Bash，cmd 总出问题
    expect(
      labels.filter((l) => /cmd|命令提示符|批处理/i.test(l)),
      `解释器里出现了 cmd 系选项：${labels.join(' / ')}`
    ).toEqual([])

    // 收起下拉（点空白处），免得挡住后面的按钮
    await cdp.evaluate<boolean>('(document.body.click(), true)')
    console.info(`[B20 DoD] 解释器下拉选项：${labels.join(' / ')}`)
  }, 120000)

  /* ------------------------------------- ④ 真跑一条本机脚本（跨进程） */

  it('本机真跑一条脚本：运行记录成功、退出码 0、中文输出不乱码、完整输出已落盘', async () => {
    const cdp = app!.cdp
    await selectTarget(cdp)
    await waitFor(cdp, isVisible('script-text'), 30000, '脚本表单就绪')

    // 默认执行位置就是「本机执行」（刻意不改成服务器：本机跑坏了不牵连线上）
    const activeKind = await cdp.evaluate<string>(`(() => {
      const host = document.querySelector('[data-test=script-kind]')
      if (!host) return ''
      const on = host.querySelector('.el-radio-button.is-active')
      if (on) return on.textContent.trim()
      // 退化路径：万一 element-plus 改了激活态的类名，用原生 checked 判
      const checked = host.querySelector('input[type=radio]:checked')
      const wrap = checked && checked.closest('.el-radio-button')
      return wrap ? wrap.textContent.trim() : ''
    })()`)
    expect(activeKind, `执行位置默认应为「本机执行」，实际是「${activeKind}」`).toContain('本机')

    // 平台默认解释器（Windows 上是 PowerShell）—— 顺带把 PowerShell 那条构造路径也跑了
    const shellText = await textOf(cdp, 'script-shell')
    expect(shellText.length, '解释器没有被自动选中').toBeGreaterThan(0)

    // PowerShell 与 Git Bash 都认 `Write-Output`，所以这段脚本两边都能跑
    expect(await setTextarea(cdp, 'script-text', `Write-Output "${LOCAL_MARKER}"`)).toBe(true)

    const before = await runRowCount(cdp)
    await clickTest(cdp, 'script-run', '执行按钮')

    // 等到**新的一条**跑完（只判"第一行不是执行中"会读到上一条，见 waitNewRunRow）
    const row = await waitNewRunRow(cdp, before, 120000)

    expect(row[2], `状态列应为「成功」，实际「${row[2]}」。整行=${JSON.stringify(row)}`).toContain(
      '成功'
    )
    expect(row[4], `退出码列应为 0，实际「${row[4]}」。整行=${JSON.stringify(row)}`).toBe('0')

    // 详情里能看到输出原文（中文没被切坏 —— 这就是"实时进任务台"那条链的产物）
    const tail = await readFirstRunOutput(cdp)
    expect(
      tail,
      `输出尾部里没有 ${LOCAL_MARKER}。真机上见过两种坏法：` +
        `① PowerShell 用控制台代码页写 stdout（GBK），按 UTF-8 解码变成 ???；` +
        `② 进度流在 stderr 上变成 CLIXML。两者都由 POWERSHELL_PREAMBLE 兜住。`
    ).toContain(LOCAL_MARKER)
    expect(tail, '输出里混进了 CLIXML（$ProgressPreference 没生效？）').not.toContain('CLIXML')

    // ④ 硬证据：**趁应用还开着**直接读台账（WAL 允许多进程读），
    //    证明"重启后还查得到"不是靠内存里那份，而是真落了库 + 真落了盘
    const check = openDatabase({
      dataDir: userDataDir,
      migrationsFolder: join(PROJECT_ROOT, 'src', 'main', 'db', 'migrations'),
      schemaVersion: 'e2e'
    })
    try {
      const r = createRepositories(check.db)
      const target = r.targets.listAll().find((t) => t.name === TARGET_NAME)!
      const runs = r.scriptRuns.listByTarget(target.id, 10)
      expect(runs.length, '台账里没有运行记录').toBeGreaterThan(0)

      const steps = r.scriptStepRuns.listByRun(runs[0]!.id)
      expect(steps.length, '运行记录里没有步骤').toBe(1)
      const step = steps[0]!
      expect(step.status).toBe('succeeded')
      expect(step.exitCode).toBe(0)
      expect(step.kind).toBe('local')
      expect(step.outputTail ?? '').toContain(LOCAL_MARKER)

      // 完整输出落盘：<数据目录>/log/script-runs/<runId>/1.log
      expect(step.outputPath, '没有记录输出文件路径').toBeTruthy()
      expect(existsSync(step.outputPath!), `输出文件不存在：${step.outputPath}`).toBe(true)
      expect(readFileSync(step.outputPath!, 'utf8')).toContain(LOCAL_MARKER)
      console.info(
        `[B20 DoD] 本机脚本成功：exitCode=0，输出落盘 ${step.outputPath}`,
        `（${step.outputBytes} 字节）`
      )
    } finally {
      check.close()
    }

    const probe = await readUiProbe(cdp)
    console.info(`[B20 DoD] 界面提示：${probe.msgs.join(' | ')}`)
  }, 240000)

  /* ---------------- ④b 控制台：点开"进行中"的任务，详情不该被悄悄关掉 */

  /**
   * 用户报的现象：**在任务控制台点开一个执行中的本机脚本，详情显示一下就自己关了**。
   *
   * 根因不在 store，也不在"详情"本身，而在 `el-table` 的当前行机制：
   * store 更新任务时**替换行对象**（`jobs[i] = { …jobs[i], percent }`），而表格没有
   * `row-key` 时会把"当前行不在数据里了"当成"用户换了行"，于是抛一次
   * `current-change(null)`，把选中项清空、详情回到"选择一个任务查看日志"。
   * 执行中的任务**每秒**都有进度事件（脚本的启发式进度就是 1s 一次），所以是"点开一秒后就关"。
   * 完整推导见 `TaskConsole.vue` 里 `onCurrentChange` 的注释。
   *
   * 这条用例的关键是让任务**跑得够久**：只有持续有进度事件，行对象才会被反复替换。
   * 所以故意用一条 10 秒的脚本，点开详情后**再等到确认来过一次进度事件**才断言
   * （只看固定几秒会撞运气 —— 同一份代码实测跑两次，一次红一次绿）。
   *
   * 断言全包在 `try/finally` 里：这条脚本是**同目标互斥**的，用例万一红了也要把它等完，
   * 否则后面的用例会撞 `E_TARGET_BUSY`（第一次写这条用例就是这么把 ⑤ 带红的，
   * 诊断信息里那句"该目标上已有脚本在执行中"就是它）。
   */
  it('任务控制台：点开"进行中"的任务后，详情不会被每秒的进度事件关掉', async () => {
    const cdp = app!.cdp
    await selectTarget(cdp)
    await waitFor(cdp, isVisible('script-text'), 30000, '脚本表单就绪')

    // 10 秒的本机脚本。按当前选中的解释器挑写法（Windows 默认 PowerShell）
    const shellText = await textOf(cdp, 'script-shell')
    const longScript = /PowerShell/.test(shellText)
      ? '1..10 | ForEach-Object { Write-Output "tick $_"; Start-Sleep -Seconds 1 }'
      : 'for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; sleep 1; done'
    expect(await setTextarea(cdp, 'script-text', longScript), '没找到脚本输入框').toBe(true)

    await clickTest(cdp, 'script-run', '执行按钮')

    // 展开底部控制台（幂等：已展开时不点，避免点成收起 —— 与 B08 同一套做法）
    const already = await cdp.evaluate<boolean>("!!document.querySelector('.tc-panel-head')")
    if (!already) {
      await cdp.evaluate<boolean>("(document.querySelector('.tc-toggle').click(), true)")
    }
    await waitFor(cdp, "!!document.querySelector('.tc-panel-head')", 10000, '任务控制台面板展开')

    /**
     * 点"进行中"的那一行。
     *
     * 判据用**行文本**（标题是 `脚本「本机脚本」`）而不是行号：这 10 秒里可能还有
     * 别的任务行插进来，行号会漂。
     */
    const rowExpr = `(() => {
      const rows = [...document.querySelectorAll('.tc-panel .el-table__body tbody tr')]
      return rows.filter((tr) => tr.textContent.includes('本机脚本'))
    })()`

    const titleExpr = "(document.querySelector('.tc-detail-title') || {}).textContent || ''"
    const logCount = (): Promise<number> =>
      cdp.evaluate<number>("document.querySelectorAll('.tc-log-line').length")

    try {
      await waitFor(
        cdp,
        `(${rowExpr}).some((tr) => tr.textContent.includes('进行中'))`,
        30000,
        '脚本任务出现在控制台且状态为「进行中」'
      )

      const clicked = await cdp.evaluate<boolean>(`(() => {
        const rows = ${rowExpr}
        const row = rows.find((tr) => tr.textContent.includes('进行中'))
        if (!row) return false
        row.click()
        return true
      })()`)
      expect(clicked, `控制台里没找到"进行中"的脚本任务行。当前界面：\n${await dumpUi(cdp)}`).toBe(
        true
      )

      // 用"等"而不是一次性读：点下去到界面反应过来之间有延迟（实测见过 3 秒以上），
      // 一次读会把"还没渲染出来"误判成"没选中"
      await waitFor(cdp, `(${titleExpr}).includes('本机脚本')`, 20000, '详情已打开（标题是脚本任务）')
      const logsBefore = await logCount()

      /*
       * 关键窗口：等到**确认又来过一次进度事件**再断言。
       *
       * 执行中的任务每秒都会推一次进度（收起条的百分比随之变化），
       * 所以"百分比变了"就是一个**确定发生了数据更新**的门 ——
       * 修复前那一次更新必然把详情关掉，修复后照旧留着。
       */
      const barPercentExpr =
        "(document.querySelector('.tc-bar .tc-percent') || {}).textContent || ''"
      const percentBefore = await cdp.evaluate<string>(barPercentExpr)
      expect(percentBefore, '收起条上没有百分比（长脚本应当还在跑）').toMatch(/%/)
      await waitFor(
        cdp,
        `(${barPercentExpr}) !== ${JSON.stringify(percentBefore)}`,
        20000,
        `进度又走了一格（起点 ${percentBefore}）`
      )

      const afterTitle = await cdp.evaluate<string>(titleExpr)
      expect(
        afterTitle,
        '又来过一次进度事件之后，详情被关掉了（回到"选择一个任务查看日志"）—— ' +
          '这正是用户报的现象：表格没有 row-key 时，行对象被替换会被当成"当前行不在了"，' +
          '于是抛一次 current-change(null) 把选中项清掉。'
      ).toContain('本机脚本')

      /**
       * 日志还得**继续长**。
       *
       * 这一条是"详情还跟着这个任务走"的证据，所以用等而不是一次性读：
       * PowerShell 往管道写是带缓冲的，某 1 秒里一行都没到是正常的。
       */
      try {
        await waitFor(
          cdp,
          `document.querySelectorAll('.tc-log-line').length > ${logsBefore}`,
          25000,
          '右侧日志继续增长'
        )
      } catch (e) {
        throw new Error(
          `详情框还在，但右侧日志不再增长（起点 ${logsBefore} 行，现在 ${await logCount()} 行）—— ` +
            '说明详情虽然没被关，却不再跟着这个运行中的任务走了。',
          { cause: e }
        )
      }

      console.info(
        `[B20 DoD] 详情在进度事件下保持打开；日志 ${logsBefore} → ${await logCount()} 行`
      )
    } finally {
      // 无论断言过不过，都要把这条 10 秒的脚本等完：同目标的脚本执行是互斥的
      await waitFor(
        cdp,
        `!(${rowExpr}).some((tr) => tr.textContent.includes('进行中'))`,
        60000,
        '10 秒的长脚本结束'
      ).catch(() => undefined)
    }
  }, 180000)

  /* ------------------------------------------ ⑤ 真跑一条服务器脚本（需凭据） */

  remoteIt(
    '服务器真跑一条脚本：远端文件真的写下了（需要 .env.it 凭据）',
    async () => {
      const cdp = app!.cdp
      await selectTarget(cdp)
      await waitFor(cdp, isVisible('script-text'), 30000, '脚本表单就绪')

      await clickTest(cdp, 'script-run-kind-remote', '执行位置=服务器执行')
      // 断言切换真的生效再跑 —— 否则后面所有断言都在看一条**本机**记录的影子
      await waitFor(
        cdp,
        `(() => {
          const host = document.querySelector('[data-test=script-kind]')
          const on = host && host.querySelector('.el-radio-button.is-active')
          return !!on && on.textContent.includes('服务器')
        })()`,
        10000,
        '执行位置已切到「服务器执行」'
      )

      const remoteScript = `mkdir -p ${REMOTE_ROOT} && echo ${REMOTE_MARKER} > ${REMOTE_ROOT}/probe.txt && cat ${REMOTE_ROOT}/probe.txt`
      expect(await setTextarea(cdp, 'script-text', remoteScript), '没找到脚本输入框').toBe(true)

      // 点之前先把三件事自证一遍 —— 否则"点了没反应"只能靠猜
      // （第一次跑就是在这里卡了 180 秒：按钮是禁用的，点了什么都不发生）
      const domScript = await cdp.evaluate<string>(`(() => {
        const host = document.querySelector('[data-test=script-text]')
        const ta = host && (host.tagName === 'TEXTAREA' ? host : host.querySelector('textarea'))
        return ta ? ta.value : ''
      })()`)
      expect(domScript, '脚本没有写进输入框（DOM 里是空的）').toBe(remoteScript)

      const runDisabled = await cdp.evaluate<boolean>(
        "!!document.querySelector('[data-test=script-run]').disabled"
      )
      // 注意：**不要在 `expect` 的说明里读探针** —— `readUiProbe()` 会清空记录，
      // 而说明字符串是**无条件求值**的，等于在点执行之前把证据抹掉了。
      const beforeMsgs = (await readUiProbe(cdp)).msgs
      expect(
        runDisabled,
        `执行按钮是禁用的 —— 模型里的脚本与 DOM 不一致（canRun 为假）。` +
          `此前的界面提示：${beforeMsgs.join(' | ') || '(无)'}`
      ).toBe(false)

      const before = await runRowCount(cdp)
      await clickTest(cdp, 'script-run', '执行按钮')

      /**
       * 服务器执行会**先弹一次确认**（本机执行不弹，见 `ScriptPanel.confirmRemote`
       * 的注释：本机脚本一天跑几十次，每次都问会把人训练成无脑点确认）。
       * 这一步必须在测试里答掉 —— 不答的话 `run()` 就停在 `await` 上：
       * 没有新记录、没有任何提示，表现成"点了没反应"，很难查。
       */
      await waitFor(cdp, "!!document.querySelector('.el-message-box')", 20000, '服务器执行的确认弹窗')
      const boxText = await cdp.evaluate<string>(
        "(document.querySelector('.el-message-box__message') || {}).textContent || ''"
      )
      expect(boxText, '服务器执行的确认框应给出第三档"对服务器的影响"').toContain(
        '【对服务器的影响】'
      )
      expect(boxText).toContain('会在服务器上执行你填写的命令')
      const confirmed = await cdp.evaluate<boolean>(`(() => {
        const btns = [...document.querySelectorAll('.el-message-box__btns button')]
        const ok = btns.find((b) => (b.textContent || '').trim() === '执行')
        if (!ok) return false
        ok.click()
        return true
      })()`)
      expect(confirmed, '确认框里没找到「执行」按钮').toBe(true)

      // 远端要连服务器、还要等它回结果，给足时间
      const row = await (async (): Promise<string[]> => {
        try {
          return await waitNewRunRow(cdp, before, 180000)
        } catch (e) {
          // 失败时把"应用到底在干什么"带出来（探针里的 `ElMessage` 只活 3 秒）
          const probe = await readUiProbe(cdp)
          const jobs = await readAppJobs(cdp)
          throw new Error(
            `${(e as Error).message}\n界面提示：${probe.msgs.join(' | ') || '(无)'}\n` +
              `应用内的任务列表：${jobs}\n界面快照：\n${await dumpUi(cdp)}`,
            { cause: e }
          )
        }
      })()

      expect(row[2], `远端脚本应成功，实际「${row[2]}」。整行=${JSON.stringify(row)}`).toContain(
        '成功'
      )
      expect(row[1], '步骤列应标出这是服务器执行').toContain('服务器')
      expect(row[4]).toBe('0')

      const detail = await readFirstRunOutput(cdp)
      expect(detail).toContain(REMOTE_MARKER)

      console.info('[B20 DoD] 远端脚本成功：远端文件内容已回显')
    },
    300000
  )

  /* ------------------------------------------ ⑥ 重启后运行记录仍在 */

  it('重启应用后运行记录仍在（这是"另建一张表"存在的唯一理由）', async () => {
    /**
     * 重启必须用 `killTree`：`closeApp()` 会把 `userDataDir` 一起删掉
     * （`e2e-app.ts` 的"临时目录用完即弃"约定），那样重启后是个全新的空库，
     * "记录还在"永远验不出来。B14 / B15 都在这上面绕过一圈。
     */
    await killTree(app!.child)
    await sleep(600)
    app = await launchApp({ projectRoot: PROJECT_ROOT, debugPort: DEBUG_PORT, userDataDir })

    const cdp = app.cdp
    await selectTarget(cdp)
    await waitFor(
      cdp,
      `!!document.querySelector('${ROWS}')`,
      60000,
      '重启后运行记录仍在'
    )
    const row = await firstRunRow(cdp)
    expect(row, '重启后运行记录为空').not.toBeNull()
    expect(row![2], `重启后状态应仍可读，实际「${row![2]}」`).toContain('成功')
    expect(row![4], '重启后退出码应仍可读').toBe('0')

    // 总闸也是落库的：重启后仍然是开的
    await openSettings(cdp)
    expect(await switchOn(cdp, 'settings-allow-user-scripts')).toBe(true)
    console.info('[B20 DoD] 重启后：运行记录与退出码仍在，总闸仍为开启')
  }, 240000)
})
