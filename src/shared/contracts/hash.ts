/**
 * 哈希与校验的跨进程契约（T07.4 / T07.8）。
 *
 * 放 shared 的原因与 workspace.ts 一致：主进程构造、渲染进程展示差异明细，
 * 一份 schema 两端共用，避免"主进程算出来的字段名渲染进程认不出"。
 *
 * 关键约定（后续 B09/B10/B13 都依赖，改动需同步 manifest）：
 * - `relPath` 一律用 **`/` 分隔的相对路径**，不带前导 `./`，不带盘符
 * - `hash` 一律 **64 位小写十六进制** SHA-256
 * - `rootHash` 是聚合指纹（见 `src/main/infra/hash-core.ts` 的算法说明），
 *   不是任何单个文件的哈希
 */
import { z } from 'zod'

/** 本地/远端一致使用的哈希算法。方案书 §6.6 只允许 sha256。 */
export const HASH_ALGO = 'sha256' as const

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 必须是 64 位小写十六进制字符串')

/* ------------------------------------------------------------ ReleaseItem */

/**
 * 一个文件的哈希条目（T07.4）。
 *
 * `size` / `mtime` 参与台账展示与"大小先变再算哈希"的快速预筛，
 * 但**不参与 rootHash 计算** —— 否则换个文件系统改了 mtime 就会指纹变化。
 */
export const releaseItemSchema = z.object({
  relPath: z
    .string()
    .min(1, '相对路径不能为空')
    // 防御性：relPath 不应带前导斜杠或 ..，它们会让远端拼接逃出暂存目录
    .refine((p) => !p.startsWith('/'), { message: 'relPath 不能以 / 开头' })
    .refine((p) => !p.split('/').some((s) => s === '..' || s === '.'), {
      message: 'relPath 不能包含 . 或 .. 段'
    })
    .refine((p) => !/[\r\n\0]/.test(p), { message: 'relPath 不能包含换行或空字符' }),
  hash: hex64,
  size: z.number().int().min(0),
  /** ISO-8601；远端可能拿不到，故可空 */
  mtime: z.string().nullable().optional()
})
export type ReleaseItem = z.infer<typeof releaseItemSchema>

/* --------------------------------------------------------- 本地哈希清单 */

export const HASH_MANIFEST_SCHEMA_VERSION = 1 as const

/**
 * 一次发布的完整哈希清单。
 *
 * 这是"本地 → 远端暂存 → 校验"链路上传递的唯一真值，
 * 也是 B09 manifest.json 的 `files` + 汇总字段的来源。
 */
export const hashManifestSchema = z.object({
  schemaVersion: z.literal(HASH_MANIFEST_SCHEMA_VERSION),
  algo: z.literal(HASH_ALGO),
  rootHash: hex64,
  totalBytes: z.number().int().min(0),
  fileCount: z.number().int().min(0),
  /** 已按 relPath 的 UTF-8 字节序排好序；解析时不重排以保持"所见即所算" */
  items: z.array(releaseItemSchema)
})
export type HashManifest = z.infer<typeof hashManifestSchema>

/**
 * 清单自洽性校验：文件数、总字节必须与 items 一致。
 *
 * 单独一个函数而不是塞进 schema：schema 只校验形状，
 * 这类"汇总字段与明细对不上"是最容易在序列化/截断中悄悄发生的错误，
 * 值得在解析后强制检查一次。
 */
export function checkManifestConsistency(m: HashManifest): string[] {
  const problems: string[] = []
  if (m.fileCount !== m.items.length) {
    problems.push(`fileCount=${m.fileCount} 与 items.length=${m.items.length} 不一致`)
  }
  const sum = m.items.reduce((a, it) => a + it.size, 0)
  if (m.totalBytes !== sum) {
    problems.push(`totalBytes=${m.totalBytes} 与 items 求和=${sum} 不一致`)
  }
  const seen = new Set<string>()
  for (const it of m.items) {
    if (seen.has(it.relPath)) problems.push(`relPath 重复：${it.relPath}`)
    seen.add(it.relPath)
  }
  return problems
}

/* ---------------------------------------------------------- 校验差异报告 */

export const hashMismatchSchema = z.object({
  relPath: z.string(),
  expected: z.string(),
  /** 远端实际哈希；命令模式（sha256sum -c）拿不到具体值时为 null */
  actual: z.string().nullable()
})

/**
 * 三分类差异（T07.8 / 方案书 §6.6「清单比对」）。
 *
 * - `missing`：期望有、远端没有
 * - `extra`：远端多出、清单里没有
 * - `mismatch`：两边都有但哈希不同
 */
export const verifyDiffSchema = z.object({
  missing: z.array(z.string()),
  extra: z.array(z.string()),
  mismatch: z.array(hashMismatchSchema),
  /** 比对通过的文件数（用于 UI 展示"1200 个文件全部一致"） */
  matchedCount: z.number().int().min(0),
  ok: z.boolean()
})
export type VerifyDiff = z.infer<typeof verifyDiffSchema>
export type HashMismatch = z.infer<typeof hashMismatchSchema>

/** 远端校验实际走的分支，用于 UI 提示与台账记录。 */
export const verifyModeSchema = z.enum([
  /** 远端有 sha256sum，走 `sha256sum -c` */
  'sha256sum',
  /** 远端只有 shasum（macOS / BSD），走 `shasum -a 256 -c` */
  'shasum',
  /** 两者都没有，SFTP 流式读取逐文件计算（慢但正确） */
  'sftp-stream',
  /** 用户在目标上关闭了 verify_remote（生产环境不允许） */
  'disabled'
])
export type VerifyMode = z.infer<typeof verifyModeSchema>

export interface RemoteVerifyResult {
  mode: VerifyMode
  diff: VerifyDiff
  /** 本次校验耗时（毫秒），降级路径会明显更久，供 UI 提示 */
  durationMs: number
  /** 命令模式的原始输出尾部，排障用（已截断） */
  rawTail?: string
}

/** 本地产物的哈希结果。 */
export interface LocalHashResult {
  rootHash: string
  items: ReleaseItem[]
  totalBytes: number
  fileCount: number
  /** 命中 local_exclude 规则而被排除的文件数，用于 UI 提示"已排除 N 个文件" */
  excludedCount: number
  /**
   * 因是符号链接而被跳过的条目数。
   *
   * 刻意不跟随符号链接：构建产物里的软链（`node_modules/.bin/*`、指向外部
   * 目录的 link）既可能是环，也可能指向产物根之外；跟随它们会让"本地哈希"
   * 与"远端实际文件"不再一一对应。跳过是安全侧的选择，但必须显式汇报，
   * 不能让用户以为文件都传上去了。
   */
  skippedSymlinks: number
  durationMs: number
}
