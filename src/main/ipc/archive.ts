/**
 * 往期版本（归档）的 IPC 接线（T09.7）。
 *
 * 本文件只做三件事：
 * 1. 把目标解析成一条**可用的远端连接**，并把它的 SFTP 通道包成
 *    归档服务需要的两个端口（文件操作 + 哈希）；
 * 2. 注册 `archives.list` / `archives.verify` / `archives.applyRetention`；
 * 3. 把审计写进 `audit_logs`。
 *
 * ## 端口为什么要在这里组装
 *
 * `services/archive.ts` 刻意不知道 ssh2 的存在（可单测）；连接池、能力探测、
 * 临时目录这类"环境事实"只有在主进程的接线层才知道。这与 B05 体检、
 * B07 校验的做法一致。
 *
 * ## 只读 vs 写
 *
 * - `list` 纯读台账，连服务器都不碰；
 * - `verify` 只读远端（读 manifest + 算哈希 + 临时清单文件写在 `$HOME/.sfvm-tmp`）；
 * - `applyRetention` 会**真的删除**远端目录，但删哪些完全由台账里已有的行决定，
 *   不接受调用方传路径。
 *
 * ## B12 补上的三条（T12.3~T12.7）
 *
 * - `archives.list` 原样保留（一次给全量、按归档时间倒序），
 *   `archives.summary` 另外给台账聚合 —— 台账聚合走 SQL 而不是"捞出全部行再算"。
 * - `archives.downloadPlan` / `archives.download`：**先出计划再动手**。
 *   计划是纯本地的（算"会落到哪个目录"），下载走任务框架（可取消、有进度）。
 *   两者都要求"写入位置由主进程拼" —— 渲染进程只能传单层的目录名。
 * - `archives.remove`：手工删除勾选的版本，**逐条如实返回**结果。
 */
import { promises as fsp } from 'node:fs'
import { join as joinLocal } from 'node:path'
import { registerHandler } from '../infra/ipc'
import { assertTargetIdle } from './target-busy'
import { logger } from '../infra/logger'
import { AppError, ErrorCode } from '../infra/errors'
import { IPC_CHANNELS } from '../../shared/channels'
import { joinRemote } from '../infra/hash-core'
import { normalizeRemotePath } from '../infra/remote-path'
import { stagingNameOf } from '../infra/archive-download'
import {
  archiveApplyRetentionInputSchema,
  archiveDetailInputSchema,
  archiveDownloadInputSchema,
  archiveDownloadPlanInputSchema,
  archiveListInputSchema,
  archiveRemoveInputSchema,
  archiveSummaryInputSchema,
  archiveVerifyInputSchema
} from '../../shared/contracts/archive'
import {
  createSftpArchivePort,
  type ArchiveService,
  type ArchiveSftpLike,
  type ArchivePorts
} from '../services/archive'
import type {
  ArchiveDownloadService,
  DownloadSourcePort,
  DownloadTransferPort
} from '../services/archive-download'
import { createSftpHashPort, type HashSftpLike, type RemoteHashPort } from '../services/hash'
import {
  createSftpTransferPort,
  createTransfer,
  type TransferSftpLike
} from '../services/transfer'
import type { JobService, JobSpec } from '../services/job'
import type { ConnectionService } from '../services/connection'
import type { SshConnectionPool } from '../services/ssh-client'
import type { Repositories } from '../db/repositories'

export interface ArchiveIpcDeps {
  archive: ArchiveService
  download: ArchiveDownloadService
  jobs: JobService
  connections: ConnectionService
  pool: SshConnectionPool
  repo: Repositories
  /**
   * 下载保存位置的默认根目录。
   *
   * 由接线层注入（`app.getPath('downloads')` + `sfvm-downloads`）而不是在这里
   * import electron：本文件从 B09 起就是"不 import electron"的，
   * 一旦破了这条，整条归档链路就没法在单测里跑。
   */
  defaultSaveDir: () => string
  /**
   * 端口装配的可注入点（**仅供单测**，与 `ipc/deploy.ts` 同一思路）。
   *
   * 只换"端口从哪来"，不换使用端口的逻辑：目录命名、校验顺序、
   * "失败保留产物"这些真正会写错的地方仍被真实执行。
   */
  openDownloadPorts?: (
    targetId: string
  ) => Promise<{ source: DownloadSourcePort; transfer: DownloadTransferPort; connectionId: string }>
}

/**
 * 三条链路的 SFTP 方法并集（归档目录操作 / 哈希 / 传输）。
 *
 * 一次 `pool.sftp()` 就够它们共用（SFTP 通道上的请求互相独立），
 * 所以不为了"类型干净"再开几条通道 —— 每多一条通道就多一次握手与一处失败点。
 * 交集写在一起也顺带保证了：只要某条链路要用的方法在这个并集里，
 * 它拿到的一定是同一条通道。
 */
type ArchiveSftp = ArchiveSftpLike & HashSftpLike & TransferSftpLike

/** 打开端口的结果：端口本身 + 通道 + 它绑定的连接（下载要标 busy）。 */
interface OpenedPorts {
  ports: ArchivePorts
  sftp: ArchiveSftp
  connectionId: string
}

export function registerArchiveHandlers(deps: ArchiveIpcDeps): void {
  const { archive, download, jobs, connections, pool, repo } = deps

  /**
   * 解析目标 → 确保连接在线 → 组装两个端口。
   *
   * 与体检（`ipc/workspace.ts`）不同，这里**复用连接池会话**而不是新建临时连接：
   * 归档校验是常规操作，复用能省掉一次握手；而体检刻意不复用是为了不改动在线状态。
   */
  async function openPorts(targetId: string): Promise<OpenedPorts> {
    const target = repo.targets.get(targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId })

    const env = repo.environments.get(target.environmentId)
    if (!env) throw new AppError(ErrorCode.E_NOT_FOUND, { environmentId: target.environmentId })

    const connId = env.connectionId
    if (!pool.isOnline(connId)) await connections.connect(connId)

    const capability = pool.capabilityOf(connId)
    if (!capability) {
      // 刚连上就拿不到能力探测结果，说明连接池状态不一致 —— 明确报错，别猜
      throw new AppError(ErrorCode.E_CONN_LOST, { connectionId: connId, reason: 'capability-missing' })
    }

    const sftp = (await pool.sftp(connId)) as unknown as ArchiveSftp
    const tmpDir = joinRemote(
      normalizeRemotePath(capability.homeDir?.trim() || '/tmp'),
      '.sfvm-tmp'
    )

    const hash: RemoteHashPort = createSftpHashPort({
      sftp,
      exec: (cmd) => pool.exec(connId, cmd),
      capability,
      tmpDir
    })

    return { ports: { fs: createSftpArchivePort(sftp), hash }, sftp, connectionId: connId }
  }

  registerHandler(IPC_CHANNELS.ARCHIVES_LIST, archiveListInputSchema, ({ targetId }) =>
    archive.list(targetId)
  )

  registerHandler(IPC_CHANNELS.ARCHIVES_VERIFY, archiveVerifyInputSchema, async ({ archiveId }) => {
    const row = repo.archives.get(archiveId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { archiveId })
    logger.info(`archives.verify: ${row.versionTag} @ ${row.storagePath}`)

    const { ports } = await openPorts(row.targetId)
    const result = await archive.verifyArchive({ archiveId, ports })

    repo.audit.write({
      level: result.ok ? 'info' : 'warn',
      scope: 'archive',
      refId: archiveId,
      message: `校验往期版本 ${row.versionTag}：${result.message}`,
      detail: JSON.stringify({
        status: result.status,
        mode: result.mode,
        missing: result.diff.missing.length,
        extra: result.diff.extra.length,
        mismatch: result.diff.mismatch.length
      })
    })
    return result
  })

  registerHandler(
    IPC_CHANNELS.ARCHIVES_APPLY_RETENTION,
    archiveApplyRetentionInputSchema,
    async ({ targetId }) => {
      const { ports } = await openPorts(targetId)
      return archive.applyRetention({ targetId, fs: ports.fs })
    }
  )

  /* ------------------------------------------------- T12.6 台账占用汇总 */

  registerHandler(IPC_CHANNELS.ARCHIVES_SUMMARY, archiveSummaryInputSchema, ({ targetId }) =>
    archive.summary(targetId)
  )

  /* --------------------------------------------------- T12.7 版本明细 */

  registerHandler(IPC_CHANNELS.ARCHIVES_DETAIL, archiveDetailInputSchema, async (input) => {
    const row = repo.archives.get(input.archiveId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { archiveId: input.archiveId })

    const { ports } = await openPorts(row.targetId)
    // 只读操作：读不到 manifest 也**不**改台账状态（那是「校验」的职责）
    return archive.readDetail({
      archiveId: input.archiveId,
      offset: input.offset,
      limit: input.limit,
      ports
    })
  })

  /* ------------------------------------------- T12.3 下载（计划 + 执行） */

  registerHandler(
    IPC_CHANNELS.ARCHIVES_DOWNLOAD_PLAN,
    archiveDownloadPlanInputSchema,
    async ({ archiveId, saveDir }) =>
      download.plan({
        archiveId,
        // 空串与 undefined 一个待遇：界面在"还没选过"时传的是 undefined
        saveDir: saveDir?.trim() ? saveDir.trim() : deps.defaultSaveDir()
      })
  )

  /**
   * 下载用的端口。与 `verify` 复用同一条连接，但**单独包一个传输端口**。
   *
   * 传输层要的是 `fastGet` / `createReadStream` 这些"搬运"能力，
   * 与归档侧的"目录操作 + 哈希"是两组不同的方法面；共用一个端口对象会让
   * 两边的方法越并越多，最终没人说得清谁真的用了什么。
   */
  async function openDownloadPorts(
    targetId: string
  ): Promise<{ source: DownloadSourcePort; transfer: DownloadTransferPort; connectionId: string }> {
    if (deps.openDownloadPorts) return deps.openDownloadPorts(targetId)

    const { ports, sftp, connectionId } = await openPorts(targetId)
    return {
      connectionId,
      source: { stat: (p) => ports.fs.stat(p), readTextFile: (p) => ports.fs.readTextFile(p) },
      transfer: createTransfer(createSftpTransferPort(sftp))
    }
  }

  registerHandler(IPC_CHANNELS.ARCHIVES_DOWNLOAD, archiveDownloadInputSchema, (input) => {
    const row = repo.archives.get(input.archiveId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { archiveId: input.archiveId })

    // 同一目标上已有任务在跑时不让下载？**允许** —— 下载是只读的，
    // 与发布/回滚并存没有正确性问题（唯一共享的是连接池，B07 已按通道隔离）。
    const target = repo.targets.get(row.targetId)
    const job = jobs.start({
      type: 'download',
      title: `下载往期版本 ${row.versionTag}`,
      targetId: row.targetId,
      async run(ctx) {
        const opened = await openDownloadPorts(row.targetId)
        // 下载期间禁止自动重连：传输中的流一旦被换掉的连接接管，
        // 只会得到"半截文件 + 一次莫名其妙的失败"，不如让它干脆失败
        pool.setBusy(opened.connectionId, true)
        try {
          return await download.download({
            archiveId: input.archiveId,
            saveDir: input.saveDir,
            finalName: input.finalName,
            source: opened.source,
            transfer: opened.transfer,
            signal: ctx.signal,
            log: (text, level) => ctx.log(text, level),
            onProgress: (p) =>
              ctx.progress({
                percent: p.percent,
                stage: p.stage,
                message: p.message,
                ...(p.bytes === undefined ? {} : { bytes: p.bytes }),
                ...(p.totalBytes === undefined ? {} : { totalBytes: p.totalBytes }),
                ...(p.files === undefined ? {} : { files: p.files }),
                ...(p.totalFiles === undefined ? {} : { totalFiles: p.totalFiles })
              })
          })
        } finally {
          pool.setBusy(opened.connectionId, false)
        }
      },
      /**
       * 收尾：**取消 / 退出时清掉未完成的下载内容**，失败时保留。
       *
       * 这个区别是有意的：
       * - 「取消」是用户的明确意图 —— "我不要了"。把几个 GB 的半截内容留在他
       *   的下载目录里，等于让他在文件管理器里自己找、自己删。
       * - 「失败」可能是"某个文件哈希不对"，那正是 T12.4 要求**保留产物并说明原因**
       *   的场景：用户可能想看看那个文件到底被改成了什么。
       *
       * 只删**本次任务的暂存目录**（`.sfvm-part-<archiveId>`），
       * 不碰最终目录、不碰保存位置里的其它东西。
       */
      async cleanup(reason, ctx) {
        if (reason === 'failed') return
        // 注意是**本地**路径拼接（`node:path`），不是远端那套 posix join
        const staging = joinLocal(input.saveDir, stagingNameOf(input.archiveId))
        try {
          const r = await removeLocalDir(staging)
          ctx.log(
            `已清理未完成的下载内容：${staging}${r ? '' : '（目录不存在，无需清理）'}`,
            'warn'
          )
        } catch (err) {
          ctx.log(`未能清理未完成的下载内容 ${staging}：${(err as Error).message}`, 'warn')
        }
      }
    } satisfies JobSpec)

    logger.info(
      `archives.download: archive=${input.archiveId} version=${row.versionTag}` +
        ` target=${target?.name ?? row.targetId} job=${job.jobId}`
    )
    return job
  })

  /* --------------------------------------------------- T12.5 删除版本 */

  registerHandler(IPC_CHANNELS.ARCHIVES_REMOVE, archiveRemoveInputSchema, async ({ archiveIds }) => {
    const rows = archiveIds.map((id) => repo.archives.get(id))
    const first = rows[0]
    if (!first) throw new AppError(ErrorCode.E_NOT_FOUND, { archiveIds })

    /**
     * 只允许删**同一个目标**下的版本。
     *
     * 跨目标批量删需要连多台服务器，而"删到一半发现自己连不上第二台"
     * 会让用户面对一个说不清的状态；界面上的勾选也天然是单目标的。
     * 真需要跨目标清理时，多操作几次比一个含糊的批量接口安全。
     */
    const otherTarget = rows.find((r) => r && r.targetId !== first.targetId)
    if (otherTarget) {
      throw new AppError(
        ErrorCode.E_PARAM,
        { targetId: first.targetId, otherTargetId: otherTarget.targetId },
        {
          message: '一次只能删除同一个目标的往期版本',
          hint: '请在目标之间分别操作。'
        }
      )
    }

    // 该目标上有任务在跑时不让删：发布/回滚正在用归档目录，
    // 而"这一版刚好是正在发布的那一版"是真实存在的场景
    assertTargetIdle(jobs, first.targetId, {
      action: '删除往期版本',
      hint: '请等它结束后再删除往期版本。'
    })

    const { ports } = await openPorts(first.targetId)
    const result = await archive.removeVersions({ archiveIds, fs: ports.fs })
    logger.info(
      `archives.remove: 成功 ${result.removed.length} / 失败 ${result.failed.length}，` +
        `释放 ${result.freedBytes} 字节`
    )
    return result
  })
}

/** 删除一个本地目录（不存在视为成功）；返回它原本是否存在。 */
async function removeLocalDir(dir: string): Promise<boolean> {
  try {
    await fsp.stat(dir)
  } catch {
    return false
  }
  await fsp.rm(dir, { recursive: true, force: true })
  return true
}
