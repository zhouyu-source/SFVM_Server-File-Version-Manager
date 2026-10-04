/**
 * 真窗口 E2E 的界面操作助手（B12 建立，B13 复用）。
 *
 * 这里放的都是"**要点的东西藏在滚动容器/弹窗里**"这类与具体用例无关的操作。
 * 单独抽出来的理由不是省代码，而是这类操作**最容易写错**：
 * - 应用默认停在「连接」页，而左侧环境树是全局的 → 不显式切到 `#/targets`
 *   就会出现"右侧还是连接页"的迷惑现象（B12 单独跑某个用例时踩到）；
 * - `el-table-v2` 只渲染视口内的行 → 点第 6 行前必须先把那行**滚进视口**，
 *   否则等再久也等不到（它不是慢，是压根没渲染）；
 * - Element Plus 的弹窗关闭后**节点仍在 DOM 里**（只是隐藏）→
 *   判"弹窗关了"要判可见性，判"节点不存在"永远为真（假绿灯）。
 *
 * 这些坑踩过一次就够了，所以集中在这里，每个批次直接复用。
 */
import { sleep, waitFor, type Cdp } from './e2e-app'

/**
 * 切到「目标」页并选中第一个目标（直到版本表格出现）。
 *
 * **每个用例都要自己调一次**：单独跑某个用例（`-t "..."`）时，
 * 前面的用例不会先替它导航过去。
 */
export async function selectTarget(cdp: Cdp): Promise<void> {
  await waitFor(
    cdp,
    `!!document.querySelector('.sfvm-nav a[href="#/targets"]')`,
    30000,
    '顶部导航就绪'
  )
  await cdp.evaluate<boolean>(
    `(document.querySelector('.sfvm-nav a[href="#/targets"]').click(), true)`
  )
  await waitFor(cdp, "location.hash === '#/targets'", 15000, '已切到目标页')
  await waitFor(cdp, "!!document.querySelector('.tree .env-list li.env')", 30000, '环境树出现')
  const hasTarget = await cdp.evaluate<boolean>(
    "!!document.querySelector('.target-list li.target')"
  )
  if (!hasTarget) {
    await cdp.evaluate<boolean>("(document.querySelector('.env-row .caret').click(), true)")
  }
  await waitFor(cdp, "!!document.querySelector('.target-list li.target')", 15000, '目标节点出现')
  await cdp.evaluate<boolean>("(document.querySelector('.target-list li.target').click(), true)")
  await waitFor(cdp, "!!document.querySelector('[data-test=archive-table]')", 30000, '版本表格出现')
}

/** 版本表格里某一行的操作按钮选择器。 */
export function archiveRowButton(
  tag: string,
  action: 'download' | 'detail' | 'remove' | 'rollback' | 'verify'
): string {
  return `[data-test=arch-${action}-${tag}]`
}

/** 找到表格内部那个真的能滚的容器（类名随 element-plus 版本会变，按行为找最稳）。 */
function scrollerExpr(): string {
  return `(() => {
    const host = document.querySelector('[data-test=archive-table]')
    if (!host) return null
    const all = [host, ...host.querySelectorAll('*')]
    return all.find((x) => {
      const st = getComputedStyle(x)
      return x.scrollHeight > x.clientHeight + 20 && /auto|scroll/.test(st.overflowY)
    }) || null
  })()`
}

/**
 * 让某个版本行进入视口。
 *
 * 从顶部开始逐段向下滚，直到那一行出现在 DOM 里。失败时把"现在 DOM 里到底有哪几行"
 * 一起打出来 —— 分不清"滚不动"与"数据不对"是最耗时间的排查。
 */
export async function ensureArchiveRowVisible(cdp: Cdp, tag: string): Promise<void> {
  const visible = (): Promise<boolean> =>
    cdp.evaluate<boolean>(
      `[...document.querySelectorAll('[data-test=arch-version]')].some((e) => e.textContent.trim() === ${JSON.stringify(tag)})`
    )
  const scroll = (down: boolean): Promise<boolean> =>
    cdp.evaluate<boolean>(`(() => {
      const el = ${scrollerExpr()}
      if (!el) return false
      el.scrollTop = ${down ? 'el.scrollTop + 120' : '0'}
      return true
    })()`)

  const hasTable = await cdp.evaluate<boolean>(
    "!!document.querySelector('[data-test=archive-table]')"
  )
  if (!hasTable) {
    throw new Error('页面上没有版本表格 —— 多半是没在「目标」页（应用默认停在连接页）')
  }

  await scroll(false)
  for (let i = 0; i < 40; i++) {
    if (await visible()) return
    await scroll(true)
    await sleep(120)
  }
  const present = await cdp.evaluate<string[]>(
    `[...document.querySelectorAll('[data-test=arch-version]')].map((e) => e.textContent.trim())`
  )
  const scrolled = await cdp.evaluate<string>(`(() => {
    const el = ${scrollerExpr()}
    return el ? el.className + ' top=' + el.scrollTop + ' h=' + el.scrollHeight + ' c=' + el.clientHeight : 'no-scroller'
  })()`)
  throw new Error(
    `向下滚了 40 段仍没看到版本 ${tag}；DOM 里有 ${JSON.stringify(present)}；容器 ${scrolled}`
  )
}

/**
 * 关掉当前**可见**的弹窗（点"关闭/取消"按钮或右上角 X）。
 *
 * 判可见性（`offsetParent`）而不是判存在：Element Plus 的弹窗关闭后
 * 节点仍留在 DOM 里，`querySelector` 照样找得到（假绿灯）。
 */
export async function closeVisibleDialog(cdp: Cdp): Promise<void> {
  await cdp.evaluate<boolean>(`(() => {
    const dlg = [...document.querySelectorAll('.el-dialog, .el-drawer')].find((d) => d.offsetParent !== null)
    if (!dlg) return false
    const btn = [...dlg.querySelectorAll('button')].find((b) => /关闭|取 消|取消/.test(b.textContent || ''))
    if (btn) { btn.click(); return true }
    const x = dlg.querySelector('.el-dialog__headerbtn, .el-drawer__close-btn')
    if (x) { x.click(); return true }
    return false
  })()`)
  await sleep(300)
}

/* ------------------------------------------------------------- 页内探针 */

/**
 * "这个元素现在**可见**吗"的页面表达式。
 *
 * 必须存在与可见分开判：Element Plus 的弹窗 / 抽屉关闭后**节点仍在 DOM 里**
 * （只把 `.el-overlay` 设成 `display: none`），所以
 * `querySelector(...) !== null` 永远为真 —— 那是个假绿灯，
 * 会掩盖"弹窗根本没打开"这种最需要知道的失败（B16 的 T16.4 先踩了一次）。
 */
export function isVisible(testId: string): string {
  return `(() => {
    const el = document.querySelector('[data-test="' + ${JSON.stringify(testId)} + '"]')
    return !!el && el.offsetParent !== null
  })()`
}

/**
 * 失败时把"界面上现在到底是什么状态"摊开。
 *
 * 真窗口用例失败最难的地方不是断言红，而是**不知道红在哪一步**：
 * 是没点上、是点了报错、还是连上了但界面没刷新。这里把可见弹层、
 * 状态徽标、离线原因、提示条与主进程日志一起打出来，
 * 省掉一轮"加日志再跑两分钟"。
 */
export async function dumpUi(cdp: Cdp, logs: string[] = []): Promise<string> {
  const ui = await cdp
    .evaluate<string>(`(() => {
      const text = (sel) => {
        const e = document.querySelector(sel)
        return e ? e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300) : '(无)'
      }
      const layers = [...document.querySelectorAll('.el-dialog, .el-drawer')]
        .filter((d) => d.offsetParent !== null)
        .map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300))
      return [
        '徽标: ' + text('[data-test="conn-status"]'),
        '离线原因: ' + text('.reasons'),
        '提示条: ' + text('.el-message'),
        '可见弹层: ' + (layers.length ? layers.join(' || ') : '(无)'),
      ].join('\\n')
    })()`)
    .catch((e: Error) => `读取界面状态失败：${e.message}`)
  const tail = logs.slice(-15)
  return `${ui}${tail.length ? `\n--- 主进程输出（末 ${tail.length} 行）---\n${tail.join('\n')}` : ''}`
}

/**
 * 装两个"看着界面"的探针，用来给**已经消失的反馈**留证据。
 *
 * 真窗口用例最难受的一类失败是"点了没反应"：`ElMessage` 只活 3 秒，
 * 60 秒后再取 DOM 什么都看不到（B16 的 T16.3 就卡在这里 —— 徽标没变、
 * 没有离线原因、没有弹窗，三条线索全断）。
 * 探针把从外面看不到的东西记在页面里：
 * - `__msgs`：出现过的提示条文案（去重）；
 * - `__clicks`：用户真的点到了哪些 `data-test` 元素（用捕获阶段监听，
 *   所以**即使某个处理器自己 preventDefault/stopPropagation 也照样记下来**）。
 *
 * 用 80ms 轮询而不是 MutationObserver：这条路径上的节点都是 Element Plus
 * 临时挂到 body 上的，观察器要处理挂载/卸载两种时序，不如轮询直白。
 */
export async function installUiProbe(cdp: Cdp): Promise<void> {
  await cdp.evaluate<boolean>(`(() => {
    window.__msgs = window.__msgs || []
    window.__clicks = window.__clicks || []
    if (window.__probe) return true
    window.__probe = setInterval(() => {
      document.querySelectorAll('.el-message, .el-notification').forEach((e) => {
        const t = (e.textContent || '').replace(/\\s+/g, ' ').trim()
        if (t && !window.__msgs.includes(t)) window.__msgs.push(t)
      })
    }, 80)
    document.addEventListener('click', (ev) => {
      const el = ev.target && ev.target.closest && ev.target.closest('[data-test]')
      if (el) window.__clicks.push(el.getAttribute('data-test'))
    }, true)
    return true
  })()`)
}

/** 读并清空探针记录。 */
export async function readUiProbe(cdp: Cdp): Promise<{ msgs: string[]; clicks: string[] }> {
  return cdp.evaluate<{ msgs: string[]; clicks: string[] }>(`(() => {
    const r = { msgs: window.__msgs || [], clicks: window.__clicks || [] }
    window.__msgs = []
    window.__clicks = []
    return r
  })()`)
}

/* --------------------------------------------------------- 发布 / 归档 / 回滚 */

/**
 * 点「发布」，等**前置校验 + 差异预览**都回来（B11 建立，B16 提到这里）。
 *
 * 这段等待条件同时覆盖两种结局：正常时出现 `preview-diff`，
 * 前置校验失败时出现 `.el-alert--error` —— 只等前者会在失败时白等到超时，
 * 报出来的错还是"等待预览超时"，把真正的原因（比如磁盘不够）盖掉。
 */
export async function openPublishDialog(cdp: Cdp): Promise<void> {
  await waitFor(cdp, "!!document.querySelector('[data-test=publish-btn]')", 30000, '发布面板出现')
  await cdp.evaluate<boolean>("(document.querySelector('[data-test=publish-btn]').click(), true)")
  await waitFor(
    cdp,
    "!!document.querySelector('[data-test=confirm-publish]') && " +
      "(!document.querySelector('.preparing') && (!!document.querySelector('[data-test=preview-diff]') || !!document.querySelector('.el-alert--error')))",
    60000,
    '确认弹窗就绪（前置校验 + 差异预览）'
  )
}

/** 在确认弹窗里填备注并点确认。 */
export async function confirmPublish(cdp: Cdp, note: string): Promise<void> {
  await cdp.evaluate<boolean>(`(() => {
    const ta = document.querySelector('[data-test=publish-note] textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(note)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await cdp.evaluate<boolean>(
    "(document.querySelector('[data-test=confirm-publish]').click(), true)"
  )
}

/** 等这次发布跑完。 */
export async function waitPublishDone(cdp: Cdp, timeoutMs = 180000): Promise<'success' | 'failed'> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await cdp.evaluate<string>(`(() => {
      if (document.querySelector('[data-test=publish-failure]')) return 'failed'
      if (document.querySelector('[data-test=publish-success]')) return 'success'
      return 'running'
    })()`)
    if (state !== 'running') return state as 'success' | 'failed'
    await sleep(300)
  }
  throw new Error('等待发布结束超时')
}

/** 当前版本号（没有就返回空串）。 */
export function currentVersion(cdp: Cdp): Promise<string> {
  return cdp.evaluate<string>(
    "(() => { const e = document.querySelector('[data-test=current-version]'); return e ? e.textContent.trim() : '' })()"
  )
}

/** 往期版本表格里现在渲染出来的版本号。 */
export function archiveTags(cdp: Cdp): Promise<string[]> {
  return cdp.evaluate<string[]>(
    "[...document.querySelectorAll('[data-test=arch-version]')].map((e) => e.textContent.trim()).sort()"
  )
}

/** 往期版本总数（工具栏上的计数，不依赖表格渲染了多少行）。 */
export function archiveCount(cdp: Cdp): Promise<number> {
  return cdp.evaluate<number>(`(() => {
    const e = document.querySelector('[data-test=archive-count]')
    const n = e ? Number.parseInt(e.textContent.trim(), 10) : NaN
    return Number.isFinite(n) ? n : -1
  })()`)
}

