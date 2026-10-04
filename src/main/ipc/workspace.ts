/**
 * 工作环境与目标资源 IPC（T05.8）。
 *
 * 体检（T05.7）需要**真实远端事实**，所以这里负责把它采集出来：
 * 建一次只读连接 → 用 SFTP 探测路径与父目录 → 能力探测 → 组装 HealthProbe
 * → 交给纯函数 buildHealthReport 出结论。
 *
 * 全部只读：不创建、不修改、不删除远端任何东西。
 * "目标路径不存在时是否创建空目录"是**用户的选择**，不在体检里自动做。
 */
import { z } from 'zod'
import { registerHandler } from '../infra/ipc'
import { logger } from '../infra/logger'
import { AppError, ErrorCode } from '../infra/errors'
import { IPC_CHANNELS } from '../../shared/channels'
import {
  environmentInputSchema,
  environmentPatchSchema,
  localArtifactStatInputSchema,
  targetInputSchema,
  targetPatchSchema
} from '../../shared/contracts/workspace'
import { statLocalArtifact } from '../services/local-artifact'
import { normalizeRemotePath } from '../infra/remote-path'
import { parentDirOf, resolveArchiveDir } from '../infra/archive-dir'
import { buildHealthReport, type HealthProbe, type HealthReport } from '../services/target-health'
import type { WorkspaceService } from '../services/workspace'
import type { ConnectionService } from '../services/connection'
import type { SshConnectionPool } from '../services/ssh-client'
import { createRemoteFs, type SftpLike } from '../services/remote-fs'
import type { Repositories } from '../db/repositories'

const idSchema = z.object({ id: z.string().min(1) })

export interface WorkspaceIpcDeps {
  workspace: WorkspaceService
  connections: ConnectionService
  pool: SshConnectionPool
  repo: Repositories
}

export function registerWorkspaceHandlers(deps: WorkspaceIpcDeps): void {
  const { workspace, connections, pool, repo } = deps
  const { environments, targets } = workspace

  /* ------------------------------------------------------------- 环境 */

  registerHandler(IPC_CHANNELS.ENV_LIST, null, () => environments.list())
  registerHandler(IPC_CHANNELS.ENV_GET, idSchema, ({ id }) => environments.get(id))
  registerHandler(IPC_CHANNELS.ENV_CREATE, environmentInputSchema, (input) =>
    environments.create(input)
  )
  registerHandler(
    IPC_CHANNELS.ENV_UPDATE,
    idSchema.extend({ patch: environmentPatchSchema }),
    ({ id, patch }) => environments.update(id, patch)
  )

  /**
   * 删除环境：只删本机配置与台账索引。
   * 返回值里带上被级联删除的目标数，便于 UI 反馈与审计。
   */
  registerHandler(IPC_CHANNELS.ENV_REMOVE, idSchema, ({ id }) => {
    const r = environments.remove(id)
    repo.audit.write({
      level: 'info',
      scope: 'app',
      refId: id,
      message: `删除环境（级联本地目标 ${r.removedTargets} 个；未触碰服务器文件）`,
      detail: JSON.stringify({ removedTargets: r.removedTargets })
    })
    return r
  })

  registerHandler(IPC_CHANNELS.ENV_DESCRIBE_REMOVAL, idSchema, ({ id }) =>
    environments.describeRemoval(id)
  )

  /* ------------------------------------------------------------- 目标 */

  registerHandler(
    IPC_CHANNELS.TARGETS_LIST,
    z.object({ environmentId: z.string().min(1) }),
    ({ environmentId }) => targets.list(environmentId)
  )
  registerHandler(IPC_CHANNELS.TARGETS_GET, idSchema, ({ id }) => targets.get(id))
  registerHandler(
    IPC_CHANNELS.TARGETS_UPDATE,
    idSchema.extend({ patch: targetPatchSchema }),
    ({ id, patch }) => targets.update(id, patch)
  )
  registerHandler(IPC_CHANNELS.TARGETS_REMOVE, idSchema, ({ id }) => {
    const r = targets.remove(id)
    repo.audit.write({
      level: 'info',
      scope: 'app',
      refId: id,
      message: `删除目标（清理本地台账：发布 ${r.removedReleases} 条、归档 ${r.removedArchives} 条；未触碰服务器文件）`,
      detail: JSON.stringify(r)
    })
    return r
  })

  registerHandler(
    IPC_CHANNELS.TARGETS_PREVIEW_ARCHIVE_DIR,
    z.object({ remotePath: z.string().min(1), archiveDir: z.string().nullable().optional() }),
    ({ remotePath, archiveDir }) => targets.previewArchiveDir(remotePath, archiveDir)
  )

  /**
   * 目标体检（支持"草稿"）。
   *
   * 两种用法：
   * - 传 id：对已保存的目标体检
   * - 传 input：对**表单里还没保存**的目标体检 —— 这是"向导里实时体检"的关键，
   *   否则用户只能先保存、失败、再改，体验很差
   *
   * 全程只读：不创建、不修改、不删除远端任何东西。
   */
  registerHandler(
    IPC_CHANNELS.TARGETS_HEALTH_CHECK,
    z
      .object({
        id: z.string().optional(),
        input: targetInputSchema.optional()
      })
      .refine((v) => Boolean(v.id) || Boolean(v.input), { message: 'id 与 input 至少要有一个' }),
    async (params) => {
      if (params.id) {
        const target = targets.get(params.id)
        return runHealthCheck({
          environmentId: target.environmentId,
          remotePath: target.remotePath,
          kind: target.kind,
          archiveDir: target.archiveDirOverridden ? target.archiveDir : null
        })
      }

      const input = params.input!
      const kind =
        input.kind ?? (normalizeRemotePath(input.remotePath).endsWith('.jar') ? 'file' : 'dir')
      return runHealthCheck({
        environmentId: input.environmentId,
        remotePath: input.remotePath,
        kind,
        archiveDir: input.archiveDir ?? null
      })
    }
  )

  /**
   * 新建目标（T05.5 + T05.7）。
   * 先体检再落库：体检有 error 时**不保存**，避免登记一个不可用的目标。
   */
  registerHandler(
    IPC_CHANNELS.TARGETS_CREATE,
    targetInputSchema.extend({ createMissingDir: z.boolean().optional() }),
    async (input) => {
      const kind =
        input.kind ?? (normalizeRemotePath(input.remotePath).endsWith('.jar') ? 'file' : 'dir')
      const report = await runHealthCheck({
        environmentId: input.environmentId,
        remotePath: input.remotePath,
        kind,
        archiveDir: input.archiveDir ?? null
      })

      if (!report.ok) {
        const firstError = report.checks.find((c) => c.level === 'error')!
        throw new AppError(
          ErrorCode.E_PARAM,
          { check: firstError.key, report },
          { message: `目标体检未通过：${firstError.detail}` }
        )
      }

      // 用户明确要求且路径是目录型、确实不存在时才创建
      if (input.createMissingDir && report.needCreateChoice) {
        await createEmptyDir(input.environmentId, normalizeRemotePath(input.remotePath))
      }

      const target = targets.create(input)
      return { target, healthCheck: report }
    }
  )

  /**
   * 本地产物轻量探测（B11 / T11.1~T11.2）。
   *
   * **纯本地**：不建连接、不碰服务器 —— 详情页打开就要显示"产物在哪、多大、
   * 多久没动过"，不该因为服务器离线而整块空白（那时候用户正是要来排查问题的）。
   * 也刻意**不算哈希**：一枚徽标不值得把几百 MB 的产物读一遍。
   */
  registerHandler(IPC_CHANNELS.TARGETS_ARTIFACT_STAT, localArtifactStatInputSchema, ({ targetId }) => {
    const target = targets.get(targetId)
    return statLocalArtifact({
      localPath: target.localPath,
      targetKind: target.kind,
      // 只有"本地产物名 vs 服务器端文件名"这一项判断要用到它（B17），
      // 其余结论仍只看本地文件系统 —— 这个通道依旧是纯本地的。
      remotePath: target.remotePath,
      exclude: target.localExclude
    })
  })

  /* ------------------------------------------------------- 内部：采集事实 */

  /** 体检的统一入口：采集事实 → 交给纯函数出结论。 */
  async function runHealthCheck(opts: {
    environmentId: string
    remotePath: string
    kind: 'dir' | 'file'
    archiveDir: string | null
  }): Promise<HealthReport> {
    const probe = await collectHealthProbe({
      environmentId: opts.environmentId,
      remotePath: opts.remotePath,
      kind: opts.kind,
      archiveDir: opts.archiveDir
    })
    return buildHealthReport(
      { remotePath: opts.remotePath, kind: opts.kind, archiveDir: opts.archiveDir },
      probe
    )
  }

  /**
   * 采集体检所需的远端事实。
   *
   * 为了不改动"在线状态"，这里**不改用连接池里的会话**，而是
   * 借连接服务建一次临时连接（与连接测试同样的思路），探测完即断开。
   * 好处：体检不会因为目标和连接不在同一个环境而误连。
   */
  async function collectHealthProbe(opts: {
    environmentId: string
    remotePath: string
    kind?: 'dir' | 'file'
    archiveDir?: string | null
  }): Promise<HealthProbe> {
    const env = repo.environments.get(opts.environmentId)
    if (!env) throw new AppError(ErrorCode.E_NOT_FOUND, { environmentId: opts.environmentId })

    const connId = env.connectionId
    const remotePath = normalizeRemotePath(opts.remotePath)
    const archiveDir = resolveArchiveDir({
      remotePath,
      archiveDir: opts.archiveDir ?? null
    })
    const parent = parentDirOf(remotePath)

    // 未连接时先建连（失败就返回"连接不可用"的报告，而不是抛一堆错）
    let connectionError: string | undefined
    try {
      if (!pool.isOnline(connId)) {
        await connections.connect(connId)
      }
    } catch (e) {
      connectionError = (e as AppError).message
      logger.warn(`health check: connect failed for ${connId}: ${connectionError}`)
      return {
        connectionOk: false,
        connectionError,
        targetExists: false,
        parentWritable: false,
        archiveDirExists: false,
        existingVersions: 0
      }
    }

    const capability = pool.capabilityOf(connId)
    const sftp = (await pool.sftp(connId)) as unknown as SftpLike
    const fs = createRemoteFs(sftp)

    try {
      const [targetStat, parentStat, archiveStat] = await Promise.all([
        fs.stat(remotePath),
        fs.stat(parent),
        fs.stat(archiveDir)
      ])

      // 归档目录下既存版本数量（用于提示"可对账导入"）
      let existingVersions = 0
      if (archiveStat.exists && archiveStat.isDirectory) {
        try {
          const entries = await fs.readdir(archiveDir)
          existingVersions = entries.filter((e) => e.isDirectory).length
        } catch {
          existingVersions = 0
        }
      }

      return {
        connectionOk: true,
        capability,
        targetExists: targetStat.exists,
        targetIsDirectory: targetStat.exists ? targetStat.isDirectory : undefined,
        // 父目录不存在也视为不可写（无法在其下创建 .versions）
        parentWritable: parentStat.exists && parentStat.isDirectory,
        archiveDirExists: archiveStat.exists && archiveStat.isDirectory,
        existingVersions
      }
    } catch (e) {
      logger.warn(`health check probe failed: ${(e as Error).message}`)
      return {
        connectionOk: true,
        capability,
        targetExists: false,
        parentWritable: false,
        archiveDirExists: false,
        existingVersions: 0
      }
    }
  }

  /** 仅在用户明确选择"现在创建空目录"时调用。 */
  async function createEmptyDir(environmentId: string, remotePath: string): Promise<void> {
    const env = repo.environments.get(environmentId)
    if (!env) throw new AppError(ErrorCode.E_NOT_FOUND, { environmentId })
    if (!pool.isOnline(env.connectionId)) await connections.connect(env.connectionId)

    const sftp = (await pool.sftp(env.connectionId)) as unknown as SftpLike
    const fs = createRemoteFs(sftp)
    await fs.mkdirp(remotePath)
    logger.info(`created empty target dir on request: ${remotePath}`)
    repo.audit.write({
      level: 'info',
      scope: 'app',
      refId: environmentId,
      message: `按用户选择创建空目录：${remotePath}`,
      detail: JSON.stringify({ remotePath })
    })
  }
}
