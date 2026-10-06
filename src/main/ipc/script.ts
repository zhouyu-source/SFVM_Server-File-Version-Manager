/**
 * 自定义脚本的 IPC 接线（B20 / T20.7）。
 *
 * 与 `ipc/deploy.ts` 同一分工：业务在 `services/script.ts`（不 import electron），
 * 这里只做三件事 —— 解析目标到一条可用连接、把执行包成任务、注册通道。
 *
 * ## 为什么远端通道是**懒**开的
 *
 * `openRemote` 只在任务的 `run()` 里被调用。若在 IPC handler 里就把连接连上，
 * "连不上"会变成一次普通的调用失败：任务台里什么都不留，用户只看到一个错误气泡，
 * 没有任何日志可看。放进任务里则变成一次**任务失败**，带错误码、带日志、
 * 与发布的行为一致（失败也要留痕）。
 */
import { registerHandler } from '../infra/ipc'
import { assertTargetIdle } from './target-busy'
import { logger } from '../infra/logger'
import { AppError, ErrorCode } from '../infra/errors'
import { IPC_CHANNELS } from '../../shared/channels'
import {
  DEFAULT_SCRIPT_RUN_LIST_LIMIT,
  scriptRunDetailInputSchema,
  scriptRunListInputSchema,
  scriptRunStepInputSchema
} from '../../shared/contracts/script'
import type { ScriptJobIo, ScriptService } from '../services/script'
import type { RawExecFn } from '../services/script-runner'
import type { JobService } from '../services/job'
import type { ConnectionService } from '../services/connection'
import type { SshConnectionPool } from '../services/ssh-client'
import type { Repositories } from '../db/repositories'

export interface ScriptIpcDeps {
  scripts: ScriptService
  jobs: JobService
  connections: ConnectionService
  pool: SshConnectionPool
  repo: Repositories
  /**
   * 远端执行通道（**仅供单测注入**）。
   *
   * 生产路径是"目标 → 环境 → 连接 → `pool.execRaw()`"。单测若要覆盖接线，
   * 就得伪造一整条 ssh2 通道；那种替身越像真的越会掩盖真实差异（B07 的教训）。
   * 所以这里只换"通道从哪来"，**换不掉使用通道的逻辑**（任务化、留档、失败语义）。
   */
  openRemote?: (targetId: string) => Promise<RawExecFn>
}

export function registerScriptHandlers(deps: ScriptIpcDeps): void {
  const { scripts, jobs, connections, pool, repo } = deps

  /** 解析目标 → 一条在线的连接 → 一个"把命令送过去并流式收输出"的函数。 */
  async function openRemote(targetId: string): Promise<RawExecFn> {
    if (deps.openRemote) return deps.openRemote(targetId)

    const target = repo.targets.get(targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId })

    const env = repo.environments.get(target.environmentId)
    if (!env) throw new AppError(ErrorCode.E_NOT_FOUND, { environmentId: target.environmentId })

    const connectionId = env.connectionId
    if (!pool.isOnline(connectionId)) await connections.connect(connectionId)

    // 这一行就是"用户脚本"这条通道的入口：`execRaw` 内部会再查一次总闸
    return (command, opts) => pool.execRaw(connectionId, command, opts)
  }

  /* ------------------------------------------------------------ 能力探测 */

  registerHandler(IPC_CHANNELS.SCRIPTS_CAPABILITIES, null, () => scripts.capabilities())

  /* ------------------------------------------------------------ 单步执行 */

  registerHandler(IPC_CHANNELS.SCRIPTS_RUN_STEP, scriptRunStepInputSchema, (input) => {
    /**
     * 同一目标上已有任务（脚本、流水线、发布、回滚……）时**直接拒绝**，不排进队列。
     *
     * 与 `deploy.start` 共用一处守卫：队列会把"手滑点了两次"变成"真的跑了两遍"，
     * 而这类脚本里通常有"关服务 / 启服务"这种**跑两遍就会坏**的操作。
     * 发布与脚本之间同样要拦 —— 它们确实共用 `t:<targetId>` 车道不会并发，
     * 但"点了一下没反应、过一会儿突然开始跑"是更差的结果。
     */
    assertTargetIdle(jobs, input.targetId, { action: '执行脚本' })

    const io: ScriptJobIo =
      input.kind === 'remote' ? { openRemote: () => openRemote(input.targetId) } : {}

    const view = jobs.start(scripts.stepJob(input, io))
    logger.info(
      `scripts.runStep: target=${input.targetId} kind=${input.kind} job=${view.jobId}`
    )
    return view
  })

  /* ------------------------------------------------------------ 运行记录 */

  registerHandler(IPC_CHANNELS.SCRIPTS_RUNS, scriptRunListInputSchema, ({ targetId, limit }) =>
    scripts.list(targetId, limit ?? DEFAULT_SCRIPT_RUN_LIST_LIMIT)
  )

  registerHandler(IPC_CHANNELS.SCRIPTS_RUN_DETAIL, scriptRunDetailInputSchema, ({ runId }) =>
    scripts.detail(runId)
  )
}
