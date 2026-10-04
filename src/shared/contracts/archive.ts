/**
 * 往期版本（归档）的跨进程契约（T09.1）。
 *
 * 方案书 §5.3 / §5.4。这里同时定义两样东西：
 * 1. **远端 `manifest.json` 的结构** —— 它是"不依赖本地数据库的真相来源"，
 *    换台电脑、换个数据库都能靠归档目录自证内容；
 * 2. 台账 `archives` 行的展示视图与入参 schema。
 *
 * ## 三个必须记住的约定（B10 / B12 / B13 / B14 都依赖）
 *
 * 1. **`files[].relPath` 相对的是 `payload_path`**（`<archive_dir>/<versionTag>/payload`），
 *    不是相对被归档的那个目标本身。所以：
 *    - 文件型目标 `/opt/svc/order.jar` → `relPath = "order.jar"`（与 §5.3 示例一致）
 *    - 目录型目标 `/opt/app/dist`     → `relPath = "dist/a.js"`（多了一层 `dist/`）
 *    这么做是为了让 `payload_path` 成为**唯一根**：校验、下载、回滚都只需要它，
 *    不必再各自推导"内容根到底是 payload 还是 payload/<basename>"。
 * 2. **`rootHash` 覆盖的是 `payload_path` 整棵树**，算法与 B07 的 `computeRootHash`
 *    完全一致（按 relPath 的 UTF-8 字节序聚合）。所以归档校验可以直接复用
 *    `verifyRemote()`，不需要第二套比对逻辑。
 * 3. **时间戳带本地时区偏移**（`+08:00`），不是 `Z` —— 方案书 §5.4 明确要求
 *    "时区统一按客户端本地时区生成"，这样运维在服务器上肉眼比对归档时间不会差 8 小时。
 */
import { z } from 'zod'

/* ------------------------------------------------------------ 版本号规则 */

/**
 * `versionTag = <yyyyMMdd-HHmmss>_<rootHash 前 7 位>[-<序号>]`（方案书 §5.4）。
 *
 * 序号从 2 开始（`-2`）：第一位不写序号，这与示例 `20250612-143015_a1b2c3d` 一致。
 */
export const VERSION_TAG_PATTERN = /^\d{8}-\d{6}_[0-9a-f]{7}(-\d+)?$/

export const versionTagSchema = z
  .string()
  .regex(VERSION_TAG_PATTERN, '版本号格式应为 yyyyMMdd-HHmmss_<哈希前7位>[-序号]')

/**
 * 单次操作最多往 `release_items` 写多少行（超过就不写，下次发布现场算远端指纹）。
 *
 * 放在契约层而不是发布服务里：**发布与回滚都要落这份清单**，而且它直接决定
 * "下一次发布的差异摘要有不有基准"。两份定义一旦漂移，就会出现
 * "回滚写了 5 万行、发布认为超过上限不写"这种对不上账的情况。
 */
export const MAX_RELEASE_ITEMS_PERSIST = 50000

/** 归档状态的取值（方案书 §5.2 的 `archives.status`）。 */
export const ARCHIVE_STATUSES = ['valid', 'missing', 'corrupt'] as const
export const archiveStatusSchema = z.enum(ARCHIVE_STATUSES)
export type ArchiveStatus = z.infer<typeof archiveStatusSchema>

export const ARCHIVE_STATUS_TEXT: Record<ArchiveStatus, string> = {
  valid: '完好',
  missing: '已丢失',
  corrupt: '已损坏'
}

export function describeArchiveStatus(status: ArchiveStatus): string {
  return ARCHIVE_STATUS_TEXT[status] ?? '未知'
}

export function archiveStatusTagType(status: ArchiveStatus): 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'valid':
      return 'success'
    case 'missing':
      return 'warning'
    case 'corrupt':
      return 'danger'
  }
}

/* -------------------------------------------------------- manifest 契约 */

export const ARCHIVE_MANIFEST_SCHEMA_VERSION = 1

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 必须是 64 位小写十六进制字符串')

export const archiveManifestFileSchema = z.object({
  /** 相对 `payload_path` 的路径，`/` 分隔（见文件头的约定 1） */
  relPath: z.string().min(1),
  hash: hex64,
  size: z.number().int().min(0),
  /** ISO-8601；远端拿不到时写 null，而不是省略字段 */
  mtime: z.string().nullable()
})
export type ArchiveManifestFile = z.infer<typeof archiveManifestFileSchema>

/**
 * 远端 `manifest.json` 的 schema。
 *
 * 两个刻意的选择：
 * - `schemaVersion` 用 `number().int().min(1)` 而不是 `literal(1)`：
 *   新版应用写下 v2 时，旧版应用**不该直接判死**，而应"能读多少读多少 + 明确告警"。
 *   归档目录是用户服务器上的资产，版本升级后连读都读不了是最糟的结果。
 * - `.passthrough()` 保留未知字段：将来加字段时，旧版应用读一遍再写回（如对账修复）
 *   不会把不认识的字段抹掉。
 */
export const archiveManifestSchema = z
  .object({
    schemaVersion: z.number().int().min(1),
    targetName: z.string().min(1),
    /** 归档前目标所在的绝对路径；回滚要靠它决定放回哪里 */
    originalPath: z.string().min(1),
    kind: z.enum(['dir', 'file']),
    versionTag: versionTagSchema,
    archivedAt: z.string(),
    hashAlgo: z.literal('sha256'),
    rootHash: hex64,
    totalBytes: z.number().int().min(0),
    fileCount: z.number().int().min(0),
    operator: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    /** 产生这个版本的发布记录 id（首次接管既有版本时为 null） */
    sourceReleaseId: z.string().nullable().optional(),
    /**
     * 明细。目录型目标可能上千条 —— **写的时候是流式的**（见 `infra/manifest-io.ts`），
     * 读的时候才整体进内存（读天然要全量比对）。
     */
    files: z.array(archiveManifestFileSchema)
  })
  .passthrough()
export type ArchiveManifest = z.infer<typeof archiveManifestSchema>

/** 本版本认识的 manifest 顶层字段，用于"未知字段"告警。 */
export const KNOWN_MANIFEST_KEYS = [
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
  'sourceReleaseId',
  'files'
] as const

/* ---------------------------------------------------------- 台账视图 */

export interface ArchiveView {
  id: string
  targetId: string
  versionTag: string
  /** 远端 `<archive_dir>/<versionTag>` */
  storagePath: string
  /** 远端 `<storagePath>/payload`，manifest 的相对根 */
  payloadPath: string
  kind: 'dir' | 'file'
  rootHash: string
  totalBytes: number
  fileCount: number
  archivedAt: string
  releaseId: string | null
  note: string | null
  status: ArchiveStatus
  /** 相邻展示用：根哈希前 8 位，UI 上比 64 位更好认 */
  shortHash: string
}

/**
 * 归档校验结果（T09.7）。
 *
 * 刻意把"台账状态"与"本次校验结论"分开：`status` 是落库后的新状态，
 * `diff` 是证据。用户对账时最需要的是"到底哪个文件不一样"，
 * 而不是一个布尔值。
 */
export interface ArchiveVerifyResult {
  archiveId: string
  versionTag: string
  status: ArchiveStatus
  /** 内容是否与 manifest 完全一致 */
  ok: boolean
  /** 校验走的分支（远端命令 / SFTP 流式 / 被策略关闭） */
  mode: 'sha256sum' | 'shasum' | 'sftp-stream' | 'disabled' | 'missing'
  /** 逐文件差异；`missing` 模式为空 */
  diff: {
    missing: string[]
    extra: string[]
    mismatch: Array<{ relPath: string; expected: string; actual: string | null }>
    matchedCount: number
  }
  /** 面向用户的一句话结论 */
  message: string
  /** 排障用：命令输出的尾部（可能为空） */
  rawTail?: string
  durationMs: number
}

/** 保留策略执行结果（T09.8）。 */
export interface RetentionResult {
  /** 受影响的归档条数（含被计划删除与已删除） */
  considered: number
  removed: Array<{ id: string; versionTag: string; storagePath: string; bytes: number }>
  /** 删除失败的条目（远端 rmrf 报错时不回滚台账，如实上报） */
  failed: Array<{ id: string; versionTag: string; reason: string }>
  /** 人类可读的策略描述，写进日志与审计 */
  policyText: string
  /** 策略非法时不执行任何删除，这里给出面向用户的原因 */
  invalidReason?: string
}

/* ------------------------------------------------------------ 入参契约 */

export const archiveListInputSchema = z.object({ targetId: z.string().min(1) })
export type ArchiveListInput = z.infer<typeof archiveListInputSchema>

export const archiveVerifyInputSchema = z.object({ archiveId: z.string().min(1) })
export type ArchiveVerifyInput = z.infer<typeof archiveVerifyInputSchema>

export const archiveApplyRetentionInputSchema = z.object({ targetId: z.string().min(1) })
export type ArchiveApplyRetentionInput = z.infer<typeof archiveApplyRetentionInputSchema>

/** 在服务器上"归档目录里多出来的、台账里没有"的版本（B14 对账会用到）。 */
export const orphanArchiveSchema = z.object({
  versionTag: z.string(),
  storagePath: z.string(),
  hasManifest: z.boolean()
})
export type OrphanArchive = z.infer<typeof orphanArchiveSchema>

/* -------------------------------------------------- 版本库（B12 / T12.6） */

/**
 * 往期版本台账的聚合（T12.6）。
 *
 * **纯台账聚合，不连服务器**：详情页一进来就要显示"共占用多少"，
 * 而用户最需要这个数字的时刻恰恰是"连不上、想清理"的时候。
 * 远端真实占用由远端 `du` 给出（不在本批次范围内），这里是台账口径。
 */
export interface ArchiveSummary {
  count: number
  /** 台账里各版本 totalBytes 之和 */
  totalBytes: number
  /** 状态分布（三种状态都给 0 值，UI 不必再判 undefined） */
  byStatus: Record<ArchiveStatus, number>
  /** 最早 / 最新的归档时间；没有版本时为 null */
  oldestAt: string | null
  newestAt: string | null
}

export const archiveSummaryInputSchema = z.object({ targetId: z.string().min(1) })
export type ArchiveSummaryInput = z.infer<typeof archiveSummaryInputSchema>

/* ------------------------------------------------ 版本明细（B12 / T12.7） */

/** 每页最多返回多少条文件（避免一次把上万个 relPath 灌进渲染进程）。 */
export const ARCHIVE_DETAIL_MAX_LIMIT = 1000
export const ARCHIVE_DETAIL_DEFAULT_LIMIT = 200

export const archiveDetailInputSchema = z.object({
  archiveId: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(ARCHIVE_DETAIL_MAX_LIMIT).default(ARCHIVE_DETAIL_DEFAULT_LIMIT)
})
export type ArchiveDetailInput = z.infer<typeof archiveDetailInputSchema>

/**
 * 版本明细（T12.7）。
 *
 * **会连服务器**：内容清单的唯一真相在远端 `manifest.json`（方案书 §5.3），
 * 台账里只有汇总数字。所以抽屉打开与翻页都会读一次远端 manifest。
 */
export interface ArchiveDetail {
  archiveId: string
  versionTag: string
  manifest: {
    schemaVersion: number
    targetName: string
    originalPath: string
    kind: 'dir' | 'file'
    archivedAt: string
    hashAlgo: 'sha256'
    rootHash: string
    totalBytes: number
    fileCount: number
    operator: string | null
    note: string | null
    sourceReleaseId: string | null
  }
  /** 本页文件（`relPath` 相对 payloadPath） */
  files: ArchiveManifestFile[]
  offset: number
  limit: number
  /** manifest 里文件总数（= manifest.fileCount 的实测值） */
  total: number
  /** manifest 顶层出现但本版本不认识的字段名（提示"可能是更新版应用写的"） */
  unknownKeys: string[]
  /** `parseManifestText` 给出的告警（schema 版本更高、未知字段等） */
  warnings: string[]
  durationMs: number
}

/* ------------------------------------------------ 下载（B12 / T12.3~12.4） */

/** 默认保存根目录名（相对系统"下载"目录），T12.3。 */
export const DEFAULT_DOWNLOAD_DIR_NAME = 'sfvm-downloads'

/** 下载保存根目录；不传时由接线层填"系统下载目录/sfvm-downloads"。 */
export const archiveDownloadPlanInputSchema = z.object({
  archiveId: z.string().min(1),
  saveDir: z.string().min(1).nullable().optional()
})
export type ArchiveDownloadPlanInput = z.infer<typeof archiveDownloadPlanInputSchema>

/**
 * 下载计划（T12.3 的第一步）。
 *
 * **纯本地 + 一次 stat**：不连服务器。作用有三个：
 * 1. 让用户在点"开始下载"之前先看到**文件会落在哪里**（这是不可逆的写盘动作）；
 * 2. 冲突改名在计划阶段就定下来，避免"下到一半才发现同名"；
 * 3. 计划里的 `finalName` 会被用户带回到下载入参里 —— 保证
 *    "看到的路径"与"实际写入的路径"是同一个（否则中间没人能解释为什么不一样）。
 */
export interface ArchiveDownloadPlan {
  /** 实际使用的保存根目录（是入参 saveDir 或默认值） */
  saveDir: string
  /** 最终目录名（单层，已做文件系统非法字符净化） */
  finalName: string
  /** `saveDir/finalName` */
  finalPath: string
  /** 同名目录已存在、已自动改成 finalName（带 `-2` 后缀）时的原始名字 */
  adjustedFrom: string | null
  /** 下载中的暂存目录（同一父目录下，`.sfvm-part-<archiveId>`） */
  stagingPath: string
  /** 保存根目录当前是否已存在（不存在时下载会先创建它） */
  saveDirExists: boolean
}

export const archiveDownloadInputSchema = z.object({
  archiveId: z.string().min(1),
  saveDir: z.string().min(1),
  /**
   * 最终目录名（来自 `archives.downloadPlan`）。
   *
   * 只接受**单层**名字：`/`、`\`、`..` 一律拒绝。这是"把路径拼接权留在主进程"
   * 的边界 —— 渲染进程可以决定"叫什么名字"，但不能决定"写到哪里"。
   */
  finalName: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !/[/\\]/.test(v), '目录名不能包含路径分隔符')
    .refine((v) => v !== '.' && v !== '..', '目录名不合法')
})
export type ArchiveDownloadInput = z.infer<typeof archiveDownloadInputSchema>

/** 下载结果（随任务失败/成功一起给出；成功时只有 `finalPath` 重要）。 */
export interface ArchiveDownloadResult {
  archiveId: string
  versionTag: string
  /** 校验通过后 rename 成的最终目录 */
  finalPath: string
  /** 下载的文件数与字节数 */
  files: number
  bytes: number
  /** 逐文件校验通过且 rootHash 复核一致 */
  verified: boolean
  durationMs: number
}

/* ------------------------------------------------ 删除（B12 / T12.5） */

/** 一次最多删多少个版本（防止误传一个巨大的数组把远端刷爆）。 */
export const ARCHIVE_REMOVE_MAX = 200

export const archiveRemoveInputSchema = z.object({
  archiveIds: z.array(z.string().min(1)).min(1).max(ARCHIVE_REMOVE_MAX)
})
export type ArchiveRemoveInput = z.infer<typeof archiveRemoveInputSchema>

/**
 * 删除结果（T12.5）。
 *
 * **逐条如实返回**，不是一个布尔值：删了哪些、哪些没删成、各是什么原因，
 * 用户需要据此决定"再试一次"还是"手工去服务器上看一眼"。
 * 删除失败的条目**保留台账行** —— 服务器上还在的东西，台账里不能假装没了。
 */
export interface ArchiveRemoveResult {
  removed: Array<{ id: string; versionTag: string; storagePath: string; bytes: number }>
  failed: Array<{ id: string; versionTag: string; reason: string }>
  /** 已删除版本释放的字节数（台账口径） */
  freedBytes: number
}
