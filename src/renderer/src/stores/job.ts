/**
 * 任务 store（T08.6）。
 *
 * 与 connection / workspace store 同样的约定：**IPC 调用集中在 store**，组件只读状态。
 *
 * 这里额外承担一件事：**把三个事件流合并成一份可直接渲染的状态**。
 * 主进程为了性能把"状态 / 进度 / 日志"分成三类事件（进度与日志还带节流），
 * 如果让组件自己去拼，每个用到任务的组件都要重复一遍合并逻辑，
 * 而且很容易漏掉"进度事件里也带着最新状态"这一点，导致列表里的百分比不动。
 *
 * 日志在渲染进程也做一次上限裁剪：主进程已限制，但一个长期开着的窗口
 * 累积多个任务后仍会吃掉内存。裁剪到同一上限，行为一致。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, IpcBusinessError } from '../api'
import {
  MAX_JOB_LOGS,
  describeJobStatus,
  describeJobType,
  isTerminalStatus,
  type JobDemoInput,
  type JobLogLine,
  type JobProgress,
  type JobStatus,
  type JobView
} from '../../../shared/contracts/job'
import { formatBytes, formatDuration, formatPercent, formatTime } from '../utils/format'

/** 进度事件里的"轻量状态"，用于把列表里的百分比也带上。 */
type ProgressSlice = Pick<JobProgress, 'percent' | 'cancelRequested'> &
  Partial<Pick<JobProgress, 'stage' | 'message' | 'bytes' | 'totalBytes' | 'files' | 'totalFiles'>>

export const useJobStore = defineStore('job', () => {
  /* ------------------------------------------------------------- state */

  /** 任务元数据，新的在前（与主进程 list() 的顺序一致） */
  const jobs = ref<JobView[]>([])
  const progressById = ref<Record<string, ProgressSlice>>({})
  const logsById = ref<Record<string, JobLogLine[]>>({})
  const droppedById = ref<Record<string, number>>({})

  const selectedJobId = ref<string | null>(null)
  /** 底部控制台是否展开 */
  const expanded = ref(false)
  const loading = ref(false)
  const error = ref('')

  let unsubscribers: Array<() => void> = []

  /* ----------------------------------------------------------- getters */

  const activeJobs = computed(() =>
    jobs.value.filter((j) => !isTerminalStatus(j.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  )

  const activeCount = computed(() => activeJobs.value.length)

  /** 收起的任务条展示哪一个：最早开始的那个（用户最关心的"还要多久"） */
  const primaryJob = computed(() => activeJobs.value[0] ?? null)

  const finishedCount = computed(() => jobs.value.filter((j) => isTerminalStatus(j.status)).length)

  const selectedJob = computed(
    () => jobs.value.find((j) => j.jobId === selectedJobId.value) ?? null
  )

  const selectedLogs = computed<JobLogLine[]>(() =>
    selectedJobId.value ? (logsById.value[selectedJobId.value] ?? []) : []
  )

  const primaryProgress = computed<ProgressSlice | null>(() =>
    primaryJob.value ? (progressById.value[primaryJob.value.jobId] ?? null) : null
  )

  /** 是否有失败的任务（用于给底部条加红色提醒） */
  const hasFailure = computed(() => jobs.value.some((j) => j.status === 'failed'))

  /* ----------------------------------------------------------- actions */

  /** 合并一个状态事件（upsert，保持"新的在前"） */
  function upsert(job: JobView): void {
    const i = jobs.value.findIndex((j) => j.jobId === job.jobId)
    if (i >= 0) jobs.value[i] = job
    else jobs.value = [job, ...jobs.value]
  }

  function applyProgress(p: JobProgress): void {
    progressById.value = {
      ...progressById.value,
      [p.jobId]: {
        percent: p.percent,
        cancelRequested: p.cancelRequested,
        ...(p.stage === undefined ? {} : { stage: p.stage }),
        ...(p.message === undefined ? {} : { message: p.message }),
        ...(p.bytes === undefined ? {} : { bytes: p.bytes }),
        ...(p.totalBytes === undefined ? {} : { totalBytes: p.totalBytes }),
        ...(p.files === undefined ? {} : { files: p.files }),
        ...(p.totalFiles === undefined ? {} : { totalFiles: p.totalFiles })
      }
    }
    // 进度事件里带着 status/percent：同步进列表，否则列表里的百分比会一动不动
    const i = jobs.value.findIndex((j) => j.jobId === p.jobId)
    if (i >= 0) {
      jobs.value[i] = {
        ...(jobs.value[i] as JobView),
        status: p.status,
        percent: p.percent,
        cancelRequested: p.cancelRequested,
        ...(p.stage === undefined ? {} : { stage: p.stage }),
        ...(p.message === undefined ? {} : { message: p.message })
      }
    }
  }

  function applyLogBatch(jobId: string, lines: JobLogLine[], dropped: number): void {
    const merged = [...(logsById.value[jobId] ?? []), ...lines]
    logsById.value = {
      ...logsById.value,
      [jobId]: merged.length > MAX_JOB_LOGS ? merged.slice(merged.length - MAX_JOB_LOGS) : merged
    }
    droppedById.value = { ...droppedById.value, [jobId]: dropped }
  }

  /** 订阅三个事件流。重复调用安全（先退订）。 */
  function subscribe(): void {
    unsubscribe()
    unsubscribers = [
      api.jobs.onState((job) => upsert(job)),
      api.jobs.onProgress((p) => applyProgress(p)),
      api.jobs.onLog((batch) => applyLogBatch(batch.jobId, batch.lines, batch.dropped))
    ]
  }

  function unsubscribe(): void {
    for (const off of unsubscribers) off()
    unsubscribers = []
  }

  /** 首次进入：**先订阅再拉列表**，否则会漏掉拉列表期间产生的进度 */
  async function init(): Promise<void> {
    subscribe()
    await fetchList()
  }

  async function fetchList(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const list = await api.jobs.list()
      jobs.value = list
      // 选中的任务可能已被清理
      if (selectedJobId.value && !list.some((j) => j.jobId === selectedJobId.value)) {
        selectedJobId.value = list[0]?.jobId ?? null
      }
    } catch (e) {
      error.value = (e as IpcBusinessError).toUserText()
    } finally {
      loading.value = false
    }
  }

  function select(jobId: string | null): void {
    selectedJobId.value = jobId
  }

  function setExpanded(v: boolean): void {
    expanded.value = v
  }

  function toggleExpanded(): void {
    expanded.value = !expanded.value
  }

  /** 取消并把该任务设为当前查看项（用户点取消后一定想看到它） */
  async function cancel(jobId: string): Promise<boolean> {
    try {
      const r = await api.jobs.cancel(jobId)
      selectedJobId.value = jobId
      return r.cancelled
    } catch (e) {
      error.value = (e as IpcBusinessError).toUserText()
      return false
    }
  }

  async function retry(jobId: string): Promise<JobView | null> {
    try {
      const job = await api.jobs.retry(jobId)
      upsert(job)
      selectedJobId.value = job.jobId
      expanded.value = true
      return job
    } catch (e) {
      error.value = (e as IpcBusinessError).toUserText()
      return null
    }
  }

  /** 启动自检任务（DoD 用；也是排障入口） */
  async function startDemo(input?: JobDemoInput): Promise<JobView | null> {
    try {
      const job = await api.jobs.startDemo(input)
      upsert(job)
      selectedJobId.value = job.jobId
      expanded.value = true
      return job
    } catch (e) {
      error.value = (e as IpcBusinessError).toUserText()
      return null
    }
  }

  async function clearFinished(): Promise<number> {
    try {
      const r = await api.jobs.clearFinished()
      await fetchList()
      // 清掉本地缓存，避免"列表空了但日志还占着内存"
      const alive = new Set(jobs.value.map((j) => j.jobId))
      const keep = <T>(rec: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(rec).filter(([id]) => alive.has(id)))
      logsById.value = keep(logsById.value)
      droppedById.value = keep(droppedById.value)
      progressById.value = keep(progressById.value)
      return r.removed
    } catch (e) {
      error.value = (e as IpcBusinessError).toUserText()
      return 0
    }
  }

  /* --------------------------------------------------------- 展示辅助 */

  function statusText(job: JobView): string {
    return job.cancelRequested && !isTerminalStatus(job.status)
      ? '取消中…'
      : describeJobStatus(job.status)
  }

  function typeText(job: JobView): string {
    return describeJobType(job.type)
  }

  /**
   * 拼"复制诊断信息"的文本（T08.6：失败任务可展开并复制诊断）。
   *
   * 目标是"贴给别人就能定位问题"，所以包含：任务标识、目标、状态、
   * 起止时间与耗时、错误码与建议、以及**完整日志**。
   */
  function diagnosticsText(jobId: string): string {
    const job = jobs.value.find((j) => j.jobId === jobId)
    if (!job) return ''
    const lines = logsById.value[jobId] ?? []
    const dropped = droppedById.value[jobId] ?? job.droppedLogs
    const head = [
      `任务：${job.title}（${describeJobType(job.type)}）`,
      `任务号：${job.jobId}`,
      `目标：${job.targetId ?? '（无）'}`,
      `状态：${describeJobStatus(job.status)}${job.cancelRequested ? '（已请求取消）' : ''}`,
      `进度：${formatPercent(job.percent)}${job.stage ? ` · ${job.stage}` : ''}`,
      `创建：${job.createdAt}`,
      `开始：${job.startedAt ?? '-'}`,
      `结束：${job.finishedAt ?? '-'}`,
      `耗时：${formatDuration(job.startedAt, job.finishedAt)}`,
      `日志：${job.logCount} 行${dropped > 0 ? `（已省略最早 ${dropped} 行）` : ''}`
    ]
    if (job.error) {
      head.push(`错误码：${job.error.code}`, `错误说明：${job.error.message}`)
      if (job.error.hint) head.push(`建议：${job.error.hint}`)
      if (job.error.detail !== undefined) {
        head.push(`明细：${safeJson(job.error.detail)}`)
      }
    }
    return [...head, '', '--- 日志 ---', ...lines.map((l) => `[${formatTime(l.at)}] ${l.text}`)].join(
      '\n'
    )
  }

  function safeJson(v: unknown): string {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }

  /** 供组件显示的"一句话进度" */
  function progressText(job: JobView): string {
    const p = progressById.value[job.jobId]
    if (!p) return formatPercent(job.percent)
    if (p.totalBytes !== undefined) {
      return `${formatPercent(p.percent)} · ${formatBytes(p.bytes)} / ${formatBytes(p.totalBytes)}`
    }
    if (p.totalFiles !== undefined) {
      return `${formatPercent(p.percent)} · ${p.files ?? 0}/${p.totalFiles} 个文件`
    }
    return p.message ?? formatPercent(p.percent)
  }

  /** 组件卸载时调用，避免热重载后重复订阅 */
  function dispose(): void {
    unsubscribe()
    unsubscribers = []
  }

  return {
    // state
    jobs,
    progressById,
    logsById,
    droppedById,
    selectedJobId,
    expanded,
    loading,
    error,
    // getters
    activeJobs,
    activeCount,
    finishedCount,
    primaryJob,
    primaryProgress,
    selectedJob,
    selectedLogs,
    hasFailure,
    // actions
    init,
    subscribe,
    unsubscribe,
    fetchList,
    select,
    setExpanded,
    toggleExpanded,
    cancel,
    retry,
    startDemo,
    clearFinished,
    diagnosticsText,
    progressText,
    statusText,
    typeText,
    dispose
  }
})

/** 供组件做状态着色时复用（避免组件自己写 switch）。 */
export function jobStatusClass(status: JobStatus): string {
  switch (status) {
    case 'running':
      return 'st-running'
    case 'succeeded':
      return 'st-ok'
    case 'failed':
      return 'st-err'
    case 'cancelled':
      return 'st-muted'
    default:
      return 'st-queued'
  }
}
