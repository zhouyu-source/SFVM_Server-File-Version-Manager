/**
 * 保留策略的纯逻辑部分（T09.8）。
 *
 * 方案书 §6.7：
 * - `{"mode":"count","value":10}`：保留最近 10 个，其余按 `archived_at` 升序删除
 * - `{"mode":"days","value":30}`：删除超过 30 天的
 *
 * ## 为什么单独抽出来
 *
 * 这是**唯一会主动删除服务器上历史数据的自动逻辑**。它没有二次确认
 * （方案书 §6.7 说"自动清理在策略保存时确认一次"），所以"删哪些、留哪些"
 * 必须是可穷举、可单测的纯函数 —— 靠人工 review 一段嵌在 IO 流程里的
 * 循环来判断"会不会误删"，是靠不住的。
 *
 * ## 两个保守选择
 *
 * 1. `archived_at` 解析不出来的行**一律保留**。数据坏了不代表该删；
 *    这类行交给对账（B14）处理，比在这里猜要安全得多。
 * 2. `value` 非法（0 / 负数 / NaN）时返回"什么都不删"并给出原因，
 *    而不是当成"全部删除"。策略写坏了的后果必须是"不清理"，不能是"清空"。
 */
import type { RetainPolicy } from '../../shared/contracts/workspace'

export interface RetainCandidate {
  id: string
  versionTag: string
  /** ISO-8601 */
  archivedAt: string
  totalBytes?: number
}

export interface RetentionPlan {
  /** 保留（不动）的归档 id */
  keep: string[]
  /** 待删除的归档，**元素顺序即删除顺序**（最旧的在前，便于日志与逐条排障） */
  remove: Array<{ id: string; versionTag: string; archivedAt: string }>
  /** 人类可读的策略描述；非法策略在 `reason` 里说明 */
  text: string
  /** 策略非法时不执行删除，这里给出面向用户的原因 */
  invalidReason?: string
}

function parseTime(iso: string): number | null {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/**
 * 计算保留计划。
 *
 * 排序刻意用**显式比较**而不是依赖入参顺序：调用方（repository）虽然已经按
 * `archived_at DESC` 查了，但"删数据的顺序依赖 SQL 的 ORDER BY 恰好没被改"
 * 是一种很脆的耦合。这里自己排一遍，顺带把"同一时刻"用 id 做稳定兜底。
 */
export function planRetention(
  archives: readonly RetainCandidate[],
  policy: RetainPolicy | null | undefined,
  now: Date
): RetentionPlan {
  if (!policy) {
    return { keep: archives.map((a) => a.id), remove: [], text: '未设置保留策略（不清理）' }
  }

  if (!Number.isInteger(policy.value) || policy.value < 1) {
    return {
      keep: archives.map((a) => a.id),
      remove: [],
      text: `保留策略非法（${policy.mode}=${policy.value}）`,
      invalidReason: `保留数量/天数必须是大于 0 的整数，当前为 ${policy.value}`
    }
  }

  /** 新 → 旧；同一时刻按 id 兜底，保证结果稳定可复现 */
  const newestFirst = [...archives].sort((a, b) => {
    const ta = parseTime(a.archivedAt) ?? Number.NEGATIVE_INFINITY
    const tb = parseTime(b.archivedAt) ?? Number.NEGATIVE_INFINITY
    if (ta !== tb) return tb - ta
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })

  if (policy.mode === 'count') {
    const keep = newestFirst.slice(0, policy.value)
    const drop = newestFirst.slice(policy.value)
    // §6.7："其余按 archived_at 升序删除" —— 即最旧的先删
    const remove = [...drop].reverse().map((a) => ({
      id: a.id,
      versionTag: a.versionTag,
      archivedAt: a.archivedAt
    }))
    return {
      keep: keep.map((a) => a.id),
      remove,
      text: `保留最近 ${policy.value} 个版本，需删除 ${remove.length} 个`
    }
  }

  const cutoff = now.getTime() - policy.value * 24 * 60 * 60 * 1000
  const keep: string[] = []
  const drop: RetainCandidate[] = []
  for (const a of newestFirst) {
    const t = parseTime(a.archivedAt)
    if (t === null) {
      keep.push(a.id) // 时间坏了 → 保守保留
      continue
    }
    if (t < cutoff) drop.push(a)
    else keep.push(a.id)
  }

  // 同样按时间升序删除：先删最旧的，中途失败时"留下来的更可能是较新的版本"
  const remove = [...drop].reverse().map((a) => ({
    id: a.id,
    versionTag: a.versionTag,
    archivedAt: a.archivedAt
  }))
  return {
    keep,
    remove,
    text: `删除早于 ${policy.value} 天（${new Date(cutoff).toISOString()}）的版本，需删除 ${remove.length} 个`
  }
}
