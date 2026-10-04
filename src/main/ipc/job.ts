/**
 * 任务的 IPC 接线（T08.4 / T08.5）与应用退出保护（T08.7）。
 *
 * 本文件是"electron 胶水层"：业务与队列全在 `services/job.ts`，
 * 这里只做三件事：
 *
 * 1. 注册 invoke 通道（注册表查询 / 取消 / 重试 / 自检任务）；
 * 2. 把 JobService 的事件推给渲染进程，**按方案书 §6.11 做 200ms 节流**；
 * 3. 退出保护：有运行中任务时，关窗口 / 退出都要先确认。
 *
 * ## 节流与顺序（容易做错的地方）
 *
 * - `job:state` **立即**推送：状态跃迁是低频且关键的信息，压着不发会让界面"卡住"。
 * - `job:progress` / `job:log` 走节流（首边沿 + 尾边沿，见 `infra/throttle.ts`）。
 * - 任务进入终态时，先把挂起的进度与日志 **flushNow**，再推状态事件 ——
 *   否则用户看到的最后一条进度不是 100%，也不是失败原因那条日志。
 */
import {
  app,
  BrowserWindow,
  dialog,
  type Event as ElectronEvent,
  type MessageBoxOptions
} from 'electron'
import { registerHandler } from '../infra/ipc'
import { logger } from '../infra/logger'
import { createThrottledFlush, type ThrottledFlush } from '../infra/throttle'
import { IPC_CHANNELS } from '../../shared/channels'
import {
  isTerminalStatus,
  jobDemoInputSchema,
  jobIdInputSchema,
  jobListFilterSchema,
  jobTargetInputSchema,
  resolveDemoOptions,
  type JobLogBatch,
  type JobLogLine,
  type JobProgress,
  type JobView
} from '../../shared/contracts/job'
import { createDemoJobSpec, type JobService } from '../services/job'

/** 进度推送节流窗口（方案书 §6.11）。 */
export const JOB_PROGRESS_THROTTLE_MS = 200

/** 默认的窗口广播实现；测试可注入替身。 */
export type PushFn = (channel: string, payload: unknown) => void

function toAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export interface JobIpcDeps {
  jobs: JobService
  push?: PushFn
  throttleMs?: number
}

/* ------------------------------------------------------------ 事件推送 */

interface JobFlushers {
  progress: ThrottledFlush<JobProgress, JobProgress>
  log: ThrottledFlush<JobLogLine, JobLogLine[]>
  /** 日志累计丢弃数（服务侧上报） */
  dropped: number
}

/**
 * 建立事件推送：返回取消订阅函数（应用退出 / 测试收尾用）。
 */
export function attachJobEventPush(deps: JobIpcDeps): () => void {
  const push = deps.push ?? toAllWindows
  const throttleMs = deps.throttleMs ?? JOB_PROGRESS_THROTTLE_MS
  const flushers = new Map<string, JobFlushers>()

  function flushersFor(jobId: string): JobFlushers {
    const existing = flushers.get(jobId)
    if (existing) return existing
    const created: JobFlushers = {
      dropped: 0,
      progress: createThrottledFlush<JobProgress, JobProgress>({
        intervalMs: throttleMs,
        reduce: (_acc, next) => next,
        onFlush: (p) => push(IPC_CHANNELS.EVT_JOB_PROGRESS, p)
      }),
      log: createThrottledFlush<JobLogLine, JobLogLine[]>({
        intervalMs: throttleMs,
        reduce: (acc, next) => {
          const arr = acc ?? []
          arr.push(next)
          return arr
        },
        onFlush: (lines) => {
          const batch: JobLogBatch = { jobId, lines, dropped: created.dropped }
          push(IPC_CHANNELS.EVT_JOB_LOG, batch)
        }
      })
    }
    flushers.set(jobId, created)
    return created
  }

  function release(jobId: string): void {
    const f = flushers.get(jobId)
    if (!f) return
    f.progress.dispose()
    f.log.dispose()
    flushers.delete(jobId)
  }

  const off = deps.jobs.onEvent((ev) => {
    try {
      if (ev.kind === 'progress') {
        flushersFor(ev.progress.jobId).progress.push(ev.progress)
        return
      }
      if (ev.kind === 'log') {
        const f = flushersFor(ev.jobId)
        f.dropped = ev.dropped
        f.log.push(ev.line)
        return
      }
      // state
      const view = ev.job
      if (isTerminalStatus(view.status)) {
        const f = flushers.get(view.jobId)
        if (f) {
          // 先把尾巴送出去，保证"最后一条进度 / 最后一条日志"到达后再报状态
          f.progress.flushNow()
          f.log.flushNow()
        }
        push(IPC_CHANNELS.EVT_JOB_STATE, view)
        release(view.jobId)
      } else {
        push(IPC_CHANNELS.EVT_JOB_STATE, view)
      }
    } catch (err) {
      logger.warn(`job event push failed: ${(err as Error).message}`)
    }
  })

  return () => {
    off()
    for (const id of [...flushers.keys()]) release(id)
  }
}

/* ------------------------------------------------------------ IPC 通道 */

export function registerJobHandlers(deps: JobIpcDeps): void {
  const { jobs } = deps

  registerHandler(IPC_CHANNELS.JOB_LIST, jobListFilterSchema, (filter) => jobs.list(filter))

  registerHandler(IPC_CHANNELS.JOB_GET, jobIdInputSchema, ({ jobId }) => jobs.get(jobId) ?? null)

  registerHandler(IPC_CHANNELS.JOB_ACTIVE_FOR_TARGET, jobTargetInputSchema, ({ targetId }) =>
    jobs.activeForTarget(targetId)
  )

  registerHandler(IPC_CHANNELS.JOB_CANCEL, jobIdInputSchema, ({ jobId }) => jobs.cancel(jobId))

  registerHandler(IPC_CHANNELS.JOB_RETRY, jobIdInputSchema, ({ jobId }) => jobs.retry(jobId))

  registerHandler(IPC_CHANNELS.JOB_CLEAR_FINISHED, null, () => ({ removed: jobs.clearFinished() }))

  // 自检任务：DoD 指定的"假任务"，同时是给用户的诊断入口
  registerHandler(IPC_CHANNELS.JOB_START_DEMO, jobDemoInputSchema, (input) => {
    const opts = resolveDemoOptions(input)
    return jobs.start(
      createDemoJobSpec({
        steps: opts.steps,
        stepMs: opts.stepMs,
        ...(opts.failAtStep === undefined ? {} : { failAtStep: opts.failAtStep }),
        ...(opts.targetId === undefined ? {} : { targetId: opts.targetId }),
        ...(opts.title === undefined ? {} : { title: opts.title })
      })
    )
  })
}

/* ------------------------------------------------------------ 退出保护 */

export interface JobGuard {
  /** 给窗口挂上"关闭前确认"（T08.7） */
  attachWindow(win: BrowserWindow): void
  /** 用户已选择放弃（供自检） */
  isBypassed(): boolean
  dispose(): void
}

export interface JobGuardDeps {
  jobs: JobService
  /** 允许"放弃并退出"前的等待上限（毫秒）。默认 5000 */
  abandonTimeoutMs?: number
  /** 便于测试注入"用户点了哪个按钮" */
  confirm?: (active: JobView[]) => Promise<boolean>
}

export async function confirmAbandon(
  active: JobView[],
  parent: BrowserWindow | null
): Promise<boolean> {
  const list = active
    .slice(0, 5)
    .map((j) => `· ${j.title}（${Math.round(j.percent)}%）`)
    .join('\n')
  const more = active.length > 5 ? `\n… 另有 ${active.length - 5} 个任务` : ''

  const options: MessageBoxOptions = {
    type: 'warning',
    title: '有任务正在进行',
    message: `还有 ${active.length} 个任务正在进行，确定要退出吗？`,
    detail:
      `${list}${more}\n\n` +
      '「继续等待」会保持应用开启，你可以先在底部任务控制台取消单个任务。\n' +
      '「取消任务并退出」会停止这些任务并清理由它们产生的远端残留。',
    buttons: ['继续等待', '取消任务并退出'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }

  const win = parent && !parent.isDestroyed() ? parent : null
  const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return r.response === 1
}

/**
 * 建立退出保护（T08.7，方案书 §6.11）。
 *
 * 两条路径都要守：
 * - 用户点窗口关闭按钮 → `win.on('close')`（Windows / Linux 上这条路最常见）
 * - 菜单退出 / `app.quit()` / 系统注销 → `app.on('before-quit')`
 *
 * 只守 `before-quit` 是不够的：Windows 上关窗口时**窗口已经销毁**，
 * 弹窗会变成没有父窗口的孤儿框；而且 `window-all-closed` 里那次 `app.quit()`
 * 发生在窗口消失之后，用户会觉得"点关闭没反应"。
 */
export function createJobGuard(deps: JobGuardDeps): JobGuard {
  const { jobs } = deps
  const abandonTimeoutMs = deps.abandonTimeoutMs ?? 5000
  let bypassed = false
  let asking = false

  async function handleQuitRequest(parent: BrowserWindow | null): Promise<void> {
    if (asking || bypassed) return
    const active = jobs.list().filter((j) => !isTerminalStatus(j.status))
    if (active.length === 0) return

    asking = true
    try {
      const abandon = deps.confirm ? await deps.confirm(active) : await confirmAbandon(active, parent)
      if (!abandon) {
        logger.info(`user chose to wait for ${active.length} running job(s)`)
        return
      }
      bypassed = true
      logger.warn(`user chose to abandon ${active.length} running job(s); cancelling before quit`)
      const result = await jobs.cancelAll('quit', { timeoutMs: abandonTimeoutMs })
      logger.warn(
        `quit cleanup done: requested=${result.requested} forced=${result.forced}` +
          (result.forced > 0 ? '（有任务未响应取消信号，已强制标记）' : '')
      )
      // bypassed 已置位，这里再走一次 before-quit 不会被拦
      app.quit()
    } catch (err) {
      logger.error(`quit guard failed: ${(err as Error).message}`)
      // 保护逻辑自身出错时优先让用户退出，不要把人卡在应用里
      bypassed = true
      app.quit()
    } finally {
      asking = false
    }
  }

  const onBeforeQuit = (event: ElectronEvent): void => {
    if (bypassed) return
    const count = jobs.activeCount()
    if (count === 0) return
    event.preventDefault()
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    void handleQuitRequest(win)
  }

  app.on('before-quit', onBeforeQuit)

  return {
    attachWindow(win: BrowserWindow): void {
      win.on('close', (event: ElectronEvent) => {
        if (bypassed) return
        if (jobs.activeCount() === 0) return
        event.preventDefault()
        void handleQuitRequest(win)
      })
    },
    isBypassed: () => bypassed,
    dispose(): void {
      app.removeListener('before-quit', onBeforeQuit)
    }
  }
}
