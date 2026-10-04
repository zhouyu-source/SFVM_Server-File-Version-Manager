/**
 * B08 的 T08.4 验收点：节流**不丢最后一条**、**不延迟第一条**。
 *
 * 这两个性质各自对应一类真实故障，所以用例按它们组织：
 * - 丢尾巴 → 进度条永远停在 97%，用户以为卡死
 * - 只做尾边沿 → 点完按钮 200ms 内"没反应"
 *
 * 用假时钟跑，避免用例真的等 200ms（20 个用例就是 4 秒）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createThrottledFlush } from '@main/infra/throttle'

afterEach(() => {
  vi.useRealTimers()
})

/** 进度式节流：合并语义 = 取最新。 */
function makeLastWins(intervalMs = 200): { push: (v: number) => void; got: number[] } {
  const got: number[] = []
  const t = createThrottledFlush<number, number>({
    intervalMs,
    reduce: (_acc, next) => next,
    onFlush: (v) => got.push(v)
  })
  return { push: (v) => t.push(v), got }
}

describe('createThrottledFlush（首边沿 + 尾边沿）', () => {
  it('第一条立即送出（不让用户等一个窗口）', () => {
    vi.useFakeTimers()
    const { push, got } = makeLastWins()
    push(1)
    expect(got).toEqual([1])
  })

  it('窗口内的多条合并成一条，并在窗口末送出', () => {
    vi.useFakeTimers()
    const { push, got } = makeLastWins()
    push(1)
    push(2)
    push(3)
    expect(got).toEqual([1])
    vi.advanceTimersByTime(199)
    expect(got).toEqual([1])
    vi.advanceTimersByTime(1)
    expect(got).toEqual([1, 3])
  })

  it('最后一条一定送到（这条挡的是"进度条卡在 97%"）', () => {
    vi.useFakeTimers()
    const { push, got } = makeLastWins()
    push(10)
    push(50)
    push(97)
    vi.advanceTimersByTime(200)
    expect(got).toEqual([10, 97])
    // 连按 500 次也只在窗口末补一条，不会丢
    for (let i = 0; i < 500; i++) push(98 + i / 1000)
    vi.advanceTimersByTime(200)
    expect(got[got.length - 1]).toBeCloseTo(98.499, 3)
    expect(got).toHaveLength(3)
  })

  it('持续推送时每窗口至多一次，且速率稳定', () => {
    vi.useFakeTimers()
    const { push, got } = makeLastWins()
    for (let t = 0; t < 1000; t += 10) {
      push(t)
      vi.advanceTimersByTime(10)
    }
    // 1 条首边沿 + 1000ms 内约 5 条（每 200ms 一条）
    expect(got.length).toBeGreaterThanOrEqual(5)
    expect(got.length).toBeLessThanOrEqual(7)
    expect(got[0]).toBe(0)
  })

  it('reduce 支持累积语义（日志批量推送不能丢行）', () => {
    vi.useFakeTimers()
    const batches: string[][] = []
    const t = createThrottledFlush<string, string[]>({
      intervalMs: 200,
      reduce: (acc, next) => {
        const arr = acc ?? []
        arr.push(next)
        return arr
      },
      onFlush: (lines) => batches.push([...lines])
    })
    t.push('a')
    t.push('b')
    t.push('c')
    vi.advanceTimersByTime(200)
    t.push('d')
    vi.advanceTimersByTime(200)
    expect(batches).toEqual([['a'], ['b', 'c'], ['d']])
  })

  it('flushNow 立刻送出挂起值，并重置窗口（下一次 push 又是首边沿）', () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const th = createThrottledFlush<number, number>({
      intervalMs: 200,
      reduce: (_a, n) => n,
      onFlush: (v) => seen.push(v)
    })
    th.push(10)
    th.push(20)
    expect(seen).toEqual([10]) // 20 还在窗口里攒着
    expect(th.hasPending()).toBe(true)

    th.flushNow()
    expect(seen).toEqual([10, 20])
    expect(th.hasPending()).toBe(false)

    // 窗口已被重置：下一条立即送出，而不是等 200ms
    th.push(30)
    expect(seen).toEqual([10, 20, 30])
  })

  it('没有挂起值时 flushNow 不产生空事件', () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const th = createThrottledFlush<number, number>({
      intervalMs: 200,
      reduce: (_a, n) => n,
      onFlush: (v) => seen.push(v)
    })
    th.flushNow()
    th.flushNow()
    expect(seen).toEqual([])
    th.push(1)
    th.flushNow()
    expect(seen).toEqual([1])
  })

  it('intervalMs = 0 时退化为直通', () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const th = createThrottledFlush<number, number>({
      intervalMs: 0,
      reduce: (_a, n) => n,
      onFlush: (v) => seen.push(v)
    })
    th.push(1)
    th.push(2)
    th.push(3)
    expect(seen).toEqual([1, 2, 3])
    expect(th.hasPending()).toBe(false)
  })

  it('dispose 后不再有尾巴事件（应用退出时不留异步尾巴）', () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const th = createThrottledFlush<number, number>({
      intervalMs: 200,
      reduce: (_a, n) => n,
      onFlush: (v) => seen.push(v)
    })
    th.push(1)
    th.push(2)
    th.dispose()
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([1])
  })

  it('hasPending 反映"有未送出的值"', () => {
    vi.useFakeTimers()
    const th = createThrottledFlush<number, number>({
      intervalMs: 200,
      reduce: (_a, n) => n,
      onFlush: () => undefined
    })
    expect(th.hasPending()).toBe(false)
    th.push(1)
    expect(th.hasPending()).toBe(false) // 首边沿已送出
    th.push(2)
    expect(th.hasPending()).toBe(true)
    vi.advanceTimersByTime(200)
    expect(th.hasPending()).toBe(false)
  })
})
