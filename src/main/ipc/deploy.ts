/**
 * 发布的 IPC 接线（T10.12）。
 *
 * 本文件是"electron 胶水层"，业务全在 `services/deploy.ts`（可单测、不 import
 * electron / ssh2）。这里只做四件事：
 *
 * 1. 把目标解析成一条**可用的远端连接**，并把 SFTP 通道包成发布需要的全部端口；
 * 2. 把发布包成 `JobSpec` 交给 `JobService`（同一目标串行、可取消、进度与日志
 *    走 B08 已有的 200ms 节流推送）—— 于是底部任务控制台不需要为发布写任何新东西；
 * 3. 注册 `deploy.precheck` / `deploy.start` / `deploy.cancel` / `deploy.cleanResidue`；
 * 4. 发布期间把连接标记为 busy（T03.6：**发布中禁止自动重连** ——
 *    换版前后目标路径可能是空的，此时自动重连重试毫无意义，只会掩盖真实状态）。
 *
 * ## 为什么清理放在 JobSpec.cleanup 里、而且**另开一条通道**
 *
 * MT-02 的形态就是"发布中链路断了"。此时 `DeployService` 自己的补偿会去删暂存目录，
 * 但它拿的是**那条已经断掉的通道**，必然失败 —— 于是服务器上会留下一个
 * `.sfvm-staging-<id>`。JobService 在任务进入终态时会调用 `cleanup`，
 * 我们在这里**重新开一条 SFTP 通道**（`pool.sftp()` 每次都新建一条）再删一次。
 * 只要 SSH 还能连上（断的是那条会话，不是网络），残留就能当场清掉。
 *
 * 这也解释了 `cleanup` 的边界：它**只删能证明是自己留下的东西** ——
 * 本次 releaseId 的暂存目录，以及**锁文件里 releaseId 与本任务一致**时的锁。
 * 不带这两个判据的清理等于给了任务层一个"删任意远端路径"的开关。
 */
import { hostname as osHostname } from 'node:os'
import { registerHandler } from '../infra/ipc'
import { logger } from '../infra/logger'
import { AppError, ErrorCode, type ErrorCodeValue } from '../infra/errors'
import { IPC_CHANNELS } from '../../shared/channels'
import { joinRemote } from '../infra/hash-core'
import { normalizeRemotePath } from '../infra/remote-path'
import { lockPathOf, parseLockPayload, stagingRootOf } from '../infra/deploy-plan'
import {
  deployCancelInputSchema,
  deployCleanResidueInputSchema,
  deployCurrentVersionInputSchema,
  deployPrecheckInputSchema,
  deployPreviewInputSchema,
  deployStartInputSchema,
  type DeployStartInput
} from '../../shared/contracts/deploy'
import {
  createSftpDeployPorts,
  type DeployPorts,
  type DeployService,
  type DeploySftpLike
} from '../services/deploy'
import type { JobService, JobSpec } from '../services/job'
import { assertTargetIdle } from './target-busy'
import type { ConnectionService } from '../services/connection'
import type { SshConnectionPool } from '../services/ssh-client'
import type { Repositories } from '../db/repositories'

export interface DeployIpcDeps {
  deploy: DeployService
  jobs: JobService
  connections: ConnectionService
  pool: SshConnectionPool
  repo: Repositories
/** 写进远端锁文件，便于用户判断"是谁在发布"。默认取本机 hostname */
  hostname?: () => string
  /**
   * 端口装配的可注入点（**仅供单测**）。
   *
   * 生产路径是"`pool.sftp()` 开一条通道 → 包成四个端口"。单测若要覆盖这条路径，
   * 就得伪造一整条 ssh2 形状的 SFTP 通道；那种替身越像手写的 ssh2，越容易掩盖
   * 真实语义差异（B07 的教训），而且它并不能证明我们的接线是对的。
   *
   * 所以这里只换"端口从哪来"：**换不掉使用端口的逻辑** —— 任务化、busy 标记、
   * 失败清理的边界（只删自己留下的东西）都仍被真实执行。
   * `openPorts` 里与连接池打交道的那几行由真机集成测试覆盖（T10.13 / T10.14）。
   */
  openPorts?: (targetId: string) => Promise<OpenedPorts>
}

/** 打开端口的结果：端口本身 + 它绑定的连接（用于标记 busy / 复用）。 */
export interface OpenedPorts {
  ports: DeployPorts
  connectionId: string
}

/** "目标 → 端口"的可注入形式（发布与流水线里的发布步骤共用）。 */
export type DeployPortsOpener = (targetId: string) => Promise<OpenedPorts>

/**
 * 发布用的一条 SFTP 通道包出的全部端口。
 *
 * `pool.sftp()` **每次都新建一条通道**，所以这个函数被再调用一次就等于
 * "换一条新通道重试" —— `cleanup` 正是靠这一点在断链后还能清理。
 *
 * B21 把"从目标解析出一条可用连接并包成端口"抽成了独立工厂：流水线里的
 * 「发布」步骤要**直接调用** `deploy.run`（不能新建任务，会自锁死锁），
 * 于是它也需要同一份端口装配。不抽出来的话，两处必然各自演一遍
 * （而其中一处的 `tmpDir` 拼错，只有真机上才会发现）。
 */
export interface DeployPortsOpenerDeps {
  repo: Repositories
  connections: ConnectionService
  pool: SshConnectionPool
  /** 写进远端锁文件，便于用户判断"是谁在发布"。默认取本机 hostname */
  hostname?: () => string
}

export function createDeployPortsOpener(
  deps: DeployPortsOpenerDeps
): (targetId: string) => Promise<OpenedPorts> {
  const hostname = deps.hostname ?? ((): string => osHostname())

  return async function openPorts(targetId: string): Promise<OpenedPorts> {
    const target = deps.repo.targets.get(targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId })

    const env = deps.repo.environments.get(target.environmentId)
    if (!env) throw new AppError(ErrorCode.E_NOT_FOUND, { environmentId: target.environmentId })

    const connectionId = env.connectionId
    if (!deps.pool.isOnline(connectionId)) await deps.connections.connect(connectionId)

    const capability = deps.pool.capabilityOf(connectionId)
    if (!capability) {
      throw new AppError(ErrorCode.E_CONN_LOST, {
        connectionId,
        reason: 'capability-missing'
      })
    }

    const sftp = (await deps.pool.sftp(connectionId)) as unknown as DeploySftpLike
    const tmpDir = joinRemote(
      normalizeRemotePath(capability.homeDir?.trim() || '/tmp'),
      '.sfvm-tmp'
    )

    return {
      connectionId,
      ports: createSftpDeployPorts({
        sftp,
        capability,
        tmpDir,
        exec: (cmd) => deps.pool.exec(connectionId, cmd),
        hostname: hostname()
      })
    }
  }
}

export function registerDeployHandlers(deps: DeployIpcDeps): void {
  const { deploy, jobs, connections, pool, repo } = deps

  const openPorts =
    deps.openPorts ??
    createDeployPortsOpener({
      repo,
      connections,
      pool,
      ...(deps.hostname ? { hostname: deps.hostname } : {})
    })

  /* --------------------------------------------------------------- 任务化 */

  /**
   * 把一次发布包成任务。
   *
   * `releaseId` 取 `ctx.jobId`：**任务的 id 就是台账行的 id**。
   * 这样用户从"发布历史"看到某条记录、从任务控制台看到某个任务时，
   * 两个 id 指的是同一件事，排障时不用来回对照（也让 B14 对账能按 id 找到残留）。
   */
  function createDeployJobSpec(input: DeployStartInput): JobSpec {
    const target = repo.targets.get(input.targetId)
    return {
      type: 'deploy',
      title: `发布「${target?.name ?? input.targetId}」`,
      targetId: input.targetId,
      async run(ctx) {
        const opened = await openPorts(input.targetId)
        // 发布期间禁止自动重连（T03.6）：换版前后目标可能是空的，
        // 此时"自动重连并重试"只会把真实状态搅得更乱
        pool.setBusy(opened.connectionId, true)
        try {
          const outcome = await deploy.run({
            targetId: input.targetId,
            ports: opened.ports,
            ctx,
            releaseId: ctx.jobId,
            note: input.note ?? null,
            ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
            ...(input.alignOwnership === undefined
              ? {}
              : { alignOwnership: input.alignOwnership }),
            ...(input.confirmCleanResidue === undefined
              ? {}
              : { confirmCleanResidue: input.confirmCleanResidue }),
            ...(input.cleanStaleLock === undefined ? {} : { cleanStaleLock: input.cleanStaleLock })
          })

          /**
           * **发布失败必须抛错**，不能把 `{ok:false}` 当正常返回值交回去。
           *
           * `JobService.execute()` 只把"抛出来的异常"当作失败 —— 返回一个
           * `ok:false` 的对象会被记成 `succeeded`：底部任务条变绿、任务列表显示"已完成"，
           * 而服务器上那一版根本没换上去。这是个典型的**静默失败**
           * （B11 做失败视图时发现：UI 根本拿不到"失败了"这个事实）。
           *
           * 抛 `AppError` 而不是普通 Error：`JobService.toErrorInfo()` 只对 AppError
           * 保留 code / hint / detail，而失败视图要靠 `detail.failure` 展示
           * 补偿动作明细（哪些清理成功、哪些要人工处理）。
           */
          if (!outcome.ok) {
            const f = outcome.failure
            throw new AppError(
              // 错误码来自我们自己的 ErrorCode 枚举（服务层只会抛这些），原样透传
              (f?.code ?? ErrorCode.E_UNKNOWN) as ErrorCodeValue,
              {
                targetId: outcome.targetId,
                releaseId: outcome.releaseId,
                versionTag: outcome.versionTag,
                failure: f
              },
              {
                message: f?.message ?? '发布失败',
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
        // 走到这里说明任务被取消 / 放弃退出 / 失败了。`run` 的 finally 通常已经把
        // busy 放掉；但如果 run 卡住迟迟不返回，就只剩这里能放 —— 所以再放一次。
        const target2 = repo.targets.get(input.targetId)
        if (!target2) return

        try {
          // 关键：**新开一条通道**。失败时旧通道很可能已经不可用（MT-02 就是断链）
          const opened = await openPorts(input.targetId)
          pool.setBusy(opened.connectionId, false)

          const remotePath = normalizeRemotePath(target2.remotePath)
          const stagingRoot = stagingRootOf(remotePath, ctx.jobId)

          const st = await opened.ports.fs.stat(stagingRoot)
          if (!st.exists) {
            ctx.log(`清理检查：远端无暂存残留（${reason}）`)
          } else {
            const r = await deploy.cleanResidue({
              targetId: input.targetId,
              paths: [stagingRoot],
              fs: opened.ports.fs
            })
            if (r.removed.length > 0) ctx.log(`已清理远端暂存目录 ${stagingRoot}`, 'warn')
            for (const f of r.failed) {
              ctx.log(`暂存目录未能清理（${f.reason}）：${f.path}`, 'warn')
            }
          }

          // 锁：只在"锁里写的正是本次任务"时才删。
          // 不这么判就等于给了任务层一个删别人锁的开关（另一台机器可能正在发布）。
          const lockPath = lockPathOf(remotePath)
          try {
            const text = await opened.ports.fs.readTextFile(lockPath)
            const lock = parseLockPayload(text, new Date())
            if (lock?.releaseId === ctx.jobId) {
              await opened.ports.fs.removeFile(lockPath)
              ctx.log('已释放远端发布锁', 'warn')
            } else if (lock) {
              ctx.log(`远端锁属于另一次发布（releaseId=${lock.releaseId}），不清理`, 'warn')
            } else if (text !== null) {
              ctx.log(`远端锁内容无法解析，未自动清理：${lockPath}`, 'warn')
            }
          } catch {
            // 读不到 = 没有锁，正常
          }
        } catch (err) {
          // 清理失败只记日志：**不能覆盖原始失败原因**（方案书 §6.11）。
          // 实在清不掉时，下次发布的前置校验仍会认出这个残留并提示。
          ctx.log(
            `远端残留清理未完成：${(err as Error).message}` +
              '（可在恢复连接后重试，或在下一次发布时确认清理）',
            'warn'
          )
        }
      }
    }
  }

  /* ------------------------------------------------------------ IPC 通道 */

  registerHandler(IPC_CHANNELS.DEPLOY_PRECHECK, deployPrecheckInputSchema, async ({ targetId }) => {
    const { ports } = await openPorts(targetId)
    return deploy.precheck({ targetId, ports })
  })

  /**
   * 发布预览（T11.3）：差异摘要 + 本地产物汇总。
   *
   * **刻意不连服务器**：这样即使用户当前离线，也能先看清"这次发布会改动什么"，
   * 再决定要不要去连。真正"能不能发"的前置校验仍然是 precheck。
   */
  registerHandler(IPC_CHANNELS.DEPLOY_PREVIEW, deployPreviewInputSchema, ({ targetId, limit }) =>
    deploy.preview({ targetId, ...(limit === undefined ? {} : { limit }) })
  )

  /**
   * 当前线上版本（纯台账）。
   *
   * 目标详情页的「当前版本」用它 —— `preview` 会因为"没配本地产物路径"直接抛错，
   * 也会为这个数字白算一次全量本地指纹。
   */
  registerHandler(IPC_CHANNELS.DEPLOY_CURRENT_VERSION, deployCurrentVersionInputSchema, (input) =>
    deploy.currentVersion(input)
  )

  registerHandler(IPC_CHANNELS.DEPLOY_START, deployStartInputSchema, (input) => {
    // 同一目标上已有任务（发布、回滚、脚本、流水线……）就直接拒绝，而不是排进队列。
    // 队列会让"手滑点了两次"变成"真的发布了两版"，而第二版与前版内容相同，
    // 除了在往期版本里多一条一模一样的记录之外没有任何意义。
    //
    // B21 起这里从"只看 type==='deploy'"放宽成"看这个目标上的**任意**任务"：
    // 脚本/流水线同样在动这个目标，静默排队对用户来说就是"点了没反应"。
    assertTargetIdle(jobs, input.targetId, { action: '发布' })
    const view = jobs.start(createDeployJobSpec(input))
    logger.info(`deploy.start: target=${input.targetId} job=${view.jobId}`)
    return view
  })

  registerHandler(IPC_CHANNELS.DEPLOY_CANCEL, deployCancelInputSchema, ({ jobId }) =>
    jobs.cancel(jobId)
  )

  registerHandler(
    IPC_CHANNELS.DEPLOY_CLEAN_RESIDUE,
    deployCleanResidueInputSchema,
    async ({ targetId, paths }) => {
      const { ports } = await openPorts(targetId)
      const r = await deploy.cleanResidue({ targetId, paths, fs: ports.fs })
      logger.info(
        `deploy.cleanResidue: target=${targetId} removed=${r.removed.length} failed=${r.failed.length}`
      )
      return r
    }
  )
}
