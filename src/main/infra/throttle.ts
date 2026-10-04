/**
 * 节流推送（T08.4：`job:progress` 200ms 节流）。
 *
 * ## 为什么不能直接用 `setTimeout` 糊一个
 *
 * 进度推送最常见的两个 bug 都出在"节流把该送的丢了"：
 * 1. **丢最后一条**：只在窗口结束时发送，任务在窗口中间就完成了 →
 *    界面永远停在 97%，用户以为卡死。所以**尾边沿必须补发**。
 * 2. **首条延迟**：只做尾边沿（debounce），任务起步的第一个进度要等满一个窗口
 *    才出现 → 点完按钮有 200ms 的"没反应"。所以**首边沿要立刻发**。
 *
 * 于是这里实现的是"首边沿 + 尾边沿、每窗口至多一次、最后一条必达"的节流：
 *
 * ```
 * push A ──立即发送──┐
 * push B ─┐          │ 窗口期
 * push C ─┴─合并─────┴─窗口结束：发送合并结果（若期间有新值）
 * ```
 *
 * `reduce` 决定"合并"的语义：
 * - 进度用"取最新"（`(_acc, next) => next`）—— 中间态没有保留价值；
 * - 日志用"追加"（把新行推进数组）—— 每一行都不能丢。
 *
 * 纯逻辑（只依赖 setTimeout，无 electron / 无 I/O），可完整单测。
 */

export interface ThrottledFlush<In, Out> {
  /** 提交一个新值。首次（或窗口刚结束）立即发送，其余合并到窗口末尾发送。 */
  push(value: In): void
  /**
   * 立即发送挂起的值（若有），并**重置窗口**。返回实际送出的合并值（无则 undefined）。
   * 用于终态：必须保证"最后一条进度/日志"先于状态事件到达渲染进程。
   */
  flushNow(): Out | undefined
  /** 是否有未发送的值（测试与自检用）。 */
  hasPending(): boolean
  /** 停止计时器（应用退出 / 测试收尾），不清空挂起值。 */
  dispose(): void
}

export interface ThrottledFlushOptions<In, Out> {
  /** 窗口长度（毫秒）。 */
  intervalMs: number
  /**
   * 合并函数：把新值并入累积值。
   *
   * 注意 `acc` 可能是 `undefined`（本窗口的第一个值），实现要处理这种情况。
   * 第二个参数后的累积值**不得为 undefined**，否则会被当作"无挂起值"。
   */
  reduce: (acc: Out | undefined, next: In) => Out
  onFlush: (value: Out) => void
}

export function createThrottledFlush<In, Out>(
  opts: ThrottledFlushOptions<In, Out>
): ThrottledFlush<In, Out> {
  const intervalMs = Math.max(0, opts.intervalMs)

  let acc: Out | undefined
  let hasPending = false
  let timer: NodeJS.Timeout | undefined

  function doFlush(): Out | undefined {
    if (!hasPending) return undefined
    const value = acc as Out
    acc = undefined
    hasPending = false
    opts.onFlush(value)
    return value
  }

  function scheduleWindow(): void {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      // 尾边沿：窗口结束时把合并结果发出去；若期间没有新值则彻底空闲
      // （下一个 push 会走首边沿立即发送）
      if (hasPending) {
        doFlush()
        scheduleWindow()
      }
    }, intervalMs)
    // 不要让节流计时器拖住进程退出
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    push(value: In): void {
      acc = opts.reduce(acc, value)
      hasPending = true
      if (!timer && intervalMs > 0) {
        // 首边沿：立即发送，避免"点完没反应"
        doFlush()
        scheduleWindow()
        return
      }
      if (intervalMs === 0) doFlush()
      else scheduleWindow()
    },

    flushNow(): Out | undefined {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      return doFlush()
    },

    hasPending(): boolean {
      return hasPending
    },

    dispose(): void {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    }
  }
}
