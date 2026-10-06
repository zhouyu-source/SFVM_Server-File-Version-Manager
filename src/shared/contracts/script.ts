/**
 * 自定义脚本的跨进程契约（B20 = 脚本执行底座；B21 = 多步骤流水线）。
 *
 * ## 一句话模型
 *
 * 一次「运行记录」（run）包含**一到多个步骤**（step），每个步骤要么在**本机**执行，
 * 要么在**服务器**执行。B20 只会产生"一个步骤"的记录（目标页跑单条脚本），
 * B21 的流水线才有多步。两张表从 B20 就一起建，是为了 B21 不必改表。
 *
 * ## 为什么运行记录必须落库
 *
 * 方案书 §6.11 明确"任务不进数据库"，而且任务框架**不保留 `run()` 的返回值**
 * （`channels.ts` 里记着 B11 的教训）。可"上一次那步到底成没成、退出码是多少、
 * 输出了什么"恰恰是用户唯一想看的东西 —— 进程一重启，任务框架就失忆了。
 * 所以运行记录单独落库，`script_runs` / `script_step_runs` 是回答这个问题的**唯一**来源。
 *
 * ## 为什么输出要"全量落文件 + 库内只存尾部"
 *
 * 一次 `mvn package` 的输出动辄几万行。整段写进 SQLite 会让台账库膨胀、
 * 在线备份变慢；而只存尾部又会在排查时丢掉最该看的前半段（编译错误通常在开头）。
 * 折中：完整输出写到 `<数据目录>/log/script-runs/<runId>/<seq>.log`（单步设体积上限），
 * 库里只留最后若干行做摘要与快速预览。
 */
import { z } from 'zod'

/* ------------------------------------------------------------ 步骤类型 */

/** 步骤在哪执行。 */
export const SCRIPT_KINDS = ['local', 'remote'] as const
export const scriptKindSchema = z.enum(SCRIPT_KINDS)
export type ScriptKind = z.infer<typeof scriptKindSchema>

export const SCRIPT_KIND_LABELS: Record<ScriptKind, string> = {
  local: '本机执行',
  remote: '服务器执行'
}

/* -------------------------------------------------------- 本地解释器 */

/**
 * 本机可用的脚本解释器。
 *
 * **刻意没有 cmd.exe**：批处理在引号、`%` 展开、错误码与编码上到处都是坑，
 * 同样的脚本在 PowerShell / Git Bash 里行为可预期得多。这不是能力取舍，
 * 而是"少一个必然出问题的选项"。
 *
 * 注意这**不是**"命令白名单"：脚本内容是由用户填写的自由文本，这一点与
 * `infra/remote-exec.ts` 那套"调用方永远不能提供命令字符串"的内部通道是
 * **两条完全不同的路**（见 `services/script-runner.ts` 文件头的说明）。
 */
export const LOCAL_SHELLS = ['powershell', 'gitbash'] as const
export const localShellSchema = z.enum(LOCAL_SHELLS)
export type LocalShell = z.infer<typeof localShellSchema>

export const LOCAL_SHELL_LABELS: Record<LocalShell, string> = {
  powershell: 'PowerShell',
  gitbash: 'Git Bash'
}

/* ---------------------------------------------------------------- 限额 */

/**
 * 默认超时：5 分钟。
 *
 * 取值理由：本地构建（`mvn package`）常见几分钟量级，而"没有超时的子进程"
 * 一旦卡住就再也不会结束 —— 用户只能杀整个应用。宁可默认短一点、让用户显式调大。
 */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 300_000
export const SCRIPT_TIMEOUT_MIN_MS = 1000
/** 上限 1 小时：再长就该考虑"放到服务器后台跑"而不是等在前台。 */
export const SCRIPT_TIMEOUT_MAX_MS = 3_600_000

/** 脚本文本上限（字符）。够写一段几百行的构建脚本，又不至于让 IPC 载荷失控。 */
export const SCRIPT_MAX_LENGTH = 20_000

/** 单个步骤落盘的输出上限（字节），超出后停止写入并留一行"已截断"。 */
export const STEP_LOG_MAX_BYTES = 8 * 1024 * 1024

/** 库内保留的输出尾部：行数与字符数**两个上限都要**（单行超长时按字符兜住）。 */
export const STEP_TAIL_MAX_LINES = 200
export const STEP_TAIL_MAX_CHARS = 32 * 1024

/** 往期运行记录的默认条数上限。 */
export const DEFAULT_SCRIPT_RUN_LIST_LIMIT = 50

/* ------------------------------------------------------------ 运行状态 */

export const SCRIPT_RUN_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const
export const scriptRunStatusSchema = z.enum(SCRIPT_RUN_STATUSES)
export type ScriptRunStatus = z.infer<typeof scriptRunStatusSchema>

export const SCRIPT_RUN_STATUS_TEXT: Record<ScriptRunStatus, string> = {
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消'
}

export function describeScriptRunStatus(status: ScriptRunStatus): string {
  return SCRIPT_RUN_STATUS_TEXT[status] ?? status
}

export function scriptRunStatusTagType(
  status: ScriptRunStatus
): 'info' | 'primary' | 'success' | 'danger' {
  switch (status) {
    case 'running':
      return 'primary'
    case 'succeeded':
      return 'success'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'info'
  }
}

/* -------------------------------------------------------------- 能力 */

export const localShellAvailabilitySchema = z.object({
  shell: localShellSchema,
  /** 本机是否真的找到了它的可执行文件 */
  available: z.boolean(),
  /** 找到的路径（`available` 为假时是 null）—— 展示给用户看"用的是哪一个" */
  exePath: z.string().nullable()
})
export type LocalShellAvailability = z.infer<typeof localShellAvailabilitySchema>

/**
 * 「脚本」区块要渲染成什么样，由这一份决定。
 *
 * 有意让渲染进程**不知道**解释器在哪：路径由主进程探测并在设置项里可覆盖，
 * 渲染进程只拿"有没有"与"默认用哪个"。
 */
export const scriptCapabilitiesSchema = z.object({
  /** 总闸：关着时整块 UI 只显示"怎么打开" */
  allowUserScripts: z.boolean(),
  shells: z.array(localShellAvailabilitySchema),
  /** 默认选中的解释器；一个都没找到时为 null */
  defaultShell: localShellSchema.nullable()
})
export type ScriptCapabilities = z.infer<typeof scriptCapabilitiesSchema>

/* ------------------------------------------------------------ 入参契约 */

/**
 * 跑一条脚本（B20 的单步入口）。
 *
 * `cwd` 只对本机步骤有意义：远端步骤请自己在脚本里 `cd`。
 * 让渲染进程传远端相对目录再拼进命令，等于在类型层面重新开了一个注入面 ——
 * 而这条通道本来就允许用户执行任意命令，没必要再引入一个"半可信"的字段。
 */
export const scriptRunStepInputSchema = z.object({
  targetId: z.string().min(1),
  kind: scriptKindSchema,
  /** 步骤名，只用于展示；不填时按类型给一个默认名 */
  name: z.string().min(1).max(120).optional(),
  script: z.string().min(1).max(SCRIPT_MAX_LENGTH),
  /** 仅 `kind === 'local'` 时使用；不填则用能力探测给出的默认值 */
  shell: localShellSchema.optional(),
  /** 仅本机步骤使用 */
  cwd: z.string().min(1).max(1024).nullable().optional(),
  timeoutMs: z
    .number()
    .int()
    .min(SCRIPT_TIMEOUT_MIN_MS)
    .max(SCRIPT_TIMEOUT_MAX_MS)
    .optional()
})
export type ScriptRunStepInput = z.infer<typeof scriptRunStepInputSchema>

export const scriptRunListInputSchema = z.object({
  targetId: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional()
})
export type ScriptRunListInput = z.infer<typeof scriptRunListInputSchema>

export const scriptRunDetailInputSchema = z.object({ runId: z.string().min(1) })
export type ScriptRunDetailInput = z.infer<typeof scriptRunDetailInputSchema>

/* ------------------------------------------------------------ 视图契约 */

export const scriptStepRunViewSchema = z.object({
  stepRunId: z.string().min(1),
  runId: z.string().min(1),
  /** 1 起，与流水线里的步骤顺序一致（B20 恒为 1） */
  seq: z.number().int().min(1),
  name: z.string(),
  kind: scriptKindSchema,
  /** 本机步骤用的解释器；远端步骤为 null */
  shell: localShellSchema.nullable(),
  status: scriptRunStatusSchema,
  /** 进程退出码；`null` = 没拿到（超时被杀、连接断开等） */
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  /** 完整输出写到了哪个文件；为 null 表示这次没有落盘 */
  outputPath: z.string().nullable(),
  outputBytes: z.number().int().min(0),
  /** 单步输出超过上限、后续内容没落盘 */
  truncated: z.boolean(),
  /** 库内保留的输出尾部（最后若干行） */
  outputTail: z.string().nullable(),
  errorMessage: z.string().nullable()
})
export type ScriptStepRunView = z.infer<typeof scriptStepRunViewSchema>

export const scriptRunViewSchema = z.object({
  runId: z.string().min(1),
  targetId: z.string().min(1),
  /**
   * 跑它的任务 id。
   *
   * 用户从底部任务台看到的 `jobId`、与从「运行记录」看到的 `runId` 不是同一个值 ——
   * 所以两个都要给出去，排障时才能对上号（`jobId` 用于取消，`runId` 用于查留档）。
   */
  jobId: z.string().min(1),
  /** B20 恒为 `step`；B21 的流水线是 `pipeline` */
  trigger: z.enum(['step', 'pipeline']),
  title: z.string(),
  status: scriptRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** 谁发起的（目前是本机 hostname）—— 多人共用一台机器时有用 */
  operator: z.string().nullable(),
  errorMessage: z.string().nullable(),
  steps: z.array(scriptStepRunViewSchema)
})
export type ScriptRunView = z.infer<typeof scriptRunViewSchema>

/* -------------------------------------------------------------- 纯工具 */

/**
 * 把可选超时补成合法值。
 *
 * 越界不抛错而是**钳到区间**：这是个"填错了也不该拦着用户"的数字，
 * 而 schema 已经负责在 IPC 层拦掉真正的垃圾值（负数、字符串、超大数）。
 */
export function clampScriptTimeout(ms?: number | null): number {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return DEFAULT_SCRIPT_TIMEOUT_MS
  return Math.min(SCRIPT_TIMEOUT_MAX_MS, Math.max(SCRIPT_TIMEOUT_MIN_MS, Math.round(ms)))
}

/** 渲染进程与主进程共用的默认步骤名。 */
export function defaultStepName(kind: ScriptKind): string {
  return kind === 'local' ? '本机脚本' : '服务器脚本'
}
