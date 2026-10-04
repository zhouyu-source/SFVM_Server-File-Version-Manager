/**
 * T09.8 单测：保留策略的"删哪些、留哪些"。
 *
 * 这是全项目**唯一会自动删除服务器历史数据**的逻辑，且没有二次确认
 * （方案书 §6.7：自动清理只在策略保存时确认一次）。所以用例覆盖的重点
 * 不是"正常情况对不对"，而是"策略坏掉时会不会把东西删光"。
 */
import { describe, expect, it } from 'vitest'
import { planRetention, type RetainCandidate } from '@main/infra/retention'
import { describeRetainPolicy, parseRetainPolicy } from '@shared/contracts/workspace'

const NOW = new Date('2025-06-30T12:00:00Z')

function at(daysAgo: number, i: number): RetainCandidate {
  return {
    id: `id-${i}`,
    versionTag: `2025060${i}-000000_aaaaaaa`,
    archivedAt: new Date(NOW.getTime() - daysAgo * 86400_000).toISOString()
  }
}

/** 5 个版本：0/1/2/3/10 天前 */
const FIVE: RetainCandidate[] = [at(0, 9), at(1, 8), at(2, 7), at(3, 6), at(10, 1)]

describe('count 模式', () => {
  it('保留最近 3 个，删掉更旧的 2 个（按 archived_at 升序删，最旧在前）', () => {
    const plan = planRetention(FIVE, { mode: 'count', value: 3 }, NOW)
    expect(plan.keep).toEqual(['id-9', 'id-8', 'id-7'])
    expect(plan.remove.map((r) => r.id)).toEqual(['id-1', 'id-6'])
    expect(plan.text).toMatch(/保留最近 3 个/)
  })

  it('条数不超上限时什么都不删', () => {
    const plan = planRetention(FIVE, { mode: 'count', value: 5 }, NOW)
    expect(plan.remove).toEqual([])
    expect(plan.keep).toHaveLength(5)
  })

  it('value=1 只留最新一个', () => {
    const plan = planRetention(FIVE, { mode: 'count', value: 1 }, NOW)
    expect(plan.keep).toEqual(['id-9'])
    expect(plan.remove).toHaveLength(4)
  })

  it('入参顺序被打乱也不影响结论（不依赖 SQL 的 ORDER BY 恰好没被改）', () => {
    const shuffled = [FIVE[4], FIVE[1], FIVE[3], FIVE[0], FIVE[2]] as RetainCandidate[]
    const plan = planRetention(shuffled, { mode: 'count', value: 2 }, NOW)
    expect(plan.keep).toEqual(['id-9', 'id-8'])
  })
})

describe('days 模式', () => {
  it('删除超过 30 天的版本', () => {
    const rows = [at(0, 1), at(29, 2), at(31, 3), at(60, 4)]
    const plan = planRetention(rows, { mode: 'days', value: 30 }, NOW)
    expect(plan.keep).toEqual(['id-1', 'id-2'])
    expect(plan.remove.map((r) => r.id)).toEqual(['id-4', 'id-3'])
  })

  it('恰好等于边界（30 天整）不外删', () => {
    const rows: RetainCandidate[] = [
      { id: 'edge', versionTag: 'v', archivedAt: new Date(NOW.getTime() - 30 * 86400_000).toISOString() }
    ]
    expect(planRetention(rows, { mode: 'days', value: 30 }, NOW).remove).toEqual([])
  })

  it('时间解析不出来的行一律保留（数据坏了不代表该删）', () => {
    const rows: RetainCandidate[] = [
      { id: 'bad', versionTag: 'v1', archivedAt: 'not-a-date' },
      at(100, 2)
    ]
    const plan = planRetention(rows, { mode: 'days', value: 1 }, NOW)
    expect(plan.keep).toContain('bad')
    expect(plan.remove.map((r) => r.id)).toEqual(['id-2'])
  })
})

describe('保守性（策略坏掉时必须"不清理"而不是"清空"）', () => {
  it('没有策略 → 一个都不删', () => {
    const plan = planRetention(FIVE, null, NOW)
    expect(plan.remove).toEqual([])
    expect(plan.text).toMatch(/未设置/)
  })

  it('value 为 0 / 负数 / 非整数 → 明确拒绝执行', () => {
    for (const value of [0, -3, 1.5]) {
      const plan = planRetention(FIVE, { mode: 'count', value }, NOW)
      expect(plan.remove, String(value)).toEqual([])
      expect(plan.invalidReason, String(value)).toBeTruthy()
      expect(plan.keep).toHaveLength(5)
    }
  })

  it('空档案列表不产生任何操作', () => {
    const plan = planRetention([], { mode: 'count', value: 3 }, NOW)
    expect(plan.keep).toEqual([])
    expect(plan.remove).toEqual([])
  })
})

describe('策略文本与解析（两个消费方共用一份实现）', () => {
  it('parseRetainPolicy 对坏数据返回 null（= 不清理），不抛错', () => {
    expect(parseRetainPolicy(null)).toBeNull()
    expect(parseRetainPolicy('')).toBeNull()
    expect(parseRetainPolicy('{oops')).toBeNull()
    expect(parseRetainPolicy('{"mode":"month","value":3}')).toBeNull()
    expect(parseRetainPolicy('{"mode":"count","value":0}')).toBeNull()
    expect(parseRetainPolicy('{"mode":"count","value":3}')).toEqual({ mode: 'count', value: 3 })
    expect(parseRetainPolicy('{"mode":"days","value":30}')).toEqual({ mode: 'days', value: 30 })
  })

  it('describeRetainPolicy 给出人能读懂的文案', () => {
    expect(describeRetainPolicy(null)).toMatch(/不自动清理/)
    expect(describeRetainPolicy({ mode: 'count', value: 10 })).toBe('保留最近 10 个版本')
    expect(describeRetainPolicy({ mode: 'days', value: 30 })).toBe('删除超过 30 天的版本')
  })
})
