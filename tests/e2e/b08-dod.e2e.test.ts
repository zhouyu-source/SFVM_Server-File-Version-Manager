/**
 * B08 批次 DoD 的真窗口验证（T08.4 / T08.6 / T08.7）。
 *
 * 批次 DoD 原文：「用一个假任务（sleep + 进度模拟）验证进度条、日志、取消、退出保护全部生效。」
 *
 * ## 为什么不能只用单测
 *
 * 单测里 `electron` 是**内存替身**（`tests/stubs/electron.ts`），被替掉的恰恰是本批次
 * 最需要验证的那一层：preload 的 `contextBridge` 暴露、`ipcRenderer.on` 的跨进程事件、
 * `win.on('close')` 与 `app.on('before-quit')` 的真实触发时机。
 * 这些环节在替身下"永远是绿的"，上线后才发现事件根本没到渲染进程。
 * 所以这里**真的启动 Electron**，用 CDP（Chrome DevTools Protocol）从外部驱动界面。
 *
 * ## 驱动方式
 *
 * CDP 客户端、启动 / 等条件 / 杀进程树 / 清临时目录这些**基建**已抽到
 * `tests/helpers/e2e-app.ts`（B11 的 E2E 复用同一份）。下面只剩本批次的断言。
 *
 * ## 怎么驱动
 *
 * 1. 启动**构建产物**（`out/`，即 `electron .`），带 `--remote-debugging-port`；
 * 2. 从 `/json/list` 拿到渲染进程的 WebSocket 调试地址；
 * 3. 用 `Runtime.evaluate` 在页面里点按钮、采样 DOM —— 不做任何"测试专用后门"，
 *    走的就是用户真实点击的那条路径（`contextIsolation` 下 `window.sfvm` 在隔离世界，
 *    主世界的 `evaluate` 也拿不到它，这本身就保证了下不了后门）。
 *
 * 用**独立 `--user-data-dir`**（临时目录）启动：绝不碰用户真实的 `sfvm.db` 台账。
 *
 * ## 覆盖的四件事
 *
 * | DoD 项 | 断言 |
 * | --- | --- |
 * | 进度条 | 采样收起条百分比：出现多个**中间值**（不是 0% 直接跳 100%）、接近满格；面板里那一行的进度条到 100% |
 * | 日志 | 面板日志行数**递增**（流式到达，不是一次性刷出）且行内容非空 |
 * | 取消 | 点收起条「取消」→ 表格里该任务状态变为「已取消」 |
 * | 退出保护 | **点窗口关闭按钮（WM_CLOSE）**：有任务时窗口/渲染进程/任务三者都还在；**对照组**无任务时点 X 立即退出（防止"其实是谁都关不掉"这种假绿灯） |
 *
 * ## 运行方式
 *
 *   $env:SFVM_E2E='1'; npx vitest run tests/e2e/b08-dod.e2e.test.ts
 *   # 或 npm run test:e2e
 *
 * 前置：先 `npm run build`（跑的是 `out/` 里的产物，不是源码）。
 * 不设 `SFVM_E2E=1` 时整个文件跳过，因此可以安全地留在仓库里、也不会拖慢 `npm test`。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import {
  Cdp,
  closeApp,
  launchApp,
  pageTargetAlive,
  ps,
  PS_CLOSE_MAIN_WINDOW,
  PS_WINDOW_ALIVE,
  sleep,
  waitFor,
  type LaunchedApp
} from '../helpers/e2e-app'


const PROJECT_ROOT = process.cwd()
const ENABLED = process.env['SFVM_E2E'] === '1'
const describeIf = ENABLED ? describe : describe.skip

/** 远程调试端口：固定值，同一时刻只跑一个实例。 */
const DEBUG_PORT = 9333

/* --------------------------------------------------------------- CDP 客户端 */


/** 当前实例（用例之间会关闭/重开，所以是 let）。 */
let app: LaunchedApp | undefined

/** 关掉当前实例并清掉引用（helper 的 `closeApp` 只负责关，不负责清引用）。 */
async function closeCurrentApp(): Promise<void> {
  const cur = app
  app = undefined
  await closeApp(cur)
}

/** 展开底部任务控制台（幂等：已展开时不点，避免点成收起）。 */
async function ensureExpanded(cdp: Cdp): Promise<void> {
  const has = await cdp.evaluate<boolean>("!!document.querySelector('.tc-panel-head')")
  if (!has) await cdp.evaluate<boolean>("(document.querySelector('.tc-toggle').click(), true)")
  await waitFor(cdp, "!!document.querySelector('.tc-panel-head')", 10000, '任务控制台面板展开')
}

/** 点面板上的「跑一次自检」。 */
async function clickDemo(cdp: Cdp): Promise<void> {
  const ok = await cdp.evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll('.tc-panel-head button')]
      .find((b) => (b.textContent || '').includes('跑一次自检'))
    if (!btn) return false
    btn.click()
    return true
  })()`)
  expect(ok, '找不到「跑一次自检」按钮').toBe(true)
}
/* ------------------------------------------------------------------- 用例 */

describeIf('B08 DoD：真窗口（进度 / 日志 / 取消 / 退出保护）', () => {
  beforeAll(async () => {
    app = await launchApp({
      projectRoot: PROJECT_ROOT,
      debugPort: DEBUG_PORT,
      readyExpr: "!!document.querySelector('.tc-bar')"
    })
  }, 180000)

  afterAll(async () => {
    await closeCurrentApp()
  })

  it('进度条：收起条百分比出现**多个中间值**，且面板那一行到 100%', async () => {
    const cdp = app!.cdp
    await ensureExpanded(cdp)

    // 在页面里装一个采样器，避免"轮询恰好错过中间态"
    await cdp.evaluate(`(() => {
      window.__pct = []
      window.__logCount = []
      window.__timer = setInterval(() => {
        const p = document.querySelector('.tc-percent')
        if (p) window.__pct.push(p.textContent.trim())
        window.__logCount.push(document.querySelectorAll('.tc-log-line').length)
      }, 40)
      return true
    })()`)
    await clickDemo(cdp)

    // 自检任务：20 步 × 150ms ≈ 3s，等它结束（仍在运行中 -> 等状态不再是"进行中"）
    await waitFor(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('.tc-status')].map((e) => e.textContent.trim())
        return rows.some((t) => t === '已完成' || t === '失败' || t === '已取消')
      })()`,
      60000,
      '自检任务结束'
    )

    const samples = await cdp.evaluate<string[]>('(window.__timer, clearInterval(window.__timer), window.__pct)')
    const percents = samples
      .map((s) => Number.parseInt(s.replace('%', ''), 10))
      .filter((n) => Number.isFinite(n))

    expect(percents.length, `采样为空：${JSON.stringify(samples)}`).toBeGreaterThan(5)
    expect(new Set(percents).size, `百分比只有一个取值，说明进度没动：${JSON.stringify(percents)}`).toBeGreaterThan(2)
    // 收起条只在**有运行中任务**时出现，任务一进终态它立刻切回"无运行中任务"，
    // 所以最后一次被画出来的值通常是最后一个节流样本（95% 左右），而不是 100%。
    // 这里按实际语义断言"接近满格"，满格由下面的面板进度条验证。
    expect(Math.max(...percents)).toBeGreaterThanOrEqual(90)
    // 关键：必须存在**严格中间**的取值 —— 否则就是"0 直接跳 100"，进度条形同虚设
    expect(percents.some((n) => n > 0 && n < 100)).toBe(true)

    // 任务结束后，面板里那一行的进度条必须真的到 100%（终态被完整记录下来）
    const rowFull = await cdp.evaluate<boolean>(
      `[...document.querySelectorAll('.tc-row-progress .tc-progress-inner')]
         .some((e) => (e.style.width || '') === '100%')`
    )
    expect(rowFull, '面板里没有任何一行进度条到 100%').toBe(true)
    console.info(`[B08 DoD] 进度采样 ${percents.length} 次，取值：${[...new Set(percents)].join(' / ')}%`)
  }, 120000)

  it('日志：面板日志行数**递增**到达（流式），且内容非空', async () => {
    const cdp = app!.cdp
    const counts = await cdp.evaluate<number[]>('window.__logCount')
    const nonZero = counts.filter((n) => n > 0)
    expect(nonZero.length, `日志行数始终为 0：${JSON.stringify(counts.slice(0, 20))}`).toBeGreaterThan(0)
    expect(new Set(nonZero).size, `日志行数没有递增过程：${JSON.stringify(nonZero)}`).toBeGreaterThan(1)

    const lines = await cdp.evaluate<string[]>(
      `[...document.querySelectorAll('.tc-log-line .tc-log-text')].map((e) => e.textContent.trim())`
    )
    // 自检任务设计上每 5 步记一条（外加首尾各一条），20 步约 6 条；
    // 这里断言"确实收到多条、且是同一任务的"，而不是硬编码条数。
    expect(lines.length).toBeGreaterThanOrEqual(5)
    expect(lines.every((t) => t.length > 0)).toBe(true)
    expect(lines.some((t) => t.includes('自检'))).toBe(true)
    console.info(`[B08 DoD] 日志 ${lines.length} 行，末行：${lines[lines.length - 1]}`)
  }, 60000)

  it('取消：点收起条「取消」后任务状态变为「已取消」', async () => {
    const cdp = app!.cdp

    // 再跑一次自检，然后在 1s 内取消（任务总时长约 3s）
    await ensureExpanded(cdp)
    await clickDemo(cdp)
    await waitFor(cdp, "!!document.querySelector('.tc-bar .tc-percent')", 15000, '任务出现在收起条')

    await sleep(900)
    const clicked = await cdp.evaluate<boolean>(`(() => {
      const btn = [...document.querySelectorAll('.tc-bar button')]
        .find((b) => (b.textContent || '').trim() === '取消')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    expect(clicked, '收起条上没有可点的「取消」按钮').toBe(true)

    await waitFor(
      cdp,
      `[...document.querySelectorAll('.tc-status')].some((e) => e.textContent.trim() === '已取消')`,
      20000,
      '任务状态变为已取消'
    )
  }, 90000)

  it('对照组：**没有**运行中任务时点窗口关闭按钮，应用真的会退出', async () => {
    const cdp = app!.cdp
    // 上一用例已把任务取消，此时不应有运行中任务
    const running = await cdp.evaluate<number>(
      `[...document.querySelectorAll('.tc-status')].filter((e) => {
         const t = e.textContent.trim()
         return t === '进行中' || t === '排队中'
       }).length`
    )
    expect(running, '对照组前提不成立：仍有运行中任务').toBe(0)
    expect(await ps(PS_CLOSE_MAIN_WINDOW), '发送 WM_CLOSE 失败').toBe('SENT')

    // 应用应真的退出：调试端口随之关闭
    const deadline = Date.now() + 20000
    let gone = false
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
        await res.json()
      } catch {
        gone = true
        break
      }
      await sleep(300)
    }
    expect(gone, '点关闭按钮后调试端口仍在响应 —— 应用没有退出').toBe(true)
    console.info('[B08 DoD] 对照组：无运行中任务时点 X 立即退出（说明下面的用例不是"永远关不掉"）')
    await closeCurrentApp()
  }, 60000)

  it('退出保护：有运行中任务时点窗口关闭按钮被拦下，窗口与任务都还在', async () => {
    // 重新起一个干净实例（上一用例把前一个实例关掉了）
    const cur = await launchApp({ projectRoot: PROJECT_ROOT, debugPort: DEBUG_PORT, readyExpr: "!!document.querySelector('.tc-bar')" })
    const cdp = cur.cdp

    await waitFor(cdp, "!!document.querySelector('.tc-bar')", 30000, '任务控制台就绪')
    await ensureExpanded(cdp)
    await clickDemo(cdp)
    await waitFor(cdp, "!!document.querySelector('.tc-bar .tc-percent')", 15000, '任务已开始')

    // 关窗**之前**先确认任务确实在跑（否则本用例证明不了任何事）
    const runningBefore = await cdp.evaluate<boolean>(
      `[...document.querySelectorAll('.tc-status')].some((e) => {
         const t = e.textContent.trim()
         return t === '进行中' || t === '排队中'
       })`
    )
    expect(runningBefore, '关窗前任务已结束，本用例证明不了退出保护').toBe(true)

    // 用户视角的真实操作：点窗口右上角的 X（= WM_CLOSE）
    expect(await ps(PS_CLOSE_MAIN_WINDOW), '发送 WM_CLOSE 失败').toBe('SENT')
    // 自检任务只有约 3s，所以先做"快"的检查（CDP），再做"慢"的检查（起 PowerShell）。
    // 否则等 PowerShell 起完，任务已经跑完了，就分不清"保护没生效"和"任务本来就结束了"。
    await sleep(1000)

    // 1) 渲染进程还活着（不是"窗口留在那儿但内容已经没了"）
    expect(await pageTargetAlive(DEBUG_PORT), '渲染进程页面目标消失').toBe(true)
    // 2) 任务还在跑（保护的是"未完成的任务"，不是把应用冻住）
    const stillRunning = await cdp.evaluate<boolean>(
      `[...document.querySelectorAll('.tc-status')].some((e) => {
         const t = e.textContent.trim()
         return t === '进行中' || t === '排队中'
       })`
    )
    expect(stillRunning, '关窗被拦下之后任务却没了').toBe(true)
    // 3) 窗口还在（原生确认框弹出、窗口未被关掉）
    expect(await ps(PS_WINDOW_ALIVE), '窗口被关掉了 —— 退出保护没有拦住').toBe('YES')

    console.info('[B08 DoD] 有运行中任务时点 X 被拦下：窗口、渲染进程、运行中任务三者都还在')
    // 收尾：原生确认框还挂着，直接结束进程并清理临时 userData
    await closeCurrentApp()
  }, 120000)

  it('（观察）渲染进程自发 `window.close()` 不会让应用退出', async () => {
    // 这条路径不是用户可达的（界面上没有任何地方调 window.close），
    // 但它是"退出保护有没有兜住程序化关窗"的探针，因此单列一条并**只**断言
    // 最重要的安全性质：**应用不能就这么退出**（运行中的任务会被无声丢弃）。
    const cur = await launchApp({ projectRoot: PROJECT_ROOT, debugPort: DEBUG_PORT, readyExpr: "!!document.querySelector('.tc-bar')" })
    const cdp = cur.cdp
    await waitFor(cdp, "!!document.querySelector('.tc-bar')", 30000, '任务控制台就绪')
    await ensureExpanded(cdp)
    await clickDemo(cdp)
    await waitFor(cdp, "!!document.querySelector('.tc-bar .tc-percent')", 15000, '任务已开始')

    const running = await cdp.evaluate<boolean>(
      `[...document.querySelectorAll('.tc-status')].some((e) => {
         const t = e.textContent.trim()
         return t === '进行中' || t === '排队中'
       })`
    )
    expect(running, '前提不成立：此刻没有运行中任务').toBe(true)

    cdp.evaluateNoWait('window.close()')
    await sleep(3000)

    const exitCode = cur.child.exitCode
    const pageStillThere = await pageTargetAlive(DEBUG_PORT)
    console.info(
      `[B08 DoD] window.close() 后：进程 exitCode=${String(exitCode)}，` +
        `渲染进程页面目标${pageStillThere ? '仍在' : '已消失'}`
    )
    expect(exitCode, '渲染进程自发 close 让应用退出了 —— 运行中任务被无声丢弃').toBeNull()
    await closeCurrentApp()
  }, 90000)
})
