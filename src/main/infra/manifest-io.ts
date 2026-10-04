/**
 * `manifest.json` 的序列化与解析（T09.1 / T09.3 的纯逻辑部分）。
 *
 * 为什么序列化要手写而不是 `JSON.stringify`：
 *
 * 1. **超大 `files` 必须流式写出**（方案书 §5.3 明确要求）。目录型目标的
 *    `files` 可能上千条，`JSON.stringify(整对象)` 会把它们一次性拼成一个
 *    几 MB 的字符串；上传时还要再复制一遍给 SFTP 缓冲。这里按块产出，
 *    内存里任何时刻只有一块（64 KB）。
 * 2. **字段顺序要稳定**。手写就能固定顺序：同一次内容永远产出同样的字节，
 *    排障时 `diff` 一下两个 manifest 就能看出差异，而不是满屏重排。
 * 3. **转义必须正确**。所以每个值仍然走 `JSON.stringify`（单值），
 *    绝不自己拼引号 —— 文件名里出现 `"` 或 `\` 时自己拼会产出坏 JSON。
 *
 * 解析侧刻意**宽容**：归档目录是用户服务器上的资产，跨版本升级后
 * "读都读不了"是最糟的结果，所以未知字段保留、更高 schemaVersion 只告警不失败。
 */
import { AppError, ErrorCode } from './errors'
import {
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  KNOWN_MANIFEST_KEYS,
  archiveManifestSchema,
  type ArchiveManifest,
  type ArchiveManifestFile
} from '../../shared/contracts/archive'
import type { ReleaseItem } from '../../shared/contracts/hash'

/** 归档目录下的固定文件名（`infra` 内唯一来源，避免各处拼字符串）。 */
export const MANIFEST_FILE_NAME = 'manifest.json'
/** 半成品名：先写它、`fsync` 意义上的"写完"后 rename，避免半截 manifest 被当真的读。 */
export const MANIFEST_TMP_NAME = 'manifest.json.tmp'
/** `payload` 目录名（`<storage_path>/payload`，方案书 §5.2）。 */
export const PAYLOAD_DIR_NAME = 'payload'

/**
 * 分块阈值。
 *
 * 取 64 KB 与本地哈希的 `HASH_CHUNK_SIZE` 一致：ssh2 的 SFTP 写流按块提交，
 * 块太小会退化成"发一笔等一次 ack"（B07 在传输层踩过这个坑，见 `transfer.ts` 注释）。
 */
export const MANIFEST_CHUNK_BYTES = 64 * 1024

/** manifest 的文案字段（除 `files` 之外的全部）。 */
export interface ManifestHeader {
  schemaVersion: number
  targetName: string
  originalPath: string
  kind: 'dir' | 'file'
  versionTag: string
  archivedAt: string
  hashAlgo: 'sha256'
  rootHash: string
  totalBytes: number
  fileCount: number
  operator: string | null
  note: string | null
  sourceReleaseId: string | null
}

export interface BuildManifestHeaderInput {
  targetName: string
  originalPath: string
  kind: 'dir' | 'file'
  versionTag: string
  archivedAt: string
  rootHash: string
  totalBytes: number
  fileCount: number
  operator?: string | null
  note?: string | null
  sourceReleaseId?: string | null
}

/**
 * 组装 header。
 *
 * `schemaVersion` / `hashAlgo` 不对外暴露成参数：它们由实现决定，
 * 让调用方能传只会有"某处写错版本号"的机会。
 */
export function buildManifestHeader(input: BuildManifestHeaderInput): ManifestHeader {
  return {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    targetName: input.targetName,
    originalPath: input.originalPath,
    kind: input.kind,
    versionTag: input.versionTag,
    archivedAt: input.archivedAt,
    hashAlgo: 'sha256',
    rootHash: input.rootHash,
    totalBytes: input.totalBytes,
    fileCount: input.fileCount,
    operator: input.operator ?? null,
    note: input.note ?? null,
    sourceReleaseId: input.sourceReleaseId ?? null
  }
}

/** header 的字段顺序（手写序列化的依据，也是"输出字节稳定"的来源）。 */
const HEADER_KEY_ORDER: ReadonlyArray<keyof ManifestHeader> = [
  'schemaVersion',
  'targetName',
  'originalPath',
  'kind',
  'versionTag',
  'archivedAt',
  'hashAlgo',
  'rootHash',
  'totalBytes',
  'fileCount',
  'operator',
  'note',
  'sourceReleaseId'
]

/** 一条文件明细序列化成**单行**：一行一条，`grep`/`head` 都能直接用。 */
function serializeFile(file: ArchiveManifestFile): string {
  const parts = [
    `"relPath":${JSON.stringify(file.relPath)}`,
    `"hash":${JSON.stringify(file.hash)}`,
    `"size":${JSON.stringify(file.size)}`,
    `"mtime":${JSON.stringify(file.mtime)}`
  ]
  return `    {${parts.join(',')}}`
}

/**
 * 流式产出 manifest 文本（T09.3）。
 *
 * 用生成器而不是返回数组：调用方（SFTP 写流）可以"取一块写一块"，
 * 生产者与消费者之间不需要把整个文档攒在内存里。
 *
 * 产出的文本是**合法 JSON**，与 `JSON.parse` 的往返有单测固定。
 */
export function* manifestChunks(
  header: ManifestHeader,
  files: Iterable<ArchiveManifestFile>
): Generator<string> {
  let buffer = '{\n'

  /**
   * 攒够一块就吐出去。抽成闭包是为了让"每写几行检查一次"不重复三遍；
   * 用 `take()` 的形式而不是在闭包里 yield（生成器里不能跨函数 yield）。
   */
  const take = (): string | null => {
    if (buffer.length < MANIFEST_CHUNK_BYTES) return null
    const out = buffer
    buffer = ''
    return out
  }

  const push = (line: string): string | null => {
    buffer += line
    return take()
  }

  for (let i = 0; i < HEADER_KEY_ORDER.length; i++) {
    const key = HEADER_KEY_ORDER[i] as keyof ManifestHeader
    const chunk = push(`  ${JSON.stringify(key)}: ${JSON.stringify(header[key])},\n`)
    if (chunk) yield chunk
  }

  // `files` 必须排在最后：它才是需要流式的那部分，放在数组中间就白流了
  const head = push(`  ${JSON.stringify('files')}: [\n`)
  if (head) yield head

  let first = true
  for (const f of files) {
    const line = `${first ? '' : ',\n'}${serializeFile(f)}`
    first = false
    const chunk = push(line)
    if (chunk) yield chunk
  }

  const tail = push(`${first ? '' : '\n'}  ]\n}\n`)
  if (tail) yield tail

  if (buffer.length > 0) yield buffer
}

/** 便于单测与小 manifest：把分块拼回一个字符串。 */
export function serializeManifest(
  header: ManifestHeader,
  files: Iterable<ArchiveManifestFile>
): string {
  let out = ''
  for (const chunk of manifestChunks(header, files)) out += chunk
  return out
}

/* ---------------------------------------------------------------- 解析 */

export interface ParsedManifest {
  manifest: ArchiveManifest
  /**
   * 非致命问题：更高版本的 schema、不认识的字段、汇总字段与明细对不上。
   * 调用方决定怎么用 —— 校验流程会把它们当"可疑"，但不会拒绝读取。
   */
  warnings: string[]
}

/**
 * 解析 manifest 文本。
 *
 * 失败一律抛 `E_ARCHIVE_CORRUPT`：manifest 坏了意味着"这份归档不能被信任"，
 * 不能让调用方把它当空对象继续跑。
 */
export function parseManifestText(text: string): ParsedManifest {
  if (typeof text !== 'string' || !text.trim()) {
    throw new AppError(ErrorCode.E_ARCHIVE_CORRUPT, { reason: 'empty-manifest' })
  }
  // 远端工具/编辑器可能留下 BOM，JSON.parse 会因此报"位置 0 的意外字符"
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  let raw: unknown
  try {
    raw = JSON.parse(cleaned)
  } catch (err) {
    throw new AppError(ErrorCode.E_ARCHIVE_CORRUPT, {
      reason: 'invalid-json',
      original: (err as Error).message
    })
  }

  const parsed = archiveManifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError(ErrorCode.E_ARCHIVE_CORRUPT, {
      reason: 'schema-mismatch',
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    })
  }

  const manifest = parsed.data
  const warnings: string[] = []

  if (manifest.schemaVersion > ARCHIVE_MANIFEST_SCHEMA_VERSION) {
    warnings.push(
      `manifest 由更新版本的应用写入（schemaVersion=${manifest.schemaVersion}，` +
        `本应用支持 ${ARCHIVE_MANIFEST_SCHEMA_VERSION}），未知字段会被忽略`
    )
  }

  const extraKeys = Object.keys(raw as Record<string, unknown>).filter(
    (k) => !(KNOWN_MANIFEST_KEYS as readonly string[]).includes(k)
  )
  if (extraKeys.length > 0) {
    warnings.push(`manifest 含本应用不认识的字段：${extraKeys.join('、')}`)
  }

  warnings.push(...checkManifestConsistency(manifest))
  return { manifest, warnings }
}

/**
 * 汇总字段与明细的自洽性检查。
 *
 * 单独一个函数、而不是塞进 schema：这类"数字对不上"是序列化/截断中
 * 最容易悄悄发生的错误，而 schema 只校验形状。校验流程会把它当"已损坏"。
 */
export function checkManifestConsistency(m: ArchiveManifest): string[] {
  const problems: string[] = []
  if (m.fileCount !== m.files.length) {
    problems.push(`fileCount=${m.fileCount} 与 files 条数=${m.files.length} 不一致`)
  }
  const sum = m.files.reduce((a, f) => a + f.size, 0)
  if (m.totalBytes !== sum) {
    problems.push(`totalBytes=${m.totalBytes} 与 files 求和=${sum} 不一致`)
  }
  const seen = new Set<string>()
  for (const f of m.files) {
    if (seen.has(f.relPath)) problems.push(`relPath 重复：${f.relPath}`)
    seen.add(f.relPath)
  }
  return problems
}

/**
 * manifest 明细 → B07 的 `ReleaseItem[]`。
 *
 * 之所以能直接转：两边的字段语义完全相同（`relPath` 相对根、`hash` 为
 * 64 位小写十六进制）。于是归档校验可以直接复用 `verifyRemote()` ——
 * 少一套比对逻辑就少一处"两个实现不一致"的可能。
 */
export function manifestToItems(m: ArchiveManifest): ReleaseItem[] {
  return m.files.map((f) => ({ relPath: f.relPath, hash: f.hash, size: f.size, mtime: f.mtime }))
}

/**
 * 把 manifest 的清单转成**相对产物根**的清单（`releaseItems` 表的形状）。
 *
 * ## 为什么需要这一层转换
 *
 * 两处的 `relPath` 口径不同（见 `contracts/archive.ts` 文件头）：
 *
 * | 来源 | 相对谁 | 目录型目标的例子 |
 * | --- | --- | --- |
 * | `manifest.files[].relPath` | `payload_path` | `dist/index.html` |
 * | `releaseItems.relPath` | 产物根（`hashLocalArtifact` 的形状） | `index.html` |
 *
 * 直接塞进去会让下一次发布的差异摘要凭空多出一层 `dist/` ——
 * 用户会看到"整个目录都被删了、又全部新增"。
 *
 * ## 形状对不上时返回 `null`（而不是抛错、也不是硬塞）
 *
 * 调用方（回滚）拿这份清单只是为了"下次发布可以省掉一次全量远端哈希"
 * 与"给用户一个正确的差异基准"。这两件事都是**锦上添花**：
 * 拿不到就退化成"下次发布现场算远端指纹"（慢一些，但正确）。
 * 往台账里写一份错的清单则会一直错下去，所以宁可不写。
 */
export function manifestToArtifactItems(
  m: ArchiveManifest,
  input: { originalPath: string; kind: 'dir' | 'file' }
): ReleaseItem[] | null {
  // 文件型目标的 relPath 就是文件名本身，两边口径天然一致
  if (input.kind === 'file') return manifestToItems(m)

  const base = input.originalPath.replace(/\/+$/, '').split('/').pop() ?? ''
  if (!base) return null
  const prefix = `${base}/`

  const out: ReleaseItem[] = []
  for (const f of m.files) {
    // 目录型归档必然带一层 `<basename>/`；不匹配说明这份 manifest 与目标形状对不上
    if (!f.relPath.startsWith(prefix) || f.relPath.length === prefix.length) return null
    out.push({
      relPath: f.relPath.slice(prefix.length),
      hash: f.hash,
      size: f.size,
      mtime: f.mtime
    })
  }
  return out
}
