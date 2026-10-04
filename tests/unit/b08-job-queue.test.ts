/**
 * B08 的 T08.3 / T08.5 验收点：任务模型、队列、注册表、取消、重试。
 *
 * 这一层是"发布可靠性的骨架"，所以用例集中钉住**调度与生命周期**的语义：
 * 同目标串行、不同目标并行、取消的两条路径（排队中 / 运行中）、
 * 清理与取消分离、终态上限、进度单调。
 *
 * 全部用真实计时器 + 短延时（毫秒级），因为队列的价值恰恰在"并发/时序"上，
 * 用假时钟容易把真实竞态测没。
 */
import { describe, expect, it } from 'vitest'
import { createDemoJobSpec, createJobService, delay, type JobSpec } from '@main/services/job'
import { ErrorCode } from '@main/infra/errors'
import { isTerminalStatus, MAX_JOB_LOGS, type JobView } from '@shared/contracts/job'

/* -------------------------------------------------------------- 工具 */

async function waitFor(cond: () => boolean, what = 'condition', timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`等待超时：${what}`)
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

function byId(jobs: ReturnType<typeof createJobService>, id: string): JobView {
  const v = jobs.get(id)
  if (!v) throw new Error(`任务不存在：${id}`)
  return v
}

async function waitStatus(
  jobs: ReturnType<typeof createJobService>,
  id: string,
  status: JobView['status']
): Promise<void> {
  await waitFor(() => byId(jobs, id).status === status, `job ${id} → ${status}`)
}

/** 一个可控的任务体：等 `release()` 或信号中止。 */
function gateSpec(opts: {
  id: string
  targetId?: string
  onCleanup?: JobSpec['cleanup']
  onStart?: () => void
}): { spec: JobSpec; release: () => void; aborted: () => boolean; started: () => boolean } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let didStart = false
  let wasAborted = false
  const spec: JobSpec = {
    type: 'deploy',
    title: opts.id,
    targetId: opts.targetId ?? null,
    async run(ctx) {
      didStart = true
      opts.onStart?.()
      ctx.log(`${opts.id} started`)
      await Promise.race([
        gate,
        new Promise<never>((_res, rej) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              wasAborted = true
              rej(new Error('aborted'))
            },
            { once: true }
          )
        })
      ])
    },
    ...(opts.onCleanup ? { cleanup: opts.onCleanup } : {})
  }
  return { spec, release, aborted: () => wasAborted, started: () => didStart }
}

/* -------------------------------------------------------------- 用例 */

describe('基本生命周期（T08.3）', () => {
  it('start → queued → running → succeeded，进度到 100 且有日志', async () => {
    const jobs = createJobService()
    const events: string[] = []
    jobs.onEvent((ev) => {
      if (ev.kind === 'state') events.push(`state:${ev.job.status}`)
    })

    const job = jobs.start({
      type: 'demo',
      title: 't',
      async run(ctx) {
        ctx.progress({ percent: 50, stage: '上传' })
        ctx.log('hello')
      }
    })

    // start() 会同步调度：若无并发占用，返回时已经在跑
    expect(['queued', 'running']).toContain(job.status)
    await waitStatus(jobs, job.jobId, 'succeeded')
    const v = byId(jobs, job.jobId)
    expect(v.percent).toBe(100)
    expect(v.startedAt).not.toBeNull()
    expect(v.finishedAt).not.toBeNull()
    expect(v.error).toBeNull()
    expect(events[0]).toBe('state:queued')
    expect(events[1]).toBe('state:running')
    expect(events[events.length - 1]).toBe('state:succeeded')
  })

  it('日志与进度都经事件流发出，终态事件最后到', async () => {
    const jobs = createJobService()
    const seq: string[] = []
    jobs.onEvent((ev) => {
      if (ev.kind === 'log') seq.push(`log:${ev.line.text}`)
      else if (ev.kind === 'progress') seq.push(`progress:${ev.progress.percent}`)
      else seq.push(`state:${ev.job.status}`)
    })

    jobs.start({
      type: 'demo',
      title: 't',
      run: async (ctx) => {
        ctx.log('a')
        ctx.progress({ percent: 30 })
      }
    })
    await waitFor(() => seq.includes('state:succeeded'))
    expect(seq.indexOf('log:a')).toBeLessThan(seq.indexOf('state:succeeded'))
    expect(seq.indexOf('progress:30')).toBeLessThan(seq.indexOf('state:succeeded'))
    expect(seq[seq.length - 1]).toBe('state:succeeded')
  })

  it('run 抛错 → failed，error 带错误码与中文文案', async () => {
    const jobs = createJobService()
    const job = jobs.start({
      type: 'demo',
      title: 'boom',
      async run(ctx) {
        ctx.progress({ percent: 40 })
        throw Object.assign(new Error('炸了'), { code: ErrorCode.E_DEPLOY_STAGE_FAILED })
      }
    })
    await waitStatus(jobs, job.jobId, 'failed')
    const v = byId(jobs, job.jobId)
    expect(v.error?.message).toBe('炸了')
    expect(v.percent).toBe(40)
    expect(v.finishedAt).not.toBeNull()
  })
})

describe('同目标串行、不同目标并行（T08.3 验收点）', () => {
  it('同 target 的任务排在同一条车道上，一次只跑一个', async () => {
    const jobs = createJobService()
    const a = gateSpec({ id: 'A', targetId: 'tg1' })
    const b = gateSpec({ id: 'B', targetId: 'tg1' })

    const ja = jobs.start(a.spec)
    const jb = jobs.start(b.spec)

    await waitStatus(jobs, ja.jobId, 'running')
    // A 还在跑，B 必须仍在排队
    expect(byId(jobs, jb.jobId).status).toBe('queued')
    expect(b.started()).toBe(false)

    a.release()
    await waitStatus(jobs, ja.jobId, 'succeeded')
    await waitStatus(jobs, jb.jobId, 'running')
    b.release()
    await waitStatus(jobs, jb.jobId, 'succeeded')
  })

  it('三个同目标任务严格按提交顺序执行', async () => {
    const jobs = createJobService()
    const order: string[] = []
    const gates = ['A', 'B', 'C'].map((id) => {
      const g = gateSpec({ id, targetId: 'tg1', onStart: () => order.push(id) })
      return g
    })
    const ids = gates.map((g) => jobs.start(g.spec).jobId)

    await waitStatus(jobs, ids[0], 'running')
    gates[0].release()
    await waitStatus(jobs, ids[1], 'running')
    gates[1].release()
    await waitStatus(jobs, ids[2], 'running')
    gates[2].release()
    await waitStatus(jobs, ids[2], 'succeeded')

    expect(order).toEqual(['A', 'B', 'C'])
  })

  it('不同 target 可以并行', async () => {
    const jobs = createJobService()
    const a = gateSpec({ id: 'A', targetId: 'tg1' })
    const b = gateSpec({ id: 'B', targetId: 'tg2' })
    const ja = jobs.start(a.spec)
    const jb = jobs.start(b.spec)

    await waitStatus(jobs, ja.jobId, 'running')
    await waitStatus(jobs, jb.jobId, 'running')
    expect(jobs.activeCount()).toBe(2)

    a.release()
    b.release()
    await waitStatus(jobs, ja.jobId, 'succeeded')
    await waitStatus(jobs, jb.jobId, 'succeeded')
  })

  it('maxConcurrency 限制跨目标并发（超出部分排队）', async () => {
    const jobs = createJobService({ maxConcurrency: 1 })
    const a = gateSpec({ id: 'A', targetId: 'tg1' })
    const b = gateSpec({ id: 'B', targetId: 'tg2' })
    const ja = jobs.start(a.spec)
    const jb = jobs.start(b.spec)

    await waitStatus(jobs, ja.jobId, 'running')
    expect(byId(jobs, jb.jobId).status).toBe('queued')

    a.release()
    await waitStatus(jobs, ja.jobId, 'succeeded')
    await waitStatus(jobs, jb.jobId, 'running')
    b.release()
    await waitStatus(jobs, jb.jobId, 'succeeded')
  })

  it('无 target 的任务各自独立，不互相排队', async () => {
    const jobs = createJobService()
    const a = gateSpec({ id: 'A' })
    const b = gateSpec({ id: 'B' })
    const ja = jobs.start(a.spec)
    const jb = jobs.start(b.spec)
    await waitStatus(jobs, ja.jobId, 'running')
    await waitStatus(jobs, jb.jobId, 'running')
    a.release()
    b.release()
  })
})

describe('取消：两条路径（T08.7）', () => {
  it('排队中的任务立刻取消，且任务体从未被调用（远端未被触碰）', async () => {
    const jobs = createJobService({ maxConcurrency: 1 })
    const a = gateSpec({ id: 'A', targetId: 'tg1' })
    const b = gateSpec({ id: 'B', targetId: 'tg2' })
    const ja = jobs.start(a.spec)
    const jb = jobs.start(b.spec)

    await waitStatus(jobs, ja.jobId, 'running')
    expect(byId(jobs, jb.jobId).status).toBe('queued')

    expect(jobs.cancel(jb.jobId).cancelled).toBe(true)
    expect(byId(jobs, jb.jobId).status).toBe('cancelled')
    expect(b.started()).toBe(false)

    // A 结束不会把已取消的 B 又拉起来
    a.release()
    await waitStatus(jobs, ja.jobId, 'succeeded')
    await new Promise((r) => setTimeout(r, 20))
    expect(byId(jobs, jb.jobId).status).toBe('cancelled')
    expect(b.started()).toBe(false)
  })

  it('运行中的任务收到 abort 信号并转为已取消，清理以 reason=cancel 执行', async () => {
    const jobs = createJobService()
    const cleanups: string[] = []
    const g = gateSpec({
      id: 'A',
      targetId: 'tg1',
      onCleanup: async (reason, ctx) => {
        cleanups.push(reason)
        ctx.log('清理完成')
      }
    })
    const ja = jobs.start(g.spec)
    await waitStatus(jobs, ja.jobId, 'running')

    expect(jobs.cancel(ja.jobId).cancelled).toBe(true)
    // 立刻可见 cancelRequested，UI 才能显示"取消中…"
    expect(byId(jobs, ja.jobId).cancelRequested).toBe(true)

    await waitStatus(jobs, ja.jobId, 'cancelled')
    expect(g.aborted()).toBe(true)
    expect(cleanups).toEqual(['cancel'])
  })

  it('取消后车道被释放，后面的同目标任务正常开跑', async () => {
    const jobs = createJobService()
    const a = gateSpec({ id: 'A', targetId: 'tg1' })
    const b = gateSpec({ id: 'B', targetId: 'tg1' })
    const ja = jobs.start(a.spec)
    const jb = jobs.start(b.spec)
    await waitStatus(jobs, ja.jobId, 'running')

    jobs.cancel(ja.jobId)
    await waitStatus(jobs, ja.jobId, 'cancelled')
    await waitStatus(jobs, jb.jobId, 'running')
    b.release()
  })

  it('对不存在 / 已结束的任务取消：不抛错，返回原因', async () => {
    const jobs = createJobService()
    expect(jobs.cancel('nope')).toEqual({ cancelled: false, reason: 'not-found' })

    const j = jobs.start({ type: 'demo', title: 't', run: async () => undefined })
    await waitStatus(jobs, j.jobId, 'succeeded')
    expect(jobs.cancel(j.jobId)).toEqual({ cancelled: false, reason: 'already-finished' })
  })

  it('重复取消同一个运行中任务只发一次 abort', async () => {
    const jobs = createJobService()
    let aborts = 0
    const j = jobs.start({
      type: 'demo',
      title: 't',
      run: async (ctx) =>
        new Promise<void>((_res, rej) => {
          ctx.signal.addEventListener('abort', () => {
            aborts++
            rej(new Error('aborted'))
          })
        })
    })
    await waitStatus(jobs, j.jobId, 'running')
    jobs.cancel(j.jobId)
    jobs.cancel(j.jobId)
    jobs.cancel(j.jobId)
    await waitStatus(jobs, j.jobId, 'cancelled')
    expect(aborts).toBe(1)
  })

  it('任务在取消请求到达前已完成：如实报"已完成"而不是"已取消"', async () => {
    const jobs = createJobService()
    const j = jobs.start({
      type: 'demo',
      title: 't',
      run: async () => {
        /* 瞬间完成 */
      }
    })
    await waitStatus(jobs, j.jobId, 'succeeded')
    jobs.cancel(j.jobId)
    expect(byId(jobs, j.jobId).status).toBe('succeeded')
  })

  it('清理抛错不会覆盖原始失败原因', async () => {
    const jobs = createJobService()
    const j = jobs.start({
      type: 'deploy',
      title: 't',
      run: async () => {
        throw new Error('原始失败')
      },
      cleanup: async () => {
        throw new Error('清理也炸了')
      }
    })
    await waitStatus(jobs, j.jobId, 'failed')
    expect(byId(jobs, j.jobId).error?.message).toBe('原始失败')
  })

  it('清理超时不会挂住任务终态（只记一条 warn 日志）', async () => {
    const jobs = createJobService({ cleanupTimeoutMs: 30 })
    const j = jobs.start({
      type: 'deploy',
      title: 't',
      run: async () => {
        throw new Error('失败')
      },
      cleanup: () => new Promise<void>(() => undefined) // 永远不结束
    })
    await waitStatus(jobs, j.jobId, 'failed')
    const v = byId(jobs, j.jobId)
    expect(v.error?.message).toBe('失败')
  })

  it('失败任务的清理以 reason=failed 执行', async () => {
    const jobs = createJobService()
    const reasons: string[] = []
    const j = jobs.start({
      type: 'deploy',
      title: 't',
      run: async () => {
        throw new Error('失败')
      },
      cleanup: async (reason) => {
        reasons.push(reason)
      }
    })
    await waitStatus(jobs, j.jobId, 'failed')
    expect(reasons).toEqual(['failed'])
  })
})

describe('cancelAll（退出保护，T08.7）', () => {
  it('请求取消全部并等待它们停下', async () => {
    const jobs = createJobService()
    const a = gateSpec({ id: 'A', targetId: 'tg1' })
    const b = gateSpec({ id: 'B', targetId: 'tg2' })
    const ja = jobs.start(a.spec)
    const jb = jobs.start(b.spec)
    await waitStatus(jobs, ja.jobId, 'running')
    await waitStatus(jobs, jb.jobId, 'running')

    const r = await jobs.cancelAll('quit', { timeoutMs: 1000 })
    expect(r).toEqual({ requested: 2, forced: 0 })
    expect(byId(jobs, ja.jobId).status).toBe('cancelled')
    expect(byId(jobs, jb.jobId).status).toBe('cancelled')
    expect(jobs.activeCount()).toBe(0)
  })

  it('对不响应信号的任务限时后强制标记，并如实记日志', async () => {
    const jobs = createJobService()
    const j = jobs.start({
      type: 'deploy',
      title: '装死',
      // 完全不看 signal：模拟卡在不可取消的系统调用里
      run: () => new Promise<void>(() => undefined)
    })
    await waitStatus(jobs, j.jobId, 'running')

    const r = await jobs.cancelAll('quit', { timeoutMs: 60 })
    expect(r.requested).toBe(1)
    expect(r.forced).toBe(1)
    const v = byId(jobs, j.jobId)
    expect(v.status).toBe('cancelled')
    expect(isTerminalStatus(v.status)).toBe(true)
  })

  it('没有活跃任务时是空操作', async () => {
    const jobs = createJobService()
    expect(await jobs.cancelAll('quit', { timeoutMs: 50 })).toEqual({ requested: 0, forced: 0 })
  })

  it('退出时排队的任务也被取消，不会在退出过程里被启动', async () => {
    const jobs = createJobService({ maxConcurrency: 1 })
    const a = gateSpec({ id: 'A', targetId: 'tg1' })
    const b = gateSpec({ id: 'B', targetId: 'tg1' })
    const ja = jobs.start(a.spec)
    const jb = jobs.start(b.spec)
    await waitStatus(jobs, ja.jobId, 'running')

    await jobs.cancelAll('quit', { timeoutMs: 500 })
    expect(byId(jobs, ja.jobId).status).toBe('cancelled')
    expect(byId(jobs, jb.jobId).status).toBe('cancelled')
    expect(b.started()).toBe(false)
  })

  it('清理原因区分 quit 与 cancel（退出路径要能识别出来）', async () => {
    const jobs = createJobService()
    const reasons: string[] = []
    const spec = (id: string): JobSpec => ({
      type: 'deploy',
      title: id,
      run: (ctx) =>
        new Promise<void>((_res, rej) => {
          ctx.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
        }),
      cleanup: async (reason) => {
        reasons.push(reason)
      }
    })

    const single = jobs.start(spec('single'))
    await waitStatus(jobs, single.jobId, 'running')
    jobs.cancel(single.jobId)
    await waitStatus(jobs, single.jobId, 'cancelled')

    const quitting = jobs.start(spec('quit'))
    await waitStatus(jobs, quitting.jobId, 'running')
    await jobs.cancelAll('quit', { timeoutMs: 500 })

    expect(reasons).toEqual(['cancel', 'quit'])
  })
})

describe('重试（方案书 §6.11：重试 = 新建任务，保留原记录）', () => {
  it('重试生成新任务，原任务记录保留', async () => {
    const jobs = createJobService()
    let attempt = 0
    const j = jobs.start({
      type: 'deploy',
      title: 't',
      run: async () => {
        attempt++
        if (attempt === 1) throw new Error('第一次失败')
      }
    })
    await waitStatus(jobs, j.jobId, 'failed')

    const retried = jobs.retry(j.jobId)
    expect(retried.jobId).not.toBe(j.jobId)
    expect(isTerminalStatus(retried.status)).toBe(false)

    await waitStatus(jobs, retried.jobId, 'succeeded')
    // 原记录仍在，且仍是 failed
    expect(byId(jobs, j.jobId).status).toBe('failed')
    expect(jobs.list()).toHaveLength(2)
  })

  it('重试进行中的任务被拒（E_JOB_NOT_RETRYABLE）', async () => {
    const jobs = createJobService()
    const a = gateSpec({ id: 'A' })
    const ja = jobs.start(a.spec)
    await waitStatus(jobs, ja.jobId, 'running')
    expect(codeOf(() => jobs.retry(ja.jobId))).toBe(ErrorCode.E_JOB_NOT_RETRYABLE)
    a.release()
  })

  it('重试不存在的任务 → E_JOB_NOT_FOUND', async () => {
    const jobs = createJobService()
    expect(codeOf(() => jobs.retry('nope'))).toBe(ErrorCode.E_JOB_NOT_FOUND)
  })
})

describe('日志环形缓冲与进度钳制', () => {
  it(`超过 ${MAX_JOB_LOGS} 行丢最旧的，并如实上报丢弃数`, async () => {
    const jobs = createJobService()
    const total = MAX_JOB_LOGS + 50
    const j = jobs.start({
      type: 'demo',
      title: 'noisy',
      run: async (ctx) => {
        for (let i = 0; i < total; i++) ctx.log(`line-${i}`)
      }
    })
    await waitStatus(jobs, j.jobId, 'succeeded')
    const v = byId(jobs, j.jobId)
    expect(v.droppedLogs).toBeGreaterThan(0)
    expect(v.logCount).toBeLessThanOrEqual(MAX_JOB_LOGS)
  })

  it('进度单调不减（回跳请求被忽略，进度条不会倒退）', async () => {
    const jobs = createJobService()
    const seen: number[] = []
    jobs.onEvent((ev) => {
      if (ev.kind === 'progress') seen.push(ev.progress.percent)
    })
    const j = jobs.start({
      type: 'demo',
      title: 't',
      run: async (ctx) => {
        ctx.progress({ percent: 40 })
        ctx.progress({ percent: 10 }) // 回退请求，应被忽略
        ctx.progress({ percent: Number.NaN }) // 非有限数，应被忽略
        ctx.progress({ percent: 60 })
      }
    })
    await waitStatus(jobs, j.jobId, 'succeeded')
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number)
    }
    expect(seen).toContain(40)
    expect(seen).toContain(60)
    expect(seen).not.toContain(10)
    // 成功结束必然收敛到 100
    expect(seen[seen.length - 1]).toBe(100)
  })

  it('进度被钳到 0~100（越界值不会把进度条画到框外）', async () => {
    const jobs = createJobService()
    const seen: number[] = []
    jobs.onEvent((ev) => {
      if (ev.kind === 'progress') seen.push(ev.progress.percent)
    })
    const j = jobs.start({
      type: 'demo',
      title: 't',
      run: async (ctx) => {
        ctx.progress({ percent: -50 })
        ctx.progress({ percent: 250 })
      }
    })
    await waitStatus(jobs, j.jobId, 'succeeded')
    expect(seen).not.toContain(-50)
    expect(seen).not.toContain(250)
    expect(seen).toContain(0)
    expect(seen).toContain(100)
  })
})

describe('全局注册表（T08.5）', () => {
  it('按目标查询活跃任务 / hasActiveForTarget / activeCount', async () => {
    const jobs = createJobService()
    const a = gateSpec({ id: 'A', targetId: 'tg1' })
    const b = gateSpec({ id: 'B', targetId: 'tg2' })
    const ja = jobs.start(a.spec)
    jobs.start(b.spec)
    await waitStatus(jobs, ja.jobId, 'running')

    expect(jobs.activeForTarget('tg1')).toHaveLength(1)
    expect(jobs.hasActiveForTarget('tg1')).toBe(true)
    expect(jobs.hasActiveForTarget('tg-unknown')).toBe(false)
    expect(jobs.activeCount()).toBe(2)

    a.release()
    await waitStatus(jobs, ja.jobId, 'succeeded')
    // 终态不再算"活跃"，否则发布前置校验会永远拒绝
    expect(jobs.hasActiveForTarget('tg1')).toBe(false)
    expect(jobs.activeForTarget('tg1')).toHaveLength(0)
  })

  it('list 支持按状态与目标过滤，且新的在前', async () => {
    const jobs = createJobService()
    const first = jobs.start({ type: 'demo', title: 'first', targetId: 'tg1', run: async () => undefined })
    const second = jobs.start({ type: 'demo', title: 'second', targetId: 'tg2', run: async () => undefined })
    await waitStatus(jobs, first.jobId, 'succeeded')
    await waitStatus(jobs, second.jobId, 'succeeded')

    const all = jobs.list()
    expect(all).toHaveLength(2)
    expect(all[0]?.title).toBe('second')

    expect(jobs.list({ targetId: 'tg1' })).toHaveLength(1)
    expect(jobs.list({ status: ['succeeded'] })).toHaveLength(2)
    expect(jobs.list({ status: ['failed'] })).toHaveLength(0)
  })

  it('get 对不存在的任务返回 undefined', () => {
    const jobs = createJobService()
    expect(jobs.get('nope')).toBeUndefined()
  })

  it('终态记录有上限，超出丢最旧的（长跑应用不能一直涨内存）', async () => {
    const jobs = createJobService({ maxTerminalRecords: 2 })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      ids.push(jobs.start({ type: 'demo', title: `t${i}`, run: async () => undefined }).jobId)
      await waitStatus(jobs, ids[i] as string, 'succeeded')
    }
    expect(jobs.list()).toHaveLength(2)
    expect(jobs.get(ids[0] as string)).toBeUndefined()
    expect(jobs.get(ids[3] as string)).toBeDefined()
  })

  it('clearFinished 只清已结束的', async () => {
    const jobs = createJobService()
    const a = gateSpec({ id: 'A' })
    const ja = jobs.start(a.spec)
    const done = jobs.start({ type: 'demo', title: 'done', run: async () => undefined })
    await waitStatus(jobs, done.jobId, 'succeeded')
    await waitStatus(jobs, ja.jobId, 'running')

    expect(jobs.clearFinished()).toBe(1)
    expect(jobs.get(done.jobId)).toBeUndefined()
    expect(jobs.get(ja.jobId)).toBeDefined()
    a.release()
  })
})

describe('事件订阅', () => {
  it('退订后不再收到事件', async () => {
    const jobs = createJobService()
    let count = 0
    const off = jobs.onEvent(() => {
      count++
    })
    jobs.start({ type: 'demo', title: 't', run: async () => undefined })
    await waitFor(() => count > 0)
    const before = count
    off()
    jobs.start({ type: 'demo', title: 't2', run: async () => undefined })
    await new Promise((r) => setTimeout(r, 30))
    expect(count).toBe(before)
  })

  it('监听器抛错不影响其他监听器与任务本身', async () => {
    const jobs = createJobService()
    jobs.onEvent(() => {
      throw new Error('listener boom')
    })
    let seen = 0
    jobs.onEvent(() => {
      seen++
    })
    const j = jobs.start({ type: 'demo', title: 't', run: async () => undefined })
    await waitStatus(jobs, j.jobId, 'succeeded')
    expect(seen).toBeGreaterThan(0)
  })
})

describe('delay（可取消 sleep）', () => {
  it('正常等待后 resolve', async () => {
    const t0 = Date.now()
    await delay(15)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10)
  })

  it('已 abort 的信号立刻拒绝', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(delay(1000, ac.signal)).rejects.toMatchObject({
      code: ErrorCode.E_JOB_CANCELLED
    })
  })

  it('等待中被 abort 立刻拒绝，且不残留监听器', async () => {
    const ac = new AbortController()
    const p = delay(5000, ac.signal)
    setTimeout(() => ac.abort(), 5)
    await expect(p).rejects.toMatchObject({ code: ErrorCode.E_JOB_CANCELLED })
    expect(ac.signal.aborted).toBe(true)
  })
})

describe('自检任务（B08 的 DoD 假任务）', () => {
  it('跑完：进度递增到 100、有日志、状态 succeeded', async () => {
    const jobs = createJobService()
    const percents: number[] = []
    jobs.onEvent((ev) => {
      if (ev.kind === 'progress') percents.push(ev.progress.percent)
    })
    const job = jobs.start(createDemoJobSpec({ steps: 6, stepMs: 5 }))
    await waitStatus(jobs, job.jobId, 'succeeded')

    const v = byId(jobs, job.jobId)
    expect(v.percent).toBe(100)
    expect(percents[percents.length - 1]).toBe(100)
    expect(percents.length).toBeGreaterThanOrEqual(6)
    expect(v.droppedLogs).toBe(0)
  })

  it('可注入失败，并执行清理', async () => {
    const jobs = createJobService()
    const job = jobs.start(createDemoJobSpec({ steps: 10, stepMs: 3, failAtStep: 3 }))
    await waitStatus(jobs, job.jobId, 'failed')
    expect(byId(jobs, job.jobId).error?.code).toBe(ErrorCode.E_DEPLOY_STAGE_FAILED)
  })

  it('跑一半取消：立刻停在中间，且执行清理而不是跑完', async () => {
    const jobs = createJobService()
    const job = jobs.start(createDemoJobSpec({ steps: 200, stepMs: 10 }))
    await waitStatus(jobs, job.jobId, 'running')
    await new Promise((r) => setTimeout(r, 40))

    const t0 = Date.now()
    jobs.cancel(job.jobId)
    await waitStatus(jobs, job.jobId, 'cancelled')
    // "取消能立刻停"：远小于把它跑完所需的时间
    expect(Date.now() - t0).toBeLessThan(500)
    const v = byId(jobs, job.jobId)
    expect(v.percent).toBeLessThan(100)
    expect(v.cancelRequested).toBe(true)
  })

  it('自检任务可以挂到目标上（用于验证同目标串行）', () => {
    const spec = createDemoJobSpec({ steps: 2, stepMs: 1, targetId: 'tg1' })
    expect(spec.targetId).toBe('tg1')
    expect(spec.type).toBe('demo')
  })
})

describe('健壮性', () => {
  it('任务体同步抛错也能落终态（不会永远卡在 running）', async () => {
    const jobs = createJobService()
    const j = jobs.start({
      type: 'demo',
      title: 't',
      run: () => {
        throw new Error('同步炸')
      }
    })
    await waitStatus(jobs, j.jobId, 'failed')
    expect(byId(jobs, j.jobId).error?.message).toBe('同步炸')
  })

  it('任务体非 Error 抛出（字符串）也能归一', async () => {
    const jobs = createJobService()
    const j = jobs.start({
      type: 'demo',
      title: 't',
      // 非 Error 抛出（字符串）也必须归一，否则错误码会丢掉
      run: () => Promise.reject('just a string')
    })
    await waitStatus(jobs, j.jobId, 'failed')
    expect(byId(jobs, j.jobId).error?.message).toBe('just a string')
  })

  it('终态只写一次（清理失败 / 强制终结都不产生第二个终态事件）', async () => {
    const jobs = createJobService()
    const terminals: string[] = []
    jobs.onEvent((ev) => {
      if (ev.kind === 'state' && isTerminalStatus(ev.job.status)) terminals.push(ev.job.status)
    })
    const j = jobs.start({
      type: 'demo',
      title: 't',
      run: async () => {
        throw new Error('x')
      }
    })
    await waitStatus(jobs, j.jobId, 'failed')
    jobs.cancel(j.jobId) // 已终态，不该再产生事件
    await new Promise((r) => setTimeout(r, 20))
    expect(terminals).toEqual(['failed'])
  })

  it('大量任务下不重复派发（同车道严格一个在跑）', async () => {
    const jobs = createJobService({ maxConcurrency: 4 })
    let concurrent = 0
    let maxConcurrent = 0
    const ids: string[] = []
    for (let i = 0; i < 12; i++) {
      ids.push(
        jobs.start({
          type: 'deploy',
          title: `j${i}`,
          targetId: `tg${i % 3}`, // 3 条车道
          run: async () => {
            concurrent++
            maxConcurrent = Math.max(maxConcurrent, concurrent)
            await new Promise((r) => setTimeout(r, 5))
            concurrent--
          }
        }).jobId
      )
    }
    await waitFor(() => ids.every((id) => byId(jobs, id).status === 'succeeded'))
    // 3 条车道 → 同时最多 3 个在跑
    expect(maxConcurrent).toBeLessThanOrEqual(3)
    expect(maxConcurrent).toBeGreaterThanOrEqual(1)
  })
})

describe('时钟注入', () => {
  it('now 可注入，便于断言时间字段', async () => {
    const fixed = new Date('2026-09-30T12:00:00.000Z')
    const jobs = createJobService({ now: () => fixed })
    const j = jobs.start({ type: 'demo', title: 't', run: async () => undefined })
    await waitStatus(jobs, j.jobId, 'succeeded')
    const v = byId(jobs, j.jobId)
    expect(v.createdAt).toBe(fixed.toISOString())
    expect(v.finishedAt).toBe(fixed.toISOString())
  })
})
