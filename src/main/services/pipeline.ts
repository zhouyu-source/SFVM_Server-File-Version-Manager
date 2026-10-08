/**
 * 自动化流水线服务（B21 / T21.2 ~ T21.4）。
 *
 * ## 一句话
 *
 * 把"有序步骤"按顺序跑完，每一步留档，失败时按该步的 `onFailure` 决定
 * 终止还是继续。整条流水线**只建一条 `script_runs`**，每一步一条 `script_step_runs`。
 *
 * ## 为什么整条只建一个任务
 *
 * 任务框架按 `t:<targetId>` 分车道、**同车道串行**。如果每一步各建一个任务，
 * 那么"发布"那一步会排在自己前面几步的后面 —— 看起来没问题，但：
 * ① 用户在任务台里看到的是一串零散任务，看不出它们属于同一次操作；
 * ② 取消要一个个点；
 * ③ 更糟的是，**一个流水线里的发布步骤如果也走 `jobs.start`，它会排在
 *    *当前这个流水线任务* 后面 —— 同一个车道、同一个任务还在跑，于是永远排不到
 *    它，形成自锁死锁**。所以发布步骤是本文件里**直接调用** `deploy.run()` 的，
 *    不是新建任务（T21.3）。
 *
 * ## 进度怎么算（T21.2）
 *
 * **每一步等权**：第 i 步占 `[i/N, (i+1)/N]`。步骤内部再各按自己的方式细分 ——
 * 脚本步骤用"未知长度"的启发式曲线（与 B20 单条脚本完全同一套，手感一致），
 * 发布步骤用它自己的阶段进度。合成的百分比**封顶 99**：真正的 100% 只在
 * 整条真的跑完时给，否则用户会在最后一步刚开始时就看到"100% 但还在跑"。
 *
 * ## 失败语义
 *
 * - `onFailure: 'stop'` → 停在这里，后面的步骤**不建记录**（不是建一条"已跳过"，
 *   那样会让"到底跑没跑"变得含糊）。
 * - `onFailure: 'continue'` → 继续跑，但**整条最终仍记 `failed`** 并把原因写清楚。
 *   把"有一步失败了但后面都成功"记成 `succeeded` 是谎报 —— 用户下次看到这条绿记录
 *   会以为当时一切正常。
 */
import { hostname as osHostname } from 'node:os'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { auditRunFinished, auditRunStarted } from './script-audit'
import type { JobContext, JobProgressInput, JobSpec } from './job'
import type { JobLogLevel } from '../../shared/contracts/job'
import type { RawExecFn } from './script-runner'
import type { Repositories } from '../db/repositories'
import type {
  ScriptJobIo,
  ScriptService,
  ScriptStepOutcome,
  StepRunRecorder
} from './script'
import {
  PIPELINE_ON_FAILURE_LABELS,
  describeStepKind,
  pipelineStepShellLabel,
  pipelineStepSummary,
  type PipelineOnFailure,
  type PipelinePreview,
  type PipelineRunInput,
  type PipelineRunStepInput,
  type PipelineSaveInput,
  type PipelineStepPreview,
  type PipelineStepView,
  type PipelineView
} from '../../shared/contracts/pipeline'
import type { DeployOutcome, DeployPrecheckReport } from '../../shared/contracts/deploy'
import type { ScriptRunStatus } from '../../shared/contracts/script'

/* -------------------------------------------------------------------- 端口 */

/**
 * 发布步骤要走的那两条路。
 *
 * **必须是"直接调用"而不是"再建一个任务"** —— 任务框架按 `t:<targetId>` 分车道、
 * 同车道串行，而整条流水线自己就占着那条车道，再建任务就是排在队尾永远轮不到，
 * 也就是自锁死锁（T21.3）。所以这里注入的是 `precheck` 与 `run` 两个**函数**，
 * 由接线层（`ipc/pipeline.ts`）实现成"开端口 → 标记连接 busy → 调用服务"。
 */
export interface PipelineDeployPort {
  precheck(targetId: string): Promise<DeployPrecheckReport>
  run(input: { targetId: string; ctx: JobContext; releaseId: string }): Promise<DeployOutcome>
}

export interface PipelineServiceDeps {
  repo: Repositories
  /** 单步执行与留档都复用 B20 的实现（不重抄 sink / tail / 脱敏那一套） */
  scripts: ScriptService
  deploy: PipelineDeployPort
  /** 「开启自定义脚本」总闸（**现取**） */
  allowUserScripts: () => boolean
  operator?: () => string
  now?: () => Date
}

/** 跑一条流水线时的外部依赖。与 `ScriptJobIo` 同源，额外带上远端通道的懒开。 */
export interface PipelineJobIo {
  openRemote?: () => Promise<RawExecFn>
}

export interface PipelineService {
  list(targetId: string): PipelineView[]
  get(pipelineId: string): PipelineView
  /** 新建（不传 `pipelineId`）或整体覆盖保存 */
  save(input: PipelineSaveInput): PipelineView
  remove(pipelineId: string): void
  /** 「会执行什么」：**纯本地**，不连服务器 */
  preview(pipelineId: string): PipelinePreview
  /** 一键跑整条 */
  runJob(input: PipelineRunInput, io: PipelineJobIo): JobSpec
  /** 只跑其中一步（其余步骤不会被触发） */
  stepRunJob(input: PipelineRunStepInput, io: PipelineJobIo): JobSpec
}

/* -------------------------------------------------------------- 进度切片 */

/**
 * 合成百分比封顶 99。
 *
 * 100 只留给"整条真的跑完了"：某一步报 100% 时它可能还在收尾（发布阶段 6
 * 的清理动作就发生在"进度 100%"之后），此时进度条跳到 100 却继续转，
 * 用户会以为界面卡住了。
 */
export const PIPELINE_PROGRESS_CAP = 99

/** 第 `index` 步（0 起）在整条 `total` 步里占的区间。 */
export function stepSliceOf(index: number, total: number): { base: number; span: number } {
  const n = Math.max(1, total)
  return { base: (index / n) * 100, span: 100 / n }
}

/** 把"这一步内部的百分比"换算成"整条的百分比"，并封顶 99。 */
export function mapStepPercent(percent: number, base: number, span: number): number {
  const clamped = Math.max(0, Math.min(100, percent))
  const mapped = base + (span * clamped) / 100
  return Math.max(0, Math.min(PIPELINE_PROGRESS_CAP, Math.round(mapped)))
}

/* -------------------------------------------------------------------- 实现 */

export function createPipelineService(deps: PipelineServiceDeps): PipelineService {
  const { repo, scripts, deploy } = deps
  const now = deps.now ?? ((): Date => new Date())
  const operator = deps.operator ?? ((): string => osHostname())

  /* ---------------------------------------------------------------- 组装 */

  function toStepView(row: {
    id: string
    seq: number
    name: string
    kind: string
    script: string
    shell: string | null
    cwd: string | null
    timeoutMs: number
    onFailure: string
  }): PipelineStepView {
    return {
      stepId: row.id,
      seq: row.seq,
      name: row.name,
      kind: row.kind === 'deploy' ? 'deploy' : row.kind === 'remote' ? 'remote' : 'local',
      script: row.script,
      shell: row.shell === 'powershell' || row.shell === 'gitbash' ? row.shell : null,
      cwd: row.cwd,
      timeoutMs: row.timeoutMs,
      onFailure: row.onFailure === 'continue' ? 'continue' : 'stop'
    }
  }

  function toView(pipelineId: string): PipelineView {
    const row = repo.pipelines.get(pipelineId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { pipelineId })
    return {
      pipelineId: row.id,
      targetId: row.targetId,
      name: row.name,
      description: row.description,
      steps: repo.pipelineSteps.listByPipeline(row.id).map(toStepView),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  function list(targetId: string): PipelineView[] {
    return repo.pipelines.listByTarget(targetId).map((p) => toView(p.id))
  }

  function get(pipelineId: string): PipelineView {
    return toView(pipelineId)
  }

  /* ---------------------------------------------------------------- 保存 */

  function save(input: PipelineSaveInput): PipelineView {
    const target = repo.targets.get(input.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: input.targetId })

    // 同一目标下不允许同名：不然"一键执行"的两个按钮分不清谁是谁。
    // 在应用层先查一遍是为了给出比"唯一约束冲突"好得多的提示。
    const sameName = repo.pipelines.findByName(input.targetId, input.name)
    if (sameName && sameName.id !== input.pipelineId) {
      throw new AppError(ErrorCode.E_DUPLICATE_NAME, {
        name: input.name,
        targetId: input.targetId
      })
    }

    if (input.pipelineId) {
      const existing = repo.pipelines.get(input.pipelineId)
      if (!existing) throw new AppError(ErrorCode.E_NOT_FOUND, { pipelineId: input.pipelineId })
      // 流水线**绑定目标**，不允许"保存时顺手换一个目标" —— 那等于把这条流水线
      // 搬到了另一个服务器上，而步骤内容（关哪个服务、发到哪个目录）都是针对原目标的
      if (existing.targetId !== input.targetId) {
        throw new AppError(ErrorCode.E_PARAM, {
          reason: 'target-mismatch',
          pipelineId: input.pipelineId
        })
      }
    }

    // 名称/描述与步骤**在同一个事务里落库**（P2-15）：分两段写会出现"新名字 + 旧步骤"
    // 的半成品。步骤整组替换（理由见 repositories：上移/下移在逐条 diff 下会撞唯一约束）。
    const pipelineId = repo.savePipelineWithSteps({
      ...(input.pipelineId ? { id: input.pipelineId } : {}),
      targetId: input.targetId,
      name: input.name,
      description: input.description ?? null,
      steps: input.steps.map((s, i) => ({
        seq: i + 1,
        name: s.name,
        kind: s.kind,
        // 发布步骤恒为空串 —— 它不是"一段交给 shell 的文本"
        script: s.kind === 'deploy' ? '' : s.script,
        // 本机步骤不填解释器就存 null（运行期按平台默认解析），
        // 存下当时的探测结果反而会在换机器后变成错的
        shell: s.kind === 'local' ? (s.shell ?? null) : null,
        cwd: s.kind === 'local' ? (s.cwd ?? null) : null,
        timeoutMs: s.timeoutMs,
        onFailure: s.onFailure
      }))
    })

    logger.info(
      `pipeline saved: id=${pipelineId} target=${input.targetId} steps=${input.steps.length}`
    )
    return toView(pipelineId)
  }

  function remove(pipelineId: string): void {
    const row = repo.pipelines.get(pipelineId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { pipelineId })
    // 步骤随外键级联删除；运行记录**保留**（它是历史事实，不该因为定义被删就消失）
    repo.pipelines.remove(pipelineId)
    logger.info(`pipeline removed: id=${pipelineId}`)
  }

  /* -------------------------------------------------------------- 预览 */

  function preview(pipelineId: string): PipelinePreview {
    const p = get(pipelineId)
    const target = repo.targets.get(p.targetId)
    const env = target ? repo.environments.get(target.environmentId) : null
    const envType = env?.envType ?? 'unknown'

    // 本机步骤没填解释器时，用**当前探测到的默认值**展示 —— 让对话框里的说法
    // 与实际会用的一致（而不是显示一个空白）
    const defaultShell = scripts.capabilities().defaultShell

    const steps: PipelineStepPreview[] = p.steps.map((s) => ({
      seq: s.seq,
      name: s.name,
      kind: s.kind,
      kindLabel: describeStepKind(s.kind),
      summary: pipelineStepSummary({
        kind: s.kind,
        script: s.script,
        remotePath: s.kind === 'deploy' ? (target?.remotePath ?? null) : null
      }),
      timeoutMs: s.timeoutMs,
      onFailure: s.onFailure,
      shellLabel: pipelineStepShellLabel({
        kind: s.kind,
        shell: s.kind === 'local' ? (s.shell ?? defaultShell) : null
      })
    }))

    return {
      pipelineId: p.pipelineId,
      name: p.name,
      targetId: p.targetId,
      targetName: target?.name ?? p.targetId,
      envType,
      requiresTypedName: envType === 'prod',
      hasRemoteStep: p.steps.some((s) => s.kind === 'remote'),
      hasDeployStep: p.steps.some((s) => s.kind === 'deploy'),
      steps
    }
  }

  /* ---------------------------------------------------------- 生产环境守卫 */

  /**
   * 生产环境必须逐字输入目标名（安全约定 #3）。
   *
   * 放在服务层而不是只放在对话框里：对话框是渲染进程画的，而"生产环境不能手滑"
   * 这条规则不该只活在一个可以被绕过的地方。多传一个字段，换"规则在服务端也成立"。
   */
  function assertProdConfirmed(targetId: string, typedName: string | undefined): void {
    const target = repo.targets.get(targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId })
    const env = repo.environments.get(target.environmentId)
    if (env?.envType !== 'prod') return
    if (typedName === target.name) return
    throw new AppError(ErrorCode.E_CONFIRM_REQUIRED, {
      targetId,
      targetName: target.name,
      envType: env.envType
    })
  }

  /* ------------------------------------------------------------ 进度映射 */

  interface StepSlice {
    /** 这一步在整条里的起点（0~100） */
    base: number
    /** 这一步占的宽度（0~100） */
    span: number
    /** 步骤标签，会出现在 `stage` 里 */
    prefix: string
  }

  function mapProgress(p: JobProgressInput, slice: StepSlice): JobProgressInput {
    const out: JobProgressInput = { stage: slice.prefix }
    if (p.percent !== undefined) out.percent = mapStepPercent(p.percent, slice.base, slice.span)
    if (p.stage) out.stage = `${slice.prefix} · ${p.stage}`
    if (p.message !== undefined) out.message = p.message
    // 字节/文件数原样透传：它们是发布阶段自己的口径，换算成"整条的比例"没有意义
    if (p.bytes !== undefined) out.bytes = p.bytes
    if (p.totalBytes !== undefined) out.totalBytes = p.totalBytes
    if (p.files !== undefined) out.files = p.files
    if (p.totalFiles !== undefined) out.totalFiles = p.totalFiles
    return out
  }

  /** 把 ctx 换成"只在这一步的切片里"的 ctx：进度被映射，日志原样。 */
  function sliceContext(ctx: JobContext, slice: StepSlice): JobContext {
    return {
      jobId: ctx.jobId,
      signal: ctx.signal,
      progress: (p) => ctx.progress(mapProgress(p, slice)),
      log: (text: string, level?: JobLogLevel) => ctx.log(text, level)
    }
  }

  /* ------------------------------------------------------ 单个步骤的执行 */

  interface StepExecArgs {
    runId: string
    targetId: string
    step: PipelineStepView
    index: number
    total: number
    ctx: JobContext
    io: PipelineJobIo
  }

  /**
   * 跑一步，返回与 B20 单步同形的结果。
   *
   * **绝不抛错**：这一步失败不该打断整条流水线的决策（`onFailure` 才决定下一步）。
   * 只有"接线错误"（漏给远端通道）会抛 —— 那是我们自己的 bug，不该被当成用户脚本的问题。
   */
  async function execStep(args: StepExecArgs): Promise<ScriptStepOutcome> {
    const { step, ctx } = args
    const slice: StepSlice = {
      base: (args.index / args.total) * 100,
      span: 100 / args.total,
      prefix: `第 ${args.index + 1}/${args.total} 步`
    }
    if (step.kind === 'deploy') {
      return execDeployStep({ ...args, slice })
    }

    return scripts.runScriptStep({
      runId: args.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      script: step.script,
      shell: step.shell,
      cwd: step.cwd,
      timeoutMs: step.timeoutMs,
      signal: ctx.signal,
      io: args.io as ScriptJobIo,
      log: (text, level) => ctx.log(text, level),
      progress: (percent, message) =>
        ctx.progress(mapProgress({ percent, message }, slice))
    })
  }

  /**
   * 发布步骤（T21.3 / T21.4）。
   *
   * ① **先 `precheck`**：有 `error` 级的项就整步失败并把报告**回显出来**
   *    （写进这一步的日志与输出文件），绝不静默跳过 —— 用户点"一键执行"
   *    时的心理预期是"它会替我把该拦的拦住"，而不是"它跳过了发布却什么都没说"。
   * ② **直接调 `deploy.run`**，不 `jobs.start`（自锁死锁，见文件头）。
   * ③ 发布自己的日志行走同一个留档器 —— 于是"流水线里的发布"与"直接点发布"
   *    在运行记录里形状一致，用户不必学两套。
   */
  async function execDeployStep(
    args: StepExecArgs & { slice: StepSlice }
  ): Promise<ScriptStepOutcome> {
    const { step, ctx, slice } = args
    const targetId = args.targetId
    const startedMs = now().getTime()
    const rec: StepRunRecorder = scripts.recorder({
      runId: args.runId,
      seq: step.seq,
      name: step.name,
      kind: 'deploy',
      shell: null,
      log: (line, level) => ctx.log(line, level)
    })

    let failure: AppError | null = null

    try {
      ctx.log('开始前置校验（连接服务器检查目标、产物、磁盘与残留）')
      const report = await deploy.precheck(targetId)

      // 报告**每一条**都回显：用户要看的往往不是那个 error，而是它旁边那条 warning
      for (const item of report.items) {
        const mark = item.level === 'error' ? '✗' : item.level === 'warn' ? '!' : '·'
        rec.feed(`${mark} [${item.level}] ${item.label}：${item.detail}\n`)
        if (item.suggestion) rec.feed(`    建议：${item.suggestion}\n`)
      }

      const errors = report.items.filter((i) => i.level === 'error')
      if (errors.length > 0) {
        throw new AppError(
          ErrorCode.E_PIPELINE_PRECHECK,
          { targetId, items: errors },
          { message: `发布前置校验未通过：${errors.map((e) => e.label).join('、')}` }
        )
      }

      ctx.log('前置校验通过，开始发布')
      const outcome = await deploy.run({
        targetId,
        // 发布自己的阶段进度会被映射进这一段的切片里（"发布步骤按自己阶段细分"）
        ctx: sliceContext(ctx, slice),
        // releaseId 取任务 id —— "任务的 id 就是台账行的 id"（与 ipc/deploy.ts 同一约定）。
        // 一条流水线最多一个发布步骤，所以不会撞暂存目录（见 contracts/pipeline.ts）
        releaseId: ctx.jobId
      })

      if (!outcome.ok) {
        const f = outcome.failure
        throw new AppError(
          ErrorCode.E_SCRIPT_EXIT,
          { targetId, releaseId: outcome.releaseId, failure: f },
          { message: f?.message ?? '发布失败' }
        )
      }

      const done = `发布完成：版本 ${outcome.versionTag}（${outcome.fileCount} 个文件，${outcome.totalBytes} 字节）`
      rec.feed(`${done}\n`)
      ctx.log(done)
    } catch (err) {
      failure =
        err instanceof AppError
          ? err
          : new AppError(ErrorCode.E_UNKNOWN, { original: String(err) })
      rec.feed(`\n${failure.message ?? '发布失败'}\n`)
      if (failure.hint) rec.feed(`建议：${failure.hint}\n`)
    } finally {
      rec.flush()
    }

    const durationMs = Math.max(0, now().getTime() - startedMs)
    const cancelled = ctx.signal.aborted
    const status: ScriptRunStatus = cancelled ? 'cancelled' : failure ? 'failed' : 'succeeded'
    const errorMessage = cancelled
      ? '已被取消'
      : failure
        ? [failure.message, failure.hint].filter(Boolean).join(' ')
        : null

    rec.close({ status, exitCode: null, durationMs, errorMessage })

    return {
      status,
      exitCode: null,
      errorMessage,
      error: failure,
      stepRunId: rec.stepRunId,
      outputBytes: rec.bytes
    }
  }

  /* ------------------------------------------------------------ 编排主体 */

  function openRun(args: {
    targetId: string
    jobId: string
    pipelineId: string
    title: string
    steps: number
  }): string {
    const row = repo.scriptRuns.create({
      targetId: args.targetId,
      jobId: args.jobId,
      trigger: 'pipeline',
      pipelineId: args.pipelineId,
      title: args.title,
      status: 'running',
      operator: operator()
    })
    logger.info(
      `pipeline run ${row.id} started: pipeline=${args.pipelineId} job=${args.jobId} target=${args.targetId}`
    )
    auditRunStarted(repo, {
      runId: row.id,
      targetId: args.targetId,
      jobId: args.jobId,
      title: args.title,
      pipelineId: args.pipelineId,
      steps: args.steps
    })
    return row.id
  }

  /**
   * 顺序执行给定的步骤（`runJob` 传全部，`stepRunJob` 传一步）。
   *
   * 抽成一个函数，是为了让"只跑一步"与"跑整条"共用**同一套**失败语义与留档 ——
   * 两套实现在这种地方一定会分叉（比如"单跑一步失败时整条记什么"）。
   */
  async function executeSteps(input: {
    runId: string
    targetId: string
    steps: PipelineStepView[]
    ctx: JobContext
    io: PipelineJobIo
    allowContinue: boolean
  }): Promise<{ status: ScriptRunStatus; error: AppError | null; errorMessage: string | null }> {
    const { steps, ctx } = input
    const total = steps.length
    const failures: Array<{ step: PipelineStepView; message: string | null }> = []
    let cancelled = false
    let firstError: AppError | null = null

    for (let i = 0; i < total; i++) {
      const step = steps[i]!

      if (ctx.signal.aborted) {
        cancelled = true
        ctx.log(`已取消，剩余 ${total - i} 步没有执行`, 'warn')
        break
      }

      ctx.log(
        `── 第 ${i + 1}/${total} 步：${step.name}（${describeStepKind(step.kind)}，超时 ${Math.round(step.timeoutMs / 1000)} 秒）`
      )

      const outcome = await execStep({
        runId: input.runId,
        targetId: input.targetId,
        step,
        index: i,
        total,
        ctx,
        io: input.io
      })

      if (outcome.status === 'succeeded') continue

      if (outcome.status === 'cancelled' || ctx.signal.aborted) {
        cancelled = true
        ctx.log(`已取消，剩余 ${total - i - 1} 步没有执行`, 'warn')
        break
      }

      failures.push({ step, message: outcome.errorMessage })
      if (!firstError) firstError = outcome.error

      if (input.allowContinue && step.onFailure === 'continue') {
        ctx.log(`这一步失败了，按设置继续往下跑（${PIPELINE_ON_FAILURE_LABELS.continue}）`, 'warn')
        continue
      }
      ctx.log('这一步失败了，按设置终止整条流水线', 'warn')
      break
    }

    if (cancelled) return { status: 'cancelled', error: firstError, errorMessage: '已被取消' }
    if (failures.length === 0) return { status: 'succeeded', error: null, errorMessage: null }

    const head = failures[0]!
    const more =
      failures.length > 1 ? `（共 ${failures.length} 步失败：${failures.map((f) => f.step.name).join('、')}）` : ''
    const continued = total > 1 && failures.some((f) => f.step.onFailure === 'continue')
    return {
      status: 'failed',
      error: firstError,
      errorMessage:
        `第 ${head.step.seq} 步「${head.step.name}」失败：${head.message ?? '未知原因'}${more}` +
        (continued ? '（已按设置继续执行后面的步骤）' : '')
    }
  }

  /* ---------------------------------------------------------------- 任务 */

  /** 任务共用的外壳：闸门 → 建运行记录 → 执行 → 落终态 → 按需抛错。 */
  function jobOf(args: {
    targetId: string
    pipelineId: string
    title: string
    steps: PipelineStepView[]
    /** 只跑一步时不做"终止/继续"的取舍 —— 本来就只有一步 */
    allowContinue: boolean
    io: PipelineJobIo
  }): JobSpec {
    return {
      type: 'script',
      title: args.title,
      targetId: args.targetId,
      async run(ctx: JobContext): Promise<unknown> {
        // 总闸再查一次：任务可能在车道里排了一会儿，期间用户可能把开关关了
        if (!deps.allowUserScripts()) {
          throw new AppError(ErrorCode.E_SCRIPT_DISABLED, { targetId: args.targetId })
        }

        const runId = openRun({
          targetId: args.targetId,
          jobId: ctx.jobId,
          pipelineId: args.pipelineId,
          title: args.title,
          steps: args.steps.length
        })

        const r = await executeSteps({
          runId,
          targetId: args.targetId,
          steps: args.steps,
          ctx,
          io: args.io,
          allowContinue: args.allowContinue
        })

        repo.scriptRuns.finish(runId, r.status, r.errorMessage)
        auditRunFinished(repo, {
          runId,
          targetId: args.targetId,
          title: args.title,
          status: r.status,
          errorMessage: r.errorMessage
        })
        logger.info(
          `pipeline run ${runId} ${r.status}: pipeline=${args.pipelineId} steps=${args.steps.length}`
        )

        // 失败必须抛错（返回一个"失败的结果对象"会被任务框架记成已完成）
        if (r.status !== 'succeeded') {
          if (r.error) throw r.error
          throw new AppError(
            r.status === 'cancelled' ? ErrorCode.E_JOB_CANCELLED : ErrorCode.E_SCRIPT_EXIT,
            { runId },
            { message: r.errorMessage ?? '流水线未成功结束' }
          )
        }
        return scripts.detail(runId)
      }
    }
  }

  function runJob(input: PipelineRunInput, io: PipelineJobIo): JobSpec {
    const p = get(input.pipelineId)
    assertProdConfirmed(p.targetId, input.typedName)
    return jobOf({
      targetId: p.targetId,
      pipelineId: p.pipelineId,
      title: `流水线「${p.name}」`,
      steps: p.steps,
      allowContinue: true,
      io
    })
  }

  function stepRunJob(input: PipelineRunStepInput, io: PipelineJobIo): JobSpec {
    const p = get(input.pipelineId)
    assertProdConfirmed(p.targetId, input.typedName)
    const step = p.steps.find((s) => s.seq === input.seq)
    if (!step) {
      throw new AppError(ErrorCode.E_NOT_FOUND, { pipelineId: p.pipelineId, seq: input.seq })
    }
    return jobOf({
      targetId: p.targetId,
      pipelineId: p.pipelineId,
      title: `流水线「${p.name}」· 只跑第 ${step.seq} 步`,
      // 只跑一步：**其余步骤不会被触发**（这是这个入口的全部意义）
      steps: [step],
      allowContinue: false,
      io
    })
  }

  return { list, get, save, remove, preview, runJob, stepRunJob }
}

/* -------------------------------------------------------------- 只在外部用 */

/**
 * 让"这一步是否需要连服务器"在接线层可判定 —— 只有含远端/发布步骤的流水线
 * 才需要懒开一条远端通道。
 */
export function pipelineNeedsRemote(view: PipelineView): boolean {
  return view.steps.some((s) => s.kind === 'remote' || s.kind === 'deploy')
}

/** 与 `PipelineOnFailure` 同义的再导出，免得接线层从两个地方 import 类型。 */
export type { PipelineOnFailure }
