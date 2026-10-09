/**
 * 任务编排：任务模型 + 队列 + 全局注册表（T08.3 / T08.5，方案书 §6.11）。
 *
 * ## 为什么要有这一层
 *
 * 发布是"多阶段、耗时、可能被打断"的操作。如果每个服务自己起 Promise，
 * 会立刻出现三个问题：用户看不到进度；同一个目标可能被同时发布两次；
 * 关窗口时不知道有没有活儿没干完。所以把"跑一件事"统一收口到这里。
 *
 * ## 关键设计
 *
 * 1. **同目标串行**：同一 `targetId` 的任务排在同一条"车道"（lane）上，一次只跑一个。
 *    不同目标之间可并行，但受 `maxConcurrency` 限制。
 * 2. **取消是协作式的**：`cancel()` 只做两件事 —— 给信号、置 `cancelRequested`。
 *    真正的停止由任务自己响应 `signal` 完成，因此"取消能立刻停"由任务实现保证。
 * 3. **清理与取消分离**（重要约定）：
 *    - `signal` → "尽快停下来"
 *    - `spec.cleanup(reason)` → "清理远端残留"
 *    任务**不要**自己在 abort 分支里做远端清理：因为退出（放弃）路径上任务可能
 *    根本没在听信号，那种情况下只有 service 侧的 `cleanup` 还会被执行。
 *    把清理收在一处，才不会出现"有时清、有时不清"。
 * 4. **进度单调不减**：进度条往回跳是用户最容易误判成 bug 的现象。
 *    跨阶段的百分比由调用方自己加权，service 只做钳制与取最大值。
 * 5. **日志有上限**：环形缓冲 + 如实上报丢了多少行。
 * 6. **不落库**：任务是一次运行期的载体，进程重启即失效（方案书 §6.11）。
 *
 * 本文件**不 import electron**，所以可以在单测里真实跑完整生命周期。
 */
import { randomUUID } from 'node:crypto'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { redact, scrubText } from '../infra/log-redact'
import {
  MAX_JOB_LOGS,
  isTerminalStatus,
  type JobErrorInfo,
  type JobLogLevel,
  type JobLogLine,
  type JobProgress,
  type JobStatus,
  type JobType,
  type JobView
} from '../../shared/contracts/job'

/* ------------------------------------------------------------ 运行上下文 */

/** 任务上报进度的入参：只需给"有变化"的字段。 */
export interface JobProgressInput {
  percent?: number
  stage?: string
  message?: string
  bytes?: number
  totalBytes?: number
  files?: number
  totalFiles?: number
}

/** 任务运行上下文。任务通过它上报进度与日志，并观察取消信号。 */
export interface JobContext {
  readonly jobId: string
  /** 取消信号：abort 后任务应尽快抛错或返回 */
  readonly signal: AbortSignal
  progress(p: JobProgressInput): void
  log(text: string, level?: JobLogLevel): void
}

export type JobCleanupReason = 'cancel' | 'quit' | 'failed'
export type JobCleanupContext = Pick<JobContext, 'jobId' | 'log'>

export interface JobSpec {
  type: JobType
  title: string
  /** 归属目标；决定"同目标串行"分到哪条车道。不传则各自独立并行 */
  targetId?: string | null
  run: (ctx: JobContext) => Promise<unknown>
  /**
   * 远端清理（取消 / 放弃退出 / 失败时由 service 调用）。
   * 抛错只记日志，不覆盖原始失败原因 —— 清理失败不该掩盖"为什么失败"。
   */
  cleanup?: (reason: JobCleanupReason, ctx: JobCleanupContext) => Promise<void>
}

/* ------------------------------------------------------------ 服务接口 */

export interface JobServiceOptions {
  /** 全局并发上限（不同目标之间）。默认 3 */
  maxConcurrency?: number
  /** 终态任务最多保留多少条（超出丢最旧的）。默认 50 */
  maxTerminalRecords?: number
  /** 单次清理的等待上限（毫秒）。默认 10000 */
  cleanupTimeoutMs?: number
  /** 便于测试注入时钟 */
  now?: () => Date
}

export type JobEvent =
  | { kind: 'state'; job: JobView }
  | { kind: 'progress'; progress: JobProgress }
  | { kind: 'log'; jobId: string; line: JobLogLine; dropped: number }

export interface CancelOutcome {
  cancelled: boolean
  reason?: 'not-found' | 'already-finished'
}

export interface CancelAllResult {
  /** 收到取消请求的任务数 */
  requested: number
  /** 未在时限内停下来、被强制标记为已取消的数量（会如实记日志） */
  forced: number
}

export interface JobService {
  start(spec: JobSpec): JobView
  list(filter?: { status?: JobStatus[]; targetId?: string }): JobView[]
  get(jobId: string): JobView | undefined
  activeForTarget(targetId: string): JobView[]
  hasActiveForTarget(targetId: string): boolean
  activeCount(): number
  /** 请求取消。`reason` 决定清理阶段拿到的是 `cancel` 还是 `quit` */
  cancel(jobId: string, reason?: JobCleanupReason): CancelOutcome
  retry(jobId: string): JobView
  /** 退出保护用：请求取消全部任务，并等待它们（含清理）结束一段有限时间 */
  cancelAll(reason: JobCleanupReason, opts?: { timeoutMs?: number }): Promise<CancelAllResult>
  onEvent(listener: (ev: JobEvent) => void): () => void
  /** 手动清理已结束任务的记录 */
  clearFinished(): number
}

/* -------------------------------------------------------------- 内部实现 */

interface JobRecord {
  jobId: string
  spec: JobSpec
  lane: string
  status: JobStatus
  percent: number
  stage?: string
  message?: string
  bytes?: number
  totalBytes?: number
  files?: number
  totalFiles?: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  cancelRequested: boolean
  /**
   * 取消原因：区分"用户单独取消这个任务"与"用户放弃退出、整个应用要关"。
   *
   * 这个区分不是洁癖：退出路径上清理必须尽快结束（进程马上就没了），
   * 而单独取消可以耐心等远端把暂存删干净。所以不清不楚地统一记成 `cancel`
   * 会让清理逻辑无法据此调整策略。
   */
  cancelReason: JobCleanupReason | null
  error: JobErrorInfo | null
  logs: JobLogLine[]
  droppedLogs: number
  controller: AbortController
  /** 任务到达终态（含清理完成）时 resolve */
  settled: Promise<void>
  resolveSettled: () => void
  cleanupDone: boolean
  /** 终态写入的幂等标志 */
  finished: boolean
}

/** 取消信号触发的统一异常。 */
function cancelledError(jobId: string): AppError {
  return new AppError(ErrorCode.E_JOB_CANCELLED, { jobId })
}

/**
 * 任务失败详情里可能夹带凭据，进 UI 前统一脱敏（T01.2 / M7 / A2）。
 *
 * 两道一起用，因为各自只覆盖一半：
 * - `redact()` 按**敏感键名**替换结构里的值（`password` / `token` …），
 *   但**不碰自由文本** —— `{ command: 'mysql -pHunter2' }` 这种原样放行；
 * - `scrubText()` 扫自由文本里的 `password=xxx` / `http://u:p@h` 形态，
 *   但认不出结构键名，也认不出裸串。
 *
 * 之所以在**这里**兜（而不是只靠各调用点自觉不塞敏感字段）：`detail` 是任意的、
 * 由无数个抛出点决定，集中过一道才能保证"无论谁往 detail 里放什么"都不会直接
 * 出现在任务失败详情面板上。
 */
function sanitizeDetail(detail: unknown): unknown {
  return scrubStrings(redact(detail))
}

function scrubStrings(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]'
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map((v) => scrubStrings(v, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubStrings(v, depth + 1)
    }
    return out
  }
  return value
}

function toErrorInfo(err: unknown): JobErrorInfo {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.detail === undefined ? {} : { detail: sanitizeDetail(err.detail) })
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { code: ErrorCode.E_UNKNOWN, message }
}

/**
 * 可被取消的 `sleep`（供耗时任务使用）。
 *
 * 用 `setTimeout` + `signal` 而不是 `AbortSignal.timeout`：后者不能被外部取消。
 * 监听器在结束时一定移除，否则长任务会累积监听器并触发 Node 的泄漏告警。
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError('aborted'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(cancelledError('cancelled'))
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 给一个 Promise 加时限。超时后 **不取消** 原 Promise（只是不再等它），
 * 所以调用方要清楚：超时意味着"我们放弃了等待"，不代表对方停了。
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<'timeout' | T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve('timeout')
    }, ms)
    p.then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** 车道键：有目标按目标分道；无目标的任务各自独立（互不排队）。 */
function laneOf(spec: JobSpec, jobId: string): string {
  return spec.targetId ? `t:${spec.targetId}` : `j:${jobId}`
}

export function createJobService(options: JobServiceOptions = {}): JobService {
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 3)
  const maxTerminalRecords = Math.max(1, options.maxTerminalRecords ?? 50)
  const cleanupTimeoutMs = Math.max(1, options.cleanupTimeoutMs ?? 10_000)
  const now = options.now ?? ((): Date => new Date())

  /** 插入顺序 = Map 的迭代顺序，用于让调度尽量按提交顺序取任务 */
  const records = new Map<string, JobRecord>()
  const lanes = new Map<string, string[]>()
  const runningLanes = new Set<string>()
  const running = new Set<string>()
  const listeners = new Set<(ev: JobEvent) => void>()

  /* ---------------------------------------------------------- 事件发射 */

  function emit(ev: JobEvent): void {
    for (const fn of listeners) {
      try {
        fn(ev)
      } catch (err) {
        logger.warn(`job event listener failed: ${(err as Error).message}`)
      }
    }
  }

  function toView(rec: JobRecord): JobView {
    return {
      jobId: rec.jobId,
      type: rec.spec.type,
      title: rec.spec.title,
      targetId: rec.spec.targetId ?? null,
      status: rec.status,
      percent: rec.percent,
      ...(rec.stage !== undefined ? { stage: rec.stage } : {}),
      ...(rec.message !== undefined ? { message: rec.message } : {}),
      cancelRequested: rec.cancelRequested,
      createdAt: rec.createdAt,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt,
      error: rec.error,
      logCount: rec.logs.length,
      droppedLogs: rec.droppedLogs
    }
  }

  function emitState(rec: JobRecord): void {
    emit({ kind: 'state', job: toView(rec) })
  }

  function emitProgress(rec: JobRecord): void {
    emit({
      kind: 'progress',
      progress: {
        jobId: rec.jobId,
        status: rec.status,
        percent: rec.percent,
        ...(rec.stage !== undefined ? { stage: rec.stage } : {}),
        ...(rec.message !== undefined ? { message: rec.message } : {}),
        ...(rec.bytes !== undefined ? { bytes: rec.bytes } : {}),
        ...(rec.totalBytes !== undefined ? { totalBytes: rec.totalBytes } : {}),
        ...(rec.files !== undefined ? { files: rec.files } : {}),
        ...(rec.totalFiles !== undefined ? { totalFiles: rec.totalFiles } : {}),
        cancelRequested: rec.cancelRequested,
        at: now().toISOString()
      }
    })
  }

  function appendLog(rec: JobRecord, text: string, level: JobLogLevel = 'info'): void {
    const line: JobLogLine = { at: now().toISOString(), level, text }
    rec.logs.push(line)
    if (rec.logs.length > MAX_JOB_LOGS) {
      const overflow = rec.logs.length - MAX_JOB_LOGS
      rec.logs.splice(0, overflow)
      rec.droppedLogs += overflow
    }
    emit({ kind: 'log', jobId: rec.jobId, line, dropped: rec.droppedLogs })
  }

  /* ------------------------------------------------------------ 调度 */

  function pump(): void {
    while (running.size < maxConcurrency) {
      const rec = takeNextRunnable()
      if (!rec) return
      startJob(rec)
    }
  }

  function takeNextRunnable(): JobRecord | null {
    // 复制键列表：循环里会删空车道
    for (const lane of [...lanes.keys()]) {
      if (runningLanes.has(lane)) continue
      const queue = lanes.get(lane)
      if (!queue || queue.length === 0) {
        lanes.delete(lane)
        continue
      }
      const jobId = queue.shift() as string
      if (queue.length === 0) lanes.delete(lane)
      const rec = records.get(jobId)
      if (!rec) continue
      return rec
    }
    return null
  }

  function startJob(rec: JobRecord): void {
    running.add(rec.jobId)
    runningLanes.add(rec.lane)
    rec.status = 'running'
    rec.startedAt = now().toISOString()
    appendLog(rec, `任务开始：${rec.spec.title}`)
    emitState(rec)
    emitProgress(rec)
    void execute(rec)
  }

  /** 任务主体：跑 → 清理 → 落终态。任何路径都必须走到 finish()。 */
  async function execute(rec: JobRecord): Promise<void> {
    const ctx: JobContext = {
      jobId: rec.jobId,
      signal: rec.controller.signal,
      progress: (p) => applyProgress(rec, p),
      log: (text, level) => appendLog(rec, text, level)
    }

    let failure: unknown = null
    try {
      await rec.spec.run(ctx)
    } catch (err) {
      failure = err
    }

    // 清理：取消 / 失败 都走这里。
    // 多一道"是否已被强制终结"的判断：cancelAll 超时后会强制落终态（退出流程
    // 不能无限等），那种情况下再跑清理只是与应用退出赛跑，没有意义。
    if (failure !== null && !isTerminalStatus(rec.status)) {
      const reason: JobCleanupReason = rec.cancelReason ?? 'failed'
      await runCleanup(rec, reason)
    }

    finish(rec, failure)
  }

  async function runCleanup(rec: JobRecord, reason: JobCleanupReason): Promise<void> {
    if (rec.cleanupDone) return
    rec.cleanupDone = true
    if (!rec.spec.cleanup) return

    appendLog(rec, reason === 'cancel' ? '正在清理由此任务产生的远端残留…' : '失败，正在清理远端残留…')
    emitState(rec)
    try {
      const r = await withTimeout(
        rec.spec.cleanup(reason, {
          jobId: rec.jobId,
          log: (text, level) => appendLog(rec, text, level)
        }),
        cleanupTimeoutMs
      )
      if (r === 'timeout') {
        appendLog(rec, `清理超过 ${Math.round(cleanupTimeoutMs / 1000)} 秒未完成，已放弃等待`, 'warn')
      } else {
        appendLog(rec, '远端清理完成')
      }
    } catch (err) {
      // 清理失败不能覆盖原始失败原因，只记日志
      appendLog(rec, `远端清理失败：${(err as Error).message}`, 'warn')
    }
  }

  function applyProgress(rec: JobRecord, p: JobProgressInput): void {
    if (p.percent !== undefined && Number.isFinite(p.percent)) {
      const clamped = Math.min(100, Math.max(0, p.percent))
      // 单调不减：进度条往回跳会被当成 bug
      rec.percent = Math.max(rec.percent, clamped)
    }
    if (p.stage !== undefined) rec.stage = p.stage
    if (p.message !== undefined) rec.message = p.message
    if (p.bytes !== undefined) rec.bytes = p.bytes
    if (p.totalBytes !== undefined) rec.totalBytes = p.totalBytes
    if (p.files !== undefined) rec.files = p.files
    if (p.totalFiles !== undefined) rec.totalFiles = p.totalFiles
    emitProgress(rec)
  }

  /** 落终态。幂等：重复调用只生效一次。 */
  function finish(rec: JobRecord, failure: unknown): void {
    if (rec.finished) return
    rec.finished = true

    if (failure === null) {
      // 跑完了就是成功 —— 即使此时 cancelRequested 为真。
      // 谎报"已取消"会掩盖一次真实完成（对发布任务而言就是"换了版却说没换"）。
      rec.status = 'succeeded'
      rec.percent = 100
      appendLog(rec, '任务完成')
      if (rec.cancelRequested) {
        appendLog(rec, '注意：取消请求到达时任务已经执行完毕，本次按已完成处理', 'warn')
      }
    } else if (rec.cancelRequested) {
      // 用户请求取消后停在哪个环节都算"已取消"；原始错误仍记进日志便于排查
      rec.status = 'cancelled'
      appendLog(rec, '任务已取消')
      appendLog(rec, `中断原因：${toErrorInfo(failure).message}`, 'debug')
    } else {
      rec.status = 'failed'
      rec.error = toErrorInfo(failure)
      appendLog(rec, `任务失败：${rec.error.message}`, 'error')
    }

    rec.finishedAt = now().toISOString()
    // 只有「确实在跑」的任务才占着车道。取消排队任务时它从未进过 running，
    // 若此处无条件删车道，pump() 会把下一个排队任务当成车道空闲而启动，
    // 与仍在跑的那个同目标任务并发 —— 而 takeNextRunnable 的
    // `if (runningLanes.has(lane)) continue` 此时已失效。
    if (running.delete(rec.jobId)) runningLanes.delete(rec.lane)

    // 释放车道（若还有排队任务，pump 会从 lanes 里取，不需保留空车道）
    const q = lanes.get(rec.lane)
    if (q && q.length === 0) lanes.delete(rec.lane)

    emitProgress(rec)
    emitState(rec)
    rec.resolveSettled()
    prune()
    pump()
  }

  /** 终态记录上限：超出丢最旧的（避免长跑应用内存一直涨）。 */
  function prune(): void {
    const terminal = [...records.values()].filter((r) => isTerminalStatus(r.status))
    if (terminal.length <= maxTerminalRecords) return
    const excess = terminal.length - maxTerminalRecords
    // records 的插入顺序即创建顺序，取其前 excess 条丢弃
    for (let i = 0; i < excess; i++) {
      const victim = terminal[i]
      if (victim) records.delete(victim.jobId)
    }
  }

  /* ------------------------------------------------------------ 公共 API */

  function start(spec: JobSpec): JobView {
    const jobId = `job_${randomUUID()}`
    let resolveSettled: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })

    const rec: JobRecord = {
      jobId,
      spec,
      lane: laneOf(spec, jobId),
      status: 'queued',
      percent: 0,
      createdAt: now().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      cancelReason: null,
      error: null,
      logs: [],
      droppedLogs: 0,
      controller: new AbortController(),
      settled,
      resolveSettled,
      cleanupDone: false,
      finished: false
    }

    records.set(jobId, rec)
    const queue = lanes.get(rec.lane)
    if (queue) queue.push(jobId)
    else lanes.set(rec.lane, [jobId])

    emitProgress(rec)
    emitState(rec)
    pump()
    return toView(rec)
  }

  function list(filter?: { status?: JobStatus[]; targetId?: string }): JobView[] {
    let out = [...records.values()]
    if (filter?.status && filter.status.length > 0) {
      const set = new Set(filter.status)
      out = out.filter((r) => set.has(r.status))
    }
    if (filter?.targetId) out = out.filter((r) => r.spec.targetId === filter.targetId)
    // 新的在前：用户最关心刚发生的
    return out.map(toView).reverse()
  }

  function get(jobId: string): JobView | undefined {
    const rec = records.get(jobId)
    return rec ? toView(rec) : undefined
  }

  function activeForTarget(targetId: string): JobView[] {
    return [...records.values()]
      .filter((r) => r.spec.targetId === targetId && !isTerminalStatus(r.status))
      .map(toView)
  }

  function hasActiveForTarget(targetId: string): boolean {
    return [...records.values()].some(
      (r) => r.spec.targetId === targetId && !isTerminalStatus(r.status)
    )
  }

  function activeCount(): number {
    return [...records.values()].filter((r) => !isTerminalStatus(r.status)).length
  }

  function cancel(jobId: string, reason: JobCleanupReason = 'cancel'): CancelOutcome {
    const rec = records.get(jobId)
    if (!rec) return { cancelled: false, reason: 'not-found' }
    if (isTerminalStatus(rec.status)) return { cancelled: false, reason: 'already-finished' }
    if (rec.cancelRequested) return { cancelled: true }

    rec.cancelRequested = true
    // 首次请求的原因胜出：后面的重复请求（比如退出时再取消一次）不该改写它
    rec.cancelReason = reason

    if (rec.status === 'queued') {
      // 还没开始：直接从队列摘掉，不需要清理（远端还没被碰过）
      const queue = lanes.get(rec.lane)
      if (queue) {
        const i = queue.indexOf(jobId)
        if (i >= 0) queue.splice(i, 1)
        if (queue.length === 0) lanes.delete(rec.lane)
      }
      appendLog(rec, '任务在排队中被取消（尚未触碰服务器）')
      emitState(rec)
      finish(rec, cancelledError(jobId))
      return { cancelled: true }
    }

    appendLog(rec, '收到取消请求，正在停止…')
    emitState(rec)
    emitProgress(rec)
    rec.controller.abort()
    return { cancelled: true }
  }

  function retry(jobId: string): JobView {
    const rec = records.get(jobId)
    if (!rec) throw new AppError(ErrorCode.E_JOB_NOT_FOUND, { jobId })
    if (!isTerminalStatus(rec.status)) {
      throw new AppError(ErrorCode.E_JOB_NOT_RETRYABLE, { jobId, status: rec.status })
    }
    // 方案书 §6.11：重试 = 新建任务，保留原任务记录
    const next = start(rec.spec)
    const nextRec = records.get(next.jobId)
    if (nextRec) appendLog(nextRec, `重试自任务 ${jobId}`)
    return next
  }

  async function cancelAll(
    reason: JobCleanupReason,
    opts?: { timeoutMs?: number }
  ): Promise<CancelAllResult> {
    const active = [...records.values()].filter((r) => !isTerminalStatus(r.status))
    if (active.length === 0) return { requested: 0, forced: 0 }

    for (const rec of active) {
      if (reason === 'quit') {
        // 退出场景要给用户一个说法：日志里必须留下痕迹
        appendLog(rec, '应用退出：已请求取消该任务', 'warn')
      }
      cancel(rec.jobId, reason)
    }

    const timeoutMs = opts?.timeoutMs ?? cleanupTimeoutMs + 2000
    const wait = Promise.all(active.map((r) => r.settled))
    const r = await withTimeout(wait, timeoutMs)

    let forced = 0
    if (r === 'timeout') {
      // 有任务不响应信号（例如卡在不可取消的系统调用里）。
      // 如实标记并记日志，而不是无限期挂住退出流程。
      for (const rec of active) {
        if (isTerminalStatus(rec.status)) continue
        forced++
        appendLog(rec, `任务未在 ${Math.round(timeoutMs / 1000)} 秒内停下来，已强制标记为取消`, 'warn')
        finish(rec, cancelledError(rec.jobId))
      }
    }

    return { requested: active.length, forced }
  }

  function onEvent(listener: (ev: JobEvent) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function clearFinished(): number {
    const victims = [...records.values()].filter((r) => isTerminalStatus(r.status))
    for (const v of victims) records.delete(v.jobId)
    return victims.length
  }

  return {
    start,
    list,
    get,
    activeForTarget,
    hasActiveForTarget,
    activeCount,
    cancel,
    retry,
    cancelAll,
    onEvent,
    clearFinished
  }
}

/* -------------------------------------------------------------- 自检任务 */

/**
 * 自检（假）任务：`sleep` + 进度模拟（B08 的 DoD 指定用它验收）。
 *
 * 它不只是测试夹具 —— 也是**给用户的诊断入口**：任务控制台没反应时，
 * 跑一次自检就能区分"服务坏了"（连日志都不出）与"只是没任务"。
 * 因此保留在生产构建里。
 */
export function createDemoJobSpec(opts: {
  steps: number
  stepMs: number
  failAtStep?: number
  targetId?: string
  title?: string
}): JobSpec {
  const { steps, stepMs, failAtStep, targetId } = opts
  return {
    type: 'demo',
    title: opts.title ?? '自检任务（进度模拟）',
    targetId: targetId ?? null,
    async run(ctx) {
      ctx.log(`开始自检：共 ${steps} 步，每步 ${stepMs}ms`)
      for (let i = 1; i <= steps; i++) {
        if (ctx.signal.aborted) throw cancelledError(ctx.jobId)
        await delay(stepMs, ctx.signal)

        if (failAtStep !== undefined && i >= failAtStep) {
          throw new AppError(ErrorCode.E_DEPLOY_STAGE_FAILED, {
            step: i,
            total: steps,
            reason: 'demo-injected-failure'
          })
        }

        const percent = Math.round((i / steps) * 100)
        ctx.progress({
          percent,
          stage: i <= steps / 2 ? '前半程' : '后半程',
          message: `模拟进度 ${i}/${steps}`,
          files: i,
          totalFiles: steps
        })
        if (i % 5 === 0 || i === steps) ctx.log(`已完成 ${i}/${steps} 步（${percent}%）`)
      }
    },
    async cleanup(reason, ctx) {
      ctx.log(`自检任务清理（原因：${reason}）`)
      // 真实任务在这里删远端暂存目录。自检没有远端副作用，只留一条日志作为
      // "清理确实被执行了"的证据 —— DoD 要求验证的正是这条路径。
      await delay(10)
    }
  }
}
