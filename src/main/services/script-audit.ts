/**
 * 脚本 / 流水线执行的审计写入（B20/B21 共同的安全约定第 6 条）。
 *
 * ## 为什么"运行记录"之外还要审计
 *
 * `script_runs` 回答的是**"这一步成没成、退出码多少"** —— 它是给当事人自己看的。
 * 审计要回答的是另一件事：**"谁、在什么时候、对着哪台机器、做了什么"**。
 * 这是全应用唯一"用户填什么就执行什么"的功能，多人共用一个发布账号时，
 * 能查的只有审计日志。两者都留，因为问题不同。
 *
 * ## 为什么单独一个模块
 *
 * 两处调用点（单条脚本、流水线）如果各写一遍，迟早出现"一处记了 targetId、
 * 另一处忘了"这种偏移 —— 而审计记录字段不齐，恰恰是它最没用的时候。
 *
 * ## detail 必须已脱敏
 *
 * 审计日志与运行记录一样会进用户反馈的诊断包，而失败信息里经常夹着连接串与
 * token。所以这里**由本模块统一过 `scrubText`**，不给调用方"自己决定要不要脱敏"
 * 的机会（与 `services/script.ts` 里"先脱敏再切行"是同一条纪律）。
 */
import { scrubText } from '../infra/log-redact'
import type { Repositories } from '../db/repositories'
import type { ScriptRunStatus } from '../../shared/contracts/script'

/** 审计里的 scope 取值。库里是 TEXT，这里只是唯一一处口径。 */
export const SCRIPT_AUDIT_SCOPE = 'script'

function write(repo: Repositories, level: 'info' | 'warn', refId: string, message: string, detail: unknown): void {
  repo.audit.write({
    level,
    scope: SCRIPT_AUDIT_SCOPE,
    refId,
    message,
    // 整段 JSON 过一遍：单独给某个字段脱敏，迟早漏掉新加的字段
    detail: scrubText(JSON.stringify(detail))
  })
}

export interface AuditRunStarted {
  runId: string
  targetId: string
  jobId: string
  /** 运行记录的标题（「脚本「关服务」」/「流水线「一键发版」」），一眼看出干了什么 */
  title: string
  /** 流水线才有；单条脚本传 null */
  pipelineId: string | null
  steps: number
}

export function auditRunStarted(repo: Repositories, a: AuditRunStarted): void {
  write(repo, 'info', a.runId, `开始执行：${a.title}`, {
    targetId: a.targetId,
    jobId: a.jobId,
    pipelineId: a.pipelineId,
    steps: a.steps,
    trigger: a.pipelineId ? 'pipeline' : 'step'
  })
}

export interface AuditRunFinished {
  runId: string
  targetId: string
  title: string
  status: ScriptRunStatus
  errorMessage: string | null
}

/**
 * 记结束。
 *
 * 结束这条至少与开始那条一样重要 —— "跑了但不知道结果"的审计记录等于没记。
 * 失败/取消记 `warn`，这样审计列表里一眼能挑出来，不必逐条读 message。
 */
export function auditRunFinished(repo: Repositories, a: AuditRunFinished): void {
  write(
    repo,
    a.status === 'succeeded' ? 'info' : 'warn',
    a.runId,
    `${a.title}：${a.status === 'succeeded' ? '成功' : a.status === 'cancelled' ? '已取消' : '失败'}`,
    {
      targetId: a.targetId,
      status: a.status,
      errorMessage: a.errorMessage
    }
  )
}
