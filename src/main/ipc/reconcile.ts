/**
 * 对账与崩溃恢复的 IPC 接线（B14 / T14.1 ~ T14.6）。
 *
 * ## 为什么这些**不是任务**
 *
 * 发布/回滚/下载都走 `JobService`（可取消、有进度），因为它们都是"跑很久且中途该能停"
 * 的动作。对账和恢复不是：
 *
 * - **对账要逐条返回结论**（补录了哪几条、哪几条标了 missing），
 *   而任务框架**不保存 `run()` 的返回值**（B11 的教训）—— 塞进 `error.detail`
 *   或者写进日志让界面去解析，都是把结构化数据降级成字符串；
 * - 它是一次**诊断**，不是一次"操作"：跑起来就该等到结论，
 *   中途停下的对账报告（"扫了一半"）对用户没有价值。
 *
 * 先例：`deploy.precheck` 同样是"连服务器 + 可能做全量哈希"的同步通道。
 * 唯一的代价是深度校验期间没有进度 —— 所以界面在按钮上给了明确的 loading
 * 与"深度校验很慢"的说明（T14.3）。
 */
import { registerHandler } from '../infra/ipc'
import { logger } from '../infra/logger'
import { AppError, ErrorCode } from '../infra/errors'
import { IPC_CHANNELS } from '../../shared/channels'
import { joinRemote } from '../infra/hash-core'
import { normalizeRemotePath } from '../infra/remote-path'
import { z } from 'zod'
import {
  diagnoseInputSchema,
  reconcileInputSchema,
  recoverInputSchema,
  remoteLockInputSchema,
  removeRemoteLockInputSchema
} from '../../shared/contracts/reconcile'
import {
  createSftpDeployPorts,
  type DeploySftpLike
} from '../services/deploy'
import type { ReconcilePorts, ReconcileService } from '../services/reconcile'
import type { ConnectionService } from '../services/connection'
import type { SshConnectionPool } from '../services/ssh-client'
import type { Repositories } from '../db/repositories'

/** 启动扫描没有任何入参。 */
const emptyInputSchema = z.object({})

export interface ReconcileIpcDeps {
  reconcile: ReconcileService
  connections: ConnectionService
  pool: SshConnectionPool
  repo: Repositories
  /** 仅供单测注入端口（与 `ipc/rollback.ts` 同一思路） */
  openPorts?: (targetId: string) => Promise<{ ports: ReconcilePorts; release?: () => void }>
}

export function registerReconcileHandlers(deps: ReconcileIpcDeps): void {
  const { reconcile, connections, pool, repo } = deps

  async function openPortsDefault(
    targetId: string
  ): Promise<{ ports: ReconcilePorts; release: () => void }> {
    const target = repo.targets.get(targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId })
    const env = repo.environments.get(target.environmentId)
    if (!env) {
      throw new AppError(ErrorCode.E_NOT_FOUND, { targetId, environmentId: target.environmentId })
    }
    const connectionId = env.connectionId
    if (!pool.isOnline(connectionId)) await connections.connect(connectionId)

    const capability = pool.capabilityOf(connectionId)
    if (!capability) {
      throw new AppError(ErrorCode.E_CONN_LOST, { connectionId, reason: 'capability-missing' })
    }
    // S2：释放权交给 handler（对账要走一次服务调用，端口在那期间必须活着）
    const { sftp: rawSftp, release } = await pool.openChannel(connectionId)
    const sftp = rawSftp as unknown as DeploySftpLike
    // 复用发布那套端口装配：对账要的能力（fs + hash）它都有，多出来的 transfer 用不上
    const ports = createSftpDeployPorts({
      sftp,
      capability,
      tmpDir: joinRemote(normalizeRemotePath(capability.homeDir?.trim() || '/tmp'), '.sfvm-tmp'),
      exec: (cmd, timeoutMs) => pool.exec(connectionId, cmd, timeoutMs),
      hostname: 'reconcile'
    })
    return { ports, release }
  }

  const openPorts = deps.openPorts ?? openPortsDefault

  /** 非任务通道没有 `ctx`，日志直接进主进程日志（排障时能对上时间线）。 */
  const log = (text: string, level?: 'debug' | 'info' | 'warn' | 'error'): void => {
    if (level === 'warn') logger.warn(text)
    else if (level === 'error') logger.error(text)
    else logger.info(text)
  }

  /**
   * 启动残留扫描（T14.4）。**纯本地**：不连服务器，启动时就能算。
   *
   * 这是唯一一个"应用一启动就会调"的通道，所以它必须快 —— 只读 SQLite 一张表。
   */
  registerHandler(IPC_CHANNELS.RECONCILE_STARTUP_SCAN, emptyInputSchema, () =>
    reconcile.startupScan()
  )

  /**
   * S2：对账的五个 handler 都是"开一条通道 → 一次服务调用 → 关掉"的同一形状，
   * 所以收成一处 —— 以后新加一个 handler 也不会忘释放。
   */
  async function withPorts<T>(
    targetId: string,
    fn: (ports: ReconcilePorts) => Promise<T> | T
  ): Promise<T> {
    const opened = await openPorts(targetId)
    try {
      return await fn(opened.ports)
    } finally {
      opened.release?.()
    }
  }

  /** 对账（T14.1~T14.3）。连服务器；`deep` 时逐文件校验（慢）。 */
  registerHandler(IPC_CHANNELS.RECONCILE_RUN, reconcileInputSchema, (input) =>
    withPorts(input.targetId, (ports) => reconcile.reconcile({ ...input, ports, log }))
  )

  /** 崩溃恢复的现场勘察（T14.5）：先看清现场，再让用户选。 */
  registerHandler(IPC_CHANNELS.RECONCILE_DIAGNOSE, diagnoseInputSchema, (input) =>
    withPorts(input.targetId, (ports) => reconcile.diagnose({ ...input, ports }))
  )

  /** 按选定方式收场（T14.5）。动作逐条返回（哪个成功、哪个要人工）。 */
  registerHandler(IPC_CHANNELS.RECONCILE_RECOVER, recoverInputSchema, (input) =>
    withPorts(input.targetId, (ports) => reconcile.recover({ ...input, ports, log }))
  )

  /** 看一眼远端锁（T14.6）：先给用户看是谁的锁、什么时候的，再决定删不删。 */
  registerHandler(IPC_CHANNELS.RECONCILE_LOCK_INFO, remoteLockInputSchema, (input) =>
    withPorts(input.targetId, (ports) => reconcile.readLock(input, ports))
  )

  /** 人工确认后删锁（T14.6）。契约层要求 `confirmed: true`，不是随手能调的。 */
  registerHandler(
    IPC_CHANNELS.RECONCILE_REMOVE_LOCK,
    removeRemoteLockInputSchema,
    (input) => withPorts(input.targetId, (ports) => reconcile.removeLock(input, ports, log))
  )
}
