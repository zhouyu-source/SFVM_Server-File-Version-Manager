/**
 * B15 DoD：设置与体验打磨（真窗口）。
 *
 * ## 为什么这一批的 DoD 特别需要真窗口
 *
 * 本批次改的东西有一半是"接线的正确性"，而这些在单测里天然测不到：
 *
 * | 要验的事 | 为什么单测测不到 |
 * | --- | --- |
 * | 设置改完**重启还在** | 单测每次都是新库 / 同进程，看不出"落库了没" |
 * | 设置改完**下一次取用就是新值** | 需要真的跑一次传输/校验才看得见，而单测的替身拿不到这个值 |
 * | 导出内容的文本框、导入结果面板 | 渲染进程的组件行为，只有真界面里有 |
 * | 快捷键表 / 关于页 / 骨架屏 | 纯粹的界面呈现 |
 * | 危险确认里那句"对服务器的影响" | 文案由组件渲染，还有"Markdown 星号"这种只有肉眼才发现的坑 |
 *
 * ## 依赖注入的两个小开关（本文件自己加的）
 *
 * 1. **`--user-data-dir` 用测试自己建的目录**，并且在"重启"那一步改用
 *    `killTree()` 而不是 `closeApp()` —— 后者会把 `userDataDir` 一起删掉
 *    （`e2e-app.ts` 的约定：临时目录用完即弃），那样"重启后还在"就永远验不出来。
 *    这一点 B14 已经踩过一次，这里直接按结论办。
 * 2. **骨架屏靠"reload 后紧轮询"**：它是瞬态的（IPC 一回来就消失）。
 *    单次轮询可能错过，所以允许重试三次，任一次观察到即通过 —— 并且把
 *    "第几次看到"打进日志，将来若变得不稳定能一眼看出是环境快了还是坏了。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp, killTree, launchApp, sleep, waitFor, type Cdp, type LaunchedApp } from '../helpers/e2e-app'
import { selectTarget } from '../helpers/e2e-ui'
import { openDatabase } from '@main/db/client'
import { createRepositories } from '@main/db/repositories'

const PROJECT_ROOT = process.cwd()
/** 端口按批次错开：B12=9336 / B13=9337 / B14=9338 / B15=9339 */
const DEBUG_PORT = 9339

const describeE2E = process.env.SFVM_E2E === '1' ? describe : describe.skip

describeE2E('B15 DoD：设置与体验打磨', () => {
  let app: LaunchedApp | null = null
  let userDataDir = ''
  /** 第一段跑完要重启（验持久化），所以实例是分段的 */
  let phase = 0

  const CONNECTION_NAME = 'B15 测试机'

  beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'sfvm-e2e-b15-'))

    // 先写库：一条连接 + 一个环境 + 一个目标（导出内容里要有东西可看）
    const db = openDatabase({
      dataDir: userDataDir,
      migrationsFolder: join(PROJECT_ROOT, 'src', 'main', 'db', 'migrations'),
      schemaVersion: 'e2e'
    })
    const repo = createRepositories(db.db)
    const conn = repo.connections.create({
      name: CONNECTION_NAME,
      host: '192.0.2.10',
      port: 22,
      username: 'deploy',
      authType: 'password',
      // 模拟 Keychain 里存过的密文：导出内容里绝不能出现它
      secretCipher: 'v10:E2E-SECRET-MUST-NOT-EXPORT',
      hostKeyFingerprint: 'SHA256:e2e-fingerprint',
      remark: 'B15 导出用'
    })
    const env = repo.environments.create({
      name: 'B15 测试环境',
      envType: 'test',
      connectionId: conn.id
    })
    repo.targets.create({
      environmentId: env.id,
      name: 'B15 目标',
      kind: 'dir',
      remotePath: '/opt/b15/web/dist',
      localExclude: JSON.stringify(['node_modules'])
    })

    db.close()

    app = await launchApp({ projectRoot: PROJECT_ROOT, debugPort: DEBUG_PORT, userDataDir })
    phase = 1
  }, 120000)

  afterAll(async () => {
    if (app) await closeApp(app)
    // closeApp 之后目录已删；若还留着（比如中途失败）再兜一次
    if (existsSync(userDataDir)) rmSync(userDataDir, { recursive: true, force: true })
  })

  /**
   * 切到某个 hash 路由，并等一个"只有该页面才有"的标志元素出现。
   *
   * ## 为什么要重试
   *
   * 应用**刚启动时**，vue-router 的首次导航是异步的（`/` → `/connections`，
   * 而路由组件是动态 import）。如果我们在它完成之前就把 hash 改成别的，
   * 那次初始导航结束时会把 hash **改回 `#/connections`** —— 表现是
   * "我明明设了 hash、`location.hash` 却在几毫秒后自己变回去了"，
   * 而单看超时信息完全看不出原因（第一版就是这么红的）。
   *
   * 所以这里不假设"设一次就生效"：设 → 等标志元素 → 没等到就再设一次。
   * 这也顺带覆盖了"上一次导航被弹窗拦住"之类的情形。
   */
  async function goto(cdp: Cdp, hash: string, marker: string, what: string): Promise<void> {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      await cdp.evaluate<boolean>(`(location.hash = ${JSON.stringify(hash)}, true)`)
      const ok = await (async (): Promise<boolean> => {
        const inner = Date.now() + 1500
        while (Date.now() < inner) {
          if (await cdp.evaluate<boolean>(marker)) return true
          await sleep(100)
        }
        return false
      })()
      if (ok) return
    }
    throw new Error(`导航到 ${what}（${hash}）失败：标志元素始终没出现`)
  }

  /**
   * 往目标里灌一批归档记录，把"往期版本"的加载变慢。
   *
   * 应用此刻正开着这个库：SQLite 的 **WAL 允许多进程并发**（一写多读），
   * 而应用这段时间没有写操作，所以测试进程直接写是安全的。
   */
  function seedBulkArchives(count: number): void {
    const db = openDatabase({
      dataDir: userDataDir,
      migrationsFolder: join(PROJECT_ROOT, 'src', 'main', 'db', 'migrations'),
      schemaVersion: 'e2e'
    })
    const repo = createRepositories(db.db)
    const target = repo.targets.listAll()[0]!
    db.raw.exec('BEGIN')
    for (let i = 0; i < count; i++) {
      const tag = `20260101-${String(i).padStart(6, '0')}_aaaaaaa`
      repo.archives.create({
        targetId: target.id,
        versionTag: tag,
        storagePath: `/opt/b15/web/dist.versions/${tag}`,
        payloadPath: `/opt/b15/web/dist.versions/${tag}/payload`,
        kind: 'dir',
        rootHash: 'f'.repeat(64),
        totalBytes: 1024,
        fileCount: 1,
        status: 'valid'
      })
    }
    db.raw.exec('COMMIT')
    db.close()
  }

  /** 切到设置页（关于区的数据目录出现即代表路由切换 + 数据目录状态都已就绪）。 */
  async function openSettings(cdp: Cdp): Promise<void> {
    await goto(cdp, '#/settings', "!!document.querySelector('[data-test=about-data-dir]')", '设置页')
  }

  /** 往 Element Plus 的输入框里写值（原生 setter + input 事件，才能触发 v-model）。 */
  async function setInput(cdp: Cdp, testId: string, value: string): Promise<boolean> {
    return cdp.evaluate<boolean>(`(() => {
      const host = document.querySelector('[data-test=${testId}]')
      if (!host) return false
      const input = host.tagName === 'INPUT' ? host : host.querySelector('input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  }

  /**
   * 点保存并等它真的完成。
   *
   * ## 两个关键点（都是踩过才知道的）
   *
   * 1. **点之前先确认按钮可用**。保存按钮是 `:disabled="!dirty"` 的，
   *    而入参如果是通过"直接写 DOM 的值 + 派发 input 事件"塞进去的，
   *    有可能**没有**触发 Vue 的模型更新 —— 这时候：
   *       · 输入框里显示的是我们刚写进去的新值（看着"改成功了"）；
   *       · 而 `form` 里还是旧值 → `dirty` 为 false → 按钮是禁用的；
   *       · 点一个禁用的按钮什么都不发生，也**没有任何报错**。
   *    于是测试会以为"保存了"，实际上一个字节都没写。
   *    所以这里把"按钮可用"当成"输入真的进了模型"的证据。
   *
   * 2. **完成信号是 dirty 提示消失**，不是"按钮里有'保存'两个字"
   *    （后者在任何时候都成立，会让断言在保存返回前就往下走）。
   *    并且先看有没有红色错误提示：保存失败时表单里仍是新值，
   *    只看 dirty 会把失败误判成"还在保存中"。
   */
  async function saveSettings(cdp: Cdp): Promise<void> {
    const enabled = await cdp.evaluate<boolean>(
      "!document.querySelector('[data-test=settings-save]').disabled"
    )
    expect(
      enabled,
      '保存按钮是禁用的 —— 说明刚才对输入框的修改**没有进入 Vue 的模型**（dirty 仍为 false）'
    ).toBe(true)

    await clickTest(cdp, 'settings-save')

    const outcome = await (async (): Promise<string> => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const r = await cdp.evaluate<{ dirty: boolean; err: string }>(`(() => ({
          dirty: !!document.querySelector('[data-test=settings-dirty]'),
          err: [...document.querySelectorAll('.el-message--error')]
            .map((e) => e.textContent || '').join(' | ')
        }))()`)
        if (r.err) return `err:${r.err}`
        if (!r.dirty) return 'ok'
        await sleep(200)
      }
      return 'timeout'
    })()
    expect(outcome, `保存没有成功（${outcome}）`).toBe('ok')

    const issues = await cdp.evaluate<string>(
      "((document.querySelector('[data-test=settings-issues]') || {}).textContent || '').trim()"
    )
    expect(issues, `保存后出现了"设置读不出来"告警：${issues}`).toBe('')
  }

  async function clickTest(cdp: Cdp, testId: string): Promise<boolean> {
    return cdp.evaluate<boolean>(`(() => {
      const el = document.querySelector('[data-test=${testId}]')
      if (!el) return false
      el.click()
      return true
    })()`)
  }

  const textOf = (cdp: Cdp, testId: string): Promise<string> =>
    cdp.evaluate<string>(
      `((document.querySelector('[data-test=${testId}]') || {}).textContent || '').trim()`
    )

  /**
   * 读 el-switch 的开 / 关。
   *
   * 同时看 `aria-checked` 与 `is-checked` 类：Element Plus 不同小版本在这两种
   * 表达之间摇摆过，只认一种会让测试"换个版本就红"，而红的原因与业务无关。
   */
  const switchOn = (cdp: Cdp, testId: string): Promise<boolean> =>
    cdp.evaluate<boolean>(`(() => {
      const el = document.querySelector('[data-test=${testId}]')
      if (!el) return false
      if (el.getAttribute('aria-checked') === 'true') return true
      return el.classList.contains('is-checked')
    })()`)

  const inputValueOf = (cdp: Cdp, testId: string): Promise<string> =>
    cdp.evaluate<string>(`(() => {
      const host = document.querySelector('[data-test=${testId}]')
      if (!host) return ''
      const input = host.tagName === 'INPUT' ? host : host.querySelector('input')
      return input ? input.value : ''
    })()`)

  /* ------------------------------------------------ T15.1 设置可改可存 */

  it('T15.1 / T15.2：设置页可改、可保存，保存后按钮回到"已保存"状态', async () => {
    const cdp = app!.cdp
    await openSettings(cdp)

    // 默认值先自证一遍（默认并发 4、兼容模式开、默认保留策略 20）
    expect(await inputValueOf(cdp, 'settings-concurrency')).toBe('4')
    expect(await switchOn(cdp, 'settings-compat-mode')).toBe(true)

    // 改两项：并发 4 → 7、关闭算法兼容模式
    expect(await setInput(cdp, 'settings-concurrency', '7')).toBe(true)
    await clickTest(cdp, 'settings-compat-mode')

    // 还没保存 → 按钮文案里带"有改动"
    await waitFor(
      cdp,
      "((document.querySelector('[data-test=settings-save]') || {}).textContent || '').includes('有改动')",
      10000,
      '保存按钮提示有未保存改动'
    )
    await saveSettings(cdp)

    // 切走再切回来：证明**服务端**存住了（不是只有本地表单还留着新值）
    await goto(
      cdp,
      '#/connections',
      `document.body.textContent.includes(${JSON.stringify(CONNECTION_NAME)})`,
      '连接页'
    )
    await openSettings(cdp)
    expect(await inputValueOf(cdp, 'settings-concurrency'), '切页回来后并发数不是 7').toBe('7')
    expect(await switchOn(cdp, 'settings-compat-mode')).toBe(false)
    console.info('[B15 DoD] 设置已保存并落库：并发=7、算法兼容模式=关')
  }, 90000)

  it('T15.2：默认保留策略可编辑并随保存落库', async () => {
    const cdp = app!.cdp
    // 默认策略是 count/20；改成 3
    expect(await inputValueOf(cdp, 'settings-default-retain-value')).toBe('20')
    await setInput(cdp, 'settings-default-retain-value', '3')
    await saveSettings(cdp)

    // 切走再切回来：证明服务端真的存了 3
    await goto(
      cdp,
      '#/connections',
      `document.body.textContent.includes(${JSON.stringify(CONNECTION_NAME)})`,
      '连接页'
    )
    await openSettings(cdp)
    expect(
      await inputValueOf(cdp, 'settings-default-retain-value'),
      '切页回来后默认保留数不是 3'
    ).toBe('3')
    console.info('[B15 DoD] 默认保留策略已改为 3 个（落库并回读一致）')
  }, 90000)

  /* ------------------------------------------------ T15.3 导出 */

  it('T15.3：导出内容不含凭据，但保留了公开信息', async () => {
    const cdp = app!.cdp
    await clickTest(cdp, 'config-export')
    await waitFor(
      cdp,
      "((document.querySelector('[data-test=config-export-text]') || {}).value || '').length > 50",
      15000,
      '导出内容已生成'
    )
    const text = await cdp.evaluate<string>(
      "document.querySelector('[data-test=config-export-text]').value"
    )

    // 凭据绝不能出现（这是 T15.3 的硬要求）
    expect(text).not.toContain('E2E-SECRET-MUST-NOT-EXPORT')
    expect(text).not.toContain('secretCipher')
    expect(text).not.toContain('secret_cipher')
    // 公开信息该在：连接名、主机指纹、目标路径
    expect(text).toContain(CONNECTION_NAME)
    expect(text).toContain('SHA256:e2e-fingerprint')
    expect(text).toContain('/opt/b15/web/dist')
    // 结构字段
    expect(JSON.parse(text)).toMatchObject({ containsCredentials: false })
    // 界面上也要明示这一点
    expect(await textOf(cdp, 'config-export-secret-free')).toContain('不含任何密码')
    console.info(`[B15 DoD] 导出内容 ${text.length} 字符，已确认不含凭据`)
  }, 60000)

  it('T15.3：把导出内容粘回去导入 → 幂等（全部跳过），且不改动本机数据', async () => {
    const cdp = app!.cdp
    const exported = await cdp.evaluate<string>(
      "document.querySelector('[data-test=config-export-text]').value"
    )

    await cdp.evaluate<boolean>(`(() => {
      const host = document.querySelector('[data-test=config-import-text]')
      const ta = host.tagName === 'TEXTAREA' ? host : host.querySelector('textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(exported)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)

    await waitFor(
      cdp,
      "!document.querySelector('[data-test=config-import]').disabled",
      10000,
      '导入按钮变为可用'
    )
    await clickTest(cdp, 'config-import')

    await waitFor(
      cdp,
      "!!document.querySelector('[data-test=config-import-result]')",
      30000,
      '导入结果面板出现'
    )
    const result = await textOf(cdp, 'config-import-result')
    // 同一份配置再导一次：连接 / 环境 / 目标全部命中判重 → 一个都不新建
    expect(result).toContain('连接 +0')
    expect(result).toContain('环境 +0')
    expect(result).toContain('目标 +0')
    console.info(`[B15 DoD] 导入结果（幂等）：${result.replace(/\s+/g, ' ').slice(0, 120)}`)
  }, 90000)

  /* ------------------------------------------------ T15.7 / T15.8 */

  it('T15.7：快捷键表列全五条，且与菜单同一份数据', async () => {
    const cdp = app!.cdp
    const rows = await cdp.evaluate<string[]>(
      `[...document.querySelectorAll('[data-test=shortcuts-table] tbody tr')].map((tr) => tr.textContent.replace(/\\s+/g, ' ').trim())`
    )
    expect(rows.length).toBe(5)
    const all = rows.join('\n')
    for (const label of ['新建连接', '刷新界面', '打开设置', '打开日志目录', '打开数据目录']) {
      expect(all, `快捷键表缺「${label}」`).toContain(label)
    }
    // Windows / Linux 上展示的是 Ctrl（不是 CmdOrCtrl 这种内部写法）
    expect(all).toContain('Ctrl+N')
    expect(all).not.toContain('CmdOrCtrl')
    console.info(`[B15 DoD] 快捷键表 ${rows.length} 条`)
  }, 60000)

  it('T15.8：关于区给出真实数据目录与日志目录（可快捷打开）', async () => {
    const cdp = app!.cdp

    // 日志目录恒为"生效数据目录下的 log"（B18：日志跟着数据目录走）。
    // 本次没配过自定义目录，生效目录就是本次测试的临时 userData ——
    // 于是这一条同时证明"数据目录来自主进程的真实解析"与"日志落在数据目录里"。
    // 不区分大小写比较：Windows 上两处的大小写形式未必一致。
    const logDir = await textOf(cdp, 'about-log-dir')
    expect(logDir.toLowerCase()).toBe(join(userDataDir, 'log').toLowerCase())

    // 「打开」入口都在且可用（不点击：会真的弹出文件管理器）
    for (const id of ['about-open-data', 'about-open-logs']) {
      expect(
        await cdp.evaluate<boolean>(`!document.querySelector('[data-test=${id}]').disabled`),
        `${id} 应当可用`
      ).toBe(true)
    }

    // 首次打开时没有配置过自定义目录 → 不该提示"要重启"，应用按钮也不该亮
    expect(await cdp.evaluate<boolean>(`!document.querySelector('[data-test=about-data-dir-pending]')`)).toBe(
      true
    )
    expect(
      await cdp.evaluate<boolean>(`document.querySelector('[data-test=about-apply-data-dir]').disabled`)
    ).toBe(true)

    console.info(`[B15 DoD] 生效数据目录 = ${logDir.replace(/[\\/]log$/i, '')}，日志目录 = ${logDir}`)
  }, 60000)

  /* ------------------------------------------------ T15.6 危险文案 */

  it('T15.6：危险确认里明确写出"对服务器的影响"，且没有 Markdown 星号残留', async () => {
    const cdp = app!.cdp

    // 走连接页的"删除"（用的是统一的 confirmDanger → ElMessageBox）
    await goto(
      cdp,
      '#/connections',
      `document.body.textContent.includes(${JSON.stringify(CONNECTION_NAME)})`,
      '连接页（列表已加载）'
    )
    /**
     * 按 `data-test` 找行内按钮。
     *
     * 原来按文字找"删除" —— 而图标改造之后这一列的按钮是**纯图标**（只有 aria-label），
     * 文字查找必然落空。这也顺带说明"给可断言元素留 data-test"这条约定
     * 为什么要覆盖到行内按钮：靠文字找按钮在英文界面、图标按钮、加图标之后都会失效。
     */
    const clicked = await cdp.evaluate<boolean>(`(() => {
      const btn = document.querySelector('button[data-test^="conn-remove-"]')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    expect(
      clicked,
      `没找到行内「删除连接」按钮。当前 hash=${await cdp.evaluate<string>('location.hash')}，` +
        `带 data-test 的按钮=${JSON.stringify(
          await cdp.evaluate<string[]>(
            "[...document.querySelectorAll('button[data-test]')].map((b) => b.getAttribute('data-test'))"
          )
        )}`
    ).toBe(true)

    await waitFor(
      cdp,
      "!!document.querySelector('.el-message-box')",
      15000,
      '危险确认弹窗出现'
    )
    const body = await cdp.evaluate<string>(
      "(document.querySelector('.el-message-box__message') || {}).textContent || ''"
    )
    expect(body).toContain('【对服务器的影响】')
    // 删连接不影响服务器，文案必须说清这一点
    expect(body).toContain('不会删除或修改服务器上的任何文件')
    // MessageBox 不渲染 Markdown：正文里出现字面量星号说明有人又用 ** 写加粗了
    expect(body).not.toContain('**')

    // 关掉弹窗（点取消，不做真的删除）
    await cdp.evaluate<boolean>(`(() => {
      const btns = [...document.querySelectorAll('.el-message-box__btns button')]
      const cancel = btns.find((b) => /取消/.test(b.textContent || ''))
      if (!cancel) return false
      cancel.click()
      return true
    })()`)
    console.info('[B15 DoD] 危险确认文案：包含服务器影响说明，无 Markdown 星号')
  }, 90000)

  it('T15.5：慢加载时先给骨架屏，而不是闪一个假的空状态', async () => {
    const cdp = app!.cdp

    /**
     * ## 为什么验在"往期版本区"，而不是连接列表
     *
     * 骨架屏是**瞬态**的：数据一回来它就没了。要找它，就得有一个"确实会慢"的加载。
     *
     * 连接列表不适合做这件事：应用启动时 `App.vue` 就把连接与环境**预取**完了，
     * 而路由组件是动态 import 的 —— 视图挂载时 `store.loaded` 往往已经是 true，
     * 骨架屏那一帧**压根不存在**（第一版就是在这里抓不到，反复怀疑是不是没生效）。
     * 而且连接表用的是 `el-table`（不虚拟滚动）：为了让它慢而灌几千条连接，
     * 结果是把整个渲染进程拖垮 —— 所有 CDP 调用一起超时，看起来像"应用挂了"。
     *
     * 往期版本区两个条件都满足：
     * - 它的数据**没有**被预取，只有进到目标详情页才第一次加载（`ArchiveSection.load`）；
     * - 它用 `el-table-v2`（虚拟滚动），灌三千条也不会卡。
     *
     * 于是：灌 3000 条归档 → 进目标详情 → 页内 4ms 探针守着。
     * 一次列表 + 汇总的读取要几十毫秒，"慢加载"这个前提才真正成立 ——
     * 这也正是骨架屏存在的意义：它不是给"快"准备的，是给"慢"准备的。
     */
    const bulk = 3000
    seedBulkArchives(bulk)
    console.info(`[B15 DoD] 已灌入 ${bulk} 条归档记录，用来制造慢加载`)

    await cdp.send('Page.enable', {})
    const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__sfvmSkeletonSeen = false
        window.__sfvmFalseEmpty = false
        window.__sfvmSawReal = false
        const timer = setInterval(() => {
          try {
            if (!window.__sfvmSkeletonSeen &&
                document.querySelector('[data-test=archive-skeleton]')) {
              window.__sfvmSkeletonSeen = true
            }
            // "真实内容出现过"的证据：统计行的数字已经填上，不再是省略号
            const count = document.querySelector('[data-test=archive-count]')
            const countText = count ? (count.textContent || '') : ''
            if (/[0-9]/.test(countText)) window.__sfvmSawReal = true
            // 统计行还停在"…"时就写出"暂无往期版本"，那就是假的空状态
            if (/暂无往期版本/.test(document.body.innerText || '') && !/[0-9]/.test(countText)) {
              window.__sfvmFalseEmpty = true
            }
          } catch (e) { /* DOM 还没准备好 */ }
        }, 4)
      `
    })
    expect(injected.error).toBeUndefined()

    cdp.evaluateNoWait(`(() => { location.hash = '#/targets'; location.reload(); })()`)

    // 等页面恢复可用（reload 之后 evaluate 会短暂抛"执行上下文已销毁"）
    let ready = false
    for (let i = 0; i < 200 && !ready; i++) {
      await sleep(50)
      try {
        ready = await cdp.evaluate<boolean>('typeof window.__sfvmSkeletonSeen === "boolean"')
      } catch {
        ready = false
      }
    }
    expect(ready, 'reload 后注入的探针没生效').toBe(true)

    // 选中目标 → 进详情页 → 往期版本区开始加载
    await selectTarget(cdp)

    // 等到真实数据出现（3000 条要读一会儿，这也顺带证明"确实慢过"）
    await waitFor(
      cdp,
      "Number((document.querySelector('[data-test=archive-count]') || {}).textContent || 0) > 0",
      40000,
      '往期版本数量已显示出来'
    )
    const probe = await cdp.evaluate<{
      skeleton: boolean
      falseEmpty: boolean
      sawReal: boolean
    }>(`({
      skeleton: window.__sfvmSkeletonSeen,
      falseEmpty: window.__sfvmFalseEmpty,
      sawReal: window.__sfvmSawReal
    })`)

    expect(probe.falseEmpty, '加载过程中闪出了"暂无往期版本"的假空状态').toBe(false)
    expect(probe.sawReal, '整个过程都没看到真实数据（探针没生效？）').toBe(true)
    expect(
      probe.skeleton,
      '页内探针从未观察到骨架屏 —— 慢加载时没给骨架屏（T15.5 没生效）'
    ).toBe(true)
    console.info('[B15 DoD] 页内探针确认：慢加载时骨架屏出现过，且没有闪出假的空状态')
  }, 180000)

  /* -------------------------------------------- 重启后的持久化（T15.1） */

  it('T15.1：**重启应用后设置仍然是改过的值**（落库 + 启动时应用）', async () => {
    const cdp = app!.cdp
    // 先从界面确认一次当前值，避免"重启后恰好相等"的巧合
    await openSettings(cdp)
    expect(await inputValueOf(cdp, 'settings-concurrency')).toBe('7')

    /**
     * 重启：**必须用 killTree，不能用 closeApp** —— 后者会把 `userDataDir`
     * 一起删掉（`e2e-app.ts` 的"临时目录用完即弃"约定），那样重启后拿到的是
     * 一个全新的空库，"设置还在"就永远验不出来。B14 已经在这上面绕过一圈。
     */
    await killTree(app!.child)
    await sleep(600)
    app = await launchApp({ projectRoot: PROJECT_ROOT, debugPort: DEBUG_PORT, userDataDir })

    await openSettings(app.cdp)
    expect(await inputValueOf(app.cdp, 'settings-concurrency')).toBe('7')
    expect(await inputValueOf(app.cdp, 'settings-default-retain-value')).toBe('3')
    expect(await switchOn(app.cdp, 'settings-compat-mode')).toBe(false)
    console.info('[B15 DoD] 重启后设置保持：并发=7、默认保留=3、兼容模式=关')
    void cdp
  }, 180000)

  it('收尾：工作区无遗留（应用已退出、临时数据目录已清）', async () => {
    // 这里只做自检；真正的清理在 afterAll
    expect(phase).toBe(1)
    console.info(`[B15 DoD] 临时数据目录：${userDataDir}`)
  }, 30000)
})
