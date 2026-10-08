/**
 * ArchiveService（T09.4 ~ T09.8，方案书 §6.7 / §5.3 / §5.4 / §7.5）。
 *
 * 职责：把目标路径上的**当前版本**安全地搬进往期版本库，并写下自描述的
 * `manifest.json`；以及校验这些版本、按保留策略清理多余的版本。
 *
 * ## 一条不能违反的语义
 *
 * 归档的第一步动作就是 `rename(目标 → 归档目录)`，也就是**把目标路径清空**。
 * 之后由发布的 SWAPPING 步骤把新版本就位（B10）。因此本文件里每一步的失败处理
 * 都必须回答同一个问题：**"此刻目标路径是空的，如果现在失败，用户还剩什么？"**
 * 答不上来的路径就是 bug：
 *
 * - rename 失败 → 目标毫发无损，直接抛错（`E_ARCHIVE_FAILED`）
 * - rename 成功但写 manifest 失败 → **把内容 rename 回去**再抛错。
 *   不能只删掉半成品目录 —— 那等于"归档失败 + 目标也被清空"，是最坏的组合。
 * - 回滚本身也失败 → 不吞掉，明确告知"内容在 <storagePath>/payload 下"，
 *   否则用户会以为内容丢了。
 *
 * ## manifest 的相对根（与 B12/B13 的约定）
 *
 * 归档布局是 `<archive_dir>/<versionTag>/payload/<basename>`，
 * 而 `files[].relPath` 相对的是 **`payload`**（不是 `<basename>`）。
 * 理由与例子见 `shared/contracts/archive.ts` 文件头 —— 一句话：
 * 让 `payload_path` 成为校验/下载/回滚的**唯一根**。
 *
 * ## 顺序上的一个硬约束
 *
 * `versionTag` 里含 `rootHash` 前 7 位（§5.4），所以**必须先算出指纹、
 * 再决定目录名**。而方案书 §6.7 的步骤列表把 `mkdirp` 写在最前面，
 * 两处规格的交汇点就在这里：先 `mkdirp(archiveDir)`（幂等、无副作用），
 * 算指纹，再定目录名。这个顺序在下面用注释标了出来，改动时不要调换。
 *
 * 本文件**不 import electron**，副作用（SFTP）全部经 `ArchivePort` / `RemoteHashPort`
 * 注入，因此单测可以用内存实现把失败与回滚路径都真实跑一遍。
 */
import { posix } from 'node:path'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { resolveArchiveDir, posixBasename } from '../infra/archive-dir'
import { normalizeRemotePath } from '../infra/remote-path'
import { compareRelPathUtf8, computeRootHash, joinRemote, sortByRelPathUtf8, sumBytes } from '../infra/hash-core'
import {
  MANIFEST_CHUNK_BYTES,
  MANIFEST_FILE_NAME,
  MANIFEST_TMP_NAME,
  PAYLOAD_DIR_NAME,
  buildManifestHeader,
  checkManifestConsistency,
  manifestChunks,
  manifestToItems,
  parseManifestText,
  type ManifestHeader
} from '../infra/manifest-io'
import { resolveVersionTagDetailed, toLocalIso } from '../infra/version-tag'
import { planRetention } from '../infra/retention'
import { copyArtifactInto } from '../infra/copy-tree'
import { createRemoteFs, type RemoteStat, type SftpLike } from './remote-fs'
import {
  hashRemoteArtifact,
  verifyRemote,
  type HashProgressFn,
  type RemoteHashPort
} from './hash'
import { DEFAULT_ARCHIVE_LIST_LIMIT, type Repositories } from '../db/repositories'
import { describeRetainPolicy, parseRetainPolicy } from '../../shared/contracts/workspace'
import { KNOWN_MANIFEST_KEYS } from '../../shared/contracts/archive'
import type {
  ArchiveDetail,
  ArchiveManifestFile,
  ArchiveRemoveResult,
  ArchiveRollbackMark,
  ArchiveStatus,
  ArchiveSummary,
  ArchiveVerifyResult,
  ArchiveView,
  RetentionResult
} from '../../shared/contracts/archive'
import type { ReleaseItem } from '../../shared/contracts/hash'
import type { JobLogLevel } from '../../shared/contracts/job'

/** 保留策略执行时必须看到**全部**归档行（分页上限不能让它漏删）。 */
const RETENTION_SCAN_LIMIT = 100000

/**
 * 给归档行打"回滚"标记时扫多少条台账记录。
 *
 * 与列表自身的上限（`DEFAULT_ARCHIVE_LIST_LIMIT`）无关，两个方向都要放开：
 * 列表可能只显示最近 N 条归档，而**很久以前**那次回滚留下的痕迹（尤其是
 * 被标成 `ROLLED_BACK` 的来源行）必须仍然可见。200 条足以覆盖任何一个目标的
 * 完整历史（每次发布或回滚各占一条）。
 */
const ROLLBACK_SCAN_LIMIT = 200

export type ArchiveLogFn = (text: string, level?: JobLogLevel) => void

/* ------------------------------------------------------------- 远端端口 */

/** 归档用到的远端文件操作（全是 SFTP，不依赖 shell —— 方案书 §8.3）。 */
export interface ArchiveFsPort {
  stat(path: string): Promise<RemoteStat>
  mkdirp(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  removeFile(path: string): Promise<void>
  rmrf(path: string): Promise<void>
  readTextFile(path: string): Promise<string>
  /**
   * 把分块文本流式写成远端文件。
   *
   * 之所以要"分块 + 流"而不是 `writeTextFile(path, 整个字符串)`：
   * 目录型目标的 `files` 可能上千条，拼成一个大字符串意味着
   * "内存里同时存在 manifest 文本 + SFTP 缓冲"两份拷贝（方案书 §5.3 明确要求流式）。
   */
  writeTextChunks(path: string, chunks: Iterable<string>): Promise<void>
  listFiles(root: string): Promise<Array<{ relPath: string; size: number; mtime?: string }>>
  /**
   * 远端内部单文件复制（T10.8 的 `copy` 模式）。
   *
   * SFTP 协议**没有** copy 原语，所以实现是"读出流 → 写入流"。
   * 存在的理由见 `infra/copy-tree.ts` 文件头：目标本身是挂载点时，
   * 归档与换版的 `rename` 都会 `EXDEV`，只能靠复制。
   */
  copyFile(srcAbsPath: string, dstAbsPath: string): Promise<void>
}

/** 归档需要的全部远端能力：文件操作 + 哈希（两个端口都注入，便于单测替换）。 */
export interface ArchivePorts {
  fs: ArchiveFsPort
  hash: RemoteHashPort
}

/** SFTP 写流：ssh2 的实现带 `destroy()`，但 Node 的类型声明里没有，故显式补上。 */
export interface ArchiveWriteStream extends NodeJS.WritableStream {
  destroy?: () => void
}

/** 读流：同样带 `destroy()`（copy 模式出错时用来掐断对端）。 */
export interface ArchiveReadStream extends NodeJS.ReadableStream {
  destroy?: () => void
}

/** 只声明本文件用到的 SFTP 方法，便于接线与单测替身。 */
export interface ArchiveSftpLike extends SftpLike {
  createWriteStream(path: string, options?: { highWaterMark?: number }): ArchiveWriteStream
  createReadStream(path: string, options?: { highWaterMark?: number }): ArchiveReadStream
  readFile(path: string, cb: (err: Error | null | undefined, data: Buffer) => void): void
}

/**
 * 把 ssh2 的 SFTPWrapper 包成 `ArchiveFsPort`。
 *
 * 复用 `createRemoteFs`（B05）而不是重写一遍：那里的 `mkdirp` / `rmrf`
 * 已经带了"层级过浅拒绝删除""高危路径名单"这些防护，重写一份必然走样。
 */
export function createSftpArchivePort(sftp: ArchiveSftpLike): ArchiveFsPort {
  const remoteFs = createRemoteFs(sftp)

  return {
    stat: (path) => remoteFs.stat(path),
    mkdirp: (path) => remoteFs.mkdirp(path),
    rename: (from, to) => remoteFs.rename(from, to),
    removeFile: (path) => remoteFs.unlinkFile(path),
    rmrf: (path) => remoteFs.rmrf(path),
    listFiles: (root) => remoteFs.listAllFiles(root).then((list) =>
      list.map((e) => ({ relPath: e.relPath, size: e.size, mtime: e.mtime }))
    ),
    readTextFile(path) {
      const p = normalizeRemotePath(path)
      return new Promise<string>((resolve, reject) => {
        sftp.readFile(p, (err, data) => {
          if (err) {
            const e = err as { code?: number; message?: string }
            if (e.code === 2 || /no such file/i.test(e.message ?? '')) {
              reject(new AppError(ErrorCode.E_ARCHIVE_MISSING, { path: p }))
              return
            }
            reject(new AppError(ErrorCode.E_CONN_LOST, { path: p, original: e.message }))
            return
          }
          resolve(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
        })
      })
    },
    writeTextChunks(path, chunks) {
      const p = normalizeRemotePath(path)
      return new Promise<void>((resolve, reject) => {
        let settled = false
        /** 是否已把**全部**分块喂给写流（用于判断"提前关闭"是否异常） */
        let fedAll = false
        const ws = sftp.createWriteStream(p, { highWaterMark: MANIFEST_CHUNK_BYTES })

        const done = (err?: Error): void => {
          if (settled) return
          settled = true
          if (err) {
            try {
              ws.destroy?.()
            } catch {
              /* 可能已经关掉了 */
            }
            reject(new AppError(ErrorCode.E_ARCHIVE_FAILED, { path: p, original: err.message }))
          } else {
            resolve()
          }
        }

        ws.on('error', (err: Error) => done(err))
        ws.on('finish', () => done())
        // ssh2 的写流在正常结束时 **'close' 也可能先到**（`_final` 先 destroy 再回调，
        // 见 B07 传输层踩过的坑）。所以判据用**状态**（分块是否喂完），不用事件时序。
        ws.on('close', () => {
          if (fedAll) done()
          else done(new Error('写流在数据喂完之前被关闭'))
        })

        const it = chunks[Symbol.iterator]()
        const pump = (): void => {
          for (;;) {
            if (settled) return
            const next = it.next()
            if (next.done) {
              fedAll = true
              ws.end()
              return
            }
            if (!ws.write(next.value)) {
              // 背压：等 drain 再继续，避免把整个 manifest 灌进内存
              ws.once('drain', pump)
              return
            }
          }
        }
        pump()
      })
    },

    /**
     * 远端 → 远端单文件复制。
     *
     * 结束判据同 `writeTextChunks`：用**状态**（源是否读完）而不是事件时序 ——
     * ssh2 的写流在正常结束时 `close` 可能先于 `finish` 到达（B07 的教训，
     * `HANDOFF §9` 第 8 条）。
     */
    copyFile(srcAbsPath, dstAbsPath) {
      const from = normalizeRemotePath(srcAbsPath)
      const to = normalizeRemotePath(dstAbsPath)
      return new Promise<void>((resolve, reject) => {
        let settled = false
        let srcEnded = false
        const rs = sftp.createReadStream(from)
        const ws = sftp.createWriteStream(to)

        const done = (err?: Error): void => {
          if (settled) return
          settled = true
          if (err) {
            try {
              rs.destroy?.()
            } catch {
              /* 已关掉 */
            }
            try {
              ws.destroy?.()
            } catch {
              /* 已关掉 */
            }
            reject(new AppError(ErrorCode.E_ARCHIVE_FAILED, { from, to, original: err.message }))
          } else {
            resolve()
          }
        }

        rs.on('end', () => {
          srcEnded = true
        })
        rs.on('error', (err: Error) => done(err))
        ws.on('error', (err: Error) => done(err))
        ws.on('finish', () => done())
        ws.on('close', () => {
          if (srcEnded) done()
          else done(new Error(`复制 ${from} → ${to} 时写流在源读完之前被关闭`))
        })
        rs.pipe(ws)
      })
    }
  }
}

/* ---------------------------------------------------------------- 服务 */

export interface ArchiveServiceDeps {
  repo: Repositories
  /** 便于测试注入固定时间（版本号里含时间） */
  now?: () => Date
  /**
   * 算法兼容模式（B15 / T15.1）。
   *
   * 归档校验（校验 / 对账深度校验 / 回滚阶段 1）都要读远端指纹，
   * 关闭时遇到没有 hash 工具的服务器会直接报错 —— 而不是静默换成流式计算。
   * 与发布侧同一个开关，取的是同一份设置。
   */
  hashCompat?: () => boolean
}

export interface ArchiveVersionInput {
  targetId: string
  ports: ArchivePorts
  /**
   * 已知的产物清单（相对**目标自身的内容根**，即 `hashLocalArtifact().items` 的形状）。
   *
   * B10 的上一版是自己发布的场景直接传上一版记录里的明细，省掉一次全量远端哈希 ——
   * 这很重要：远端读受服务器出带宽限制（实测某机器 ~0.46 MB/s），
   * 几百 MB 的产物重算一次要几十分钟。
   *
   * 不传则对目标路径上的**现网内容**现场计算（首次接管既有版本时只能这么做）。
   */
  items?: readonly ReleaseItem[]
  operator?: string | null
  note?: string | null
  /** 产生这个版本的发布记录 id；首次接管填 null */
  releaseId?: string | null
  /**
   * 期望的基础版本号（B10 用）。
   *
   * 发布流程在阶段 1 就算出了新内容的指纹并给了它一个版本号；这份内容在
   * **下一次**发布时被归档。若不传 `preferredTag`，归档会按"归档时刻 + 指纹"
   * 重新生成，于是同一份内容在"发布记录"与"往期版本"里是两个号 ——
   * 用户在两个页面之间对不上。
   *
   * 仍然要过冲突检查（有可能同名的目录被手工建过），冲突时照旧追加序号。
   */
  preferredTag?: string | null
  /**
   * 搬迁方式（T10.8）。
   *
   * - `rename`（默认）：同文件系统内原子完成。
   * - `copy`：目标本身是挂载点 / 跨设备时用。**代价很大**：要把目标的内容
   *   完整读一遍再写一遍（受远端出带宽限制），所以只在必要时用。
   *   传 `copy` 的前提是已确认 `rename` 不可用（见 `infra/deploy-plan.ts` 的
   *   `decideSwapStrategy`）—— 这里不做二次判断，因为"探明"这件事需要
   *   `df` 与真实报错，不是归档层能知道的。
   */
  moveMode?: 'rename' | 'copy'
  signal?: AbortSignal
  log?: ArchiveLogFn
  onProgress?: HashProgressFn
}

export interface ArchiveVersionResult {
  archive: ArchiveView
  /** 版本号冲突次数（0 = 一次命中，> 0 说明同一秒内归档了多次） */
  tagConflicts: number
  /** 是否现场计算了远端指纹（用于在 UI/日志里解释"为什么慢"） */
  hashedRemotely: boolean
}

export interface VerifyArchiveInput {
  archiveId: string
  ports: ArchivePorts
  signal?: AbortSignal
  onProgress?: HashProgressFn
  log?: ArchiveLogFn
}

export interface ApplyRetentionInput {
  targetId: string
  fs: ArchiveFsPort
  log?: ArchiveLogFn
}

/** 手工删除指定版本（T12.5）。 */
export interface RemoveVersionsInput {
  /** 用户勾选的归档 id；顺序无意义，会去重 */
  archiveIds: readonly string[]
  fs: ArchiveFsPort
  log?: ArchiveLogFn
}

/** 读版本明细（T12.7）。 */
export interface ReadDetailInput {
  archiveId: string
  offset?: number
  limit?: number
  ports: ArchivePorts
}

/**
 * 把一次归档**撤销**：内容搬回目标路径，归档目录与台账行一并清掉。
 *
 * 这是发布流程（B10 阶段 5）失败时的补偿动作 —— 那时归档已经成功、目标路径是空的，
 * 若不复位，用户就只剩"归档目录里那一份"，目标永久为空。
 *
 * 放在这里而不是 B10 里，是因为"搬回去"与"搬过来"必须**用同一种方式**
 * （去程是 copy 回程也只能 copy，见 `rollbackMove` 的注释）；
 * 分两处实现迟早会出现"搬过去能成、搬回来不成"的不对称 bug。
 */
export interface UndoArchiveInput {
  archiveId: string
  ports: ArchivePorts
  /** 必须与去程一致：去程 rename 就 rename 回来，去程 copy 就只能 copy 回来 */
  moveMode?: 'rename' | 'copy'
  log?: ArchiveLogFn
}

function toArchiveStatus(raw: string): ArchiveStatus {
  return raw === 'missing' || raw === 'corrupt' ? raw : 'valid'
}

/** 截断过长的文件名列表，避免错误详情把日志刷爆。 */
function previewList(names: readonly string[], max = 5): string {
  const head = names.slice(0, max).map((n) => JSON.stringify(n)).join('、')
  return names.length > max ? `${head} 等 ${names.length} 个` : head
}

/* ------------------------------------------------- 回滚标记（纯派生） */

/** `buildRollbackMarks` 的归档行输入：只取判定需要的字段，便于单测直接构造。 */
export interface RollbackMarkArchiveRow {
  id: string
  versionTag: string
  releaseId: string | null
}

export interface RollbackMarkReleaseRow {
  id: string
  action: string
  versionTag: string
  status: string
  archiveId: string | null
  startedAt: string
  finishedAt: string | null
}

export interface RollbackMarkResult {
  rollback: ArchiveRollbackMark | null
  supersededByRollbackAt: string | null
}

/**
 * 把 `releases` 里的回滚痕迹归到具体的归档行上。
 *
 * 三条判据都不需要新字段：
 *
 * | 归档行的身份 | 判据 |
 * | --- | --- |
 * | 某次回滚的**来源**（被回滚到的版本） | `action='rollback' && status='SUCCESS' && archiveId === 行.id` |
 * | 某次回滚**归档出来**的产物 | `releaseId === 行.id`（那行 `action='rollback'`） |
 * | 内容已被后来的回滚取代 | `status='ROLLED_BACK' && versionTag === 行.versionTag` |
 *
 * 两处刻意的取舍：
 *
 * 1. **来源只认成功的回滚**：失败的回滚会被补偿把内容搬回去，那一刻"线上版本"
 *    并没有换成它 —— 让它顶着"当前线上版本"的标记是谎话。
 * 2. **`archived` 不筛状态**：归档行只要还在台账里，就说明那次回滚确实归档过它
 *    （失败且补偿成功的归档行会被摘掉，自然不会出现在输入里）。
 *
 * ## 发布成功之后，回滚标记整体退场（2026-10 用户要求）
 *
 * 三个标记回答的都是"这一版与**最近那次回滚**的关系"。一旦之后又发布过新版本，
 * "线上版本"就与任何一次回滚无关了 —— 尤其是 source 那条，tooltip 写的是
 * "这一版就是当前的线上版本"，新版本上去之后这就是谎话（旧版回滚之间互相取代
 * 时没有这个问题：取代它的仍是一次回滚，来源标记会因 status 变成 `ROLLED_BACK`
 * 自然消失；**发布不会给上一条台账打 `ROLLED_BACK`**，所以必须在这里显式判）。
 *
 * 判据：**最近一次成功的操作是发布** → 全部标记置空。两个边界：
 * - 只看 `status === 'SUCCESS'` 的行 —— 失败的发布/回滚不改变"线上是什么"；
 * - 台账里**还没有任何**成功操作时不抑制（比如只有一次失败的回滚：它留下的
 *   归档行仍要如实标成 `archived`，见 B19 的用例）。
 */
export function buildRollbackMarks(input: {
  archives: readonly RollbackMarkArchiveRow[]
  releases: readonly RollbackMarkReleaseRow[]
}): Map<string, RollbackMarkResult> {
  /** 归档行 id → 它作为某次回滚来源的标记 */
  const asSource = new Map<string, ArchiveRollbackMark>()
  /** 台账行 id → 它那次回滚归档出来的产物标记 */
  const asArchived = new Map<string, ArchiveRollbackMark>()
  /** 版本号 → 被回滚取代的时间（`finishedAt` 读不到就给 null） */
  const supersededAt = new Map<string, string | null>()

  for (const r of input.releases) {
    if (r.status === 'ROLLED_BACK' && !supersededAt.has(r.versionTag)) {
      supersededAt.set(r.versionTag, r.finishedAt)
    }
    if (r.action !== 'rollback') continue
    const at = r.finishedAt ?? r.startedAt
    if (r.status === 'SUCCESS' && r.archiveId) {
      asSource.set(r.archiveId, { role: 'source', toVersionTag: r.versionTag, at })
    }
    asArchived.set(r.id, { role: 'archived', toVersionTag: r.versionTag, at })
  }

  const out = new Map<string, RollbackMarkResult>()
  // `releases` 必须按时间倒序（`listByTarget` 的顺序）—— 与下面 supersededAt 的
  // "先到先得"是同一个前提
  const closedByDeploy = input.releases.find((r) => r.status === 'SUCCESS')?.action === 'deploy'
  for (const a of input.archives) {
    if (closedByDeploy) {
      out.set(a.id, { rollback: null, supersededByRollbackAt: null })
      continue
    }
    // 来源优先于"回滚归档"：同一行不可能两者都是，但来源那条更贴近"它在哪"这个问题
    const fromSource = asSource.get(a.id)
    const fromArchived = a.releaseId ? asArchived.get(a.releaseId) : undefined
    out.set(a.id, {
      rollback: fromSource ?? fromArchived ?? null,
      supersededByRollbackAt: supersededAt.get(a.versionTag) ?? null
    })
  }
  return out
}

export function createArchiveService(deps: ArchiveServiceDeps) {
  const { repo } = deps
  const now = deps.now ?? ((): Date => new Date())

  function toView(row: {
    id: string
    targetId: string
    versionTag: string
    storagePath: string
    payloadPath: string
    kind: string
    rootHash: string
    totalBytes: number
    fileCount: number
    archivedAt: string
    releaseId: string | null
    note: string | null
    status: string
  }): ArchiveView {
    return {
      id: row.id,
      targetId: row.targetId,
      versionTag: row.versionTag,
      storagePath: row.storagePath,
      payloadPath: row.payloadPath,
      kind: row.kind === 'file' ? 'file' : 'dir',
      rootHash: row.rootHash,
      totalBytes: row.totalBytes,
      fileCount: row.fileCount,
      archivedAt: row.archivedAt,
      releaseId: row.releaseId ?? null,
      note: row.note ?? null,
      status: toArchiveStatus(row.status),
      shortHash: row.rootHash.slice(0, 8),
      // 回滚标记要一次看全某个目标的 `releases` 才能算，所以由 `list()` 拿到整批
      // 归档行之后统一补上。单独调用 `toView` 的地方（如刚归档完的返回值）给空值。
      rollback: null,
      supersededByRollbackAt: null
    }
  }

  /* ------------------------------------------------------------ 列举 */

  function list(targetId: string, limit = DEFAULT_ARCHIVE_LIST_LIMIT): ArchiveView[] {
    const rows = repo.archives.listByTarget(targetId, limit)
    /**
     * 回滚标记是**派生**的：现读一次 `releases`，不缓存、不落库。
     *
     * 成本只有一次本地 SQL（命中 `idx_releases_target_time`），换来的是"列表里
     * 一眼能看出回滚到过哪一版、哪一版被回滚取代了" —— 而这正是回滚之后用户
     * 最想确认的事。把它做成第二个 IPC 会让 UI 多一次往返与一处可能不同步的
     * 加载态，不值得。
     */
    const marks = buildRollbackMarks({
      archives: rows.map((r) => ({ id: r.id, versionTag: r.versionTag, releaseId: r.releaseId })),
      releases: repo.releases.listByTarget(targetId, ROLLBACK_SCAN_LIMIT)
    })
    return rows.map((row) => {
      const mark = marks.get(row.id)
      return {
        ...toView(row),
        rollback: mark?.rollback ?? null,
        supersededByRollbackAt: mark?.supersededByRollbackAt ?? null
      }
    })
  }

  function count(targetId: string): number {
    return repo.archives.countByTarget(targetId)
  }

  /**
   * 台账口径的占用汇总（T12.6）。
   *
   * 纯读台账、**不连服务器**：用户最需要"共占用多少"的时刻，往往正是
   * "连不上、想清理"的时候。远端真实占用由 B15 的"服务器占用视图"给出。
   */
  function summary(targetId: string): ArchiveSummary {
    const agg = repo.archives.summaryByTarget(targetId)
    const byStatus: Record<ArchiveStatus, number> = { valid: 0, missing: 0, corrupt: 0 }
    for (const r of agg.byStatus) {
      // 只统计三个已知状态：多出来的取值说明数据被改坏了，
      // 把它算进 valid 会让"看起来都好"这个结论变成谎话
      if (r.status === 'valid' || r.status === 'missing' || r.status === 'corrupt') {
        byStatus[r.status] = r.count
      } else {
        logger.warn(`archives.status 出现未知取值：${r.status}（${r.count} 条，未计入汇总）`)
      }
    }
    return {
      count: agg.count,
      totalBytes: agg.bytes,
      byStatus,
      oldestAt: agg.oldest,
      newestAt: agg.newest
    }
  }

  /* ------------------------------------------------------------ 归档 */

  async function archiveVersion(input: ArchiveVersionInput): Promise<ArchiveVersionResult> {
    const log: ArchiveLogFn = input.log ?? ((): void => undefined)
    const target = repo.targets.get(input.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: input.targetId })

    const kind: 'dir' | 'file' = target.kind === 'file' ? 'file' : 'dir'
    const remotePath = normalizeRemotePath(target.remotePath)
    const archiveDir = resolveArchiveDir({
      remotePath,
      archiveDir: target.archiveDir,
      kind
    })
    const base = posixBasename(remotePath)

    /* ---- 1) 先算清单与指纹（versionTag 里含 rootHash，见文件头说明） ---- */
    let sourceItems = input.items
    let hashedRemotely = false
    if (!sourceItems) {
      log(`正在计算目标当前内容的指纹（${kind === 'dir' ? '目录' : '文件'} ${remotePath}）…`)
      const computed = await hashRemoteArtifact({
        port: input.ports.hash,
        remotePath,
        kind,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {})
      })
      if (computed.unsafeRelPaths.length > 0) {
        // 不静默跳过：跳过等于归档一份"清单表达不全"的版本，往期版本库从此对不上号
        throw new AppError(
          ErrorCode.E_ARCHIVE_FAILED,
          { unsafeRelPaths: computed.unsafeRelPaths.slice(0, 20) },
          {
            message: '目标中存在文件名含换行或空字符的文件，无法归档',
            hint: `请先重命名这些文件：${previewList(computed.unsafeRelPaths)}。` +
              '这类文件名无法进入行式校验清单，强行归档会造成往期版本无法校验。'
          }
        )
      }
      sourceItems = computed.items
      hashedRemotely = true
    }

    // 目录型目标整体被 rename 到 `payload/<basename>`，所以相对 `payload` 要补一层前缀；
    // 文件型目标的 relPath 就是文件名本身（与方案书 §5.3 的示例一致）。
    const files: ArchiveManifestFile[] = sortByRelPathUtf8(
      sourceItems.map((it) => ({
        relPath: kind === 'dir' ? `${base}/${it.relPath}` : it.relPath,
        hash: it.hash,
        size: it.size,
        mtime: it.mtime ?? null
      }))
    )
    const rootHash = computeRootHash(files)
    const totalBytes = sumBytes(files)

    /* ---- 2) 归档目录（幂等，无副作用，所以可以排在算指纹之后） ---- */
    await input.ports.fs.mkdirp(archiveDir)

    /* ---- 3) 定版本号（同名目录已存在则追加序号；5 次仍冲突则报错） ---- */
    const resolved = await resolveVersionTagDetailed({
      rootHash,
      now: now(),
      ...(input.preferredTag ? { baseTag: input.preferredTag } : {}),
      exists: async (tag) => (await input.ports.fs.stat(joinRemote(archiveDir, tag))).exists
    })
    const { versionTag } = resolved
    if (resolved.attempts > 1) {
      logger.warn(`version tag 冲突 ${resolved.attempts - 1} 次，最终使用 ${versionTag}`)
      log(`版本号发生 ${resolved.attempts - 1} 次冲突，已使用 ${versionTag}`, 'warn')
    }

    const storagePath = joinRemote(archiveDir, versionTag)
    const payloadPath = joinRemote(storagePath, PAYLOAD_DIR_NAME)
    const artifactAt = joinRemote(payloadPath, base)

    /* ---- 4) payload 目录 + 搬迁（这一步会**清空目标路径**） ----
     *
     * 两种搬迁方式：
     * - `rename`（默认）：同文件系统内原子完成，毫秒级。
     * - `copy`：目标本身是挂载点时，源与归档目录必然不在同一文件系统上，
     *   `rename` 报 `EXDEV`；此时只能逐个文件复制。
     *   注意 `copyArtifactInto` 会**先确认副本完整**才返回，
     *   所以我们随后才敢删除目标 —— 见 `infra/copy-tree.ts` 文件头。 */
    const moveMode: 'rename' | 'copy' = input.moveMode === 'copy' ? 'copy' : 'rename'
    await input.ports.fs.mkdirp(payloadPath)
    try {
      if (moveMode === 'copy') {
        log('目标不支持原子 rename（挂载点或跨设备），改用复制方式归档，耗时更长…', 'warn')
        await copyArtifactInto({
          fs: input.ports.fs,
          src: remotePath,
          dst: artifactAt,
          kind,
          ...(input.signal ? { signal: input.signal } : {})
        })
      } else {
        await input.ports.fs.rename(remotePath, artifactAt)
      }
    } catch (err) {
      // 目标原封不动（复制模式下半成品都在归档目录里），直接失败即可
      throw new AppError(
        ErrorCode.E_ARCHIVE_FAILED,
        { remotePath, storagePath, moveMode, original: (err as Error).message },
        {
          message:
            moveMode === 'copy'
              ? '归档当前版本失败（复制未完成，目标未被改动）'
              : '归档当前版本失败（目标未被改动）'
        }
      )
    }

    /**
     * 复制模式下"清空目标"是**独立的一步、独立的失败语义**。
     *
     * 走到这里归档副本已经完整落在归档目录里（`copyArtifactInto` 逐条核对过），
     * 与上一步"复制没做完"是两回事：若仍报"复制未完成"，用户会去重发一遍，
     * 而真正该做的是先对账清掉那份无清单的残留副本。目标本身没被改动。
     */
    if (moveMode === 'copy') {
      try {
        await input.ports.fs.rmrf(remotePath)
      } catch (err) {
        throw new AppError(
          ErrorCode.E_ARCHIVE_FAILED,
          { remotePath, storagePath, moveMode, stage: 'clear-target', original: (err as Error).message },
          {
            message:
              '归档副本已完成，但清空目标失败（目标未被改动）。' +
              '归档目录里残留一份无清单副本，请勿重复发布，先到「往期版本 → 对账」处理。'
          }
        )
      }
    }

    /* ---- 5) 写 manifest（先 .tmp 再 rename，绝不产生半截文件） ----
     *
     * 走到这里目标路径已经是空的（内容在 artifactAt）。所以这个 try 里的任何失败
     * 都必须回滚，否则"归档失败"会连带把现网版本弄没。 */
    const manifestHeader = buildManifestHeader({
      targetName: target.name,
      originalPath: remotePath,
      kind,
      versionTag,
      archivedAt: toLocalIso(now()),
      rootHash,
      totalBytes,
      fileCount: files.length,
      operator: input.operator ?? null,
      note: input.note ?? null,
      sourceReleaseId: input.releaseId ?? null
    })

    try {
      await writeManifestAtomically(input.ports.fs, storagePath, manifestHeader, files)
    } catch (err) {
      // 目标此刻是空的 —— 必须把内容搬回去，否则"归档失败"会连带把现网版本弄丢
      await rollbackMove(input.ports.fs, {
        artifactAt,
        remotePath,
        storagePath,
        kind,
        moveMode,
        log
      })
      throw err instanceof AppError
        ? err
        : new AppError(ErrorCode.E_ARCHIVE_FAILED, {
            storagePath,
            original: (err as Error).message
          })
    }

    /* ---- 6) 入库 ---- */
    const row = repo.archives.create({
      targetId: target.id,
      versionTag,
      storagePath,
      payloadPath,
      kind,
      rootHash,
      totalBytes,
      fileCount: files.length,
      releaseId: input.releaseId ?? null,
      note: input.note ?? null,
      status: 'valid'
    })

    repo.audit.write({
      level: 'info',
      scope: 'archive',
      refId: row.id,
      message:
        `归档版本 ${versionTag}（${files.length} 个文件 / ${totalBytes} 字节）` +
        `${hashedRemotely ? '；指纹由远端现网内容现场计算' : ''}`,
      detail: JSON.stringify({ targetId: target.id, storagePath, rootHash })
    })
    logger.info(`archived ${remotePath} -> ${storagePath} (${files.length} files, root=${rootHash.slice(0, 12)})`)
    log(`已归档为 ${versionTag}（${files.length} 个文件 / ${totalBytes} 字节）`)

    return { archive: toView(row), tagConflicts: resolved.attempts - 1, hashedRemotely }
  }

  /**
   * 原子写 manifest：先写 `manifest.json.tmp`，再 rename 成 `manifest.json`。
   *
   * "半截 manifest"比"没有 manifest"危险得多 —— 它看起来是完整的 JSON 文档
   * （或至少能被部分解析），对着它做校验/下载会得出错误结论。
   * 先写临时名 + rename 之后，`manifest.json` 要么不存在、要么是完整的一份。
   */
  async function writeManifestAtomically(
    fs: ArchiveFsPort,
    storagePath: string,
    header: ManifestHeader,
    files: readonly ArchiveManifestFile[]
  ): Promise<void> {
    const tmpPath = joinRemote(storagePath, MANIFEST_TMP_NAME)
    const finalPath = joinRemote(storagePath, MANIFEST_FILE_NAME)
    try {
      await fs.writeTextChunks(tmpPath, manifestChunks(header, files))
      await fs.rename(tmpPath, finalPath)
    } catch (err) {
      // 尽力清掉半成品；清不掉也不影响正确性（它不叫 manifest.json）
      try {
        await fs.removeFile(tmpPath)
      } catch {
        /* 忽略：临时文件残留不影响读取方 */
      }
      throw err
    }
  }

  /**
   * 写 manifest 失败后的回滚：把内容放回目标路径。
   *
   * 顺序很重要：**先搬回去、成功了再删掉半成品的归档目录**。
   * 反过来的话，如果搬回去失败，内容就真的没了。
   *
   * 两种搬迁方式对应两种回滚方式 —— 必须与去程一致：
   * 去程是 `rename` 就用 `rename` 回来；去程是 `copy` 就只能再复制一遍
   * （此时源与目标跨设备，`rename` 一定失败）。
   */
  async function rollbackMove(
    fs: ArchiveFsPort,
    opts: {
      artifactAt: string
      remotePath: string
      storagePath: string
      kind: 'dir' | 'file'
      moveMode: 'rename' | 'copy'
      log: ArchiveLogFn
    }
  ): Promise<void> {
    const { artifactAt, remotePath, storagePath, kind, moveMode, log } = opts
    log('写 manifest 失败，正在把内容放回目标路径…', 'warn')
    try {
      if (moveMode === 'copy') {
        // 去程把目标清空了，所以先把目标清干净再放回去，避免留下新版本的碎片
        if ((await fs.stat(remotePath)).exists) await fs.rmrf(remotePath)
        await copyArtifactInto({ fs, src: artifactAt, dst: remotePath, kind })
      } else {
        await fs.rename(artifactAt, remotePath)
      }
    } catch (err) {
      const message =
        `写 manifest 失败后回滚也失败：目标路径 ${remotePath} 目前为空，` +
        `内容仍在 ${storagePath}/payload 下。请手工移动回去或使用对账功能恢复。`
      logger.error(`${message}（原因：${(err as Error).message}）`)
      log(message, 'error')
      throw new AppError(
        ErrorCode.E_ARCHIVE_FAILED,
        { target: remotePath, storagePath, moveMode, original: (err as Error).message },
        { message, hint: '内容没有丢，但需要人工介入。请把上述路径告知运维。' }
      )
    }
    try {
      await fs.rmrf(storagePath)
    } catch (err) {
      logger.warn(`回滚后清理空归档目录失败（不影响正确性）：${(err as Error).message}`)
    }
    log('已回滚到归档前状态', 'warn')
  }

  /* ------------------------------------------------------------ 校验 */

  /**
   * 重算远端哈希并比对 manifest（T09.7）。
   *
   * 复用 B07 的 `verifyRemote()`：manifest 的明细能直接转成 `ReleaseItem[]`，
   * 两边的 relPath 语义一致。少一套比对实现，就少一处"两个实现不一致"的可能。
   */
  async function verifyArchive(input: VerifyArchiveInput): Promise<ArchiveVerifyResult> {
    const log: ArchiveLogFn = input.log ?? ((): void => undefined)
    const row = repo.archives.get(input.archiveId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { archiveId: input.archiveId })

    const started = Date.now()
    const manifestPath = joinRemote(row.storagePath, MANIFEST_FILE_NAME)

    const fail = (
      status: ArchiveStatus,
      message: string,
      extra: Partial<ArchiveVerifyResult> = {}
    ): ArchiveVerifyResult => {
      repo.archives.setStatus(row.id, status)
      logger.warn(`archive verify ${row.versionTag}: ${status} — ${message}`)
      log(`${row.versionTag} 校验结论：${message}`, status === 'valid' ? 'info' : 'warn')
      return {
        archiveId: row.id,
        versionTag: row.versionTag,
        status,
        ok: false,
        mode: 'missing',
        diff: { missing: [], extra: [], mismatch: [], matchedCount: 0 },
        message,
        durationMs: Date.now() - started,
        ...extra
      }
    }

    // manifest 读不到 ⇒ 这份归档已经不可信（没有自描述信息就无法判断内容）
    let text: string
    try {
      text = await input.ports.fs.readTextFile(manifestPath)
    } catch (err) {
      const reason = err instanceof AppError && err.code === ErrorCode.E_ARCHIVE_MISSING
        ? '归档目录里没有 manifest.json'
        : `读取 manifest.json 失败：${(err as Error).message}`
      return fail('missing', reason)
    }

    let parsed
    try {
      parsed = parseManifestText(text)
    } catch (err) {
      const detail = err instanceof AppError ? JSON.stringify(err.detail) : (err as Error).message
      return fail('corrupt', `manifest.json 无法解析（${detail}）`)
    }

    const integrityIssues = checkManifestConsistency(parsed.manifest)
    if (integrityIssues.length > 0) {
      return fail('corrupt', `manifest.json 自相矛盾：${integrityIssues.join('；')}`)
    }
    if (parsed.warnings.length > 0) {
      log(`manifest 提示：${parsed.warnings.join('；')}`, 'warn')
    }

    const payloadStat = await input.ports.fs.stat(row.payloadPath)
    if (!payloadStat.exists) {
      return fail('missing', `归档内容目录不存在：${row.payloadPath}`)
    }

    // 远端校验要往 $HOME/.sfvm-tmp 写临时清单，先保证目录在
    await input.ports.fs.mkdirp(input.ports.hash.tmpDir)

    const result = await verifyRemote({
      port: input.ports.hash,
      payloadDir: row.payloadPath,
      expected: manifestToItems(parsed.manifest),
      // 用版本号做临时文件名：同一目标并发校验时不会互相覆盖
      releaseId: row.versionTag,
      allowStreamFallback: deps.hashCompat?.() ?? true,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {})
    })

    const status: ArchiveStatus = result.diff.ok ? 'valid' : 'corrupt'
    repo.archives.setStatus(row.id, status)

    const message = result.diff.ok
      ? `内容与 manifest 一致（${result.diff.matchedCount} 个文件，校验方式：${result.mode}）`
      : `内容与 manifest 不一致：缺失 ${result.diff.missing.length} 个、` +
        `多余 ${result.diff.extra.length} 个、哈希不符 ${result.diff.mismatch.length} 个`
    logger.info(`archive verify ${row.versionTag}: ${status} — ${message}`)
    log(`${row.versionTag} 校验结论：${message}`, result.diff.ok ? 'info' : 'warn')

    return {
      archiveId: row.id,
      versionTag: row.versionTag,
      status,
      ok: result.diff.ok,
      mode: result.mode,
      diff: result.diff,
      message,
      ...(result.rawTail === undefined ? {} : { rawTail: result.rawTail }),
      durationMs: Date.now() - started
    }
  }

  /* -------------------------------------------------------- 保留策略 */

  /**
   * 执行保留策略（T09.8）。
   *
   * 由发布成功后**异步**调用（B10），因此这里既不抛"没策略"的错，
   * 也不因为单个版本删除失败而整体失败 —— 清理是收尾动作，
   * 不该反过来把一次成功的发布变成失败。
   */
  async function applyRetention(input: ApplyRetentionInput): Promise<RetentionResult> {
    const log: ArchiveLogFn = input.log ?? ((): void => undefined)
    const target = repo.targets.get(input.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: input.targetId })

    const rawPolicy = target.retainPolicy
    const policy = parseRetainPolicy(rawPolicy)
    const rows = repo.archives.listByTarget(target.id, RETENTION_SCAN_LIMIT)
    const plan = planRetention(
      rows.map((r) => ({
        id: r.id,
        versionTag: r.versionTag,
        archivedAt: r.archivedAt,
        totalBytes: r.totalBytes
      })),
      policy,
      now()
    )

    /**
     * "没配策略"与"策略坏了"必须区分开。
     *
     * 前者是用户的正常选择（不清理），后者是数据被改坏 —— 如果都表现成
     * "没清理"，用户会以为自动清理在正常工作，历史版本却一直堆在服务器上。
     */
    const policyBroken = Boolean(rawPolicy) && policy === null
    const invalidReason = policyBroken
      ? `保留策略无法解析（原始值：${rawPolicy}），未清理任何版本`
      : plan.invalidReason

    const base: RetentionResult = {
      considered: rows.length,
      removed: [],
      failed: [],
      policyText: `${describeRetainPolicy(policy)}；${plan.text}`,
      ...(invalidReason === undefined ? {} : { invalidReason })
    }

    if (invalidReason) {
      logger.warn(`保留策略不可用，跳过清理：${invalidReason}`)
      log(`保留策略不可用，未清理任何版本：${invalidReason}`, 'warn')
      return base
    }
    if (plan.remove.length === 0) {
      log(`保留策略无需清理（${plan.text}）`)
      return base
    }

    log(`开始执行保留策略：${plan.text}`)
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const victim of plan.remove) {
      const row = byId.get(victim.id)
      if (!row) continue
      try {
        // rmrf 对"已不存在"是幂等的（stat 不存在直接返回），
        // 所以"服务器上已被手工删掉"的版本也能顺利摘掉台账行
        await input.fs.rmrf(row.storagePath)
        repo.archives.remove(row.id)
        base.removed.push({
          id: row.id,
          versionTag: row.versionTag,
          storagePath: row.storagePath,
          bytes: row.totalBytes
        })
        logger.info(`retention: removed ${row.versionTag} (${row.storagePath})`)
        log(`已删除往期版本 ${row.versionTag}（${row.totalBytes} 字节）`)
      } catch (err) {
        // 台账行**保留**：服务器上还在的东西，台账里不能假装没了
        base.failed.push({
          id: row.id,
          versionTag: row.versionTag,
          reason: (err as Error).message
        })
        logger.warn(`retention: failed to remove ${row.versionTag}: ${(err as Error).message}`)
        log(`删除往期版本 ${row.versionTag} 失败：${(err as Error).message}`, 'warn')
      }
    }

    repo.audit.write({
      level: base.failed.length > 0 ? 'warn' : 'info',
      scope: 'archive',
      refId: target.id,
      message:
        `保留策略清理：删除 ${base.removed.length} 个版本` +
        `${base.failed.length > 0 ? `，失败 ${base.failed.length} 个` : ''}（${plan.text}）`,
      detail: JSON.stringify({
        policy,
        removed: base.removed.map((r) => r.versionTag),
        failed: base.failed
      })
    })
    return base
  }

  /* ------------------------------------------------------ 手工删除版本 */

  /**
   * 手工删除指定版本（T12.5）。
   *
   * 与保留策略共用同一套动作（`rmrf(storagePath)` + 摘台账行），但**驱动源不同**：
   * 这里删哪些版本完全由用户勾选，所以：
   *
   * 1. **逐条如实返回**，不是一个布尔值 —— "哪几个删了、哪几个没删成、为什么"
   *    是用户接着做决定（重试 / 手工上服务器看）的唯一依据；
   * 2. 删除失败的条目**保留台账行** —— 服务器上还在的东西，台账里不能假装没了；
   * 3. 台账里查不到的 id 也算失败（而不是静默跳过）：静默跳过会让
   *    "选了 5 个、只删了 3 个、界面说完成"成为一次无人察觉的数据丢失。
   */
  async function removeVersions(input: RemoveVersionsInput): Promise<ArchiveRemoveResult> {
    const log: ArchiveLogFn = input.log ?? ((): void => undefined)
    const result: ArchiveRemoveResult = { removed: [], failed: [], freedBytes: 0 }

    // 去重：界面多选理论上不会重复，但"同一个 id 删两次"的第二次会报"台账里没有"
    const ids = [...new Set(input.archiveIds)]

    for (const id of ids) {
      const row = repo.archives.get(id)
      if (!row) {
        result.failed.push({ id, versionTag: '(未知)', reason: '台账里找不到这条版本记录' })
        log(`跳过：台账里找不到归档记录 ${id}`, 'warn')
        continue
      }
      try {
        // rmrf 对"已不存在"是幂等的：服务器上被手工删过的版本也能干净地摘掉台账行
        await input.fs.rmrf(row.storagePath)
        repo.archives.remove(row.id)
        result.removed.push({
          id: row.id,
          versionTag: row.versionTag,
          storagePath: row.storagePath,
          bytes: row.totalBytes
        })
        result.freedBytes += row.totalBytes
        logger.info(`archive remove: ${row.versionTag} (${row.storagePath})`)
        log(`已删除往期版本 ${row.versionTag}（释放 ${row.totalBytes} 字节）`)
      } catch (err) {
        result.failed.push({ id: row.id, versionTag: row.versionTag, reason: (err as Error).message })
        logger.warn(`archive remove failed: ${row.versionTag} — ${(err as Error).message}`)
        log(`删除往期版本 ${row.versionTag} 失败：${(err as Error).message}`, 'warn')
      }
    }

    repo.audit.write({
      level: result.failed.length > 0 ? 'warn' : 'info',
      scope: 'archive',
      refId: ids[0] ?? 'unknown',
      message:
        `手工删除往期版本：成功 ${result.removed.length} 个` +
        `${result.failed.length > 0 ? `，失败 ${result.failed.length} 个` : ''}` +
        `（释放 ${result.freedBytes} 字节）`,
      detail: JSON.stringify({
        removed: result.removed.map((r) => r.versionTag),
        failed: result.failed
      })
    })
    return result
  }

  /* ------------------------------------------------------ 版本明细 */

  /**
   * 读一个版本的明细（T12.7）。
   *
   * 内容清单的唯一真相在远端 `manifest.json`（方案书 §5.3），台账里只有汇总数字，
   * 所以这一步**会连服务器**。分页在服务端做：一个上千文件的目录，
   * 把全部 relPath 塞进渲染进程再分页，等于每次翻页都付一次全量 IPC 的代价。
   *
   * **刻意没有副作用**：即使 manifest 读不到也不改台账状态 ——
   * 打开抽屉看一眼不该改变"这条版本可不可信"的记录（那是「校验」的职责）。
   */
  async function readDetail(input: ReadDetailInput): Promise<ArchiveDetail> {
    const started = Date.now()
    const row = repo.archives.get(input.archiveId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { archiveId: input.archiveId })

    const offset = Math.max(0, input.offset ?? 0)
    const limit = Math.max(1, input.limit ?? 200)

    const manifestPath = joinRemote(row.storagePath, MANIFEST_FILE_NAME)
    const text = await input.ports.fs.readTextFile(manifestPath)
    const parsed = parseManifestText(text)
    const m = parsed.manifest

    return {
      archiveId: row.id,
      versionTag: row.versionTag,
      manifest: {
        schemaVersion: m.schemaVersion,
        targetName: m.targetName,
        originalPath: m.originalPath,
        kind: m.kind,
        archivedAt: m.archivedAt,
        hashAlgo: m.hashAlgo,
        rootHash: m.rootHash,
        totalBytes: m.totalBytes,
        fileCount: m.fileCount,
        operator: m.operator ?? null,
        note: m.note ?? null,
        sourceReleaseId: m.sourceReleaseId ?? null
      },
      files: m.files.slice(offset, offset + limit),
      offset,
      limit,
      total: m.files.length,
      unknownKeys: Object.keys(m).filter((k) => !(KNOWN_MANIFEST_KEYS as readonly string[]).includes(k)),
      warnings: parsed.warnings,
      durationMs: Date.now() - started
    }
  }

  /* ------------------------------------------------------------ 撤销归档 */

  async function undoArchive(input: UndoArchiveInput): Promise<void> {
    const log: ArchiveLogFn = input.log ?? ((): void => undefined)
    const row = repo.archives.get(input.archiveId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { archiveId: input.archiveId })

    const target = repo.targets.get(row.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: row.targetId })

    const remotePath = normalizeRemotePath(target.remotePath)
    const kind: 'dir' | 'file' = row.kind === 'file' ? 'file' : 'dir'
    const artifactAt = joinRemote(row.payloadPath, posixBasename(remotePath))
    const moveMode: 'rename' | 'copy' = input.moveMode === 'copy' ? 'copy' : 'rename'

    if (!(await input.ports.fs.stat(artifactAt)).exists) {
      throw new AppError(
        ErrorCode.E_ARCHIVE_MISSING,
        { artifactAt, storagePath: row.storagePath },
        {
          message: '归档复位失败：归档目录里找不到内容',
          hint: `请人工检查 ${row.storagePath}。`
        }
      )
    }

    // 目标路径已被占用就**拒绝**：覆盖它可能把别的东西弄没，
    // 而"目标为什么有东西"这件事只有人判断得了。
    if ((await input.ports.fs.stat(remotePath)).exists) {
      throw new AppError(
        ErrorCode.E_ARCHIVE_FAILED,
        { remotePath, storagePath: row.storagePath },
        {
          message: `归档复位被拒绝：目标路径 ${remotePath} 已经有内容`,
          hint: '为避免覆盖，未做任何改动。请人工确认该路径的内容后再处理。'
        }
      )
    }

    log(`正在把归档版本 ${row.versionTag} 复位到 ${remotePath}…`, 'warn')
    try {
      if (moveMode === 'copy') {
        await copyArtifactInto({
          fs: input.ports.fs,
          src: artifactAt,
          dst: remotePath,
          kind
        })
      } else {
        await input.ports.fs.rename(artifactAt, remotePath)
      }
    } catch (err) {
      const message =
        `归档复位失败：目标 ${remotePath} 仍为空，内容还在 ${row.storagePath}/payload 下。` +
        `请手工移动回去。`
      logger.error(`${message}（原因：${(err as Error).message}）`)
      log(message, 'error')
      throw new AppError(
        ErrorCode.E_ARCHIVE_FAILED,
        { remotePath, storagePath: row.storagePath, original: (err as Error).message },
        { message, hint: '内容没有丢，但需要人工介入。请把上述路径告知运维。' }
      )
    }

    try {
      await input.ports.fs.rmrf(row.storagePath)
    } catch (err) {
      // 台账行仍要删掉（内容已经回到目标路径，这个版本不再"在版本库里"），
      // 但目录没删干净要说出来，否则会在归档目录里留下一个对不上账的孤儿目录
      logger.warn(`归档复位后清理 ${row.storagePath} 失败：${(err as Error).message}`)
      log(`警告：归档目录 ${row.storagePath} 未能删除，请手工清理`, 'warn')
    }
    repo.archives.remove(row.id)
    repo.audit.write({
      level: 'warn',
      scope: 'archive',
      refId: row.id,
      message: `撤销归档 ${row.versionTag}：内容已复位到 ${remotePath}`,
      detail: JSON.stringify({ targetId: row.targetId, storagePath: row.storagePath, moveMode })
    })
    log(`已把归档版本 ${row.versionTag} 复位到目标路径`, 'warn')
  }

  /* -------------------------------------------- 去重：丢掉与另一份相同的归档 */

  /**
   * 丢掉一份**与另一份内容完全相同**的归档（远端目录 + 台账行一起摘除）。
   *
   * ## 它为谁存在
   *
   * 回滚到旧版之后再发布新版：阶段 4 会把"现网那一份"（就是上次回滚恢复出来的
   * 内容）再归档一次 —— 而它在版本库里本来就有一份（回滚默认保留来源）。
   * 不去重的话，「往期版本」里会出现两份一模一样的版本，用户分不清哪份是哪份。
   *
   * ## 为什么在发布成功之后做、而不是在阶段 4 跳过归档
   *
   * 阶段 4 的"目标上有内容就必须归档、归档失败禁止继续"是整条补偿链的前提
   * （归档失败时目标可能已经空了，只有 `undoArchive` 能把内容还回去）。
   * 发布已经成功，这时才摘掉重复的那份 —— 任何失败都只是"多留了一份重复"，
   * 绝不会丢内容。所以这里的失败**只上报、不抛出**。
   *
   * ## 判据刻意收窄（宁可不去重，也不能误删）
   *
   * 两份的 `rootHash` 必须完全一致 —— 这是"内容相同"唯一可用的判据。
   * 注意它比较的是**两份各自独立落库的清单**：`keepArchiveId` 那份的清单来自它
   * 归档时的 manifest，`archiveId` 这份来自发布时传入的上一版清单 —— 两者不是
   * 同一次计算，只有内容真的相同时才会相等。清单对不上（比如回滚后有人动过
   * 现网、逐文件清单根本没落库）时宁可留一份重复，也不删。
   */
  async function discardDuplicateArchive(input: {
    /** 要摘除的那份（本次发布刚归档出来的） */
    archiveId: string
    /** 要保留的那份（上次回滚的来源归档） */
    keepArchiveId: string
    fs: ArchivePorts['fs']
    log?: ArchiveLogFn
  }): Promise<{ discarded: boolean; keptVersionTag: string | null; reason?: string }> {
    const log: ArchiveLogFn = input.log ?? ((): void => undefined)
    const drop = repo.archives.get(input.archiveId)
    const keep = repo.archives.get(input.keepArchiveId)
    if (!drop) {
      const reason = '要摘除的归档记录不存在'
      log(`未去除重复归档：${reason}`, 'warn')
      return { discarded: false, keptVersionTag: null, reason }
    }
    if (!keep) {
      // 预期路径：回滚时选了"不保留来源"，现网这份就是唯一副本 —— 说清楚即可，不必告警
      const reason = '上次回滚的来源归档已不在版本库，这份归档就是唯一副本，照常保留'
      log(`未去除重复归档：${reason}`, 'info')
      return { discarded: false, keptVersionTag: null, reason }
    }
    if (drop.id === keep.id) {
      return { discarded: false, keptVersionTag: null, reason: '两份是同一条记录' }
    }
    if (drop.rootHash !== keep.rootHash) {
      // 这条值得说清楚：现网内容与版本库里那份**不一样**，所以这次归档必须留 ——
      // （最常见的原因是回滚之后有人动过服务器）
      const reason =
        `现网内容与版本库中的 ${keep.versionTag} 不一致` +
        `（${drop.rootHash.slice(0, 8)} / ${keep.rootHash.slice(0, 8)}），照常保留这次归档`
      log(`未去除重复归档：${reason}`, 'info')
      return { discarded: false, keptVersionTag: null, reason }
    }

    try {
      await input.fs.rmrf(drop.storagePath)
    } catch (err) {
      // 目录没删掉就**不摘台账行**：那会让台账指向一个仍然存在的目录，对账反而说不清。
      // 留着它顶多是列表里多一份重复，内容不会丢 —— 所以不上抛（调用方在成功路径上）。
      const reason = `删除归档目录 ${drop.storagePath} 失败：${(err as Error).message}`
      log(`未去除重复归档：${reason}`, 'warn')
      return { discarded: false, keptVersionTag: null, reason }
    }
    repo.archives.remove(drop.id)
    repo.audit.write({
      level: 'info',
      scope: 'archive',
      refId: drop.id,
      message: `去除重复归档 ${drop.versionTag}（与 ${keep.versionTag} 内容一致）`,
      detail: JSON.stringify({
        targetId: drop.targetId,
        keptArchiveId: keep.id,
        rootHash: drop.rootHash
      })
    })
    log(`已去掉重复归档 ${drop.versionTag}（与 ${keep.versionTag} 内容一致），保留原版本`)
    return { discarded: true, keptVersionTag: keep.versionTag }
  }

  return { list, count, summary, archiveVersion, verifyArchive, applyRetention, removeVersions, readDetail, undoArchive, discardDuplicateArchive }
}

export type ArchiveService = ReturnType<typeof createArchiveService>

/** 供 UI/日志展示：归档时间倒序时的人类可读排序键（纯函数，便于单测）。 */
export function compareByArchivedAtDesc(
  a: { archivedAt: string },
  b: { archivedAt: string }
): number {
  // P1-1：解析成时刻再比较。列里理论上已统一为 UTC，但迁移特意保留的
  // "解析失败的坏行"与任何未来的格式漂移，都不该靠字符串序碰运气。
  const ta = Date.parse(a.archivedAt)
  const tb = Date.parse(b.archivedAt)
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta
  // 双方至少有一方解析失败、或同一时刻 → 退回字符串序，保证结果稳定可复现
  return compareRelPathUtf8(b.archivedAt, a.archivedAt)
}

/** 归档根目录（供 UI 展示"版本存在哪里"）。 */
export function archiveDirOf(target: {
  remotePath: string
  archiveDir: string | null
  kind: string
}): string {
  return resolveArchiveDir({
    remotePath: target.remotePath,
    archiveDir: target.archiveDir,
    kind: target.kind === 'file' ? 'file' : 'dir'
  })
}

/** 便于测试与 B12：`payload/<basename>` 的完整路径（回滚要 rename 的就是它）。 */
export function artifactPathOf(payloadPath: string, originalPath: string): string {
  return posix.join(normalizeRemotePath(payloadPath), posixBasename(originalPath))
}
