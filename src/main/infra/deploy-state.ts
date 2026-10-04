/**
 * 发布状态机的**校验**部分（T10.1）。
 *
 * 迁移表本身放在 `shared/contracts/deploy.ts`（两端共用），这里只负责
 * "拿表来判 + 把非法迁移炸掉"，避免主进程里到处写 `if (status === ...)`。
 *
 * ## 为什么要有一个显式的状态机
 *
 * 发布是本项目唯一会**改动生产服务器**的流程。历史上出过的事故形态几乎都是
 * "某一步在错误的状态下被执行了"：目标被归档走了却没人换版、暂存没删就报成功、
 * 归档失败还被当成成功继续换版。把这些顺序约束写成一张表，好处是：
 * - 代码写错顺序时**当场抛错**，而不是"看起来跑完了但服务器状态不对"；
 * - 单测可以穷举 8×8 的组合，不需要真连服务器；
 * - 事后能从台账的 status 序列反推"它走到哪一步断的"。
 */
import { AppError, ErrorCode } from './errors'
import {
  DEPLOY_STATE_TRANSITIONS,
  DEPLOY_STAGES,
  isTerminalReleaseStatus,
  type ReleaseStatus
} from '../../shared/contracts/deploy'

/** 迁移是否合法。 */
export function canTransition(from: ReleaseStatus, to: ReleaseStatus): boolean {
  return (DEPLOY_STATE_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * 校验一次迁移；非法则抛 `E_DEPLOY_STAGE_FAILED`。
 *
 * 用同一个错误码而不是新造一个：走到这里说明**代码里的阶段顺序与状态不符**，
 * 对用户而言表现就是"发布流程中断"，提示语（"远端已回滚到发布前状态"）也适用。
 * 但 `detail` 里会带上 from/to，让日志能直接定位。
 */
export function assertTransition(from: ReleaseStatus, to: ReleaseStatus): void {
  if (canTransition(from, to)) return
  const allowed = DEPLOY_STATE_TRANSITIONS[from] ?? []
  throw new AppError(
    ErrorCode.E_DEPLOY_STAGE_FAILED,
    { from, to, allowed },
    {
      message: `发布状态非法迁移：${from} → ${to}`,
      hint:
        allowed.length === 0
          ? `${from} 是终态，不能继续迁移；若需重试请新建一次发布。`
          : `允许的下一步是：${allowed.join(' / ')}。`
    }
  )
}

/** 某状态下允许的下一步（UI 据此决定按钮的可用性）。 */
export function allowedTransitions(from: ReleaseStatus): readonly ReleaseStatus[] {
  return DEPLOY_STATE_TRANSITIONS[from] ?? []
}

/** 由阶段号取它应处于的状态。 */
export function statusOfStage(stage: number): ReleaseStatus {
  const def = DEPLOY_STAGES.find((s) => s.index === stage)
  if (!def) {
    throw new AppError(ErrorCode.E_PARAM, { stage }, { message: `未知的发布阶段：${stage}` })
  }
  return def.status
}

/** 由阶段号取它的中文名（日志/错误文案用）。 */
export function stageText(stage: number): string {
  return DEPLOY_STAGES.find((s) => s.index === stage)?.text ?? `阶段 ${stage}`
}

/** 该阶段是否会改动远端（决定失败时要不要去远端做补偿）。 */
export function stageMutatesRemote(stage: number): boolean {
  return DEPLOY_STAGES.find((s) => s.index === stage)?.mutatesRemote ?? false
}

export { isTerminalReleaseStatus }
