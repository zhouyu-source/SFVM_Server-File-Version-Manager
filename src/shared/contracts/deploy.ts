/**
 * 发布（DeployService）的跨进程契约（B10 / T10.1）。
 *
 * 这份文件是**状态与阶段的唯一真相来源**：
 * - `RELEASE_STATUSES` / `DEPLOY_STATE_TRANSITIONS`：状态机（`main/infra/deploy-state.ts` 用它做校验，
 *   `db/repositories.ts` 用它定义"终态"，UI 用它出中文文案）。
 * - `DEPLOY_STAGES`：7 个阶段与状态的对应关系，进度条与日志都按它渲染。
 *
 * ## 为什么状态机要放在 shared 而不是主进程内部
 *
 * "一个 release 行当前处于什么状态、能不能往下走"这件事，**两端都要用**：
 * - 主进程：每次迁移前校验（防止代码写错顺序）；
 * - 渲染进程：B11/B13 要画进度条、要判断"这个版本还能不能回滚 / 重试"。
 *
 * 两边各写一份判断迟早会错位（B09 的保留策略解析就吃过这个亏，已提到 shared）。
 *
 * ## 状态命名的一个约定
 *
 * 状态里**没有 CANCELLED**（方案书 §5.2 的 status 取值是固定的 8 个）。
 * 被用户取消的发布记为 `FAILED`，取消原因写在 `current_step`（`cancelled`）与
 * `error_message` 里。这样不破坏方案书的取值集合，又能让 UI 区分
 * "跑失败了"与"我自己停的" —— 这两者给用户的建议动作完全不同。
 */
import { z } from 'zod'

/* ------------------------------------------------------------------ 状态 */

/** 发布流程的全部状态（方案书 §5.2 / db/schema.ts 的注释）。 */
export const RELEASE_STATUSES = [
  'PENDING',
  'UPLOADING',
  'VERIFYING',
  'ARCHIVING',
  'SWAPPING',
  'SUCCESS',
  'FAILED',
  'ROLLED_BACK'
] as const
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number]

/**
 * "已结束"的状态：这些状态下该 release **不会再产生新的远端残留**。
 *
 * 这是 B14 的启动残留扫描（`repo.releases.listUnfinished`）用的判据 ——
 * 它要找出"可能中断"的行，而 SUCCESS 的行当然已经干净了。
 *
 * ## 它与"状态机出度为 0"**不是一回事**（B10 踩到过这个混淆）
 *
 * `SUCCESS` 在这里算"已结束"，但状态机里它还有一条出边 `SUCCESS → ROLLED_BACK`（B13）。
 * 两个概念混在一起会导致两个方向的错误：
 * - 若为了"终态无出边"而禁止 SUCCESS → ROLLED_BACK：B13 回滚一个已发布版本时
 *   没有任何合法状态可写，只能硬改数据库；
 * - 若为了"SUCCESS 可回滚"而把 SUCCESS 从本集合移除：B14 会把每一次成功发布
 *   都当成"可能中断的残留"重新扫描一遍，每次启动都弹一堆误报。
 *
 * 所以两份定义分开：**本集合回答"还有没有烂摊子"，`DEPLOY_STATE_SINKS` 回答
 * "还能不能往下走"**。
 */
export const TERMINAL_RELEASE_STATUSES: readonly ReleaseStatus[] = [
  'SUCCESS',
  'FAILED',
  'ROLLED_BACK'
]

/** 状态机里**没有任何出边**的状态：到达后这一行不会再变。 */
export const DEPLOY_STATE_SINKS: readonly ReleaseStatus[] = ['FAILED', 'ROLLED_BACK']

export function isTerminalReleaseStatus(status: string): boolean {
  return (TERMINAL_RELEASE_STATUSES as readonly string[]).includes(status)
}

/** 状态机意义下的终态（出度为 0）。 */
export function isStateSink(status: ReleaseStatus): boolean {
  return (DEPLOY_STATE_SINKS as readonly ReleaseStatus[]).includes(status)
}

/**
 * 合法迁移表。
 *
 * 几点刻意的设计：
 * - `PENDING → PENDING` 是**自环**：阶段 0 与阶段 1 都在 PENDING 上（前置校验与本地指纹
 *   都不碰远端），所以"迁到同一个状态"必须是允许的，否则每次都要写特例。
 * - 任何非终态都可以 → `FAILED`：任一阶段失败都归到 FAILED（补偿动作在服务层做）。
 * - `SUCCESS → ROLLED_BACK`：B13 回滚一个已成功发布的版本。
 * - `FAILED` / `ROLLED_BACK` **出度为 0**：重试是新建一行（方案书 §6.11），
 *   不是把旧行改回去 —— 否则"失败历史"就没了。
 */
export const DEPLOY_STATE_TRANSITIONS: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
  PENDING: ['PENDING', 'UPLOADING', 'FAILED'],
  UPLOADING: ['UPLOADING', 'VERIFYING', 'FAILED'],
  VERIFYING: ['VERIFYING', 'ARCHIVING', 'FAILED'],
  ARCHIVING: ['ARCHIVING', 'SWAPPING', 'FAILED'],
  SWAPPING: ['SWAPPING', 'SUCCESS', 'FAILED'],
  SUCCESS: ['ROLLED_BACK'],
  FAILED: [],
  ROLLED_BACK: []
}

/* ------------------------------------------------------------------ 阶段 */

export interface DeployStageDef {
  /** 0 = 前置校验，1..6 = 方案书 §6.8 表格里的阶段编号 */
  index: number
  /** 进入该阶段时应处于的状态 */
  status: ReleaseStatus
  /** 面向用户的中文阶段名（进度条与日志用） */
  text: string
  /**
   * 该阶段**是否会改动远端**。
   *
   * 用于两件事：① 日志里提醒"从这里开始服务器会被改动"；
   * ② 失败补偿时判断"要不要去远端收拾"（阶段 0/1 失败时远端毫发无损，
   * 不做任何清理动作，也就不会把"只是本地路径写错了"误报成"远端已回滚"）。
   */
  mutatesRemote: boolean
}

export const DEPLOY_STAGES: readonly DeployStageDef[] = [
  { index: 0, status: 'PENDING', text: '前置校验', mutatesRemote: false },
  { index: 1, status: 'PENDING', text: '计算本地指纹', mutatesRemote: false },
  { index: 2, status: 'UPLOADING', text: '上传到暂存目录', mutatesRemote: true },
  { index: 3, status: 'VERIFYING', text: '远端逐文件校验', mutatesRemote: true },
  { index: 4, status: 'ARCHIVING', text: '归档当前版本', mutatesRemote: true },
  { index: 5, status: 'SWAPPING', text: '换版', mutatesRemote: true },
  { index: 6, status: 'SUCCESS', text: '收尾', mutatesRemote: true }
] as const

export const DEPLOY_STAGE_COUNT = DEPLOY_STAGES.length

/**
 * 阶段在整体进度里的区间（左闭右开，百分比）。
 *
 * 为什么不是"7 个阶段各占 14%"：上传（阶段 2）在小文件场景下几乎瞬间完成，
 * 而大目录要跑几十秒；平均分配会让进度条"一秒冲到大半然后卡住"。
 * 这里的权重按实测耗时分布给：上传占 55%，校验 15%，归档 10%。
 *
 * 注意：阶段内部还会在区间内插值（按文件数 / 字节数），所以这里是**区间**不是刻度。
 */
export const DEPLOY_STAGE_PROGRESS: ReadonlyArray<{ from: number; to: number }> = [
  { from: 0, to: 2 }, // 0 前置校验
  { from: 2, to: 10 }, // 1 本地指纹
  { from: 10, to: 65 }, // 2 上传
  { from: 65, to: 80 }, // 3 远端校验
  { from: 80, to: 90 }, // 4 归档
  { from: 90, to: 98 }, // 5 换版
  { from: 98, to: 100 } // 6 收尾
]

export function stageProgressRange(stage: number): { from: number; to: number } {
  const def = DEPLOY_STAGES.find((s) => s.index === stage)
  return DEPLOY_STAGE_PROGRESS[def?.index ?? 0] ?? { from: 0, to: 0 }
}

/** 阶段 0~6 的 `current_step` 取值，供台账与 UI 展示"卡在哪一步"。 */
export const DEPLOY_CANCELLED_STEP = 'cancelled'

/* ------------------------------------------------------------ 换版与对齐 */

export const DEPLOY_STRATEGIES = ['rename', 'copy'] as const
export const deployStrategySchema = z.enum(DEPLOY_STRATEGIES)
export type DeployStrategy = z.infer<typeof deployStrategySchema>

/**
 * 磁盘余量系数（方案书 §6.8 阶段 0：`磁盘剩余空间 ≥ 产物大小 × 2.2`）。
 *
 * 2.2 不是拍脑袋：同一时刻服务器上要同时存在 **暂存副本（1×）**、
 * **旧版本归档副本（1×）**，再留 0.2× 给 manifest、临时清单与文件系统元数据的
 * 抖动（大目录的 inode 与目录项本身也占空间）。
 */
export const DEPLOY_SPACE_FACTOR = 2.2

/**
 * 必需的可用空间（字节）。
 *
 * 刻意写成整数运算 `totalBytes * 22 / 10` 而不是 `totalBytes * 2.2`：
 * IEEE-754 下 `100 * 2.2 === 220.00000000000003`，`Math.ceil` 之后变成 **221**。
 * 多要 1 字节本身无害，但"100 字节的产物要 221 字节空间"是错的，
 * 而且会让单测里的边界断言（恰好相等）永远差 1，看起来像逻辑有 bug。
 */
export function requiredBytesFor(fields: { totalBytes: number }): number {
  const bytes = Math.max(0, Math.trunc(fields.totalBytes))
  return Math.ceil((bytes * 22) / 10)
}

/* -------------------------------------------------------------- 远端布局 */

/** 暂存目录前缀：`<父目录>/.sfvm-staging-<releaseId>`（方案书 §6.8 / 附录 C）。 */
export const STAGING_PREFIX = '.sfvm-staging-'

/** 跨机器互斥锁文件名（方案书 §6.8）。 */
export const LOCK_FILE_NAME = '.sfvm.lock'

/** 超过这个时长的锁视为陈旧（只提示，不自动删）。 */
export const LOCK_STALE_MS = 30 * 60 * 1000

/* ------------------------------------------------------------------ 入参 */

export const deployStartInputSchema = z.object({
  targetId: z.string().min(1),
  /** 发布备注（写进台账，方便日后回溯"这次为什么发"） */
  note: z.string().max(500).nullish(),
  /** 覆盖目标上的换版策略；不传则用目标配置 */
  strategy: deployStrategySchema.optional(),
  /**
   * 是否在换版后恢复目标的权限/属主（T10.9）。
   * 默认跟随目标的 `deploy_strategy` 之外**始终尝试**（记录失败仅告警），
   * 传 false 可显式关掉。
   */
  alignOwnership: z.boolean().optional(),
  /**
   * 残留清理确认（方案书 §6.8：「发布前若检测到远端同名残留，
   * 先提示用户确认清理」）。不传时一旦发现残留就拒绝发布。
   */
  confirmCleanResidue: z.boolean().optional(),
  /**
   * 确认清理**陈旧**的远端发布锁（> 30 分钟）。
   *
   * 与残留不同，锁必须单独确认：有锁意味着"可能真的有人在发布"，
   * 只是从时间上判断那人大概已经走了。自动删锁的风险远高于自动删暂存目录。
   */
  cleanStaleLock: z.boolean().optional()
})
export type DeployStartInput = z.infer<typeof deployStartInputSchema>

export const deployCancelInputSchema = z.object({ jobId: z.string().min(1) })
export type DeployCancelInput = z.infer<typeof deployCancelInputSchema>

export const deployPrecheckInputSchema = z.object({ targetId: z.string().min(1) })
export type DeployPrecheckInput = z.infer<typeof deployPrecheckInputSchema>

export const deployCleanResidueInputSchema = z.object({
  targetId: z.string().min(1),
  /** 只清理探测到的这些路径，避免调用方传任意路径进来当删除接口用 */
  paths: z.array(z.string().min(1)).max(50)
})
export type DeployCleanResidueInput = z.infer<typeof deployCleanResidueInputSchema>

/**
 * 残留清理的结果。
 *
 * 定义在契约里而不是服务里，因为它**跨 IPC**（preload / renderer 都要引用）。
 * `failed` 里的 `reason` 是给用户看的：清理失败不能让 UI 以为服务器已经干净了。
 */
export interface DeployResidueCleanResult {
  removed: string[]
  failed: Array<{ path: string; reason: string }>
}

/* -------------------------------------------------- 前置校验（阶段 0） */

export type PrecheckLevel = 'ok' | 'warn' | 'error'

export type PrecheckKey =
  | 'connection'
  | 'local-artifact'
  /**
   * 文件型目标：本地产物名与服务器端文件名不一致（B17）。
   *
   * 单独一项而不是并进 `local-artifact`：`PrecheckItem.key` 同时是列表渲染的 key，
   * 同一类不能出现两条；而且这一项**只可能是 warn** —— 发布不再因此失败
   * （阶段 1 会按配置里的文件名上传），它只回答"发上去以后叫什么名字"。
   */
  | 'file-name'
  | 'remote-target'
  | 'parent-writable'
  /**
   * 目标位于挂载点 / 与父目录跨设备（将退化成复制模式）。
   *
   * 与 `disk-space` 分开：`PrecheckItem.key` 同时是列表渲染的 key，两者在
   * `mode === 'full'` 时会同时出现，共用 one key 就是重复 key（L12）。
   */
  | 'filesystem'
  | 'disk-space'
  | 'residue'
  | 'lock'
  | 'active-release'

export interface PrecheckItem {
  key: PrecheckKey
  label: string
  level: PrecheckLevel
  detail: string
  suggestion?: string
  data?: Record<string, unknown>
}

/**
 * 本地产物的汇总（precheck 与"发布预览"共用同一份形状）。
 *
 * 提出来单独定义是刻意的：确认弹窗要把这两处的数据**画成同一块 UI**
 * （本地产物卡片 + 差异摘要）。两处各写一份形状，迟早出现"precheck 里叫
 * `newestMtime`、预览里叫 `mtime`"这种改名漂移，UI 就得写两套渲染。
 */
export interface ArtifactSummary {
  localPath: string
  kind: 'dir' | 'file'
  fileCount: number
  totalBytes: number
  rootHash: string
  /** 被 `local_exclude` 规则过滤掉的文件数 */
  excludedCount: number
  /** 跳过的符号链接数（不跟随，避免成环） */
  skippedSymlinks: number
  /** 本地最新 mtime 是否超过 24h（T11.2 的"产物可能过期"徽标数据源） */
  possiblyStale: boolean
  newestMtime: string | null
}

export interface DeployPrecheckReport {
  /** 无 error 级问题即可发布 */
  ok: boolean
  items: PrecheckItem[]
  /** 是否有需要用户确认才能继续的项（残留 / 陈旧锁） */
  needConfirm: boolean
  /** 探测到但不自动删除的远端残留路径 */
  residue: string[]
  /** 本地产物的汇总（full 模式且成功时才有值） */
  artifactSummary?: ArtifactSummary
}

/* ------------------------------------------------- 发布预览（B11 / T11.3） */

/**
 * "当前线上版本"查询（B13 后补）。
 *
 * ## 为什么单开一个通道，而不是继续用 `deploy.preview().lastVersionTag`
 *
 * `preview` 是**发布预览**：它要求目标配了本地产物路径，并且会为此算一次
 * **全量本地指纹**（几百 MB 的产物就是几百 MB 的读盘）。而"当前版本是哪个"
 * 只需要读一行台账 —— 把它挂在 preview 上有两个后果，都是实际踩到的：
 *
 * 1. **目标没配本地产物路径时**（比如只是接管一个既有目录），`preview` 直接抛
 *    `E_LOCAL_PATH_MISSING`，界面上的「当前版本」就变成"未知" —— 明明台账里有记录；
 * 2. **每次切到目标页都要 hash 一遍整个产物目录**，而这个数字与本地内容无关。
 */
export const deployCurrentVersionInputSchema = z.object({
  targetId: z.string().min(1)
})
export type DeployCurrentVersionInput = z.infer<typeof deployCurrentVersionInputSchema>

/**
 * 当前线上版本（纯台账口径：最近一次**成功操作**，发布或回滚都算）。
 *
 * `versionTag` 为 null 表示台账里没有任何成功记录（目标可能是手工建的）。
 * 注意它**不反映服务器现状** —— 用户可能手工改过目标目录；要判断那个得连服务器
 * 现算指纹（那是 `precheck` 的事）。
 */
export const deployCurrentVersionSchema = z.object({
  versionTag: z.string().nullable(),
  /** 'deploy' | 'rollback' */
  action: z.string().nullable(),
  /** 那次操作的成功时间 */
  at: z.string().nullable(),
  fileCount: z.number().int().min(0),
  totalBytes: z.number().int().min(0)
})
export type DeployCurrentVersion = z.infer<typeof deployCurrentVersionSchema>

export const deployPreviewInputSchema = z.object({
  targetId: z.string().min(1),
  /** 每类差异最多列多少条路径（计数永远准确，列表可截断）。默认 200 */
  limit: z.number().int().min(1).max(2000).optional()
})
export type DeployPreviewInput = z.infer<typeof deployPreviewInputSchema>

/**
 * 发布差异（相对**上一次成功发布**的清单）。
 *
 * 三类与 B07 远端校验同源（`diffByHashes`），只是换了视角：
 * `extra` → 新增、`mismatch` → 修改、`missing` → 删除、`matchedCount` → 未变。
 */
export interface PublishDiff {
  /** 本地有、上次发布没有 */
  added: string[]
  /** 两边都有、内容不同 */
  modified: string[]
  /** 上次发布有、本地没有（发布会让它们从服务器上消失） */
  deleted: string[]
  unchangedCount: number
  counts: { added: number; modified: number; deleted: number; unchanged: number }
  /** 是否有分类因为超过上限而只给了计数 */
  truncated: boolean
  /** 上次发布没有逐文件清单可比（首次发布 / 上版清单缺失） */
  firstPublish: boolean
  /** 上次成功发布的版本号（`firstPublish` 为 true 时为 null） */
  previousVersionTag: string | null
}

/**
 * 发布确认弹窗需要的全部信息。
 *
 * 与 precheck 分开的理由：precheck 是"能不能发"的清单（也要给体检用），
 * 而这里是"发出去会变成什么样"（要额外算一次本地指纹与差异，代价更高），
 * 只在用户**真的按了发布**时才值得算。
 */
export interface DeployPreview {
  targetId: string
  /** 本地产物汇总（含本地指纹） */
  artifact: ArtifactSummary
  diff: PublishDiff
  /** 上次成功发布的版本号（`diff.previousVersionTag` 的直读副本）；从未成功发布过为 null */
  lastVersionTag: string | null
  /** 目标是否配了保留策略（弹窗里提示"发完之后会自动清理"） */
  retainPolicyText: string | null
}

/* ------------------------------------------------------------ 发布结果 */

export interface DeployFailure {
  /** 失败发生在哪个阶段 */
  stage: number
  stageText: string
  code: string
  message: string
  hint?: string
  /** 补偿动作的执行情况（补偿失败必须让用户看见，不能吞掉） */
  compensations: Array<{ action: string; ok: boolean; detail?: string }>
  /** 需要用户手动处理的残留（如 copy 模式的 `.old-*`） */
  manualCleanup?: string[]
}

export interface DeployOutcome {
  ok: boolean
  releaseId: string
  targetId: string
  versionTag: string
  status: ReleaseStatus
  /** 归档走的版本号（阶段 4 成功时才有），B12 的"往期版本"会看到它 */
  archivedVersionTag?: string
  strategy: DeployStrategy
  /** 实际是否发生了 rename→copy 的回退（供 UI 提示"耗时较长"） */
  strategyFallback?: { from: 'rename'; to: 'copy'; reason: string }
  rootHash: string
  fileCount: number
  totalBytes: number
  durationMs: number
  /** 权限/属主对齐的执行结果（失败仅告警，不影响成功判定） */
  alignment?: Array<{ action: 'chmod' | 'chown'; ok: boolean; detail?: string }>
  failure?: DeployFailure
}

/* ------------------------------------------------------------ 锁与残留 */

export interface RemoteLockInfo {
  releaseId: string
  hostname: string
  pid: number
  /** ISO-8601 */
  ts: string
  /** 锁是否已陈旧（> 30 分钟）——陈旧也只是提示，不自动删 */
  stale: boolean
  /** 锁文件所在的绝对路径 */
  path: string
}

/**
 * 锁载荷 schema。
 *
 * 解析失败时**不报错**，返回 null 由调用方决定：一个内容坏掉的锁文件
 * 不应该让"发布"整个不可用（它是被别人/别的工具写坏的可能性很小，
 * 更可能是我们的旧版本写的）。调用方会把"锁文件存在但读不懂"作为 warn 呈现。
 */
export const remoteLockSchema = z.object({
  releaseId: z.string().min(1),
  hostname: z.string(),
  pid: z.number().int().min(0),
  ts: z.string().min(1)
})
export type RemoteLockPayload = z.infer<typeof remoteLockSchema>
