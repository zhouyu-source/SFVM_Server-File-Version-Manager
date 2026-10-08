/**
 * 时间格式化（utils/format）。
 *
 * 这些函数是纯逻辑，且最容易在时区上出错（历史教训：台账里存的是 UTC，
 * 展示端直接 slice 原文，东八区的"最近发布"看起来差 8 小时），
 * 所以即使属于渲染进程也要有单测。用例全部写成**时区无关**：
 * 不假设测试机在哪个时区，任何机器上结果都一样。
 */
import { describe, expect, it } from 'vitest'
import { formatDateTime, formatDuration, formatTime } from '@renderer/utils/format'

describe('时间格式化（utils/format）', () => {
  it('formatDateTime：空值 → "-"，解析失败 → 原样返回', () => {
    expect(formatDateTime(null)).toBe('-')
    expect(formatDateTime(undefined)).toBe('-')
    expect(formatDateTime('')).toBe('-')
    expect(formatDateTime('昨天下午')).toBe('昨天下午')
  })

  it('formatDateTime：UTC 串按本地时区渲染，还原出原来的墙上时间', () => {
    // 用本地 getter 造一个墙上时间，转成 UTC ISO 再格式化，必须原样还原。
    // 若实现错把 UTC 原文直接展示，这条在任何非 UTC 时区都会失败。
    const local = new Date(2026, 9, 2, 8, 5, 9) // 本地 2026-10-02 08:05:09
    expect(formatDateTime(local.toISOString())).toBe('2026-10-02 08:05:09')
  })

  it('formatDateTime：带偏移的串（对账补录场景）与等价 UTC 串渲染一致', () => {
    // 两个串指向**同一时刻**，所以无论测试机在哪个时区都必须格式化成同一个结果
    expect(formatDateTime('2026-09-10T12:00:00+08:00')).toBe(
      formatDateTime('2026-09-10T04:00:00Z')
    )
  })

  it('formatTime：仍是 HH:mm:ss（任务日志用，不带日期）', () => {
    const local = new Date(2026, 9, 2, 8, 5, 9)
    expect(formatTime(local.toISOString())).toBe('08:05:09')
  })

  it('formatDuration：先取整秒再拆分钟，不会出现"1 分 60 秒"（P2-20）', () => {
    const start = new Date(2026, 9, 2, 8, 0, 0).toISOString()
    // 119.6 秒：旧实现 round(59.6)=60 → 打出 "1 分 60 秒"
    expect(formatDuration(start, new Date(2026, 9, 2, 8, 1, 59, 600).toISOString())).toBe(
      '2 分 00 秒'
    )
    // 62.4 秒 → 1 分 02 秒
    expect(formatDuration(start, new Date(2026, 9, 2, 8, 1, 2, 400).toISOString())).toBe(
      '1 分 02 秒'
    )
  })
})
