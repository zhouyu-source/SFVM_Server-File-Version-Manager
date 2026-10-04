/**
 * 回滚（RollbackService）的跨进程契约（B13 / T13.1 ~ T13.5）。
 *
 * ## 回滚是什么
 *
 * "把某个往期版本恢复成当前版本，**且当前版本不丢失**"（计划书 B13 目标）。
 * 后半句是关键：回滚不是"把归档覆盖到目标上"，而是
 *
 * ```
 * 当前版本 ──归档──> 版本库      （先腾空目标，与发布阶段 4 同一个动作）
 * 所选归档 ──就位──> 目标路径    （再换上去）
 * ```
 *
 * 所以它和发布**共用同一套原语**（归档 / 换版 / 锁 / 权限恢复），只是方向相反。
 * 也正因为共用，两者必须抢**同一把锁**（见 `infra/deploy-lock.ts`）。
 *
 * ## 与 `ArchiveService.undoArchive()` 的区别（别混）
 *
 * `undoArchive` 是**发布失败的补偿**：把刚归档的旧版本搬回目标，然后把那条归档
 * 记录彻底删掉（那次发布当作没发生过）。
 *
 * 回滚不一样：被回滚到的那个版本**去留由用户决定** ——
 * 默认保留（用户可能还想滚回去），此时必须**复制**而不是搬走；
 * 选"删除来源"时才等价于 `undoArchive` 的行为。
 * 这个耦合（保留 → copy / 删除 → rename）是硬绑定，不暴露成两个独立开关：
 * 允许"rename + 保留"会让归档目录当场少掉 payload，台账与磁盘对不上。
 */
import { z } from 'zod'

/* ------------------------------------------------------------------ 阶段 */

export interface RollbackStageDef {
  /** 0 = 前置校验，1..6 与发布的阶段编号对齐（进度条与日志都按它渲染） */
  index: number
  text: string
  /** 该阶段是否会改动远端（失败时据此判断"要不要去远端收拾"） */
  mutatesRemote: boolean
}

/**
 * 回滚的 7 个阶段。
 *
 * 刻意与 `DEPLOY_STAGES` **同构但不同文案**：发布的"上传到暂存目录"在回滚里
 * 变成"校验归档"，"计算本地指纹"变成"恢复所选版本"。
 * 编号对齐（0..6）让两个流程的失败语义可以互相参照（"阶段 3 失败 = 目标可能是空的"）。
 */
export const ROLLBACK_STAGES: readonly RollbackStageDef[] = [
  { index: 0, text: '前置校验', mutatesRemote: false },
  { index: 1, text: '校验归档完整性', mutatesRemote: false },
  { index: 2, text: '归档当前版本', mutatesRemote: true },
  { index: 3, text: '恢复所选版本', mutatesRemote: true },
  { index: 4, text: '恢复权限', mutatesRemote: true },
  { index: 5, text: '写入台账', mutatesRemote: false },
  { index: 6, text: '收尾', mutatesRemote: true }
] as const

export const ROLLBACK_STAGE_COUNT = ROLLBACK_STAGES.length

/** 每个阶段占进度条的区间（与发布同样按"阶段编号"插值）。 */
export const ROLLBACK_STAGE_PROGRESS: Readonly<Record<number, { from: number; to: number }>> = {
  0: { from: 0, to: 5 },
  1: { from: 5, to: 45 },
  2: { from: 45, to: 65 },
  3: { from: 65, to: 90 },
  4: { from: 90, to: 95 },
  5: { from: 95, to: 97 },
  6: { from: 97, to: 100 }
}

export function rollbackStageText(index: number): string {
  return ROLLBACK_STAGES[index]?.text ?? `阶段 ${index}`
}

/* ------------------------------------------------------------------ 入参 */

/**
 * 回滚入参。
 *
 * `keepSource` 的语义是**用户的**（"这个版本还要不要留在版本库里"），
 * 它同时决定了搬运方式（copy / rename）—— 见文件头的说明，两者是绑定的。
 */
export const rollbackStartInputSchema = z.object({
  targetId: z.string().min(1),
  /** 要回滚到的往期版本（`archives.id`） */
  archiveId: z.string().min(1),
  /** 保留来源版本（默认 true）。false = 搬走后删掉归档目录与台账行 */
  keepSource: z.boolean().optional(),
  /** 跳过归档完整性校验（T13.2 的"快速回滚"）。默认 false */
  skipVerify: z.boolean().optional(),
  /** 已确认可以清理陈旧锁 */
  cleanStaleLock: z.boolean().optional(),
  /** 是否恢复目标权限/属主（默认 true） */
  alignOwnership: z.boolean().optional(),
  note: z.string().max(500).nullable().optional()
})
export type RollbackStartInput = z.infer<typeof rollbackStartInputSchema>

export const rollbackPreviewInputSchema = z.object({
  targetId: z.string().min(1),
  archiveId: z.string().min(1)
})
export type RollbackPreviewInput = z.infer<typeof rollbackPreviewInputSchema>

/* ------------------------------------------------------------ 对比预览 */

/**
 * 对比的一侧（当前版本 / 目标版本）。
 *
 * `origin` 告诉用户这个数字**是从哪来的** —— 台账口径的"当前版本"记录的是
 * 那次操作时的快照，用户完全可能在两次发布之间手工往目标目录塞过东西。
 * 不标来源就等于把台账数字冒充成"服务器现状"，那是在撒谎。
 */
export const rollbackSideSchema = z.object({
  versionTag: z.string(),
  rootHash: z.string().nullable(),
  totalBytes: z.number().int().min(0),
  fileCount: z.number().int().min(0),
  /** 时间（归档时间 / 那次操作的成功时间），带本地时区偏移 */
  at: z.string().nullable(),
  /** 这个数字的来源：`release` = 台账里某次操作的记录；`archive` = 归档行的记录 */
  origin: z.enum(['release', 'archive'])
})
export type RollbackSide = z.infer<typeof rollbackSideSchema>

export const rollbackPreviewSchema = z.object({
  targetId: z.string(),
  targetName: z.string(),
  remotePath: z.string(),
  kind: z.enum(['dir', 'file']),
  /** 当前线上版本（台账最近一次成功操作）。台账里找不到时为 null */
  current: rollbackSideSchema.nullable(),
  /** 要回滚到的版本（来自归档行，**不需要连服务器**） */
  target: rollbackSideSchema.extend({
    archiveId: z.string(),
    status: z.enum(['valid', 'missing', 'corrupt'])
  }),
  /**
   * 需要用户看见的提醒。
   *
   * 与"错误"不同：这里有内容就说明**操作仍然可以进行**，只是用户该知道
   * （比如"归档上次校验是损坏状态"、"台账里没有当前版本的记录"）。
   */
  warnings: z.array(z.string())
})
export type RollbackPreview = z.infer<typeof rollbackPreviewSchema>

/* ------------------------------------------------------------------ 结果 */

export const rollbackCompensationSchema = z.object({
  /** 补偿动作名，如 `undo-archive`（把刚归档的当前版本搬回去） */
  action: z.string(),
  ok: z.boolean(),
  detail: z.string().optional()
})

export const rollbackFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  /** 失败时做了哪些补偿（"此刻目标是空的，用户还剩什么"的答案） */
  compensations: z.array(rollbackCompensationSchema)
})
export type RollbackFailure = z.infer<typeof rollbackFailureSchema>

export const rollbackOutcomeSchema = z.object({
  ok: z.boolean(),
  /** 台账行 id（= 任务 id） */
  rollbackId: z.string(),
  targetId: z.string(),
  /** 回滚到的版本号 */
  versionTag: z.string(),
  /** 回滚前的当前版本被归档成了什么（目标原本不存在时没有） */
  archivedVersionTag: z.string().optional(),
  /** 搬运方式：`copy` = 保留了来源版本；`rename` = 来源已被搬走 */
  moveMode: z.enum(['rename', 'copy']),
  /** 是否真的做过完整性校验（false = 用户选了快速回滚） */
  verified: z.boolean(),
  durationMs: z.number().int().min(0),
  failure: rollbackFailureSchema.optional()
})
export type RollbackOutcome = z.infer<typeof rollbackOutcomeSchema>

/** 快速回滚（跳过校验）时给用户的风险提示 —— 界面与日志用同一份文案。 */
export const ROLLBACK_SKIP_VERIFY_WARNING =
  '已跳过完整性校验：若归档内容在服务器上被改动过，回滚会把改动后的内容直接换上线。' +
  '只有在归档刚校验通过、且你确信服务器上没人动过它时，才该这么做。'
