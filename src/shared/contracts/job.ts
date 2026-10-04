/**
 * 任务（Job）的跨进程契约（T08.3 / T08.4 / T08.5）。
 *
 * 为什么任务状态要放在 shared：主进程产状态、preload 转发事件、渲染进程渲染
 * 任务条与日志 —— 三端必须对同一组字段名与取值达成一致。写在这里的好处是
 * 任何一端改动都会在另外两端编译失败，而不是变成"UI 上那个字段永远空白"。
 *
 * 与 DB 的关系：**任务不进数据库**（方案书 §6.11 明确为"单主进程内任务队列"）。
 * 任务是一次运行期的进度载体，进程重启即失效；持久化的是发布结果（`releases` 表）。
 * 这条边界很重要：如果任务也落库，"应用崩溃后还挂着一个 running 任务"就会变成
 * 需要额外清理的脏数据（那属于 B14 的残留扫描）。
 */
import { z } from 'zod'

/* ---------------------------------------------------------------- 状态 */

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export const jobStatusSchema = z.enum(JOB_STATUSES)
export type JobStatus = z.infer<typeof jobStatusSchema>

/** 运行中（占用资源、退出前需要确认）的状态集合。 */
export const ACTIVE_JOB_STATUSES = ['queued', 'running'] as const

/** 终态：不会再变化，可以安全地展示"重试"按钮。 */
export function isTerminalStatus(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

export function isActiveStatus(status: JobStatus): boolean {
  return !isTerminalStatus(status)
}

export const JOB_STATUS_TEXT: Record<JobStatus, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

export function describeJobStatus(status: JobStatus): string {
  return JOB_STATUS_TEXT[status] ?? '未知'
}

/** Element Plus 的 tag type（UI 直接用，避免各组件自己 switch）。 */
export function jobStatusTagType(status: JobStatus): 'info' | 'primary' | 'success' | 'danger' {
  switch (status) {
    case 'queued':
      return 'info'
    case 'running':
      return 'primary'
    case 'succeeded':
      return 'success'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'info'
  }
}

/* ------------------------------------------------------------ 任务类型 */

/**
 * 任务类型。B08 只用到 `demo`（DoD 的假任务）；
 * 其余取值是 B10~B14 会陆续接上的发布/回滚/下载等。
 * 这里先定全集，是因为 UI 文案与图标要按类型区分，早定比"每批次改一遍契约"省事。
 */
export const JOB_TYPES = [
  'demo',
  'deploy',
  'rollback',
  'download',
  'archive',
  'reconcile',
  'health'
] as const
export const jobTypeSchema = z.enum(JOB_TYPES)
export type JobType = z.infer<typeof jobTypeSchema>

export const JOB_TYPE_TEXT: Record<JobType, string> = {
  demo: '自检',
  deploy: '发布',
  rollback: '回滚',
  download: '下载',
  archive: '归档',
  reconcile: '对账',
  health: '体检'
}

export function describeJobType(type: JobType): string {
  return JOB_TYPE_TEXT[type] ?? type
}

/* -------------------------------------------------------------- 日志 */

export const jobLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
export type JobLogLevel = z.infer<typeof jobLogLevelSchema>

export const jobLogLineSchema = z.object({
  /** ISO-8601 时间戳 */
  at: z.string(),
  level: jobLogLevelSchema,
  text: z.string()
})
export type JobLogLine = z.infer<typeof jobLogLineSchema>

/**
 * 每个任务保留的日志行上限（环形缓冲）。
 *
 * 必须有上限：一次 5000 文件的上传会打出上万行，不设界会把主进程内存吃光。
 * 超出后丢最旧的，并如实上报丢了多少行 —— 让用户知道"日志被截断过"，
 * 而不是以为这就是全部。
 */
export const MAX_JOB_LOGS = 2000

/* -------------------------------------------------------------- 进度 */

/**
 * 进度载荷（`job:progress` 事件，方案书 §6.11 要求节流 200 ms）。
 *
 * 字段都做成可选：不同任务能给出的信息不同（上传知道字节数，归档只知道文件数），
 * 强行要求全部字段只会逼调用方填假数据。
 */
export const jobProgressSchema = z.object({
  jobId: z.string().min(1),
  status: jobStatusSchema,
  /** 0~100；由 JobService 钳制并保证单调不减 */
  percent: z.number().min(0).max(100),
  /** 阶段名，如"上传"、"校验" */
  stage: z.string().optional(),
  /** 一句话说明，如"上传 order.jar 31/46 MB" */
  message: z.string().optional(),
  bytes: z.number().int().min(0).optional(),
  totalBytes: z.number().int().min(0).optional(),
  files: z.number().int().min(0).optional(),
  totalFiles: z.number().int().min(0).optional(),
  /** 用户已请求取消、但任务还没停下来（UI 显示"取消中…"） */
  cancelRequested: z.boolean(),
  at: z.string()
})
export type JobProgress = z.infer<typeof jobProgressSchema>

/** 日志批量推送载荷（节流后一次带多行）。 */
export const jobLogBatchSchema = z.object({
  jobId: z.string().min(1),
  lines: z.array(jobLogLineSchema),
  /** 因环形缓冲上限被丢弃的行数（累计） */
  dropped: z.number().int().min(0)
})
export type JobLogBatch = z.infer<typeof jobLogBatchSchema>

/* ------------------------------------------------------------ 任务视图 */

export const jobErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  detail: z.unknown().optional()
})
export type JobErrorInfo = z.infer<typeof jobErrorSchema>

/**
 * 任务视图（列表与 `job:state` 事件共用）。
 *
 * **不含 logs**：日志单独走 `job:log`，否则每推一次状态都要把上千行日志重新序列化一遍。
 */
export const jobViewSchema = z.object({
  jobId: z.string().min(1),
  type: jobTypeSchema,
  title: z.string(),
  targetId: z.string().nullable(),
  status: jobStatusSchema,
  percent: z.number().min(0).max(100),
  stage: z.string().optional(),
  message: z.string().optional(),
  cancelRequested: z.boolean(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: jobErrorSchema.nullable(),
  /** 当前保留的日志行数 */
  logCount: z.number().int().min(0),
  /** 被环形缓冲丢弃的行数 */
  droppedLogs: z.number().int().min(0)
})
export type JobView = z.infer<typeof jobViewSchema>

/* ------------------------------------------------------------ 入参契约 */

export const jobIdInputSchema = z.object({ jobId: z.string().min(1) })
export type JobIdInput = z.infer<typeof jobIdInputSchema>

/** 取消请求的结果。`cancelled:false` 时 `reason` 说明为什么没取消，UI 据此给文案。 */
export const jobCancelResultSchema = z.object({
  cancelled: z.boolean(),
  reason: z.enum(['not-found', 'already-finished']).optional()
})
export type JobCancelResult = z.infer<typeof jobCancelResultSchema>

export const jobClearResultSchema = z.object({ removed: z.number().int().min(0) })
export type JobClearResult = z.infer<typeof jobClearResultSchema>

export const jobTargetInputSchema = z.object({ targetId: z.string().min(1) })
export type JobTargetInput = z.infer<typeof jobTargetInputSchema>

export const jobListFilterSchema = z
  .object({
    status: z.array(jobStatusSchema).optional(),
    targetId: z.string().min(1).optional()
  })
  .optional()
export type JobListFilter = z.infer<typeof jobListFilterSchema>

/**
 * 自检任务（DoD 的"假任务"）入参。
 *
 * 保留在契约里而不是测试专用：它同时也是**给用户的诊断入口** ——
 * 任务条显示不出来时，点一下就能区分"服务坏了"还是"只是没任务"。
 *
 * 注意字段全部可选、**不用 `z.default()`**：带 default 的 schema 其输入类型
 * 与输出类型不同（输入可省略、输出必有），而 IPC 的 `registerHandler` 要求
 * schema 与 handler 共用同一个类型；默认值因此放在 `DEMO_JOB_DEFAULTS`，
 * 由 handler 合并。这样"默认值只声明一处"，也不用跟类型系统较劲。
 */
export const DEMO_JOB_DEFAULTS = { steps: 20, stepMs: 150 } as const

export const jobDemoInputSchema = z
  .object({
    /** 进度步数 */
    steps: z.number().int().min(1).max(200).optional(),
    /** 每步耗时（毫秒） */
    stepMs: z.number().int().min(1).max(5000).optional(),
    /** 在第几步失败（1 起）；不传则成功结束 */
    failAtStep: z.number().int().min(1).max(200).optional(),
    /** 挂到某个目标上（用于验证"同目标串行"） */
    targetId: z.string().min(1).optional(),
    /** 任务标题（默认"自检任务"） */
    title: z.string().min(1).max(120).optional()
  })
  .optional()
export type JobDemoInput = z.infer<typeof jobDemoInputSchema>

/** 合并默认值后的自检任务参数。 */
export interface JobDemoOptions {
  steps: number
  stepMs: number
  failAtStep?: number
  targetId?: string
  title?: string
}

/** 把可选入参补全成完整参数（默认值只声明在 `DEMO_JOB_DEFAULTS`）。 */
export function resolveDemoOptions(input?: JobDemoInput): JobDemoOptions {
  return {
    steps: input?.steps ?? DEMO_JOB_DEFAULTS.steps,
    stepMs: input?.stepMs ?? DEMO_JOB_DEFAULTS.stepMs,
    ...(input?.failAtStep === undefined ? {} : { failAtStep: input.failAtStep }),
    ...(input?.targetId === undefined ? {} : { targetId: input.targetId }),
    ...(input?.title === undefined ? {} : { title: input.title })
  }
}
