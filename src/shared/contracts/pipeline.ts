/**
 * 自动化流水线的跨进程契约（B21）。
 *
 * ## 一句话模型
 *
 * 一条「流水线」属于**一个目标**，由**有序步骤**组成。每个步骤要么在本机执行、
 * 要么在服务器执行、要么是**一次发布**。既能一键跑完整条，也能只跑其中一步。
 *
 * 用户给的原型就是这条：`①构筑 JAR（本机）→ ②关服务（服务器）→ ③发布 jar → ④启服务（服务器）`。
 *
 * ## 为什么发布要单独一个步骤类型，而不是"让用户写一条 deploy 命令"
 *
 * 用户在步骤里当然可以自己敲 `rsync`，但那样就没有版本库、没有回滚、没有校验。
 * 「发布」是应用已经实现好的两阶段提交换版流程，作为流水线的一环应当**复用**它，
 * 而不是让用户用脚本重新实现一遍。所以 `kind === 'deploy'` 的步骤没有 `script`
 * 字段 —— 它不是"一段文本交给 shell"，而是一次内部服务调用。
 *
 * ## 一条流水线最多一个「发布」步骤
 *
 * 发布要写 `releases` 台账、要占 `.sfvm-staging-<releaseId>` 暂存目录，而
 * `releaseId` 取的是任务 id（"任务的 id 就是台账行的 id"，见 `ipc/deploy.ts`）。
 * 一条流水线里放两个发布步骤，第二个就会撞上第一个的暂存目录与台账 id。
 * 而"对同一个目标连发两版"本身也没有意义 —— 所以直接在契约层禁掉，
 * 让它在"存下来的那一刻"就失败，而不是等跑到一半才莫名其妙地报错。
 *
 * ## 刻意没做的两件事（写在这里，免得下一个人以为是漏了）
 *
 * 1. **步骤级环境变量**：`JAVA_HOME` 这类需求在脚本里写一行
 *    （`$env:JAVA_HOME='...'` / `export JAVA_HOME=...`）就解决了，而把一个
 *    `env` 字段做成流水线级的公共设施，要额外面对"值里带引号/带换行怎么转义"。
 *    收益是少写一行，代价是一个新的转义面 —— 不值。
 * 2. **执行中暂停确认**：要真做，要么用主进程原生模态框（真窗口 E2E 驱动不了，
 *    等于这个特性永远测不到），要么新开一整套"任务反问界面"的双向通道。
 *    一个可选步骤付一整套通道的代价太大。取而代之：**跑整条一律先确认**
 *    （对话框里列全步骤与远端影响），生产环境还要逐字输入目标名（见下）。
 */
import { z } from 'zod'
import {
  SCRIPT_MAX_LENGTH,
  SCRIPT_TIMEOUT_MAX_MS,
  SCRIPT_TIMEOUT_MIN_MS,
  localShellSchema,
  type LocalShell
} from './script'

/* ------------------------------------------------------------ 步骤类型 */

export const PIPELINE_STEP_KINDS = ['local', 'remote', 'deploy'] as const
export const pipelineStepKindSchema = z.enum(PIPELINE_STEP_KINDS)
export type PipelineStepKind = z.infer<typeof pipelineStepKindSchema>

export const PIPELINE_STEP_KIND_LABELS: Record<PipelineStepKind, string> = {
  local: '本机执行',
  remote: '服务器执行',
  deploy: '发布'
}

/** 这一步是"填脚本"还是"调用内部的发布流程" —— UI 据此切换表单。 */
export function stepNeedsScript(kind: PipelineStepKind): boolean {
  return kind !== 'deploy'
}

/* ------------------------------------------------------------ 失败策略 */

export const PIPELINE_ON_FAILURES = ['stop', 'continue'] as const
export const pipelineOnFailureSchema = z.enum(PIPELINE_ON_FAILURES)
export type PipelineOnFailure = z.infer<typeof pipelineOnFailureSchema>

export const PIPELINE_ON_FAILURE_LABELS: Record<PipelineOnFailure, string> = {
  stop: '终止整条',
  continue: '继续往下跑'
}

/* ---------------------------------------------------------------- 限额 */

/**
 * 步骤数上限。
 *
 * 20 是个"够用且不至于让确认对话框变成一堵墙"的数：用户的原型是 4 步，
 * 复杂一点的发布流程也就 8~10 步。超过这个数更该考虑拆成两条流水线。
 */
export const PIPELINE_MAX_STEPS = 20
export const PIPELINE_NAME_MAX = 60
export const PIPELINE_STEP_NAME_MAX = 120
export const PIPELINE_DESC_MAX = 200

/* ------------------------------------------------------------ 步骤草稿 */

export const pipelineStepDraftSchema = z
  .object({
    name: z.string().min(1).max(PIPELINE_STEP_NAME_MAX),
    kind: pipelineStepKindSchema,
    /**
     * 脚本原文。`deploy` 步骤必须为空 —— 见文件头"为什么发布要单独一个步骤类型"。
     * 这里不给默认值，让"忘了填"在 schema 层就暴露。
     */
    script: z.string().max(SCRIPT_MAX_LENGTH),
    /** 仅本机步骤有意义；null / 不传则用能力探测的默认解释器 */
    shell: localShellSchema.nullable().optional(),
    /** 仅本机步骤有意义：远端请自己在脚本里 `cd`（同 B20 的理由，不再开注入面） */
    cwd: z.string().min(1).max(1024).nullable().optional(),
    timeoutMs: z.number().int().min(SCRIPT_TIMEOUT_MIN_MS).max(SCRIPT_TIMEOUT_MAX_MS),
    /** 这一步失败之后怎么办 */
    onFailure: pipelineOnFailureSchema
  })
  .superRefine((v, ctx) => {
    const has = v.script.trim().length > 0
    if (v.kind === 'deploy' && has) {
      ctx.addIssue({
        code: 'custom',
        path: ['script'],
        message: '「发布」步骤不需要脚本内容 —— 它执行的是应用自己的发布流程'
      })
    }
    if (v.kind !== 'deploy' && !has) {
      ctx.addIssue({ code: 'custom', path: ['script'], message: '这一步还没有填脚本' })
    }
  })
export type PipelineStepDraft = z.infer<typeof pipelineStepDraftSchema>

/* ------------------------------------------------------------ 流水线草稿 */

/**
 * 步骤数组（含"最多一个发布步骤"的校验）。
 *
 * 校验放在**数组这一层**而不是外层对象上，是有原因的：外层一旦挂了
 * `.superRefine`，它就从 `ZodObject` 变成 `ZodEffects`，而 `ZodEffects`
 * 没有 `.extend()` —— 保存入参正是"草稿 + 可选的 pipelineId"，需要 `extend`。
 * 把规则下沉到字段上，外层就保持是一个普通对象，两处入参共用同一套规则
 * （而不是"保存时不校验、运行时才发现"）。
 */
const pipelineStepsSchema = z
  .array(pipelineStepDraftSchema)
  .min(1, '至少要有一个步骤')
  .max(PIPELINE_MAX_STEPS, `步骤最多 ${PIPELINE_MAX_STEPS} 个`)
  .superRefine((steps, ctx) => {
    const deploys = steps.filter((s) => s.kind === 'deploy').length
    if (deploys > 1) {
      ctx.addIssue({
        code: 'custom',
        message: '一条流水线里最多只能有一个「发布」步骤'
      })
    }
  })

export const pipelineDraftSchema = z.object({
  targetId: z.string().min(1),
  name: z.string().min(1).max(PIPELINE_NAME_MAX),
  description: z.string().max(PIPELINE_DESC_MAX).nullable().optional(),
  steps: pipelineStepsSchema
})
export type PipelineDraft = z.infer<typeof pipelineDraftSchema>

/* -------------------------------------------------------------- 入参 */

export const pipelineListInputSchema = z.object({ targetId: z.string().min(1) })
export type PipelineListInput = z.infer<typeof pipelineListInputSchema>

export const pipelineDetailInputSchema = z.object({ pipelineId: z.string().min(1) })
export type PipelineDetailInput = z.infer<typeof pipelineDetailInputSchema>

/** 新建（不传 `pipelineId`）或整体覆盖保存（传）。步骤**整组替换**，不做逐条 diff。 */
export const pipelineSaveInputSchema = pipelineDraftSchema.extend({
  pipelineId: z.string().min(1).optional()
})
export type PipelineSaveInput = z.infer<typeof pipelineSaveInputSchema>

export const pipelineRemoveInputSchema = z.object({ pipelineId: z.string().min(1) })
export type PipelineRemoveInput = z.infer<typeof pipelineRemoveInputSchema>

export const pipelinePreviewInputSchema = z.object({ pipelineId: z.string().min(1) })
export type PipelinePreviewInput = z.infer<typeof pipelinePreviewInputSchema>

/**
 * 跑整条。
 *
 * `typedName` 只在**生产环境**（`envType === 'prod'`）需要，且必须逐字等于目标名。
 * 为什么服务端也要校验一遍：危险确认是渲染进程画的，而"生产环境不能手滑"这条规则
 * 不该只活在一个可以被绕过的地方。多传一个字段，换"规则在服务端也成立"。
 */
export const pipelineRunInputSchema = z.object({
  pipelineId: z.string().min(1),
  typedName: z.string().optional()
})
export type PipelineRunInput = z.infer<typeof pipelineRunInputSchema>

/** 只跑其中一步。`seq` 是步骤在流水线里的序号（1 起），不是数组下标。 */
export const pipelineRunStepInputSchema = z.object({
  pipelineId: z.string().min(1),
  seq: z.number().int().min(1).max(PIPELINE_MAX_STEPS),
  typedName: z.string().optional()
})
export type PipelineRunStepInput = z.infer<typeof pipelineRunStepInputSchema>

/* -------------------------------------------------------------- 视图 */

export const pipelineStepViewSchema = z.object({
  stepId: z.string().min(1),
  /** 1 起，与执行顺序一致 */
  seq: z.number().int().min(1),
  name: z.string(),
  kind: pipelineStepKindSchema,
  script: z.string(),
  shell: localShellSchema.nullable(),
  cwd: z.string().nullable(),
  timeoutMs: z.number().int(),
  onFailure: pipelineOnFailureSchema
})
export type PipelineStepView = z.infer<typeof pipelineStepViewSchema>

export const pipelineViewSchema = z.object({
  pipelineId: z.string().min(1),
  targetId: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  steps: z.array(pipelineStepViewSchema),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type PipelineView = z.infer<typeof pipelineViewSchema>

/** 「会执行什么」的一行摘要：确认对话框与步骤列表共用。 */
export const pipelineStepPreviewSchema = z.object({
  seq: z.number().int().min(1),
  name: z.string(),
  kind: pipelineStepKindSchema,
  kindLabel: z.string(),
  /** 脚本步骤：第一行非空内容（截断）；发布步骤：发布动作的说明 */
  summary: z.string(),
  timeoutMs: z.number().int(),
  onFailure: pipelineOnFailureSchema,
  /** 本机步骤用的解释器标签；其余为 null */
  shellLabel: z.string().nullable()
})
export type PipelineStepPreview = z.infer<typeof pipelineStepPreviewSchema>

export const pipelinePreviewSchema = z.object({
  pipelineId: z.string().min(1),
  name: z.string(),
  targetId: z.string().min(1),
  targetName: z.string(),
  envType: z.string(),
  /** 跑之前必须逐字输入目标名（生产环境） */
  requiresTypedName: z.boolean(),
  /** 含服务器步骤 —— 提示语要说"会在服务器上执行命令" */
  hasRemoteStep: z.boolean(),
  /** 含发布步骤 —— 提示语要说"会替换目标路径上的文件" */
  hasDeployStep: z.boolean(),
  steps: z.array(pipelineStepPreviewSchema)
})
export type PipelinePreview = z.infer<typeof pipelinePreviewSchema>

/* -------------------------------------------------------------- 纯工具 */

/** 脚本摘要：第一行非空内容，过长截断。确认对话框里只看得见一行。 */
export function firstMeaningfulLine(script: string, max = 80): string {
  for (const raw of script.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    return line.length > max ? `${line.slice(0, max)}…` : line
  }
  return ''
}

/**
 * 步骤摘要（**渲染进程也会用**，所以放在契约里）。
 *
 * 发布步骤的文案刻意说清"两件事"：会替换目标路径上的文件、旧版本会进版本库。
 * 只说"发布"两个字，用户没法判断这一步的破坏力。
 */
export function pipelineStepSummary(step: {
  kind: PipelineStepKind
  script: string
  remotePath?: string | null
}): string {
  if (step.kind === 'deploy') {
    return step.remotePath
      ? `发布本地产物到 ${step.remotePath}（旧版本先进版本库，可回滚）`
      : '发布本地产物到目标路径（旧版本先进版本库，可回滚）'
  }
  return firstMeaningfulLine(step.script) || '（未填脚本）'
}

/** 本机步骤的解释器标签（渲染进程与主进程共用一份说法）。 */
export function pipelineStepShellLabel(step: {
  kind: PipelineStepKind
  shell: LocalShell | null
}): string | null {
  if (step.kind !== 'local' || !step.shell) return null
  return step.shell === 'powershell' ? 'PowerShell' : 'Git Bash'
}

/** 步骤类型 → 中文（`deploy` 的标签是"发布"，不是"部署"）。 */
export function describeStepKind(kind: PipelineStepKind): string {
  return PIPELINE_STEP_KIND_LABELS[kind] ?? kind
}
