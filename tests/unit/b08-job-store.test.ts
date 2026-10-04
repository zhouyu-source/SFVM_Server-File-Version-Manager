/**
 * 任务 store 单测（T08.6 的渲染侧）。
 *
 * store 承担一件不显眼但很容易错的事：**把主进程推来的三个事件流
 * （state / progress / log）合并成一份可直接渲染的状态**。
 * 这部分逻辑没有 UI 就完全测不到，而它错了的表现是"列表里百分比不动"
 * "日志少了一段"这类**看起来像后端问题**的现象 —— 所以必须单测。
 *
 * 做法：给 `window.sfvm.jobs` 挂一份内存替身（就是 preload 暴露的那个形状），
 * 由测试自己"推事件"。不启动 Electron，也不碰真实 IPC。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { MAX_JOB_LOGS, type JobLogBatch, type JobProgress, type JobView } from '@shared/contracts/job'
import { useJobStore } from '@renderer/stores/job'

/* ------------------------------------------------------------ IPC 替身 */

type StateListener = (job: JobView) => void
type ProgressListener = (progress: JobProgress) => void
type LogListener = (batch: JobLogBatch) => void

const listeners = {
  state: [] as StateListener[],
  progress: [] as ProgressListener[],
  log: [] as LogListener[]
}

/** 让 `list()` 可控（可挂起，用于验证"先订阅再拉列表"）。 */
let listImpl: () => Promise<unknown> = async () => ({ ok: true, data: [] })
let cancelImpl: (jobId: string) => Promise<unknown> = async () => ({ ok: true, data: { cancelled: true } })
let retryImpl: (jobId: string) => Promise<unknown> = async () => ({ ok: true, data: null })
let demoImpl: (input?: unknown) => Promise<unknown> = async () => ({ ok: true, data: null })
let clearImpl: () => Promise<unknown> = async () => ({ ok: true, data: { removed: 0 } })

const bridge = {
  jobs: {
    list: () => listImpl() as Promise<unknown>,
    get: async () => ({ ok: true, data: null }),
    cancel: (jobId: string) => cancelImpl(jobId),
    retry: (jobId: string) => retryImpl(jobId),
    activeForTarget: async () => ({ ok: true, data: [] }),
    startDemo: (input?: unknown) => demoImpl(input),
    clearFinished: () => clearImpl(),
    onState: (cb: StateListener) => {
      listeners.state.push(cb)
      return () => {
        listeners.state = listeners.state.filter((f) => f !== cb)
      }
    },
    onProgress: (cb: ProgressListener) => {
      listeners.progress.push(cb)
      return () => {
        listeners.progress = listeners.progress.filter((f) => f !== cb)
      }
    },
    onLog: (cb: LogListener) => {
      listeners.log.push(cb)
      return () => {
        listeners.log = listeners.log.filter((f) => f !== cb)
      }
    }
  }
}

// 在**任何 store 调用之前**挂上替身：渲染侧的 `api` 是懒解析 `window.sfvm` 的，
// 因此这里赋值一次就够（不需要 mock 模块）。
;(globalThis as unknown as { window: unknown }).window = { sfvm: bridge }

const emitState = (job: JobView): void => listeners.state.forEach((f) => f(job))
const emitProgress = (p: JobProgress): void => listeners.progress.forEach((f) => f(p))
const emitLog = (batch: JobLogBatch): void => listeners.log.forEach((f) => f(batch))

/* -------------------------------------------------------------- 造数据 */

let seq = 0
function makeJob(patch: Partial<JobView> = {}): JobView {
  seq += 1
  return {
    jobId: `job_${seq}`,
    type: 'demo',
    title: `任务${seq}`,
    targetId: null,
    status: 'running',
    percent: 0,
    stage: undefined,
    message: undefined,
    cancelRequested: false,
    createdAt: `2025-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    startedAt: null,
    finishedAt: null,
    logCount: 0,
    droppedLogs: 0,
    error: null,
    ...patch
  }
}

function makeProgress(patch: Partial<JobProgress> & { jobId: string }): JobProgress {
  return {
    status: 'running',
    percent: 0,
    cancelRequested: false,
    ...patch
  } as JobProgress
}

beforeEach(() => {
  listeners.state = []
  listeners.progress = []
  listeners.log = []
  seq = 0
  listImpl = async () => ({ ok: true, data: [] })
  cancelImpl = async () => ({ ok: true, data: { cancelled: true } })
  retryImpl = async () => ({ ok: true, data: null })
  demoImpl = async () => ({ ok: true, data: null })
  clearImpl = async () => ({ ok: true, data: { removed: 0 } })
  setActivePinia(createPinia())
})

/* ---------------------------------------------------------------- 用例 */

describe('任务 store：事件合并（T08.4 / T08.6）', () => {
  it('init() 先订阅再拉列表：拉列表期间到达的进度不会丢', async () => {
    const store = useJobStore()
    let resolveList: (v: unknown) => void = () => {}
    listImpl = () =>
      new Promise((resolve) => {
        resolveList = resolve
      })

    const job = makeJob({ jobId: 'j1' })
    const p = store.init()
    // 此刻列表还没回来，但事件已经来了
    expect(listeners.progress.length).toBe(1)
    emitProgress(makeProgress({ jobId: 'j1', percent: 42, cancelRequested: false }))

    resolveList({ ok: true, data: [job] })
    await p

    expect(store.progressById['j1']?.percent).toBe(42)
  })

  it('进度事件会同时刷新列表里的 status/percent（否则列表百分比一动不动）', async () => {
    const store = useJobStore()
    await store.init()
    emitState(makeJob({ jobId: 'j1', percent: 0, status: 'running' }))
    emitProgress(makeProgress({ jobId: 'j1', percent: 70, status: 'running', message: '传输中' }))

    const row = store.jobs.find((j) => j.jobId === 'j1')
    expect(row?.percent).toBe(70)
    expect(row?.message).toBe('传输中')
  })

  it('状态事件是 upsert：同 jobId 覆盖、新任务排在最前', async () => {
    const store = useJobStore()
    await store.init()
    emitState(makeJob({ jobId: 'a', title: 'A' }))
    emitState(makeJob({ jobId: 'b', title: 'B' }))
    emitState(makeJob({ jobId: 'a', title: 'A2' }))

    expect(store.jobs.map((j) => j.jobId)).toEqual(['b', 'a'])
    expect(store.jobs.find((j) => j.jobId === 'a')?.title).toBe('A2')
  })

  it('日志按批追加，并且是**累积**的（不是每批覆盖）', async () => {
    const store = useJobStore()
    await store.init()
    emitState(makeJob({ jobId: 'j1' }))
    emitLog({ jobId: 'j1', lines: [{ at: 't1', level: 'info', text: '第一行' }], dropped: 0 })
    emitLog({ jobId: 'j1', lines: [{ at: 't2', level: 'info', text: '第二行' }], dropped: 0 })

    expect(store.selectedLogs.length).toBe(0) // 未选中该任务
    store.select('j1')
    expect(store.selectedLogs.map((l) => l.text)).toEqual(['第一行', '第二行'])
  })

  it('日志超过上限时裁掉最早的（渲染进程也要防内存膨胀）', async () => {
    const store = useJobStore()
    await store.init()
    store.select('j1')
    const batch: JobLogBatch = {
      jobId: 'j1',
      lines: Array.from({ length: MAX_JOB_LOGS + 50 }, (_, i) => ({
        at: `t${i}`,
        level: 'info' as const,
        text: `行 ${i}`
      })),
      dropped: 0
    }
    emitLog(batch)

    expect(store.selectedLogs.length).toBe(MAX_JOB_LOGS)
    // 保的是**最后** MAX_JOB_LOGS 条
    expect(store.selectedLogs[0]?.text).toBe('行 50')
    expect(store.selectedLogs[store.selectedLogs.length - 1]?.text).toBe(`行 ${MAX_JOB_LOGS + 49}`)
  })

  it('dropped 会被记录（"已省略最早 N 行"要能显示）', async () => {
    const store = useJobStore()
    await store.init()
    store.select('j1')
    emitLog({ jobId: 'j1', lines: [{ at: 't', level: 'info', text: 'x' }], dropped: 5000 })
    expect(store.droppedById['j1']).toBe(5000)
  })
})

describe('任务 store：派生状态（T08.5 / T08.6）', () => {
  it('activeJobs 只含未终态，且按 createdAt 升序（收起条取最早的那个）', async () => {
    const store = useJobStore()
    await store.init()
    emitState(makeJob({ jobId: 'late', createdAt: '2025-01-01T00:00:09.000Z' }))
    emitState(makeJob({ jobId: 'done', status: 'succeeded' }))
    emitState(makeJob({ jobId: 'early', createdAt: '2025-01-01T00:00:01.000Z' }))

    expect(store.activeJobs.map((j) => j.jobId)).toEqual(['early', 'late'])
    expect(store.primaryJob?.jobId).toBe('early')
    expect(store.finishedCount).toBe(1)
    expect(store.hasFailure).toBe(false)
  })

  it('全部结束 → primaryJob 为 null、hasFailure 为 true', async () => {
    const store = useJobStore()
    await store.init()
    emitState(makeJob({ jobId: 'f', status: 'failed' }))
    expect(store.primaryJob).toBeNull()
    expect(store.hasFailure).toBe(true)
  })

  it('statusText 区分"取消中…"与"已取消"', async () => {
    const store = useJobStore()
    await store.init()
    const running = makeJob({ jobId: 'r', status: 'running', cancelRequested: true })
    const cancelled = makeJob({ jobId: 'c', status: 'cancelled', cancelRequested: true })
    expect(store.statusText(running)).toBe('取消中…')
    expect(store.statusText(cancelled)).toBe('已取消')
    expect(store.typeText(running)).toBe('自检')
  })

  it('progressText 分别支持"字节 / 文件数 / 自由文案"三种形态', async () => {
    const store = useJobStore()
    await store.init()
    const job = makeJob({ jobId: 'j1', percent: 0 })
    emitState(job)
    store.select('j1')

    // 没有进度记录 → 退回 percent
    expect(store.progressText(job)).toBe('0%')

    emitProgress(
      makeProgress({ jobId: 'j1', percent: 25, bytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 })
    )
    expect(store.progressText(job)).toContain('25%')
    expect(store.progressText(job)).toContain('/')

    emitProgress(makeProgress({ jobId: 'j1', percent: 50, files: 3, totalFiles: 10 }))
    expect(store.progressText(job)).toContain('3/10 个文件')

    emitProgress(makeProgress({ jobId: 'j1', percent: 60, message: '正在换版' }))
    expect(store.progressText(job)).toBe('正在换版')
  })

  it('diagnosticsText 覆盖任务信息、错误与完整日志（"贴给别人就能定位"）', async () => {
    const store = useJobStore()
    await store.init()
    const job = makeJob({
      jobId: 'bad',
      title: '失败任务',
      status: 'failed',
      percent: 37,
      error: { code: 'E_DEPLOY_STAGE_FAILED', message: '换版失败', hint: '检查权限' }
    })
    emitState(job)
    emitLog({ jobId: 'bad', lines: [{ at: '2025-01-01T00:00:00.000Z', level: 'error', text: '炸了' }], dropped: 2 })

    const text = store.diagnosticsText('bad')
    expect(text).toContain('失败任务')
    expect(text).toContain('E_DEPLOY_STAGE_FAILED')
    expect(text).toContain('检查权限')
    expect(text).toContain('炸了')
    expect(text).toContain('已省略最早 2 行')
    // 不存在的任务给出空串（调用方据此提示"没有可复制的信息"）
    expect(store.diagnosticsText('nope')).toBe('')
  })
})

describe('任务 store：动作', () => {
  it('cancel 成功时把该任务设为当前查看项；失败时写入 error', async () => {
    const store = useJobStore()
    await store.init()
    emitState(makeJob({ jobId: 'j1' }))

    expect(await store.cancel('j1')).toBe(true)
    expect(store.selectedJobId).toBe('j1')

    cancelImpl = async () => ({ ok: false, code: 'E_JOB_NOT_FOUND', message: '任务不存在' })
    expect(await store.cancel('j1')).toBe(false)
    expect(store.error).toContain('任务不存在')
  })

  it('startDemo 会 upsert、选中并展开（用户点完立刻看到进度与日志）', async () => {
    const store = useJobStore()
    await store.init()
    const job = makeJob({ jobId: 'demo1', title: '自检任务' })
    demoImpl = async () => ({ ok: true, data: job })

    const started = await store.startDemo({ steps: 5, stepMs: 10 })
    expect(started?.jobId).toBe('demo1')
    expect(store.selectedJobId).toBe('demo1')
    expect(store.expanded).toBe(true)
    expect(store.jobs.some((j) => j.jobId === 'demo1')).toBe(true)
  })

  it('retry 会展开面板并选中新任务', async () => {
    const store = useJobStore()
    await store.init()
    const retried = makeJob({ jobId: 'r1', status: 'queued' })
    retryImpl = async () => ({ ok: true, data: retried })

    const job = await store.retry('old')
    expect(job?.jobId).toBe('r1')
    expect(store.selectedJobId).toBe('r1')
    expect(store.expanded).toBe(true)
  })

  it('clearFinished 之后本地日志/进度缓存只保留仍然存在的任务（防内存泄漏）', async () => {
    const store = useJobStore()
    await store.init()
    const keep = makeJob({ jobId: 'keep', status: 'running' })
    const gone = makeJob({ jobId: 'gone', status: 'succeeded' })
    emitState(keep)
    emitState(gone)
    emitLog({ jobId: 'gone', lines: [{ at: 't', level: 'info', text: 'x' }], dropped: 0 })
    emitProgress(makeProgress({ jobId: 'gone', percent: 100 }))

    listImpl = async () => ({ ok: true, data: [keep] })
    clearImpl = async () => ({ ok: true, data: { removed: 1 } })
    expect(await store.clearFinished()).toBe(1)

    expect(store.logsById['gone']).toBeUndefined()
    expect(store.progressById['gone']).toBeUndefined()
  })

  it('dispose 之后事件不再影响状态（热重载不重复订阅）', async () => {
    const store = useJobStore()
    await store.init()
    store.dispose()
    emitState(makeJob({ jobId: 'zzz' }))
    expect(store.jobs).toHaveLength(0)
  })

  it('列表刷新后，被清理掉的选中任务会自动改选第一条（不留悬空选中）', async () => {
    const store = useJobStore()
    const a = makeJob({ jobId: 'a' })
    const b = makeJob({ jobId: 'b' })
    listImpl = async () => ({ ok: true, data: [a, b] })
    await store.init()
    store.select('b')

    listImpl = async () => ({ ok: true, data: [a] })
    await store.fetchList()
    expect(store.selectedJobId).toBe('a')
  })
})
