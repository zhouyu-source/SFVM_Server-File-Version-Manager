/**
 * 环境与目标资源的跨进程契约（T05.8）。
 *
 * 放 shared：主进程注册 schema、渲染进程复用类型，一份定义两端共用。
 */
import { z } from 'zod'

/* ------------------------------------------------------------------ 环境 */

export const envTypeSchema = z.enum(['prod', 'test', 'custom'])
export type EnvType = z.infer<typeof envTypeSchema>

export const environmentInputSchema = z.object({
  name: z.string().min(1, '环境名称不能为空'),
  envType: envTypeSchema,
  connectionId: z.string().min(1, '必须绑定一个连接'),
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  sortOrder: z.number().int().optional()
})
export type EnvironmentInput = z.infer<typeof environmentInputSchema>

export const environmentPatchSchema = environmentInputSchema.partial()

export interface EnvironmentView {
  id: string
  name: string
  envType: EnvType
  description: string | null
  connectionId: string
  color: string | null
  sortOrder: number
  targetCount: number
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------ 目标 */

export const targetKindSchema = z.enum(['dir', 'file'])
export type TargetKind = z.infer<typeof targetKindSchema>

export const retainPolicySchema = z.object({
  mode: z.enum(['count', 'days']),
  value: z.number().int().min(1)
})
export type RetainPolicy = z.infer<typeof retainPolicySchema>

/**
 * 解析 `targets.retain_policy` 这个 TEXT 列（存的是 JSON）。
 *
 * 放在 shared 而不是各 service 内部：保留策略有**两个**消费方 ——
 * 目标表单（展示/保存）与归档服务（执行清理）。两处各自解析一份，
 * 迟早会出现"表单认得的写法清理时不认"的错位。
 *
 * 解析失败一律返回 null（= 不清理），绝不抛错：一个坏掉的 JSON 字段
 * 不该让"往期版本"页面整个打不开；而且"不清理"是安全侧。
 */
export function parseRetainPolicy(raw: string | null | undefined): RetainPolicy | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    const r = retainPolicySchema.safeParse(parsed)
    return r.success ? r.data : null
  } catch {
    return null
  }
}

export function describeRetainPolicy(policy: RetainPolicy | null | undefined): string {
  if (!policy) return '不自动清理（保留全部往期版本）'
  return policy.mode === 'count'
    ? `保留最近 ${policy.value} 个版本`
    : `删除超过 ${policy.value} 天的版本`
}

export const deployStrategySchema = z.enum(['rename', 'copy'])

export const targetInputSchema = z.object({
  environmentId: z.string().min(1),
  name: z.string().min(1, '目标名称不能为空'),
  remotePath: z.string().min(1, '请填写服务器上的路径'),
  kind: targetKindSchema.optional(),
  archiveDir: z.string().nullable().optional(),
  localPath: z.string().nullable().optional(),
  localExclude: z.array(z.string()).optional(),
  verifyRemote: z.boolean().optional(),
  retainPolicy: retainPolicySchema.nullable().optional(),
  deployStrategy: deployStrategySchema.optional(),
  autoConnect: z.boolean().optional()
})
export type TargetInput = z.infer<typeof targetInputSchema>

export const targetPatchSchema = targetInputSchema.partial()

export interface TargetView {
  id: string
  environmentId: string
  name: string
  kind: TargetKind
  remotePath: string
  archiveDir: string
  archiveDirOverridden: boolean
  localPath: string | null
  localExclude: string[]
  hashAlgo: string
  verifyRemote: boolean
  retainPolicy: RetainPolicy | null
  deployStrategy: 'rename' | 'copy'
  autoConnect: boolean
  lastDeployAt: string | null
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------ 体检 */

export type HealthLevel = 'ok' | 'warn' | 'error'

export interface HealthCheck {
  key: 'connection' | 'path' | 'parent-writable' | 'archive-dir' | 'hash-tool'
  label: string
  level: HealthLevel
  detail: string
  suggestion?: string
  data?: Record<string, unknown>
}

export interface HealthReport {
  ok: boolean
  checks: HealthCheck[]
  needCreateChoice: boolean
  existingVersions: number
}

/** 新建目标的返回：目标本身 + 体检报告（方案书 §8.1）。 */
export interface TargetCreateResult {
  target: TargetView
  healthCheck: HealthReport
}

/* ------------------------------------ 本地产物探测（B11 / T11.1 ~ T11.2） */

export const localArtifactStatInputSchema = z.object({ targetId: z.string().min(1) })
export type LocalArtifactStatInput = z.infer<typeof localArtifactStatInputSchema>

/**
 * 本地产物的**轻量**信息（只 stat，不算哈希、不连服务器）。
 *
 * 为什么不复用 `deploy.precheck` 的 `artifactSummary`：
 * 1. **离线也要能显示**。"产物是否过期"是本机的事，不该因为服务器连不上就看不见；
 *    precheck 的第一步是建连接，场景不对。
 * 2. precheck（full）会**把整个产物哈希一遍**（为差异摘要与磁盘余量服务）。
 *    一枚黄色徽标不值得那个代价 —— 用户可能只是打开详情页看一眼。
 */
export interface LocalArtifactInfo {
  /** 目标上配置的本地路径；未配置时为 null，此时其余字段无意义 */
  path: string | null
  exists: boolean
  /** 实际类型；不存在时为 null */
  kind: 'dir' | 'file' | null
  /** 目录型：递归文件数；文件型恒为 1；不存在时为 null */
  fileCount: number | null
  totalBytes: number | null
  /** 最新一次修改时间；取不到为 null */
  mtime: string | null
  mtimeMs: number | null
  /**
   * 是否"可能已过期"：最新 mtime 距今超过 `ARTIFACT_STALE_MS`（24 小时）。
   * **只提示、不阻止发布** —— 稳定的产物完全可能几天不动。
   */
  possiblyStale: boolean
  /** 距今多久（"3 天前"）；取不到 mtime 为 null */
  ageText: string | null
  /** 目标类型与本地路径类型不符时的说明（提前告知，别等点了发布才报错） */
  kindMismatch: string | null
  /**
   * 文件型目标：本地产物名与服务器端文件名不一致时的说明（B17）。
   *
   * 与 `kindMismatch` 的区别在于**它不影响能否发布** —— 发布时会按配置里的
   * 文件名上传（见 `alignArtifactItems`）。这里提前说出来，只是免得用户在服务器上
   * 找不到自己刚传的那个文件。目录型目标恒为 null。
   */
  nameMismatch: string | null
}

/* ------------------------------------------ 本地外壳（B11 / T11.7） */

export const pickArtifactInputSchema = z.object({
  kind: targetKindSchema,
  /** 回填用的初始路径（编辑既有配置时传入） */
  current: z.string().nullable().optional()
})
export type PickArtifactInput = z.infer<typeof pickArtifactInputSchema>

export const revealPathInputSchema = z.object({
  /** 要展示的本地路径：目录则打开它，文件则选中它 */
  path: z.string().min(1)
})
export type RevealPathInput = z.infer<typeof revealPathInputSchema>

/** "在终端里打开"与"打开所在目录"入参形状相同（都是"一个本地路径"）。 */
export const openTerminalInputSchema = revealPathInputSchema
export type OpenTerminalInput = RevealPathInput

/**
 * 选择一个本地目录（B12 / T12.3 的下载保存位置）。
 *
 * 与 `pickArtifact` 分开而不是复用它：那个通道的语义是"选本地产物"，
 * 选出来的路径会被写进目标的配置；保存位置只是一次性的动作参数。
 * 合成一个通道，将来任一边想加约束都会牵动另一边。
 */
export const pickDirectoryInputSchema = z.object({
  /** 打开对话框时的初始目录；不传则由系统决定 */
  defaultPath: z.string().min(1).nullable().optional()
})
export type PickDirectoryInput = z.infer<typeof pickDirectoryInputSchema>

/**
 * 选择一个**可执行文件**（B20：设置「Git Bash 路径」）。
 *
 * 再开一个通道而不是复用 `pickDirectory`（它只让选目录）或 `pickArtifact`
 * （它的标题写着"本地产物"，出现在"选 bash.exe"这一步上会让人以为选错了东西）。
 * 和它们一样**只回传路径、不读内容**。
 */
export const pickExecutableInputSchema = z.object({
  /** 对话框标题与用途说明（如"选择 Git Bash 的 bash.exe"） */
  title: z.string().min(1),
  defaultPath: z.string().min(1).nullable().optional()
})
export type PickExecutableInput = z.infer<typeof pickExecutableInputSchema>

export interface OpenShellResult {
  ok: boolean
  /** 失败原因（如"路径不存在"）；成功时为空 */
  reason?: string
}
