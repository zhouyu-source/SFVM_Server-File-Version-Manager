/**
 * 往期版本下载服务（B12 / T12.3~T12.4）。
 *
 * 一句话：**把远端归档目录的内容，按 `manifest.json` 逐文件校验地搬到本地**。
 *
 * ## 为什么"校验"只做一遍、而且交给传输层做
 *
 * 每一笔文件在下载时都带 `expectedHash`，`transfer.download()` 的实现是
 * "先写 `.part` → 对**刚落盘的文件**读一遍算哈希 → 一致才 rename 成正式名"。
 * 也就是说：**校验发生在数据已经在本地磁盘上之后**，不是"写完就信"。
 *
 * 那么要不要再全量算一次本地 rootHash？不需要，而且是浪费：
 * rootHash 是 `(relPath, hash)` 序列的聚合值，既然每个文件都与 manifest 一致、
 * 文件集合也与 manifest 一致（阶段 3 复核），聚合值必然一致 ——
 * 再读一遍几个 GB 的产物只为了验证一个数学恒等式，不可取。
 *
 * 阶段 3 仍然要**走一遍目录**，但它看的是**集合与大小**（有没有缺文件、
 * 有没有多出文件），这是"逐文件哈希"无法回答的问题，且代价只是一次 stat 遍历。
 *
 * ## 失败时产物留在哪里
 *
 * T12.4 要求"校验失败时保留产物并说明原因"。所以：
 * - 全程写**暂存目录** `<saveDir>/.sfvm-part-<archiveId>/`，只有全部通过才 rename
 *   成 `<saveDir>/<目标名>-<版本号>/`；
 * - 任何失败都**不删暂存目录**，错误信息里带上它的路径 ——
 *   用户可能只是想把已经下好的那几个文件拿走，替他删掉是越权；
 * - 下一次下载会先清掉这个暂存目录（半截内容没有保留价值），这条写在日志里。
 */
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { AppError, ErrorCode, type ErrorCodeValue } from '../infra/errors'
import { logger } from '../infra/logger'
import { joinRemote } from '../infra/hash-core'
import { MANIFEST_FILE_NAME, parseManifestText, type ParsedManifest } from '../infra/manifest-io'
import {
  buildArchiveDirName,
  joinInside,
  mapStagePercent,
  pickFreeDirName,
  stagingNameOf,
  unsafeRelPathsOf
} from '../infra/archive-download'
import { collectLocalFiles } from './hash'
import type { ArchiveFsPort } from './archive'
import { DEFAULT_CONCURRENCY, type Transfer } from './transfer'
import type { JobLogLevel } from '../../shared/contracts/job'
import type { ArchiveDownloadPlan, ArchiveDownloadResult } from '../../shared/contracts/archive'
import type { Repositories } from '../db/repositories'

/** 本地文件系统的最小面：注入以便单测在不碰真实磁盘的情况下覆盖各分支。 */
export interface LocalFsPort {
  stat(path: string): Promise<{ exists: boolean; isDirectory: boolean }>
  mkdirp(path: string): Promise<void>
  /** 递归删除；不存在视为成功 */
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

const defaultLocalFs: LocalFsPort = {
  async stat(path) {
    try {
      const st = await fsp.stat(path)
      return { exists: true, isDirectory: st.isDirectory() }
    } catch {
      // 不存在与"没权限看"在下载场景里都表现为"这儿什么都没有"，都由后续步骤报错
      return { exists: false, isDirectory: false }
    }
  },
  async mkdirp(path) {
    await fsp.mkdir(path, { recursive: true })
  },
  async remove(path) {
    await fsp.rm(path, { recursive: true, force: true })
  },
  async rename(from, to) {
    await fsp.rename(from, to)
  }
}

/** 下载只用到归档端口的两个只读方法（读 manifest、探 payload 是否存在）。 */
export type DownloadSourcePort = Pick<ArchiveFsPort, 'stat' | 'readTextFile'>

/** 下载只用到传输层的 `download`。 */
export type DownloadTransferPort = Pick<Transfer, 'download'>

export interface DownloadProgress {
  percent: number
  stage: string
  message: string
  bytes?: number
  totalBytes?: number
  files?: number
  totalFiles?: number
}

export type DownloadProgressFn = (p: DownloadProgress) => void
export type DownloadLogFn = (text: string, level?: JobLogLevel) => void

export interface ArchiveDownloadServiceDeps {
  repo: Repositories
  localFs?: LocalFsPort
  now?: () => Date
  /** 传输并发数（B15 / T15.1，取设置里的当前值；不传则由传输层用默认） */
  transferConcurrency?: () => number
}

export interface DownloadRunInput {
  archiveId: string
  saveDir: string
  /** 来自 `plan()` 的单层目录名 —— 保证"看到的路径"与"写入的路径"一致 */
  finalName: string
  source: DownloadSourcePort
  transfer: DownloadTransferPort
  signal?: AbortSignal
  log?: DownloadLogFn
  onProgress?: DownloadProgressFn
}

export function createArchiveDownloadService(deps: ArchiveDownloadServiceDeps) {
  const { repo } = deps
  const fs = deps.localFs ?? defaultLocalFs

  function mustGetArchive(archiveId: string): {
    id: string
    targetId: string
    versionTag: string
    storagePath: string
    payloadPath: string
    kind: string
    rootHash: string
    totalBytes: number
    fileCount: number
  } {
    const row = repo.archives.get(archiveId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { archiveId })
    return row
  }

  /** 标记台账状态：只在"确实有证据说这份归档坏了/没了"时调用。 */
  function markStatus(archiveId: string, status: 'missing' | 'corrupt'): void {
    try {
      repo.archives.setStatus(archiveId, status)
    } catch (err) {
      // 状态写不进去不该掩盖真正的失败原因
      logger.warn(`标记归档状态失败（${status}）：${(err as Error).message}`)
    }
  }

  /**
   * 计算下载计划（T12.3 第一步）。
   *
   * **不连服务器**，只读台账 + 一次本地冲突探测。这样用户在点"开始下载"之前
   * 就能看到"会写到哪儿"，而"同名目录已存在"这种事也在动手之前就有答案。
   */
  async function plan(input: { archiveId: string; saveDir: string }): Promise<ArchiveDownloadPlan> {
    const row = mustGetArchive(input.archiveId)
    const saveDir = input.saveDir

    const dirStat = await fs.stat(saveDir)
    if (dirStat.exists && !dirStat.isDirectory) {
      throw new AppError(
        ErrorCode.E_LOCAL_PATH_KIND,
        { path: saveDir, actual: 'file', expected: 'dir' },
        { message: '保存位置不是一个目录', hint: '请选择一个目录作为下载保存位置。' }
      )
    }

    const target = repo.targets.get(row.targetId)
    const preferred = buildArchiveDirName(target?.name ?? row.targetId, row.versionTag)

    // 冲突检测必须**真的去 stat**：目录名里带版本号，但同一份归档被重复下载是很常见的
    const picked = await pickFreeDirName(
      preferred,
      async (name) => (await fs.stat(joinInside(saveDir, name))).exists
    )
    if (!picked) {
      throw new AppError(
        ErrorCode.E_LOCAL_PATH_EXISTS,
        { saveDir, preferred },
        {
          message: `保存位置下已有 ${preferred}（以及 50 个同名候选目录）`,
          hint: '请换一个保存位置，或先清理旧目录。'
        }
      )
    }

    return {
      saveDir,
      finalName: picked.name,
      finalPath: joinInside(saveDir, picked.name),
      adjustedFrom: picked.adjustedFrom,
      stagingPath: joinInside(saveDir, stagingNameOf(row.id)),
      saveDirExists: dirStat.exists
    }
  }

  /**
   * 执行下载。
   *
   * 四个阶段（`DOWNLOAD_STAGES`）：读清单 → 下载 → 本地复核 → 就位。
   * 任何一步失败都不删暂存目录，并在错误里给出它的路径。
   */
  async function download(input: DownloadRunInput): Promise<ArchiveDownloadResult> {
    const started = Date.now()
    const log: DownloadLogFn = input.log ?? ((): void => undefined)
    const report: DownloadProgressFn = input.onProgress ?? ((): void => undefined)

    const row = mustGetArchive(input.archiveId)
    const finalPath = joinInside(input.saveDir, input.finalName)
    const stagingPath = joinInside(input.saveDir, stagingNameOf(row.id))

    /**
     * 失败收口：把"内容还在暂存目录里"这个事实写进错误详情。
     *
     * 不删暂存目录（T12.4）。用户看到的失败文案必须能回答
     * "我刚才等了这么一会儿，东西在哪" —— 否则他只能重新下一遍。
     */
    const fail = (
      code: ErrorCodeValue,
      detail: Record<string, unknown>,
      text: { message: string; hint?: string },
      keepStaging = true
    ): AppError => {
      logger.warn(`archive download 失败：${text.message}`)
      log(text.message, 'warn')
      if (keepStaging) log(`已下载的部分保留在：${stagingPath}`, 'warn')
      repo.audit.write({
        level: 'warn',
        scope: 'archive',
        refId: row.id,
        message: `下载往期版本 ${row.versionTag} 失败：${text.message}`,
        detail: JSON.stringify({ ...detail, stagingPath: keepStaging ? stagingPath : null })
      })
      return new AppError(
        code,
        { archiveId: row.id, versionTag: row.versionTag, stagingPath, ...detail },
        {
          message: text.message,
          ...(text.hint
            ? { hint: text.hint }
            : keepStaging
              ? { hint: `已下载的部分保留在 ${stagingPath}，可人工取用或删除。` }
              : {})
        }
      )
    }

    if ((await fs.stat(finalPath)).exists) {
      throw fail(
        ErrorCode.E_LOCAL_PATH_EXISTS,
        { finalPath },
        {
          message: `本地已存在同名目录：${finalPath}`,
          hint: '请重新选择保存位置（计划里的目录名可能已被占用）。'
        },
        false
      )
    }

    // 保存根目录可能是新建的；上一次中断留下的暂存目录整块清掉重来
    await fs.mkdirp(input.saveDir)
    await fs.remove(stagingPath)
    await fs.mkdirp(stagingPath)

    /* ------------------------------------------------- 阶段 1：读清单 */
    report({ percent: downloadStagePercent('manifest', 0, 1), stage: '读取版本清单', message: '正在读取远端 manifest.json' })
    const manifestPath = joinRemote(row.storagePath, MANIFEST_FILE_NAME)

    let text: string
    try {
      text = await input.source.readTextFile(manifestPath)
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.E_ARCHIVE_MISSING) {
        markStatus(row.id, 'missing')
        throw fail(
          ErrorCode.E_ARCHIVE_MISSING,
          { manifestPath },
          {
            message: `往期版本 ${row.versionTag} 的清单文件不存在，无法下载`,
            hint: '该归档可能已在服务器上被删除。可对这条版本执行「校验」以更新状态。'
          },
          false
        )
      }
      throw fail(
        ErrorCode.E_CONN_LOST,
        { manifestPath, original: (err as Error).message },
        { message: `读取版本清单失败：${(err as Error).message}`, hint: '请检查连接后重试。' },
        false
      )
    }

    let parsed: ParsedManifest
    try {
      parsed = parseManifestText(text)
    } catch (err) {
      markStatus(row.id, 'corrupt')
      throw fail(
        ErrorCode.E_ARCHIVE_CORRUPT,
        { original: (err as Error).message },
        {
          message: `往期版本 ${row.versionTag} 的清单无法解析，已拒绝下载`,
          hint: '归档内容可能已损坏。可执行「校验」确认，或从备份恢复归档目录。'
        },
        false
      )
    }

    const m = parsed.manifest
    for (const w of parsed.warnings) log(w, 'warn')

    /**
     * 与台账记录交叉核对。
     *
     * 台账里那一行是我们**当年**归档时写下的指纹；manifest 是归档目录的自述。
     * 两者不一致 = 这个目录被换过内容 —— 此时"下载一份来历不明的东西"
     * 不该被允许，哪怕它自己的 manifest 是自洽的。
     */
    if (m.versionTag !== row.versionTag || m.rootHash !== row.rootHash) {
      markStatus(row.id, 'corrupt')
      throw fail(
        ErrorCode.E_ARCHIVE_CORRUPT,
        {
          manifestVersionTag: m.versionTag,
          manifestRootHash: m.rootHash,
          ledgerVersionTag: row.versionTag,
          ledgerRootHash: row.rootHash
        },
        {
          message: `归档内容与台账记录不一致（清单 ${m.versionTag}/${m.rootHash.slice(0, 8)}，台账 ${row.versionTag}/${row.rootHash.slice(0, 8)}）`,
          hint: '归档目录可能被替换或改写过。请先执行「校验」，确认后再决定是否使用这份内容。'
        },
        false
      )
    }

    /**
     * relPath 安全校验：manifest 是远端内容，而它决定了本地往哪写。
     * 一个被构造过的 manifest 只要写上 `../../.ssh/authorized_keys`，
     * "下载"就成了"往任意位置写文件"。
     */
    const unsafe = unsafeRelPathsOf(m.files.map((f) => f.relPath))
    if (unsafe.length > 0) {
      markStatus(row.id, 'corrupt')
      throw fail(
        ErrorCode.E_ARCHIVE_CORRUPT,
        { unsafeRelPaths: unsafe },
        {
          message: '归档清单里含有会写到目标目录之外的路径，已拒绝下载',
          hint: `可疑路径：${unsafe.slice(0, 5).join('、')}。这份归档已标记为"已损坏"。`
        },
        false
      )
    }

    const payloadStat = await input.source.stat(row.payloadPath)
    if (!payloadStat.exists) {
      markStatus(row.id, 'missing')
      throw fail(
        ErrorCode.E_ARCHIVE_MISSING,
        { payloadPath: row.payloadPath },
        {
          message: `归档内容目录不存在：${row.payloadPath}`,
          hint: '该版本可能已在服务器上被手工删除。可执行「校验」以更新状态。'
        },
        false
      )
    }

    /* --------------------------------------------------- 阶段 2：下载 */
    const files = m.files.map((f) => ({
      remotePath: joinRemote(row.payloadPath, f.relPath),
      // relPath 已过安全校验且用 `/` 分隔，join 会按当前平台换成分隔符
      localPath: join(stagingPath, f.relPath),
      size: f.size,
      expectedHash: f.hash
    }))

    report({
      percent: downloadStagePercent('fetch', 0, 1),
      stage: '下载文件',
      message: `准备下载 ${files.length} 个文件`,
      files: 0,
      totalFiles: files.length
    })

    let summary
    try {
      summary = await input.transfer.download(files, {
        concurrency: deps.transferConcurrency?.() ?? DEFAULT_CONCURRENCY,
        ...(input.signal ? { signal: input.signal } : {}),
        onProgress: (p) => {
          report({
            percent: downloadStagePercent('fetch', p.transferred, p.total),
            stage: '下载文件',
            message: `${p.filesDone}/${p.filesTotal} 个文件 · ${p.currentFile}`,
            bytes: p.transferred,
            totalBytes: p.total,
            files: p.filesDone,
            totalFiles: p.filesTotal
          })
        }
      })
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.E_VERIFY_MISMATCH) {
        // 内容与清单不符 = 归档本身被改过（传输层是对**落盘后**的文件算的哈希）
        markStatus(row.id, 'corrupt')
        throw fail(ErrorCode.E_VERIFY_MISMATCH, { transfer: err.detail }, {
          message: '下载到的内容与其清单哈希不一致，已中止',
          hint: '归档内容可能已被改动（人为编辑、磁盘损坏或同步工具截断）。可执行「校验」确认。'
        })
      }
      if (err instanceof AppError && err.code === ErrorCode.E_JOB_CANCELLED) {
        /**
         * 取消时**不承诺"产物保留"**：任务层的 `cleanup('cancel')` 会把这个
         * 暂存目录删掉（用户明确说了"我不要了"）。这里要是写着"保留在…"，
         * 日志就会自相矛盾。
         */
        throw fail(ErrorCode.E_JOB_CANCELLED, {}, { message: '下载已取消' }, false)
      }
      if (err instanceof AppError) {
        throw fail(err.code, { transfer: err.detail }, { message: err.message, ...(err.hint ? { hint: err.hint } : {}) })
      }
      throw fail(
        ErrorCode.E_DOWNLOAD_INTERRUPTED,
        { original: (err as Error).message },
        { message: `下载中断：${(err as Error).message}` }
      )
    }

    /* ----------------------------------------------- 阶段 3：本地复核 */
    report({ percent: downloadStagePercent('verify', 0, 1), stage: '本地复核', message: '核对文件集合与大小' })

    let collected
    try {
      collected = await collectLocalFiles({ root: stagingPath, ...(input.signal ? { signal: input.signal } : {}) })
    } catch (err) {
      throw fail(
        ErrorCode.E_LOCAL_READ_DENIED,
        { original: (err as Error).message },
        { message: `复核本地文件失败：${(err as Error).message}` }
      )
    }

    const sizeByRel = new Map(collected.files.map((f) => [f.relPath, f.size]))
    const expectedRels = new Set(m.files.map((f) => f.relPath))
    const missing: string[] = []
    const sizeMismatch: string[] = []
    for (const f of m.files) {
      const size = sizeByRel.get(f.relPath)
      if (size === undefined) missing.push(f.relPath)
      else if (size !== f.size) sizeMismatch.push(f.relPath)
    }
    const extra = [...sizeByRel.keys()].filter((k) => !expectedRels.has(k))

    if (missing.length > 0 || sizeMismatch.length > 0 || extra.length > 0) {
      markStatus(row.id, 'corrupt')
      throw fail(
        ErrorCode.E_VERIFY_MISMATCH,
        {
          missing: missing.slice(0, 20),
          sizeMismatch: sizeMismatch.slice(0, 20),
          extra: extra.slice(0, 20),
          missingCount: missing.length,
          sizeMismatchCount: sizeMismatch.length,
          extraCount: extra.length
        },
        {
          message:
            `下载结果与清单对不上（缺失 ${missing.length} / 大小不符 ${sizeMismatch.length} / 多余 ${extra.length}）`,
          hint: '归档内容可能已被改动。可执行「校验」确认。'
        }
      )
    }

    /* --------------------------------------------------- 阶段 4：就位 */
    report({ percent: downloadStagePercent('finalize', 0, 1), stage: '整理目录', message: `正在整理到 ${input.finalName}` })
    try {
      await fs.rename(stagingPath, finalPath)
    } catch (err) {
      throw fail(ErrorCode.E_LOCAL_MOVE_FAILED, { finalPath, original: (err as Error).message }, {
        message: `把内容整理到 ${finalPath} 时失败：${(err as Error).message}`,
        hint: `内容完整保存在 ${stagingPath}，可手工改名后使用。`
      })
    }

    const result: ArchiveDownloadResult = {
      archiveId: row.id,
      versionTag: row.versionTag,
      finalPath,
      files: files.length,
      bytes: summary.bytes,
      verified: true,
      durationMs: Date.now() - started
    }

    logger.info(
      `archive download ok: ${row.versionTag} → ${finalPath}（${files.length} 文件 / ${summary.bytes} 字节，${result.durationMs}ms）`
    )
    log(`下载完成：${files.length} 个文件 / ${summary.bytes} 字节 → ${finalPath}`)
    repo.audit.write({
      level: 'info',
      scope: 'archive',
      refId: row.id,
      message: `下载往期版本 ${row.versionTag} 到 ${finalPath}`,
      detail: JSON.stringify({
        targetId: row.targetId,
        files: files.length,
        bytes: summary.bytes,
        retries: summary.retries,
        durationMs: result.durationMs
      })
    })
    return result
  }

  return { plan, download }
}

export type ArchiveDownloadService = ReturnType<typeof createArchiveDownloadService>

/** 供单测与接线共用的阶段进度映射（转调 infra，集中一处避免各写一份）。 */
export function downloadStagePercent(
  key: 'manifest' | 'fetch' | 'verify' | 'finalize',
  done: number,
  total: number
): number {
  return mapStagePercent(key, done, total)
}
