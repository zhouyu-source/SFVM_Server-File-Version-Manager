/**
 * 自动重连退避（T03.5 的纯逻辑部分）。
 *
 * 方案书 §6.2 规定：失败后按 `1s → 2s → 5s → 10s`（上限 10s）退避重试，最多 5 次。
 * 抽成纯函数便于单测，也便于 T10 的"发布中禁止重连"复用同一套计数。
 */

/** 退避序列（毫秒）。最后一项是上限，超出后一直沿用。 */
export const BACKOFF_MS = [1000, 2000, 5000, 10000] as const

/** 最大重试次数（方案书 §6.2）。 */
export const MAX_RETRIES = 5

/**
 * 第 `attempt` 次重试（从 0 开始计）应等待多久。
 * 超过序列长度时取上限，不会无限增长。
 */
export function backoffDelay(attempt: number): number {
  if (attempt <= 0) return BACKOFF_MS[0]
  const idx = Math.min(attempt, BACKOFF_MS.length - 1)
  return BACKOFF_MS[idx]
}

/** 是否还允许继续重试。 */
export function canRetry(attempt: number, max = MAX_RETRIES): boolean {
  return attempt < max
}

/**
 * 生成完整的退避时间表，便于文档化与测试断言。
 * 例：5 次重试 → [1000, 2000, 5000, 10000, 10000]
 */
export function backoffSchedule(max = MAX_RETRIES): number[] {
  return Array.from({ length: max }, (_, i) => backoffDelay(i))
}

/**
 * 重连是否被允许。
 * 方案书 §6.2：**发布任务执行期间不自动重连** —— 半途换会话会产生不一致，
 * 此时直接判定任务失败。
 */
export function shouldReconnect(opts: {
  attempt: number
  /** 该连接上是否有进行中的发布/回滚任务 */
  busy: boolean
  /** 是否已被用户主动断开 */
  userInitiated: boolean
}): boolean {
  if (opts.userInitiated) return false
  if (opts.busy) return false
  return canRetry(opts.attempt)
}
