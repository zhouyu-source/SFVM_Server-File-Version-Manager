/**
 * B08 的 T08.4 / T08.5 / T08.7 接线验收点：事件推送、IPC 通道、退出保护。
 *
 * 这三块的共同风险是"**看起来接上了，其实没接**"：
 * handler 注册了但形状不对、事件推了但没节流、退出守护挂在了不会触发的事件上。
 * 所以这里直接调用真实的 handler 与真实的事件发射，不 mock 自己的代码。
 *
 * electron 由 tests/stubs/electron.ts 替身（见 vitest.config.ts 的 alias），
 * 其中 ipcMain 会记录 handler、app 会记录监听器，因此都可断言。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  __emitApp,
  __appListenerCount,
  __invokeIpc,
  __registeredIpc,
  __resetAppListeners,
  __resetIpcHandlers,
  app as electronApp,
  dialog as electronDialog
} from '../stubs/electron'
import type { IpcResult } from '@shared/ipc'
import { IPC_CHANNELS } from '@shared/channels'
import {
  DEMO_JOB_DEFAULTS,
  MAX_JOB_LOGS,
  describeJobStatus,
  isTerminalStatus,
  jobDemoInputSchema,
  jobListFilterSchema,
  jobProgressSchema,
  jobStatusTagType,
  jobViewSchema,
  resolveDemoOptions,
  type JobLogBatch,
  type JobProgress,
  type JobView
} from '@shared/contracts/job'
import { createJobService, type JobService } from '@main/services/job'
import { attachJobEventPush, createJobGuard, registerJobHandlers } from '@main/ipc/job'
import { unregisterAllHandlers } from '@main/infra/ipc'

/* ------------------------------------------------------------ 工具 */

type Push = { channel: string; payload: unknown }

function recorder(): { push: (c: string, p: unknown) => void; events: Push[] } {
  const events: Push[] = []
  return { events, push: (channel, payload) => events.push({ channel, payload }) }
}

function progressOf(events: Push[]): JobProgress[] {
  return events
    .filter((e) => e.channel === IPC_CHANNELS.EVT_JOB_PROGRESS)
    .map((e) => e.payload as JobProgress)
}

function statesOf(events: Push[]): JobView[] {
  return events
    .filter((e) => e.channel === IPC_CHANNELS.EVT_JOB_STATE)
    .map((e) => e.payload as JobView)
}

function logsOf(events: Push[]): JobLogBatch[] {
  return events
    .filter((e) => e.channel === IPC_CHANNELS.EVT_JOB_LOG)
    .map((e) => e.payload as JobLogBatch)
}

/** 让仅靠 microtask 完成的任务跑完（用假时钟时不能用 setTimeout 轮询）。 */
async function flushMicrotasks(times = 40): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

async function waitFor(cond: () => boolean, what = 'condition', timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`等待超时：${what}`)
}

function unwrap<T>(r: unknown): T {
  const env = r as IpcResult<T>
  if (!env.ok) throw new Error(`IPC 失败：${env.code} ${env.message}`)
  return env.data
}

async function callFail(channel: string, arg?: unknown): Promise<{ code: string }> {
  const env = (await __invokeIpc(channel, arg)) as IpcResult<unknown>
  expect(env.ok).toBe(false)
  return { code: (env as { code: string }).code }
}

function fakeWindow(): {
  win: Electron.BrowserWindow
  fireClose: () => boolean
} {
  const handlers = new Map<string, (e: { preventDefault: () => void }) => void>()
  const win = {
    on: (ev: string, fn: (e: { preventDefault: () => void }) => void): void => {
      handlers.set(ev, fn)
    },
    isDestroyed: (): boolean => false
  } as unknown as Electron.BrowserWindow

  return {
    win,
    // 返回"是否被 preventDefault"（即是否拦下了关闭）
    fireClose: (): boolean => {
      let prevented = false
      handlers.get('close')?.({ preventDefault: () => (prevented = true) })
      return prevented
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/* -------------------------------------------------------------- 契约 */

describe('任务契约（Zod）', () => {
  it('自检任务入参全部可选，默认值由 resolveDemoOptions 补全', () => {
    // 不用 z.default()：带 default 的 schema 输入/输出类型不同，
    // 与 registerHandler 的"同一类型"要求冲突（详见 contracts 注释）
    expect(jobDemoInputSchema.parse(undefined)).toBeUndefined()
    expect(jobDemoInputSchema.parse({ steps: 5 })).toEqual({ steps: 5 })

    expect(DEMO_JOB_DEFAULTS).toEqual({ steps: 20, stepMs: 150 })
    expect(resolveDemoOptions(undefined)).toEqual({ steps: 20, stepMs: 150 })
    expect(resolveDemoOptions({ steps: 5, title: 'x' })).toEqual({
      steps: 5,
      stepMs: 150,
      title: 'x'
    })
  })

  it('自检任务入参拒绝越界值（防止 UI 传个步数把队列占死）', () => {
    for (const bad of [
      { steps: 0 },
      { steps: 201 },
      { steps: 1.5 },
      { stepMs: 0 },
      { stepMs: 100000 },
      { failAtStep: 0 },
      { targetId: '' }
    ]) {
      expect(jobDemoInputSchema.safeParse(bad).success, `应拒绝 ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('列表过滤参数是可选的（不传即全部）', () => {
    expect(jobListFilterSchema.parse(undefined)).toBeUndefined()
    expect(jobListFilterSchema.parse({ status: ['running'] })).toEqual({ status: ['running'] })
    expect(jobListFilterSchema.safeParse({ status: ['bogus'] }).success).toBe(false)
  })

  it('进度与任务视图的形状被校验', () => {
    const ok = jobProgressSchema.safeParse({
      jobId: 'j1',
      status: 'running',
      percent: 42,
      cancelRequested: false,
      at: '2026-09-30T00:00:00.000Z'
    })
    expect(ok.success).toBe(true)
    // percent 越界必须被拒（否则 UI 的进度条会画到框外）
    expect(
      jobProgressSchema.safeParse({
        jobId: 'j1',
        status: 'running',
        percent: 101,
        cancelRequested: false,
        at: 'x'
      }).success
    ).toBe(false)

    expect(
      jobViewSchema.safeParse({
        jobId: 'j1',
        type: 'demo',
        title: 't',
        targetId: null,
        status: 'queued',
        percent: 0,
        cancelRequested: false,
        createdAt: 'x',
        startedAt: null,
        finishedAt: null,
        error: null,
        logCount: 0,
        droppedLogs: 0
      }).success
    ).toBe(true)
  })

  it('状态判定与文案', () => {
    expect(isTerminalStatus('succeeded')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
    expect(isTerminalStatus('cancelled')).toBe(true)
    expect(isTerminalStatus('queued')).toBe(false)
    expect(isTerminalStatus('running')).toBe(false)
    expect(describeJobStatus('running')).toBe('进行中')
    expect(jobStatusTagType('failed')).toBe('danger')
    expect(jobStatusTagType('succeeded')).toBe('success')
  })

  it('日志上限是个正数常量', () => {
    expect(MAX_JOB_LOGS).toBeGreaterThan(0)
  })
})

/* ---------------------------------------------------------- 事件推送 */

describe('attachJobEventPush（T08.4：状态立即、进度与日志节流）', () => {
  it('状态事件立即推送（不节流）', async () => {
    const jobs = createJobService()
    const rec = recorder()
    const off = attachJobEventPush({ jobs, push: rec.push })

    jobs.start({ type: 'demo', title: 't', run: async () => undefined })
    // 同步就该看到 queued / running
    expect(statesOf(rec.events).map((s) => s.status)).toContain('queued')
    await flushMicrotasks()
    expect(statesOf(rec.events).map((s) => s.status)).toContain('succeeded')
    off()
  })

  it('进度被节流：20 次上报远少于 20 次推送，且最后一条必达 100%', async () => {
    vi.useFakeTimers()
    const jobs = createJobService()
    const rec = recorder()
    const off = attachJobEventPush({ jobs, push: rec.push, throttleMs: 200 })

    let emissions = 0
    jobs.onEvent((ev) => {
      if (ev.kind === 'progress') emissions++
    })

    jobs.start({
      type: 'demo',
      title: 't',
      run: async (ctx) => {
        for (let i = 1; i <= 20; i++) ctx.progress({ percent: i * 5, message: `step ${i}` })
      }
    })
    await flushMicrotasks()

    const pushes = progressOf(rec.events)
    expect(emissions).toBeGreaterThanOrEqual(20)
    expect(pushes.length).toBeLessThanOrEqual(4)
    // 这条挡的是"进度条永远停在 97%"
    expect(pushes[pushes.length - 1]?.percent).toBe(100)
    expect(pushes[pushes.length - 1]?.status).toBe('succeeded')
    off()
  })

  it('窗口结束后补发尾边沿（不丢中间那段进度）', async () => {
    vi.useFakeTimers()
    const jobs = createJobService()
    const rec = recorder()
    const off = attachJobEventPush({ jobs, push: rec.push, throttleMs: 200 })

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const job = jobs.start({
      type: 'demo',
      title: 't',
      run: async (ctx) => {
        ctx.progress({ percent: 30 })
        await gate
      }
    })
    await flushMicrotasks()

    // 首边沿：启动时那一条已立即送出；30% 还在窗口里
    expect(progressOf(rec.events).map((p) => p.percent)).toEqual([0])

    vi.advanceTimersByTime(200)
    expect(progressOf(rec.events).map((p) => p.percent)).toEqual([0, 30])

    release()
    await flushMicrotasks()
    await waitFor(
      () => statesOf(rec.events).some((s) => s.status === 'succeeded'),
      'job 完成'
    )
    expect(progressOf(rec.events).map((p) => p.percent)).toEqual([0, 30, 100])
    expect(job.jobId).toBeTruthy()
    off()
  })

  it('日志按批合并推送（不逐行发 IPC）', async () => {
    vi.useFakeTimers()
    const jobs = createJobService()
    const rec = recorder()
    const off = attachJobEventPush({ jobs, push: rec.push, throttleMs: 200 })

    jobs.start({
      type: 'demo',
      title: 't',
      run: async (ctx) => {
        for (let i = 0; i < 10; i++) ctx.log(`line ${i}`)
      }
    })
    await flushMicrotasks()

    const batches = logsOf(rec.events)
    const totalLines = batches.reduce((n, b) => n + b.lines.length, 0)
    // 10 行日志不能变成 10 条 IPC 消息
    expect(batches.length).toBeLessThanOrEqual(2)
    expect(totalLines).toBeGreaterThanOrEqual(10)
    off()
  })

  it('终态时先把进度与日志的尾巴送出去，再报状态（顺序不能反）', async () => {
    vi.useFakeTimers()
    const jobs = createJobService()
    const rec = recorder()
    const off = attachJobEventPush({ jobs, push: rec.push, throttleMs: 200 })

    jobs.start({
      type: 'demo',
      title: 't',
      run: async (ctx) => {
        ctx.log('最后一条日志')
        ctx.progress({ percent: 88 })
      }
    })
    await flushMicrotasks()

    const idx = (pred: (p: Push) => boolean): number => rec.events.findIndex(pred)
    const terminalIdx = idx(
      (p) =>
        p.channel === IPC_CHANNELS.EVT_JOB_STATE &&
        (p.payload as JobView).status === 'succeeded'
    )
    expect(terminalIdx).toBeGreaterThanOrEqual(0)

    const lastProgressIdx = rec.events
      .map((p, i) => (p.channel === IPC_CHANNELS.EVT_JOB_PROGRESS ? i : -1))
      .filter((i) => i >= 0)
      .pop() as number
    const lastLogIdx = rec.events
      .map((p, i) => (p.channel === IPC_CHANNELS.EVT_JOB_LOG ? i : -1))
      .filter((i) => i >= 0)
      .pop() as number

    // 必须能看到 100%，且它出现在终态之前
    expect(progressOf(rec.events).map((p) => p.percent)).toContain(100)
    expect(lastProgressIdx).toBeLessThan(terminalIdx)
    expect(lastLogIdx).toBeLessThan(terminalIdx)
    off()
  })

  it('退订后不再推送', async () => {
    const jobs = createJobService()
    const rec = recorder()
    const off = attachJobEventPush({ jobs, push: rec.push })
    off()
    jobs.start({ type: 'demo', title: 't', run: async () => undefined })
    await flushMicrotasks()
    expect(rec.events).toEqual([])
  })

  it('推送通道抛错不影响任务本身（渲染进程没准备好也不能拖垮主流程）', async () => {
    const jobs = createJobService()
    const off = attachJobEventPush({
      jobs,
      push: () => {
        throw new Error('webContents 已销毁')
      }
    })
    const job = jobs.start({ type: 'demo', title: 't', run: async () => undefined })
    await flushMicrotasks()
    expect(jobs.get(job.jobId)?.status).toBe('succeeded')
    off()
  })
})

/* ------------------------------------------------------------ IPC 通道 */

describe('registerJobHandlers（T08.5）', () => {
  let jobs: JobService
  let offPush: () => void

  beforeAll(() => {
    __resetIpcHandlers()
    unregisterAllHandlers()
    jobs = createJobService()
    offPush = attachJobEventPush({ jobs, push: () => undefined })
    registerJobHandlers({ jobs })
  })

  it('注册了全部任务通道', () => {
    const channels = __registeredIpc()
    for (const c of [
      IPC_CHANNELS.JOB_LIST,
      IPC_CHANNELS.JOB_GET,
      IPC_CHANNELS.JOB_CANCEL,
      IPC_CHANNELS.JOB_RETRY,
      IPC_CHANNELS.JOB_ACTIVE_FOR_TARGET,
      IPC_CHANNELS.JOB_START_DEMO,
      IPC_CHANNELS.JOB_CLEAR_FINISHED
    ]) {
      expect(channels, `缺少通道 ${c}`).toContain(c)
    }
  })

  it('job.startDemo 启动自检任务，可从列表查到并跑完', async () => {
    const job = unwrap<JobView>(
      await __invokeIpc(IPC_CHANNELS.JOB_START_DEMO, { steps: 3, stepMs: 1 })
    )
    expect(job.type).toBe('demo')
    expect(job.title).toContain('自检')

    await waitFor(() => jobs.get(job.jobId)?.status === 'succeeded', '自检任务完成')
    const listed = unwrap<JobView[]>(await __invokeIpc(IPC_CHANNELS.JOB_LIST, undefined))
    expect(listed.some((j) => j.jobId === job.jobId)).toBe(true)
  })

  it('job.startDemo 不传参数也能用（默认 20 步）', async () => {
    const job = unwrap<JobView>(await __invokeIpc(IPC_CHANNELS.JOB_START_DEMO, undefined))
    expect(job.status).toBe('running')
    jobs.cancel(job.jobId)
    await waitFor(() => isTerminalStatus(jobs.get(job.jobId)!.status), '取消完成')
  })

  it('job.startDemo 参数非法 → E_PARAM（不是把坏参数塞进队列）', async () => {
    expect((await callFail(IPC_CHANNELS.JOB_START_DEMO, { steps: 0 })).code).toBe('E_PARAM')
  })

  it('job.get 对不存在的任务返回 null（而不是抛错）', async () => {
    expect(unwrap<JobView | null>(await __invokeIpc(IPC_CHANNELS.JOB_GET, { jobId: 'nope' }))).toBe(
      null
    )
  })

  it('job.get 缺参数 → E_PARAM', async () => {
    expect((await callFail(IPC_CHANNELS.JOB_GET, {})).code).toBe('E_PARAM')
  })

  it('job.cancel 对不存在 / 已结束的任务如实返回原因', async () => {
    expect(
      unwrap(await __invokeIpc(IPC_CHANNELS.JOB_CANCEL, { jobId: 'nope' }))
    ).toEqual({ cancelled: false, reason: 'not-found' })

    const done = unwrap<JobView>(
      await __invokeIpc(IPC_CHANNELS.JOB_START_DEMO, { steps: 1, stepMs: 1 })
    )
    await waitFor(() => isTerminalStatus(jobs.get(done.jobId)!.status), '完成')
    expect(
      unwrap(await __invokeIpc(IPC_CHANNELS.JOB_CANCEL, { jobId: done.jobId }))
    ).toEqual({ cancelled: false, reason: 'already-finished' })
  })

  it('job.retry 对新任务可用；对进行中的任务返回 E_JOB_NOT_RETRYABLE', async () => {
    // 先造一个失败任务
    const failed = unwrap<JobView>(
      await __invokeIpc(IPC_CHANNELS.JOB_START_DEMO, { steps: 5, stepMs: 1, failAtStep: 2 })
    )
    await waitFor(() => jobs.get(failed.jobId)?.status === 'failed', '失败')

    const retried = unwrap<JobView>(await __invokeIpc(IPC_CHANNELS.JOB_RETRY, { jobId: failed.jobId }))
    expect(retried.jobId).not.toBe(failed.jobId)
    await waitFor(() => isTerminalStatus(jobs.get(retried.jobId)!.status), '重试完成')

    // 进行中的任务不能重试
    const running = unwrap<JobView>(
      await __invokeIpc(IPC_CHANNELS.JOB_START_DEMO, { steps: 200, stepMs: 20 })
    )
    expect((await callFail(IPC_CHANNELS.JOB_RETRY, { jobId: running.jobId })).code).toBe(
      'E_JOB_NOT_RETRYABLE'
    )
    jobs.cancel(running.jobId)
    await waitFor(() => isTerminalStatus(jobs.get(running.jobId)!.status), '取消完成')
  })

  it('job.activeForTarget 能反映某目标上是否有任务（发布前置校验要用）', async () => {
    const job = unwrap<JobView>(
      await __invokeIpc(IPC_CHANNELS.JOB_START_DEMO, {
        steps: 200,
        stepMs: 20,
        targetId: 'tg-x'
      })
    )
    const active = unwrap<JobView[]>(
      await __invokeIpc(IPC_CHANNELS.JOB_ACTIVE_FOR_TARGET, { targetId: 'tg-x' })
    )
    expect(active.some((j) => j.jobId === job.jobId)).toBe(true)
    expect(
      unwrap<JobView[]>(
        await __invokeIpc(IPC_CHANNELS.JOB_ACTIVE_FOR_TARGET, { targetId: 'tg-other' })
      )
    ).toEqual([])

    jobs.cancel(job.jobId)
    await waitFor(() => isTerminalStatus(jobs.get(job.jobId)!.status), '取消完成')
  })

  it('job.clearFinished 只清已结束的', async () => {
    const before = jobs.list().length
    expect(before).toBeGreaterThan(0)
    const r = unwrap<{ removed: number }>(await __invokeIpc(IPC_CHANNELS.JOB_CLEAR_FINISHED))
    expect(r.removed).toBeGreaterThan(0)
    expect(jobs.list().every((j) => !isTerminalStatus(j.status))).toBe(true)
    offPush()
  })
})

/* ------------------------------------------------------------ 退出保护 */

describe('createJobGuard（T08.7）', () => {
  it('没有活跃任务时不拦截窗口关闭，也不挂多余的守护行为', async () => {
    const jobs = createJobService()
    const guard = createJobGuard({ jobs, confirm: async () => false })
    const { win, fireClose } = fakeWindow()
    guard.attachWindow(win)

    expect(fireClose()).toBe(false)
    guard.dispose()
  })

  it('有活跃任务时拦截关闭，用户选"继续等待"则不退出、不取消', async () => {
    const jobs = createJobService()
    const confirm = vi.fn(async () => false)
    const quit = vi.spyOn(electronApp, 'quit')
    const guard = createJobGuard({ jobs, confirm })
    const { win, fireClose } = fakeWindow()
    guard.attachWindow(win)

    const job = jobs.start({
      type: 'deploy',
      title: '长任务',
      run: () => new Promise<void>(() => undefined) // 永不结束，模拟耗时发布
    })
    await waitFor(() => jobs.get(job.jobId)?.status === 'running', '任务开跑')

    expect(fireClose()).toBe(true) // 拦下了
    await waitFor(() => confirm.mock.calls.length === 1, '弹了确认框')
    expect(quit).not.toHaveBeenCalled()
    expect(jobs.get(job.jobId)?.status).toBe('running')
    expect(guard.isBypassed()).toBe(false)

    jobs.cancel(job.jobId)
    guard.dispose()
  })

  it('用户选"取消任务并退出"：清理被执行、随后真的退出', async () => {
    const jobs = createJobService()
    const confirm = vi.fn(async () => true)
    const quit = vi.spyOn(electronApp, 'quit')
    const guard = createJobGuard({ jobs, confirm, abandonTimeoutMs: 1000 })
    const { win, fireClose } = fakeWindow()
    guard.attachWindow(win)

    const cleanups: string[] = []
    const job = jobs.start({
      type: 'deploy',
      title: '长任务',
      run: (ctx) =>
        new Promise<void>((_res, rej) => {
          ctx.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
        }),
      cleanup: async (reason) => {
        cleanups.push(reason)
      }
    })
    await waitFor(() => jobs.get(job.jobId)?.status === 'running', '任务开跑')

    expect(fireClose()).toBe(true)
    await waitFor(() => quit.mock.calls.length === 1, '应用退出')
    expect(guard.isBypassed()).toBe(true)
    // "放弃时执行远端清理"（方案书 §6.11）
    expect(cleanups).toEqual(['quit'])
    expect(jobs.get(job.jobId)?.status).toBe('cancelled')
    guard.dispose()
  })

  it('不响应取消信号的任务不会挂住退出流程（限时后强制终结）', async () => {
    const jobs = createJobService()
    const quit = vi.spyOn(electronApp, 'quit')
    const guard = createJobGuard({ jobs, confirm: async () => true, abandonTimeoutMs: 80 })
    const { win, fireClose } = fakeWindow()
    guard.attachWindow(win)

    const job = jobs.start({
      type: 'deploy',
      title: '装死',
      run: () => new Promise<void>(() => undefined)
    })
    await waitFor(() => jobs.get(job.jobId)?.status === 'running', '任务开跑')

    fireClose()
    await waitFor(() => quit.mock.calls.length === 1, '应用退出')
    expect(jobs.get(job.jobId)?.status).toBe('cancelled')
    expect(jobs.activeCount()).toBe(0)
    guard.dispose()
  })

  it('before-quit 也被守住（菜单退出 / app.quit() 路径）', async () => {
    __resetAppListeners()
    const jobs = createJobService()
    const confirm = vi.fn(async () => false)
    const guard = createJobGuard({ jobs, confirm })

    const job = jobs.start({
      type: 'deploy',
      title: '长任务',
      run: () => new Promise<void>(() => undefined)
    })
    await waitFor(() => jobs.get(job.jobId)?.status === 'running', '任务开跑')

    let prevented = false
    __emitApp('before-quit', { preventDefault: () => (prevented = true) })
    expect(prevented).toBe(true)
    await waitFor(() => confirm.mock.calls.length === 1, '弹了确认框')

    jobs.cancel(job.jobId)
    guard.dispose()
  })

  it('没有活跃任务时 before-quit 直接放行', () => {
    __resetAppListeners()
    const jobs = createJobService()
    const guard = createJobGuard({ jobs, confirm: async () => false })
    let prevented = false
    __emitApp('before-quit', { preventDefault: () => (prevented = true) })
    expect(prevented).toBe(false)
    guard.dispose()
  })

  it('dispose 后 before-quit 不再被拦', () => {
    __resetAppListeners()
    const jobs = createJobService()
    const guard = createJobGuard({ jobs, confirm: async () => false })
    expect(__appListenerCount('before-quit')).toBe(1)
    guard.dispose()
    expect(__appListenerCount('before-quit')).toBe(0)
  })

  it('确认框的文案说明了"继续等待"不会丢任务（避免用户以为只能放弃）', async () => {
    const spy = vi.spyOn(electronDialog, 'showMessageBox')
    const { confirmAbandon } = await import('@main/ipc/job')
    const active = [
      {
        jobId: 'j1',
        type: 'deploy' as const,
        title: '订单服务',
        targetId: 'tg1',
        status: 'running' as const,
        percent: 66,
        cancelRequested: false,
        createdAt: 'x',
        startedAt: 'x',
        finishedAt: null,
        error: null,
        logCount: 0,
        droppedLogs: 0
      }
    ]
    // 默认 response=0 → "继续等待"
    await expect(confirmAbandon(active, null)).resolves.toBe(false)
    const opts = spy.mock.calls[0]?.[0] as { detail?: string; buttons?: string[] } | undefined
    expect(opts?.buttons).toEqual(['继续等待', '取消任务并退出'])
    expect(opts?.detail).toContain('订单服务')
    expect(opts?.detail).toContain('继续等待')
    spy.mockRestore()
  })
})
