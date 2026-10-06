/**
 * 回滚的 IPC 接线（T13.1 ~ T13.5）。
 *
 * 与 `ipc/deploy.ts` 同构，只做四件事：解析连接 → 装配端口 → 包成任务 → 注册通道。
 * 业务全在 `services/rollback.ts`（不 import electron / ssh2，可单测）。
 *
 * ## 为什么"同一目标已有发布在跑"要直接拒绝
 *
 * 回滚与发布动的是同一批路径（目标路径 / 归档目录 / 那把锁）。排队执行听起来友好，
 * 实际后果是：用户点了回滚，等发布跑完，回滚才悄悄开始 —— 而它消费的"当前版本"
 * 已经是刚发布上去的那一版，不是用户看着弹窗确认的那一版。
 * 拒绝并说明原因，比排进队列诚实。
 *
 * ## 为什么回滚也要 `pool.setBusy`
 *
 * 回滚的阶段 2 会把目标路径**清空**、阶段 3 才铺上新内容。这中间自动重连毫无意义：
 * 重连"重试"的是一个已经走到一半的换版过程，只会把真实状态搅得更乱（T03.6）。
 */
import { hostname as osHostname } from 'node:os'
import { registerHandler } from '../infra/ipc'
import { logger } from '../infra/logger'
import { AppError, ErrorCode } from '../infra/errors'
import { IPC_CHANNELS } from '../../shared/channels'
import { joinRemote } from '../infra/hash-core'
import { normalizeRemotePath } from '../infra/remote-path'
import { lockPathOf, parseLockPayload } from '../infra/deploy-plan'
import { assertTargetIdle } from './target-busy'
import {
  rollbackPreviewInputSchema,
  rollbackStartInputSchema,
  type RollbackStartInput
} from '../../shared/contracts/rollback'
import {
  createSftpDeployPorts,
  type DeployPorts,
  type DeploySftpLike
} from '../services/deploy'
import type { RollbackPorts, RollbackService } from '../services/rollback'
import type { JobService, JobSpec } from '../services/job'
import type { ConnectionService } from '../services/connection'
import type { SshConnectionPool } from '../services/ssh-client'
import type { Repositories } from '../db/repositories'

export interface RollbackIpcDeps {
  rollback: RollbackService
  jobs: JobService
  connections: ConnectionService
  pool: SshConnectionPool
  repo: Repositories
  /** 写进锁文件，便于在服务器上判断"是谁在操作"。默认取本机 hostname */
  hostname?: () => string
  /**
   * 端口装配的可注入点（**仅供单测**，与 `ipc/archive.ts` 同一思路）。
   *
   * 只换"端口从哪来"，不换使用端口的逻辑：六阶段的顺序、补偿、
   * "失败必须抛错"这些真正会写错的地方仍被真实执行。
   */
  openPorts?: (targetId: string) => Promise<{
    connectionId: string
    ports: DeployPorts
    rollbackPorts: RollbackPorts
  }>
}

export function registerRollbackHandlers(deps: RollbackIpcDeps): void {
  const { rollback, jobs, connections, pool, repo } = deps
  const hostname = deps.hostname ?? ((): string => osHostname())

  /**
   * 打开一条可用的远端连接并装配端口。
   *
   * 复用 `createSftpDeployPorts`（它已经把这四个端口的 SFTP 方法收在一处）：
   * 回滚不需要 `transfer`，但多给一个不用的字段不会带来任何行为差异 ——
   * 而"再写一份端口装配"会多一处要跟着改的地方（B07~B12 已经吃过这种亏）。
   */
  async function openPortsDefault(targetId: string): Promise<{
    connectionId: string
    ports: DeployPorts
    rollbackPorts: RollbackPorts
  }> {
    const target = repo.targets.get(targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId })

    const env = repo.environments.get(target.environmentId)
    if (!env) {
      throw new AppError(ErrorCode.E_NOT_FOUND, {
        targetId,
        environmentId: target.environmentId
      })
    }

    const connectionId = env.connectionId
    if (!pool.isOnline(connectionId)) await connections.connect(connectionId)

    const capability = pool.capabilityOf(connectionId)
    if (!capability) {
      throw new AppError(ErrorCode.E_CONN_LOST, { connectionId, reason: 'capability-missing' })
    }

    const sftp = (await pool.sftp(connectionId)) as unknown as DeploySftpLike
    const ports = createSftpDeployPorts({
      sftp,
      capability,
      tmpDir: joinRemote(normalizeRemotePath(capability.homeDir?.trim() || '/tmp'), '.sfvm-tmp'),
      exec: (cmd) => pool.exec(connectionId, cmd),
      hostname: hostname()
    })

    // `DeployPorts` 在结构上就满足 `RollbackPorts`（多出来的 `transfer` 用不上），
    // 这里原样传即可 —— 不写 `as` 是为了让"哪天两边端口形状真不一致"变成编译错误。
    return { connectionId, ports, rollbackPorts: ports }
  }

  const openPorts = deps.openPorts ?? openPortsDefault

  /* --------------------------------------------------------------- 任务化 */

  /**
   * 把一次回滚包成任务。
   *
   * `rollbackId` 取 `ctx.jobId`：**任务 id 就是台账行 id**（与发布同一个约定）。
   * 用户从任务控制台、从发布历史、在服务器上看到的锁内容，都是同一个 id。
   */
  function createRollbackJobSpec(input: RollbackStartInput): JobSpec {
    const target = repo.targets.get(input.targetId)
    const archiveRow = repo.archives.get(input.archiveId)
    return {
      type: 'rollback',
      title: `回滚「${target?.name ?? input.targetId}」到 ${archiveRow?.versionTag ?? input.archiveId}`,
      targetId: input.targetId,
      async run(ctx) {
        const opened = await openPorts(input.targetId)
        pool.setBusy(opened.connectionId, true)
        try {
          const outcome = await rollback.run({
            targetId: input.targetId,
            archiveId: input.archiveId,
            ports: opened.rollbackPorts,
            ctx,
            rollbackId: ctx.jobId,
            ...(input.keepSource === undefined ? {} : { keepSource: input.keepSource }),
            ...(input.skipVerify === undefined ? {} : { skipVerify: input.skipVerify }),
            ...(input.cleanStaleLock === undefined ? {} : { cleanStaleLock: input.cleanStaleLock }),
            ...(input.alignOwnership === undefined
              ? {}
              : { alignOwnership: input.alignOwnership }),
            note: input.note ?? null
          })

          /**
           * **回滚失败必须抛错**，不能把 `{ok:false}` 当正常返回值交回去。
           *
           * `JobService.execute()` 只把抛出来的异常当失败 —— 返回 `ok:false` 会被记成
           * `succeeded`：底部任务条变绿、任务列表显示"已完成"，而服务器上的版本
           * 根本没换回来。这是 B11 在发布侧抓到的静默失败，回滚同样会踩。
           */
          if (!outcome.ok) {
            const f = outcome.failure
            throw new AppError(
              (f?.code ?? ErrorCode.E_ROLLBACK_FAILED) as never,
              { failure: f, rollbackId: outcome.rollbackId },
              {
                message: f?.message ?? '回滚失败',
                ...(f?.hint ? { hint: f.hint } : {})
              }
            )
          }
          return outcome
        } finally {
          pool.setBusy(opened.connectionId, false)
        }
      },
      async cleanup(reason, ctx) {
        const t = repo.targets.get(input.targetId)
        if (!t) return
        try {
          // 新开一条通道：失败/取消时旧通道很可能已经不可用
          const opened = await openPorts(input.targetId)
          pool.setBusy(opened.connectionId, false)

          /**
           * 回滚不像发布那样有暂存目录要清 —— 它只可能留下**锁**。
           *
           * 而且只删"锁里写的正是本次任务"的那把：不这么判就等于给了任务层
           * 一个删别人锁的开关（另一台机器可能正在发布）。
           */
          const remotePath = normalizeRemotePath(t.remotePath)
          const lockPath = lockPathOf(remotePath)
          try {
            const text = await opened.ports.fs.readTextFile(lockPath)
            const lock = parseLockPayload(text, new Date())
            if (lock?.releaseId === ctx.jobId) {
              await opened.ports.fs.removeFile(lockPath)
              ctx.log(`已释放远端锁（${reason}）`, 'warn')
            } else if (lock) {
              ctx.log(`远端锁属于另一次操作（releaseId=${lock.releaseId}），不清理`, 'warn')
            }
          } catch {
            // 读不到 = 没有锁，正常
          }
        } catch (err) {
          // 清理失败只记日志：不能覆盖原始失败原因（方案书 §6.11）
          ctx.log(
            `远端锁清理未完成：${(err as Error).message}（可在恢复连接后重试）`,
            'warn'
          )
        }
      }
    }
  }

  /* ------------------------------------------------------------ IPC 通道 */

  /**
   * 回滚对比预览（T13.3）。**纯本地**，不连服务器。
   *
   * 这样用户离线也能先看清"要改成什么"，再决定要不要连 —— 与 `deploy.preview`
   * 的分工一致；真正"能不能回滚"（归档内容还在不在、锁被没被占）由 start 的阶段 0 回答。
   */
  registerHandler(IPC_CHANNELS.ROLLBACK_PREVIEW, rollbackPreviewInputSchema, (input) =>
    rollback.preview(input)
  )

  registerHandler(IPC_CHANNELS.ROLLBACK_START, rollbackStartInputSchema, (input) => {
    // B21 起放宽成"这个目标上的**任意**任务"：脚本/流水线同样在动这个目标，
    // 静默排队对用户来说就是"点了没反应"（与 deploy.start 同一处守卫）
    assertTargetIdle(jobs, input.targetId, { action: '回滚' })
    const view = jobs.start(createRollbackJobSpec(input))
    logger.info(
      `rollback.start: target=${input.targetId} archive=${input.archiveId} job=${view.jobId}`
    )
    return view
  })
}
