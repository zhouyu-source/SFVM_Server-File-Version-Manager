/**
 * 「这个目标上已经有任务在跑了」的统一守卫（B21 / T21.7）。
 *
 * ## 为什么要有这么一个小文件
 *
 * 发布、回滚、脚本、流水线、删往期版本这几个入口**各自都写过一遍**这段判断，
 * 而且每个的过滤条件都不一样（有的只看 `type === 'deploy'`，有的看
 * `deploy | rollback`，有的看任意类型）。结果是同一种冲突在不同入口有不同的
 * 说法与宽严：
 *
 * - 跑到流水线的"发布"那一环时点「发布」，收不到"这个目标正在忙"，
 *   而是排进队列 —— 表现为"点了发布没反应，过一会儿突然开始发"；
 * - 脚本在跑时点「发布」同样会被静默排队，而这两件事都动同一个目标。
 *
 * 现在统一成一句话：**同一目标上同时只允许一个任务**。
 * 这不是新增限制，而是把原本已经成立的现实（任务框架按 `t:<targetId>` 分车道、
 * 同车道串行 → 本来就得排队）**明说出来**：与其让用户等一个看不见的队列，
 * 不如当场告诉他"谁在跑、去哪儿取消"。
 *
 * ## 为什么文案里要带上"正在跑的那个任务"
 *
 * 只说"目标忙"用户会一头雾水（界面上并没有"忙"这个状态）。带上任务标题之后，
 * 用户能立刻对上底部任务控制台里那一行，也知道该去取消谁。
 */
import { AppError, ErrorCode } from '../infra/errors'
import type { JobService } from '../services/job'
import type { JobView } from '../../shared/contracts/job'

/** 该目标上正在跑（或排队）的那个任务；没有则返回 `undefined`。 */
export function activeJobForTarget(jobs: JobService, targetId: string): JobView | undefined {
  // `activeForTarget` 自己已经排除了终态，这里不再重复过滤
  return jobs.activeForTarget(targetId)[0]
}

export interface TargetIdleOptions {
  /** 用户正想做的那件事，会拼进文案："不能同时<action>" */
  action: string
  /** 覆盖默认建议（例如删往期版本的场景更适合说"等它结束后再删"） */
  hint?: string
}

/**
 * 目标上有任务在跑就抛 `E_TARGET_BUSY`，否则什么都不做。
 *
 * 抛错而不是排队：这些操作（发布、回滚、脚本）每一个都可能"跑两遍就坏"
 * （发布多一版台账、脚本把服务重启两次），把"手滑点两次"变成"真的跑两遍"
 * 是不可接受的。而"确实想再来一次"的用户，等几秒再点是几乎没有成本的。
 */
export function assertTargetIdle(
  jobs: JobService,
  targetId: string,
  opts: TargetIdleOptions
): void {
  const active = activeJobForTarget(jobs, targetId)
  if (!active) return
  throw new AppError(
    ErrorCode.E_TARGET_BUSY,
    { targetId, jobId: active.jobId, type: active.type, title: active.title },
    {
      message: `该目标上正在进行「${active.title}」，不能同时${opts.action}`,
      hint: opts.hint ?? '请等它结束，或先在底部任务控制台取消它。'
    }
  )
}
