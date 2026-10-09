/**
 * 自动化流水线的 IPC 接线（B21 / T21.5）。
 *
 * 与 `ipc/deploy.ts`、`ipc/script.ts` 同一分工：业务在 `services/pipeline.ts`
 * （不 import electron / ssh2），这里只做四件事 —— 解析目标到一条可用连接、
 * 装配"发布步骤"需要的端口、把运行包成任务、注册通道。
 *
 * ## 发布步骤的端口为什么在这里装配
 *
 * `services/pipeline.ts` 只认识两个函数（`precheck` / `run`），它不知道 SFTP、
 * 不知道连接池、更不知道"发布期间要把连接标记为 busy"。这些恰好都是**接线层
 * 才知道的事**，所以由本文件实现 `PipelineDeployPort` 并注入进去。
 * 好处是流水线的编排逻辑（顺序、失败策略、进度映射、留档）可以在单测里
 * 用一个假端口跑完整条 —— 不需要伪造一条 ssh2 通道。
 *
 * ## 为什么发布步骤也要 `setBusy`
 *
 * `setBusy(connectionId, true)` 的含义是"发布中禁止自动重连"（T03.6）：
 * 换版前后目标路径可能短暂为空，此时自动重连重试只会把真实状态搅得更乱。
 * 流水线里的发布与直接点发布是**同一次换版**，没有理由只给后者加这道保护。
 */
import { registerHandler } from '../infra/ipc'
import { assertTargetIdle } from './target-busy'
import { logger } from '../infra/logger'
import { AppError, ErrorCode } from '../infra/errors'
import { IPC_CHANNELS } from '../../shared/channels'
import {
  pipelineDetailInputSchema,
  pipelineListInputSchema,
  pipelinePreviewInputSchema,
  pipelineRemoveInputSchema,
  pipelineRunInputSchema,
  pipelineRunStepInputSchema,
  pipelineSaveInputSchema
} from '../../shared/contracts/pipeline'
import { pipelineNeedsRemote, type PipelineDeployPort, type PipelineService } from '../services/pipeline'
import { cleanupDeployResidue } from '../services/deploy-residue'
import type { RawExecFn } from '../services/script-runner'
import type { JobService } from '../services/job'
import type { ConnectionService } from '../services/connection'
import type { SshConnectionPool } from '../services/ssh-client'
import type { DeployService } from '../services/deploy'
import type { DeployPortsOpener } from './deploy'
import type { Repositories } from '../db/repositories'

export interface PipelineIpcDeps {
  pipelines: PipelineService
  jobs: JobService
  connections: ConnectionService
  pool: SshConnectionPool
  repo: Repositories
  /** 发布端口装配（与 `registerDeployHandlers` 共用同一份实现） */
  openPorts: DeployPortsOpener
  /**
   * 远端执行通道（**仅供单测注入**）——与 `ipc/script.ts` 的同名注入点同一理由：
   * 只换"通道从哪来"，换不掉使用通道的逻辑（任务化、留档、失败语义、互斥）。
   */
  openRemote?: (targetId: string) => Promise<RawExecFn>
}

/**
 * 装配流水线里「发布」步骤需要的两个动作。
 *
 * 单独导出（而不是就地塞进 `registerPipelineHandlers`）是因为它要在
 * `createPipelineService()` 之前构造好注入进去，而那个调用发生在接线层。
 * 放在这里是为了让"发布步骤怎么落地"只有一处实现 —— 与 `ipc/deploy.ts` 的
 * `createDeployPortsOpener` 同一动机。
 */
export function createPipelineDeployPort(args: {
  openPorts: DeployPortsOpener
  deploy: DeployService
  pool: SshConnectionPool
  /** 第二道清理要读目标行（M6）—— 与 `ipc/deploy.ts` 的 `cleanup` 同一份实现 */
  repo: Repositories
}): PipelineDeployPort {
  return {
    precheck: async (targetId) => {
      // 前置校验自己开一条通道：它只读不写，与后面的发布通道互不影响
      const opened = await args.openPorts(targetId)
      try {
        return await args.deploy.precheck({ targetId, ports: opened.ports })
      } finally {
        // S2：这条通道只活到前置校验结束
        opened.release?.()
      }
    },
    run: async ({ targetId, ctx, releaseId }) => {
      const opened = await args.openPorts(targetId)
      args.pool.setBusy(opened.connectionId, true)
      try {
        return await args.deploy.run({
          targetId,
          ports: opened.ports,
          ctx,
          // releaseId 取任务 id —— 与 `ipc/deploy.ts` 同一约定（"任务的 id 就是
          // 台账行的 id"），于是用户从发布历史与从任务台看到的 id 指向同一件事
          releaseId
        })
      } finally {
        args.pool.setBusy(opened.connectionId, false)
        // S2：发布步骤的通道活到 `deploy.run` 返回为止
        opened.release?.()
      }
    },
    // M6：与直接点发布共用同一份残留清理（避免两个入口各写一遍、迟早漏一处）
    cleanupResidue: (input) =>
      cleanupDeployResidue(
        {
          repo: args.repo,
          openPorts: args.openPorts,
          cleanResidue: (i) => args.deploy.cleanResidue(i),
          setBusy: (connectionId, busy) => args.pool.setBusy(connectionId, busy)
        },
        input
      )
  }
}

export function registerPipelineHandlers(deps: PipelineIpcDeps): void {
  const { pipelines, jobs, connections, pool, repo } = deps

  /** 解析目标 → 一条在线的连接 → 一个"把命令送过去并流式收输出"的函数。 */
  async function openRemote(targetId: string): Promise<RawExecFn> {
    if (deps.openRemote) return deps.openRemote(targetId)

    const target = repo.targets.get(targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId })

    const env = repo.environments.get(target.environmentId)
    if (!env) throw new AppError(ErrorCode.E_NOT_FOUND, { environmentId: target.environmentId })

    const connectionId = env.connectionId
    if (!pool.isOnline(connectionId)) await connections.connect(connectionId)

    return (command, opts) => pool.execRaw(connectionId, command, opts)
  }

  /* ---------------------------------------------------------------- 定义 */

  registerHandler(IPC_CHANNELS.PIPELINES_LIST, pipelineListInputSchema, ({ targetId }) =>
    pipelines.list(targetId)
  )

  registerHandler(IPC_CHANNELS.PIPELINES_GET, pipelineDetailInputSchema, ({ pipelineId }) =>
    pipelines.get(pipelineId)
  )

  registerHandler(IPC_CHANNELS.PIPELINES_SAVE, pipelineSaveInputSchema, (input) => {
    const view = pipelines.save(input)
    logger.info(
      `pipelines.save: id=${view.pipelineId} target=${view.targetId} steps=${view.steps.length}`
    )
    return view
  })

  registerHandler(IPC_CHANNELS.PIPELINES_REMOVE, pipelineRemoveInputSchema, ({ pipelineId }) => {
    pipelines.remove(pipelineId)
    return { removed: true }
  })

  // 「会执行什么」：纯本地，不连服务器 —— 确认对话框据此渲染
  registerHandler(IPC_CHANNELS.PIPELINES_PREVIEW, pipelinePreviewInputSchema, ({ pipelineId }) =>
    pipelines.preview(pipelineId)
  )

  /* ---------------------------------------------------------------- 运行 */

  /**
   * 准备一次运行的公共部分：查定义 → 互斥守卫 → 组装远端通道。
   *
   * 三个动作的顺序刻意如此：先用**最便宜**的方式确认流水线存在（本地一行查询），
   * 再回答"现在能不能跑"，最后才由服务层做生产环境的目标名确认。
   */
  function prepare(pipelineId: string): { targetId: string; needsRemote: boolean } {
    const view = pipelines.get(pipelineId)
    assertTargetIdle(jobs, view.targetId, { action: '跑流水线' })
    return { targetId: view.targetId, needsRemote: pipelineNeedsRemote(view) }
  }

  registerHandler(IPC_CHANNELS.PIPELINES_RUN, pipelineRunInputSchema, (input) => {
    const { targetId, needsRemote } = prepare(input.pipelineId)
    const view = jobs.start(
      pipelines.runJob(input, needsRemote ? { openRemote: () => openRemote(targetId) } : {})
    )
    logger.info(
      `pipelines.run: id=${input.pipelineId} target=${targetId} job=${view.jobId}`
    )
    return view
  })

  registerHandler(IPC_CHANNELS.PIPELINES_RUN_STEP, pipelineRunStepInputSchema, (input) => {
    const { targetId, needsRemote } = prepare(input.pipelineId)
    const view = jobs.start(
      pipelines.stepRunJob(input, needsRemote ? { openRemote: () => openRemote(targetId) } : {})
    )
    logger.info(
      `pipelines.runStep: id=${input.pipelineId} seq=${input.seq} target=${targetId} job=${view.jobId}`
    )
    return view
  })
}
