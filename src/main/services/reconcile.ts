/**
 * ReconcileService（B14 / T14.1 ~ T14.6）：对账与崩溃恢复。
 *
 * ## 这个服务与其它服务最不一样的地方
 *
 * 其它服务都在"执行一个用户明确要求的动作"；这里是**修账**。所以它必须极保守：
 *
 * - **只补录能自证的东西**。远端版本目录里那份 `manifest.json` 是自描述的
 *   （方案书 §5.3），所以它可以作为补录依据；**没有 manifest 的目录一律不补录** ——
 *   补进去只会得到一条既不能校验、也不能回滚的记录。
 * - **只在有把握时下结论**。`missing` 只有"台账里有、远端目录确实不在"才标；
 *   内容是否损坏只有**深度校验**（逐文件哈希）才敢说，结构对账不猜。
 * - **改台账之前先说清楚改了什么**。报告里逐条给出 `inLedger / onRemote / hasManifest`
 *   与最终结论，用户能自己核对，而不是只看到一个数字。
 *
 * ## 与其它模块的分工
 *
 * | 关心的事 | 归谁 |
 * | --- | --- |
 * | 结构对不对（目录在不在、manifest 能不能解析、汇总与明细对不对得上） | 本文件（`reconcile`） |
 * | 内容对不对（逐文件哈希） | `ArchiveService.verifyArchive`（深度模式下调它） |
 * | 一次具体操作怎么走完 | `deploy` / `rollback` |
 * | 崩溃后怎么收场 | 本文件（`diagnose` / `recover`） |
 *
 * ## 端口
 *
 * 与其它服务一样：不 import electron / ssh2，副作用全经 `ReconcilePorts` 注入，
 * 于是"补录保留 archivedAt""manifest 缺失不补录"这类关键正确性用例能在单测里真跑。
 */
import { randomUUID } from 'node:crypto'
import {
  recoveryDescriptorSchema,
  RECOVERY_FILE,
  RECOVERY_CLOSED_FILE,
  type ArchiveRecoveryDescriptor
} from '../infra/archive-recovery'
import { acquireRemoteLock, type LockFsPort } from '../infra/deploy-lock'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { normalizeRemotePath } from '../infra/remote-path'
import { parentDirOf } from '../infra/archive-dir'
import { joinRemote } from '../infra/hash-core'
import { toUtcIso } from '../infra/version-tag'
import {
  MANIFEST_FILE_NAME,
  PAYLOAD_DIR_NAME,
  parseManifestText,
  checkManifestConsistency
} from '../infra/manifest-io'
import { stagingRootOf, lockPathOf, parseLockPayload } from '../infra/deploy-plan'
import { STAGING_PREFIX } from '../../shared/contracts/deploy'
import { VERSION_TAG_PATTERN } from '../../shared/contracts/archive'
import { archiveDirOf, type ArchiveFsPort, type ArchivePorts, type ArchiveService } from './archive'
import type { RemoteHashPort } from './hash'
import type { Repositories } from '../db/repositories'
import type {
  DiagnoseInput,
  ReconcileInput,
  ReconcileReport,
  RecoverInput,
  RecoverResult,
  RecoveryDiagnosis,
  RemoteLockInfoView,
  RemoveRemoteLockInput,
  StartupScan
} from '../../shared/contracts/reconcile'

/**
 * 台账扫描窗口。
 *
 * 与保留策略用同一个理由（`ArchiveService` 的 `RETENTION_SCAN_LIMIT`）：
 * **对账必须是全量的** —— 只扫前 1000 条的话，第 1001 条之后的差异永远发现不了，
 * 而这正是"删了数据库要重建"的场景里最要紧的那部分。
 */
const RECONCILE_SCAN_LIMIT = 100000

/** 对账需要的远端能力（比归档多一个 `readdir`：要列归档目录）。 */
export interface ReconcilePorts {
  fs: ArchiveFsPort &
    LockFsPort & {
      readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>>
    }
  hash: RemoteHashPort
}

export interface ReconcileLogFn {
  // 带上 `debug`：`ArchiveService` 的日志函数是更宽的签名（深度校验时直接复用）
  (text: string, level?: 'debug' | 'info' | 'warn' | 'error'): void
}

export function createReconcileService(deps: {
  repo: Repositories
  archive: ArchiveService
  now?: () => Date
}) {
  const { repo, archive } = deps
  const now = deps.now ?? ((): Date => new Date())

  /* ------------------------------------------------ 启动残留扫描（T14.4） */

  /**
   * 扫一遍台账里"可能没做完"的操作。**纯本地**，所以启动时就能跑。
   *
   * 判定是 `status NOT IN TERMINAL_RELEASE_STATUSES`（SUCCESS / FAILED / ROLLED_BACK 之外的
   * 都算"可能中断"）。注意这里**不做任何修正** —— 启动扫描要快、要只读；
   * 真正要动台账或远端，得等用户在对账/恢复里明确点一下。
   */
  function startupScan(): StartupScan {
    const rows = repo.releases.listUnfinished()
    const unfinished = rows.map((r) => {
      const target = repo.targets.get(r.targetId)
      const env = target ? repo.environments.get(target.environmentId) : undefined
      return {
        releaseId: r.id,
        targetId: r.targetId,
        // 目标可能已经被删了（那这条记录本身就是孤儿），如实说明而不是崩掉
        targetName: target?.name ?? '(目标已删除)',
        environmentName: env?.name ?? '(环境已删除)',
        action: r.action,
        status: r.status,
        recoveryRequired: r.recoveryRequired,
        versionTag: r.versionTag,
        startedAt: r.startedAt,
        currentStep: r.currentStep ?? null
      }
    })
    return { scannedAt: now().toISOString(), unfinished }
  }

  /* ---------------------------------------------------- 远端锁（T14.6） */

  async function readLock(
    input: { targetId: string },
    ports: ReconcilePorts
  ): Promise<RemoteLockInfoView> {
    const target = repo.targets.get(input.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: input.targetId })
    const remotePath = normalizeRemotePath(target.remotePath)
    const lockPath = lockPathOf(remotePath)

    let text: string | null
    try {
      text = await ports.fs.readTextFile(lockPath)
    } catch {
      text = null // 读不到 = 没有锁
    }
    if (text === null) {
      return {
        targetId: target.id,
        remotePath,
        exists: false,
        path: lockPath,
        releaseId: null,
        hostname: null,
        pid: null,
        ts: null,
        stale: false,
        unreadable: false
      }
    }
    const lock = parseLockPayload(text, now())
    return {
      targetId: target.id,
      remotePath,
      exists: true,
      path: lockPath,
      releaseId: lock?.releaseId ?? null,
      hostname: lock?.hostname ?? null,
      pid: lock?.pid ?? null,
      ts: lock?.ts ?? null,
      // 内容读不懂时**当作陈旧**（与 `deploy-plan.isLockStale` 同一口径）：
      // 否则用户会被一把"永远清不掉"的坏锁挡在门外
      stale: lock ? lock.stale : true,
      unreadable: lock === null
    }
  }

  /**
   * 人工确认后删锁（T14.6）。
   *
   * 与 `deploy.cleanResidue` 一样，这个入口**只做一件明确的事**：
   * 删掉那个固定的锁文件路径。它不接受任意路径，也不顺手清别的东西 ——
   * 否则它就成了"删任意远端文件"的开关。
   *
   * 不满 30 分钟的锁**也允许删**：方案书 §6.8 要求"锁只由人确认后清理"，
   * 而不是"超过 30 分钟才能清"。界面上的文案负责说清风险。
   */
  async function removeLock(
    input: RemoveRemoteLockInput,
    ports: ReconcilePorts,
    log: ReconcileLogFn = (): void => undefined
  ): Promise<{ removed: boolean; path: string }> {
    const before = await readLock({ targetId: input.targetId }, ports)
    if (!before.exists) {
      return { removed: false, path: before.path }
    }
    await ports.fs.removeFile(before.path)
    logger.warn(`人工清理远端锁 ${before.path}（原属 releaseId=${before.releaseId ?? '?'}）`)
    log(`已删除远端锁 ${before.path}`, 'warn')
    repo.audit.write({
      level: 'warn',
      scope: 'reconcile',
      refId: input.targetId,
      message: `人工清理远端锁 ${before.path}`,
      detail: JSON.stringify({ lock: before, confirmed: input.confirmed })
    })
    return { removed: true, path: before.path }
  }

  /* ---------------------------------------------------------- 对账（T14.1~T14.3） */

  async function reconcile(
    input: ReconcileInput & { ports: ReconcilePorts; log?: ReconcileLogFn }
  ): Promise<ReconcileReport> {
    const started = Date.now()
    const log: ReconcileLogFn = input.log ?? ((): void => undefined)
    const target = repo.targets.get(input.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: input.targetId })

    const remotePath = normalizeRemotePath(target.remotePath)
    const archiveDir = archiveDirOf(target)
    const doAdopt = input.adopt !== false
    const doMarkMissing = input.markMissing !== false
    const deep = input.deep === true
    const fs = input.ports.fs

    log(`开始对账「${target.name}」：远端 ${archiveDir} ↔ 本地台账`)

    /* ---- 1) 列远端归档目录 ---- */
    /**
     * 先用 `stat` 判断"在不在"，再决定要不要列。
     *
     * 不靠"`readdir` 抛错"来判断：真实 SFTP 上不同服务端对"列一个不存在的目录"
     * 返回的错误码不统一（有的返回空列表、有的报 `SSH_FX_NO_SUCH_FILE`），
     * 靠异常区分"目录不存在"和"目录存在但读不了"是不可靠的。
     * `stat` 的语义就是"存在吗"，用它。
     *
     * 归档目录不存在不是错误：这个目标可能从来没归档过任何版本。
     */
    const archiveDirExists = (await fs.stat(archiveDir)).exists
    let entries: Array<{ name: string; isDirectory: boolean; size: number }> = []
    if (archiveDirExists) {
      try {
        entries = await fs.readdir(archiveDir)
      } catch (err) {
        // 存在却列不出来（权限？）：如实报出来，不要假装"这个目标没有归档"
        logger.warn(`归档目录存在但无法列出：${archiveDir}（${(err as Error).message}）`)
        log(`警告：归档目录 ${archiveDir} 无法列出：${(err as Error).message}`, 'warn')
      }
    }

    const remoteTags: string[] = []
    const unrecognized: string[] = []
    for (const e of entries) {
      if (!e.isDirectory) {
        // 归档目录下的散落文件不认得，如实报告（不去动它）
        unrecognized.push(e.name)
        continue
      }
      if (VERSION_TAG_PATTERN.test(e.name)) remoteTags.push(e.name)
      else unrecognized.push(e.name)
    }
    remoteTags.sort()

    for (const tag of remoteTags) {
      const intentPath = joinRemote(joinRemote(archiveDir, tag), RECOVERY_FILE)
      const closedPath = joinRemote(joinRemote(archiveDir, tag), RECOVERY_CLOSED_FILE)
      const markerPath = (await fs.stat(closedPath)).exists ? closedPath : intentPath
      if (!(await fs.stat(markerPath)).exists) continue
      try {
        const raw = JSON.parse(await fs.readTextFile(markerPath))
        const descriptor = checkedDescriptor(raw, target, raw.operationId)
        const existing = repo.releases.get(descriptor.operationId)
        if (existing && existing.targetId !== target.id) throw new Error('recovery target mismatch')
        if (descriptor.phase === 'committed' || descriptor.phase === 'abandoned') {
          if (existing) {
            repo.atomic(() => {
              repo.releases.finish(
                existing.id,
                descriptor.phase === 'committed' ? 'SUCCESS' : 'FAILED'
              )
              repo.releases.update(existing.id, {
                recoveryRequired: false,
                recoveryInfo: null,
                ...(descriptor.phase === 'abandoned' ? { currentStep: 'recovered-abandoned' } : {})
              })
            })
          }
          if ((await fs.stat(intentPath)).exists) await fs.removeFile(intentPath)
          if ((await fs.stat(closedPath)).exists) await fs.removeFile(closedPath)
          continue
        }
        if (!existing)
          repo.releases.create({
            id: descriptor.operationId,
            targetId: target.id,
            action: 'deploy',
            status: 'FAILED',
            versionTag: descriptor.versionTag,
            recoveryRequired: true,
            recoveryInfo: JSON.stringify(descriptor),
            currentStep: 'recovery-required'
          })
        else if (
          !['SUCCESS', 'ROLLED_BACK'].includes(existing.status) &&
          !existing.currentStep?.startsWith('recovered-')
        ) {
          repo.releases.update(existing.id, {
            recoveryRequired: true,
            recoveryInfo: JSON.stringify(descriptor)
          })
        }
      } catch (err) {
        log(`恢复信息无法补录：${markerPath}：${String(err)}`, 'warn')
      }
    }

    /* ---- 2) 台账（全量：对账不能只看前 N 条） ---- */
    const ledger = repo.archives.listByTarget(target.id, RECONCILE_SCAN_LIMIT)
    const ledgerByTag = new Map(ledger.map((r) => [r.versionTag, r]))

    const report: ReconcileReport = {
      targetId: target.id,
      targetName: target.name,
      remotePath,
      archiveDir,
      archiveDirExists,
      counts: {
        adopted: 0,
        foundMissing: 0,
        markedMissing: 0,
        corrupt: 0,
        ok: 0,
        unrecognized: unrecognized.length,
        withoutManifest: 0
      },
      adopted: [],
      missing: [],
      corrupt: [],
      items: [],
      unrecognized,
      lock: null,
      stagingResidue: [],
      deep,
      durationMs: 0
    }

    /* ---- 3) 远端逐个版本目录 ---- */
    for (const tag of remoteTags) {
      const storagePath = joinRemote(archiveDir, tag)
      const payloadPath = joinRemote(storagePath, PAYLOAD_DIR_NAME)
      const row = ledgerByTag.get(tag)

      let manifest: ReturnType<typeof parseManifestText>['manifest'] | null = null
      let manifestProblem: string | null = null
      try {
        const text = await fs.readTextFile(joinRemote(storagePath, MANIFEST_FILE_NAME))
        const parsed = parseManifestText(text)
        const issues = checkManifestConsistency(parsed.manifest)
        if (issues.length > 0) manifestProblem = `manifest 自相矛盾：${issues.join('；')}`
        manifest = parsed.manifest
      } catch (err) {
        manifestProblem =
          err instanceof AppError ? `manifest 不可用（${err.code}）` : 'manifest 读取失败'
      }

      /**
       * **没有 manifest 就不补录**。
       *
       * 没有自描述信息，我们不知道这份内容是什么、指纹是多少、什么时候归档的 ——
       * 补录进去只会得到一条既不能校验、也不能回滚的记录，还会让"版本库"这个
       * 概念本身变得不可信。如实报告出来，让人来判断。
       */
      if (!manifest) {
        report.counts.withoutManifest += 1
        report.items.push({
          versionTag: tag,
          inLedger: Boolean(row),
          onRemote: true,
          hasManifest: false,
          status: 'no-manifest',
          archivedAt: row?.archivedAt ?? null,
          fileCount: row?.fileCount ?? null,
          totalBytes: row?.totalBytes ?? null,
          note: `${manifestProblem ?? '缺少 manifest.json'}（未补录，需要人工处理；若确认是归档失败留下的无清单副本，可直接删除该版本目录）`
        })
        continue
      }

      /**
       * **形状守卫**：归档的 `originalPath` 必须是这个目标。
       *
       * 归档目录有可能被人为塞进了别的目标的内容（复制目录、改名、手工放一份）。
       * 那种东西补进来会让"某个版本属于哪个目标"这件事彻底乱掉 ——
       * 回滚时就会把别人的内容搬到这个目标上。
       */
      if (normalizeRemotePath(manifest.originalPath) !== remotePath) {
        report.counts.withoutManifest += 1
        report.items.push({
          versionTag: tag,
          inLedger: Boolean(row),
          onRemote: true,
          hasManifest: true,
          status: 'no-manifest',
          archivedAt: manifest.archivedAt,
          fileCount: manifest.fileCount,
          totalBytes: manifest.totalBytes,
          note: `manifest 里的目标路径是 ${manifest.originalPath}，与本目标（${remotePath}）不一致，未补录`
        })
        continue
      }

      const payloadExists = (await fs.stat(payloadPath)).exists

      if (!row) {
        /* ---- 远端有、台账没有 → 补录 ---- */
        if (!doAdopt) {
          report.items.push({
            versionTag: tag,
            inLedger: false,
            onRemote: true,
            hasManifest: true,
            status: 'adopted',
            archivedAt: manifest.archivedAt,
            fileCount: manifest.fileCount,
            totalBytes: manifest.totalBytes,
            note: payloadExists ? '远端有、台账没有（按设置未补录）' : '归档内容目录不存在'
          })
          continue
        }
        /**
         * 补录的字段**全部来自 manifest**（远端是真相来源）。
         *
         * `archivedAt` 也必须用 manifest 里的那个：它是"这个版本是什么时候归档的"
         * 唯一可靠记录 —— 用"现在"会让 MT-06（删库后重建）的时间对不上，
         * 而且往期版本列表的排序会整体乱掉。
         */
        // P1-1：manifest 时间是本地偏移格式，落库前归一成 UTC（见 toUtcIso 注释）。
        const manifestTimeParsed = toUtcIso(manifest.archivedAt)
        const adoptedAt = manifestTimeParsed ?? new Date().toISOString()
        const created = repo.archives.create({
          targetId: target.id,
          versionTag: tag,
          storagePath,
          payloadPath,
          kind: manifest.kind === 'file' ? 'file' : 'dir',
          rootHash: manifest.rootHash,
          totalBytes: manifest.totalBytes,
          fileCount: manifest.fileCount,
          releaseId: manifest.sourceReleaseId ?? null,
          note: manifest.note ?? null,
          status: payloadExists ? 'valid' : 'missing',
          // P1-1：manifest 里的时间（本地偏移格式）必须归一成 UTC 再落库 ——
          // archived_at 列上的排序/统计是字符串比较，两种格式混存会错序。
          // manifest 时间解析失败（不该发生）→ 用重建时刻兜底，报告里注明。
          archivedAt: adoptedAt
        })
        report.counts.adopted += 1
        report.adopted.push({
          versionTag: tag,
          archiveId: created.id,
          archivedAt: created.archivedAt,
          fileCount: manifest.fileCount,
          totalBytes: manifest.totalBytes,
          how: 'adopted'
        })
        report.items.push({
          versionTag: tag,
          inLedger: false,
          onRemote: true,
          hasManifest: true,
          status: 'adopted',
          archivedAt: manifest.archivedAt,
          fileCount: manifest.fileCount,
          totalBytes: manifest.totalBytes,
          note:
            (payloadExists
              ? '已按 manifest 补录'
              : '已补录，但归档内容目录不存在（标为 missing）') +
            (manifestTimeParsed ? '' : '；manifest 时间无法解析，台账已用重建时刻')
        })
        log(`补录版本 ${tag}（${manifest.fileCount} 个文件，${created.archivedAt}）`)
        continue
      }

      /* ---- 两边都有：核对关键字段 ---- */
      const drifted =
        row.rootHash !== manifest.rootHash ||
        row.totalBytes !== manifest.totalBytes ||
        row.fileCount !== manifest.fileCount ||
        (row.kind === 'file' ? 'file' : 'dir') !== (manifest.kind === 'file' ? 'file' : 'dir')

      if (!payloadExists) {
        report.counts.foundMissing += 1
        if (doMarkMissing && row.status !== 'missing') {
          repo.archives.setStatus(row.id, 'missing')
          report.counts.markedMissing += 1
        }
        report.missing.push({ versionTag: tag, archiveId: row.id })
        report.items.push({
          versionTag: tag,
          inLedger: true,
          onRemote: true,
          hasManifest: true,
          status: 'missing',
          archivedAt: manifest.archivedAt,
          fileCount: manifest.fileCount,
          totalBytes: manifest.totalBytes,
          note: '版本目录在，但归档内容目录（payload）不存在'
        })
        continue
      }

      if (drifted && doAdopt) {
        /**
         * 台账记的与 manifest 不符 → **以 manifest 为准**（远端是真相来源）。
         *
         * `archivedAt` 同样要归一成 UTC 再落库（M1）：manifest 里的时间是
         * **本地偏移格式**（`2026-10-09T12:00:00+08:00`），而 `archived_at` 列上的
         * 排序/统计是**字符串比较** —— 迁移 0003 已经把存量行统一成 UTC，
         * 这里若原样写回本地偏移，就会在列里重新混入两种格式、把顺序搞乱
         * （正是上面"补录"分支已经用 `toUtcIso` 规避的那个坑，修正分支漏了）。
         * manifest 时间解析不出来时保留台账原值：改成"现在"会让这条版本的
         * 归档时间凭空变新，比"沿用旧值"更失真。
         */
        repo.archives.update(row.id, {
          rootHash: manifest.rootHash,
          totalBytes: manifest.totalBytes,
          fileCount: manifest.fileCount,
          archivedAt: toUtcIso(manifest.archivedAt) ?? row.archivedAt,
          status: 'valid'
        })
        report.counts.adopted += 1
        report.adopted.push({
          versionTag: tag,
          archiveId: row.id,
          archivedAt: manifest.archivedAt,
          fileCount: manifest.fileCount,
          totalBytes: manifest.totalBytes,
          how: 'updated'
        })
        report.items.push({
          versionTag: tag,
          inLedger: true,
          onRemote: true,
          hasManifest: true,
          status: 'updated',
          archivedAt: manifest.archivedAt,
          fileCount: manifest.fileCount,
          totalBytes: manifest.totalBytes,
          note: '台账记录与 manifest 不一致，已按 manifest 修正'
        })
        log(`按 manifest 修正台账里的 ${tag}`, 'warn')
        continue
      }

      report.counts.ok += 1
      report.items.push({
        versionTag: tag,
        inLedger: true,
        onRemote: true,
        hasManifest: true,
        status: row.status === 'corrupt' ? 'corrupt' : 'valid',
        archivedAt: manifest.archivedAt,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        note: manifestProblem ?? null
      })
    }

    /* ---- 4) 台账有、远端没有 → missing ---- */
    const remoteSet = new Set(remoteTags)
    for (const row of ledger) {
      if (remoteSet.has(row.versionTag)) continue
      report.counts.foundMissing += 1
      if (doMarkMissing && row.status !== 'missing') {
        repo.archives.setStatus(row.id, 'missing')
        report.counts.markedMissing += 1
      }
      report.missing.push({ versionTag: row.versionTag, archiveId: row.id })
      report.items.push({
        versionTag: row.versionTag,
        inLedger: true,
        onRemote: false,
        hasManifest: false,
        status: 'missing',
        archivedAt: row.archivedAt,
        fileCount: row.fileCount,
        totalBytes: row.totalBytes,
        note: '台账里有，但远端归档目录里已经没有这个版本'
      })
    }
    if (report.counts.foundMissing > 0) {
      log(
        doMarkMissing
          ? `${report.counts.markedMissing} 个版本在远端已不存在，台账已标记为「目录缺失」`
          : `${report.counts.foundMissing} 个版本在远端已不存在（本次为只读预演，台账未改动）`,
        'warn'
      )
    }

    /* ---- 5) 深度校验（可选，慢） ---- */
    if (deep) {
      const toVerify = repo.archives
        .listByTarget(target.id, RECONCILE_SCAN_LIMIT)
        .filter((r) => remoteSet.has(r.versionTag))
      log(`深度校验 ${toVerify.length} 个版本（逐文件比对内容与 manifest）…`)
      for (const row of toVerify) {
        try {
          const v = await archive.verifyArchive({
            archiveId: row.id,
            ports: { fs, hash: input.ports.hash } satisfies ArchivePorts,
            log: (text, level) => log(text, level)
          })
          if (!v.ok) {
            report.counts.corrupt += 1
            report.corrupt.push({ versionTag: row.versionTag, reason: v.message })
          }
        } catch (err) {
          report.counts.corrupt += 1
          report.corrupt.push({ versionTag: row.versionTag, reason: (err as Error).message })
        }
      }
    }

    /* ---- 6) 顺带看一眼锁与暂存残留（T14.4/T14.6） ---- */
    try {
      const lockView = await readLock({ targetId: target.id }, input.ports)
      report.lock = lockView.exists
        ? {
            path: lockView.path,
            releaseId: lockView.releaseId,
            hostname: lockView.hostname,
            ts: lockView.ts,
            stale: lockView.stale,
            unreadable: lockView.unreadable
          }
        : null
    } catch {
      report.lock = null
    }
    try {
      const parent = parentDirOf(remotePath)
      report.stagingResidue = (await fs.readdir(parent))
        .filter((e) => e.name.startsWith(STAGING_PREFIX))
        .map((e) => joinRemote(parent, e.name))
    } catch {
      report.stagingResidue = []
    }

    report.durationMs = Date.now() - started
    log(
      `对账完成：补录 ${report.counts.adopted}、缺失 ${report.counts.foundMissing}、` +
        `损坏 ${report.counts.corrupt}、正常 ${report.counts.ok}（${report.durationMs}ms）`
    )
    repo.audit.write({
      level: 'info',
      scope: 'reconcile',
      refId: target.id,
      message: `对账完成（${archiveDir}）`,
      detail: JSON.stringify({ counts: report.counts, deep })
    })
    return report
  }

  /* ------------------------------------------------ 崩溃恢复（T14.5） */

  /**
   * 现场勘察：这次操作走到哪、目标路径现在什么样、用户还剩什么。
   *
   * 三个选项的可用性就从这里推出来（界面直接按 `options` 决定按钮能不能点）。
   */
  function validateRecoveryRelease(targetId: string, releaseId: string, allowCompleted = false) {
    if (!/^[a-zA-Z0-9_-]+$/.test(releaseId))
      throw new AppError(ErrorCode.E_DEPLOY_BLOCKED, { releaseId })
    const release = repo.releases.get(releaseId)
    if (!release) throw new AppError(ErrorCode.E_NOT_FOUND, { releaseId })
    if (release.targetId !== targetId)
      throw new AppError(ErrorCode.E_DEPLOY_BLOCKED, { targetId, releaseId })
    const completedRecovery =
      release.status === 'FAILED' && release.currentStep?.startsWith('recovered-')
    if (
      ['SUCCESS', 'ROLLED_BACK'].includes(release.status) ||
      (release.status === 'FAILED' &&
        !release.recoveryRequired &&
        !(allowCompleted && completedRecovery))
    ) {
      throw new AppError(
        ErrorCode.E_DEPLOY_BLOCKED,
        { releaseId },
        { message: '这条操作已结束，不允许执行崩溃恢复' }
      )
    }
    return release
  }

  function checkedDescriptor(
    raw: unknown,
    target: NonNullable<ReturnType<typeof repo.targets.get>>,
    releaseId: string
  ): ArchiveRecoveryDescriptor {
    const d = recoveryDescriptorSchema.parse(raw)
    const remotePath = normalizeRemotePath(target.remotePath)
    const expectedStorage = joinRemote(archiveDirOf(target), d.versionTag)
    if (
      d.targetId !== target.id ||
      d.operationId !== releaseId ||
      d.originalPath !== remotePath ||
      !VERSION_TAG_PATTERN.test(d.versionTag) ||
      d.storagePath !== expectedStorage ||
      d.payloadPath !== joinRemote(expectedStorage, PAYLOAD_DIR_NAME) ||
      d.artifactPath !== joinRemote(d.payloadPath, remotePath.split('/').at(-1)!) ||
      d.kind !== target.kind
    )
      throw new AppError(ErrorCode.E_DEPLOY_BLOCKED, {
        releaseId,
        reason: 'recovery-path-mismatch'
      })
    return d
  }

  function descriptorFor(
    target: NonNullable<ReturnType<typeof repo.targets.get>>,
    release: NonNullable<ReturnType<typeof repo.releases.get>>
  ) {
    if (release.recoveryInfo)
      return checkedDescriptor(JSON.parse(release.recoveryInfo), target, release.id)
    const row =
      release.action === 'deploy'
        ? release.archiveId
          ? repo.archives.get(release.archiveId)
          : undefined
        : repo.archives
            .listByTarget(target.id, RECONCILE_SCAN_LIMIT)
            .find((r) => r.releaseId === release.id)
    if (!row || row.targetId !== target.id) return undefined
    return checkedDescriptor(
      {
        operationId: release.id,
        targetId: target.id,
        originalPath: normalizeRemotePath(target.remotePath),
        storagePath: row.storagePath,
        payloadPath: row.payloadPath,
        artifactPath: joinRemote(
          row.payloadPath,
          normalizeRemotePath(target.remotePath).split('/').at(-1)!
        ),
        kind: row.kind,
        archiveMoveMode: 'rename',
        versionTag: row.versionTag,
        rootHash: row.rootHash,
        archiveId: row.id
      },
      target,
      release.id
    )
  }

  async function diagnose(
    input: DiagnoseInput & { ports: ReconcilePorts }
  ): Promise<RecoveryDiagnosis> {
    const target = repo.targets.get(input.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: input.targetId })
    const release = validateRecoveryRelease(target.id, input.releaseId)

    const remotePath = normalizeRemotePath(target.remotePath)
    const fs = input.ports.fs

    const st = await fs.stat(remotePath)
    const descriptor = descriptorFor(target, release)
    const archiveRow = descriptor
      ? { ...descriptor, id: descriptor.archiveId ?? descriptor.storagePath }
      : undefined
    const storageExists = descriptor ? (await fs.stat(descriptor.artifactPath)).exists : false

    const lockView = await readLock({ targetId: target.id }, input.ports).catch(() => null)
    let staging: string[]
    try {
      const parent = parentDirOf(remotePath)
      staging = (await fs.readdir(parent))
        .filter((e) => joinRemote(parent, e.name) === stagingRootOf(remotePath, release.id))
        .map((e) => joinRemote(parent, e.name))
    } catch {
      staging = []
    }

    const canRestore = Boolean(archiveRow && storageExists)
    /**
     * 目标路径上有内容时**不允许** restore。
     *
     * 两个原因：① `undoArchive` 明确拒绝往已有内容的路径上搬东西；
     * ② 更要紧的是"目标里现在这套东西是什么"没人判断得了 ——
     * 可能是这次操作换上去的半成品、也可能是别人后来放的。
     * 这种情况只该由人看过之后决定，不该由工具替他决定。
     */
    const targetOccupied = st.exists
    const lockBlocked = Boolean(lockView?.exists)
    const lockReason =
      '远端锁仍存在。确认没有其他操作后，请先到「往期版本 → 对账」显式清理旧锁，再查看现场。'
    const restoreReason = lockBlocked
      ? lockReason
      : !archiveRow
        ? '这次操作没有归档过旧版本（崩在归档之前），没有东西可以恢复'
        : !storageExists
          ? `归档内容 ${archiveRow.storagePath} 已不存在，无法恢复`
          : targetOccupied
            ? '目标路径上已有内容：可能是这次操作留下的半成品，也可能是别的程序放进去的。请先人工确认，再决定是恢复还是放弃'
            : '可以把归档的旧版本搬回目标路径'

    const options: RecoveryDiagnosis['options'] = [
      {
        mode: 'restore-old',
        enabled: canRestore && !targetOccupied && !lockBlocked,
        reason: restoreReason
      },
      {
        mode: 'abandon',
        enabled: !lockBlocked,
        reason: lockBlocked ? lockReason : '把这条记录收尾（标为失败），仅清理本记录的暂存目录'
      },
      { mode: 'retry', enabled: true, reason: '用当前本地产物重新发起一次发布（新的一次操作）' }
    ]

    const archiveText = archiveRow
      ? `归档里有 ${archiveRow.versionTag}${storageExists ? '' : '（目录已不存在）'}`
      : '没有归档记录'
    const summary =
      `${release.action === 'rollback' ? '回滚' : '发布'}停在「${release.currentStep ?? release.status}」；` +
      `目标路径${targetOccupied ? '有内容' : '为空/不存在'}；${archiveText}` +
      (staging.length > 0 ? `；有 ${staging.length} 个暂存残留` : '')

    return {
      releaseId: release.id,
      targetId: target.id,
      targetName: target.name,
      remotePath,
      release: {
        action: release.action,
        status: release.status,
        versionTag: release.versionTag,
        startedAt: release.startedAt,
        currentStep: release.currentStep ?? null
      },
      target: { exists: st.exists, isDirectory: st.isDirectory },
      archive: archiveRow
        ? { archiveId: archiveRow.id, versionTag: archiveRow.versionTag, storageExists }
        : null,
      lock: lockView?.exists
        ? { path: lockView.path, releaseId: lockView.releaseId, stale: lockView.stale }
        : null,
      staging,
      options,
      summary
    }
  }

  /**
   * 按选定的方式收场。
   *
   * 校验记录并获取新锁后，只向空目标恢复旧版；已有目标内容必须由人确认。
   * 仅清理本记录的暂存目录，释放自己持有的锁，最后收尾或保留待恢复状态。
   */
  async function recover(
    input: RecoverInput & { ports: ReconcilePorts; log?: ReconcileLogFn; signal?: AbortSignal }
  ): Promise<RecoverResult> {
    const log = input.log ?? ((): void => undefined)
    const target = repo.targets.get(input.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: input.targetId })
    const release = validateRecoveryRelease(target.id, input.releaseId, true)
    if (
      !release.recoveryRequired &&
      release.currentStep === `recovered-${input.mode === 'restore-old' ? 'restored' : 'abandoned'}`
    ) {
      return {
        releaseId: release.id,
        mode: input.mode,
        status: 'success',
        actions: [],
        manualCleanup: []
      }
    }
    const remotePath = normalizeRemotePath(target.remotePath)
    const fs = input.ports.fs
    const recovery = descriptorFor(target, release)
    if (input.signal?.aborted) throw new AppError(ErrorCode.E_JOB_CANCELLED, {})
    if (input.mode === 'restore-old' && !recovery)
      throw new AppError(ErrorCode.E_NOT_FOUND, { releaseId: release.id })
    const lockId = `recovery_${randomUUID()}`
    // An old lock must be explicitly removed through the existing confirmation UI.
    await acquireRemoteLock({
      fs,
      remotePath,
      releaseId: lockId,
      hostname: 'sfvm-recovery',
      pid: process.pid,
      now: now(),
      cleanStaleLock: false,
      log
    })
    const actions: RecoverResult['actions'] = []
    const attempt = async (action: string, fn: () => Promise<void> | void): Promise<void> => {
      try {
        await fn()
        actions.push({ action, ok: true })
      } catch (err) {
        actions.push({ action, ok: false, detail: String(err) })
        log(`${action}失败：${String(err)}`, 'error')
      }
    }
    try {
      if (input.mode === 'restore-old') {
        if ((await fs.stat(remotePath)).exists)
          throw new AppError(
            ErrorCode.E_DEPLOY_BLOCKED,
            {},
            { message: '目标路径已有内容，拒绝覆盖；请先人工确认' }
          )
        if (input.signal?.aborted) throw new AppError(ErrorCode.E_JOB_CANCELLED, {})
        await attempt('恢复旧版本', () =>
          archive.restoreRecovery({ recovery: recovery!, ports: input.ports, log })
        )
      }
      if (input.cleanResidue !== false) {
        await attempt('清理暂存目录', async () => {
          const staging = stagingRootOf(remotePath, release.id)
          if ((await fs.stat(staging)).exists) await fs.rmrf(staging)
        })
      }
    } finally {
      await attempt('释放恢复锁', async () => {
        const owner = parseLockPayload(await fs.readTextFile(lockPathOf(remotePath)), now())
        if (owner?.releaseId !== lockId) throw new AppError(ErrorCode.E_TARGET_BUSY, { lockId })
        await fs.removeFile(lockPathOf(remotePath))
      })
    }
    const failed = actions.some((a) => !a.ok)
    await attempt('收尾台账', () => {
      repo.atomic(() => {
        repo.releases.finish(release.id, 'FAILED', `crashed:${input.mode}`)
        repo.releases.update(release.id, {
          recoveryRequired: failed,
          recoveryInfo: failed && recovery ? JSON.stringify(recovery) : null,
          ...(!failed && input.mode === 'restore-old' && release.action === 'deploy'
            ? { archiveId: null }
            : {}),
          currentStep: failed
            ? 'recovery-partial'
            : input.mode === 'restore-old'
              ? 'recovered-restored'
              : 'recovered-abandoned'
        })
      })
    })
    if (!actions.some((a) => !a.ok) && recovery && (await fs.stat(recovery.storagePath)).exists) {
      await attempt('清理恢复标记', () => archive.completeRecovery(recovery, fs, 'abandoned'))
    }
    if (actions.some((a) => !a.ok)) {
      try {
        repo.releases.update(release.id, {
          recoveryRequired: true,
          recoveryInfo: recovery ? JSON.stringify(recovery) : null,
          currentStep: 'recovery-partial'
        })
      } catch (err) {
        log(`恢复残留标记写入失败：${String(err)}`, 'error')
      }
    }
    try {
      repo.audit.write({
        level: 'warn',
        scope: 'reconcile',
        refId: target.id,
        message: `崩溃恢复（${input.mode}）`,
        detail: JSON.stringify({ releaseId: release.id, actions })
      })
    } catch (err) {
      log(`恢复审计写入失败：${String(err)}`, 'warn')
    }
    const manualCleanup = actions.filter((a) => !a.ok).map((a) => a.detail ?? a.action)
    return {
      releaseId: release.id,
      mode: input.mode,
      status: manualCleanup.length ? 'partial' : 'success',
      actions,
      manualCleanup
    }
  }

  return { startupScan, reconcile, diagnose, recover, readLock, removeLock }
}

export type ReconcileService = ReturnType<typeof createReconcileService>
