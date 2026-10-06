/**
 * B21 自动化流水线的验收点。
 *
 * ## 这一批最要紧的四件事
 *
 * 1. **发布步骤是"直接调用"而不是"再建一个任务"**：任务框架按目标分车道、
 *    同车道串行，整条流水线自己占着那条车道 —— 发布那步若走 `jobs.start`，
 *    它会排在自己身后，永远轮不到（自锁死锁）。所以这里断言的是
 *    "`deploy.run` 被调到了"，而不是"产生了第二个任务"。
 * 2. **`onFailure` 真的决定后续步骤跑不跑**，且"有一步失败"绝不被记成成功。
 * 3. **只跑一步时其余步骤不被触发** —— 用假远端通道记下实际发出去的脚本。
 * 4. **生产环境的目标名是服务端校验的**：渲染进程画的确认框可以被绕过，
 *    而"生产环境不能手滑"这条规则不该只活在那儿。
 */
import { describe, expect, it } from 'vitest'
import { makeTestDb, seedBasic } from '../helpers/db'
import { createScriptService } from '@main/services/script'
import { createPipelineService, mapStepPercent, stepSliceOf, type PipelineDeployPort } from '@main/services/pipeline'
import { auditRunFinished } from '@main/services/script-audit'
import { assertTargetIdle, activeJobForTarget } from '@main/ipc/target-busy'
import { AppError, ErrorCode } from '@main/infra/errors'
import {
  describeStepKind,
  pipelineDraftSchema,
  pipelineStepDraftSchema,
  pipelineStepSummary
} from '@shared/contracts/pipeline'
import type { JobContext, JobService, JobSpec } from '@main/services/job'
import type { RawExecFn } from '@main/services/script-runner'
import type { PipelineSaveInput, PipelineStepDraft } from '@shared/contracts/pipeline'
import type { DeployOutcome, DeployPrecheckReport } from '@shared/contracts/deploy'
import type { JobView } from '@shared/contracts/job'
import { join } from 'node:path'

/* ------------------------------------------------------------- 测试脚手架 */

interface RecordingCtx extends JobContext {
  logs: string[]
  progresses: Array<{ percent?: number; stage?: string; message?: string }>
}

function makeCtx(jobId = 'job-1', signal?: AbortSignal): RecordingCtx {
  const logs: string[] = []
  const progresses: RecordingCtx['progresses'] = []
  return {
    jobId,
    signal: signal ?? new AbortController().signal,
    progress: (p) => progresses.push(p),
    log: (text: string) => logs.push(text),
    logs,
    progresses
  }
}

/** 假远端通道：把收到的命令记下来，按回调决定退出码与输出。 */
function recordingExec(
  seen: string[],
  decide: (command: string) => { code: number | null; out?: string } = () => ({ code: 0 })
): RawExecFn {
  return (command, opts) => {
    seen.push(command)
    const r = decide(command)
    if (r.out) opts.onStdout(Buffer.from(r.out, 'utf8'))
    return Promise.resolve({ stdout: '', stderr: '', code: r.code, timedOut: false })
  }
}

function okReport(): DeployPrecheckReport {
  return { ok: true, items: [], needConfirm: false, residue: [] }
}

function okOutcome(releaseId: string): DeployOutcome {
  return {
    ok: true,
    releaseId,
    targetId: 't',
    versionTag: '20261006-100000_abcdefg',
    status: 'SUCCESS',
    strategy: 'rename',
    rootHash: 'x',
    fileCount: 3,
    totalBytes: 1024,
    durationMs: 10
  }
}

/** 记录调用的假发布端口（真发布在 B10 的集成测试里验）。 */
function fakeDeployPort(opts: {
  precheck?: (targetId: string) => DeployPrecheckReport
  run?: (input: { targetId: string; releaseId: string }) => DeployOutcome
} = {}): { port: PipelineDeployPort; calls: { precheck: string[]; run: string[] } } {
  const calls = { precheck: [] as string[], run: [] as string[] }
  return {
    calls,
    port: {
      precheck: (targetId) => {
        calls.precheck.push(targetId)
        return Promise.resolve(opts.precheck?.(targetId) ?? okReport())
      },
      run: ({ targetId, releaseId }) => {
        calls.run.push(releaseId)
        return Promise.resolve(opts.run?.({ targetId, releaseId }) ?? okOutcome(releaseId))
      }
    }
  }
}

function makeService(
  t: ReturnType<typeof makeTestDb>,
  opts: {
    allow?: () => boolean
    deploy?: PipelineDeployPort
    jobId?: string
  } = {}
) {
  const scripts = createScriptService({
    repo: t.repo,
    allowUserScripts: opts.allow ?? ((): boolean => true),
    runsDir: () => join(t.dataDir, 'script-runs'),
    operator: () => 'tester',
    now: () => new Date('2026-10-06T10:00:00.000Z'),
    // 本机步骤在这批里不是重点：全部步骤用 remote / deploy，免得测试依赖开发机装了什么
    resolveShellExe: () => null
  })
  const deploy = opts.deploy ?? fakeDeployPort().port
  const pipelines = createPipelineService({
    repo: t.repo,
    scripts,
    deploy,
    allowUserScripts: opts.allow ?? ((): boolean => true),
    operator: () => 'tester',
    now: () => new Date('2026-10-06T10:00:00.000Z')
  })
  return { scripts, pipelines, deploy }
}

function stepDraft(patch: Partial<PipelineStepDraft> = {}): PipelineStepDraft {
  return {
    name: '服务器脚本',
    kind: 'remote',
    script: 'echo hi',
    timeoutMs: 300_000,
    onFailure: 'stop',
    ...patch
  }
}

function draft(targetId: string, steps: PipelineStepDraft[], name = '一键发版'): PipelineSaveInput {
  return { targetId, name, description: null, steps }
}

async function runSpec(
  spec: JobSpec,
  ctx: JobContext
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await spec.run(ctx) }
  } catch (error) {
    return { ok: false, error }
  }
}

/* ---------------------------------------------------------------- 契约层 */

describe('B21 契约：步骤草稿的校验', () => {
  it('「发布」步骤不允许带脚本 —— 它执行的是应用自己的发布流程，不是一段 shell 文本', () => {
    const r = pipelineStepDraftSchema.safeParse(stepDraft({ kind: 'deploy', script: 'rm -rf /' }))
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('不需要脚本内容')
  })

  it('非发布步骤必须有脚本（空白不算）', () => {
    expect(pipelineStepDraftSchema.safeParse(stepDraft({ script: '   ' })).success).toBe(false)
    expect(pipelineStepDraftSchema.safeParse(stepDraft({ script: 'echo ok' })).success).toBe(true)
  })

  it('发布步骤的脚本留空是合法的', () => {
    expect(
      pipelineStepDraftSchema.safeParse(stepDraft({ kind: 'deploy', script: '' })).success
    ).toBe(true)
  })

  it('一条流水线最多一个「发布」步骤（两个会撞暂存目录与台账 id）', () => {
    const steps = [
      stepDraft({ kind: 'deploy', name: '发布', script: '' }),
      stepDraft({ kind: 'deploy', name: '再发一次', script: '' })
    ]
    const r = pipelineDraftSchema.safeParse({ targetId: 't', name: 'p', steps })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('最多只能有一个')
  })

  it('步骤数与名称长度都有上限', () => {
    const many = Array.from({ length: 21 }, () => stepDraft())
    expect(pipelineDraftSchema.safeParse({ targetId: 't', name: 'p', steps: many }).success).toBe(
      false
    )
    expect(
      pipelineDraftSchema.safeParse({ targetId: 't', name: '', steps: [stepDraft()] }).success
    ).toBe(false)
  })
})

/* ------------------------------------------------------------ 定义与保存 */

describe('B21 定义：保存、整组替换与唯一性', () => {
  it('新建后步骤按 1..N 排好；再次保存是**整组替换**（id 会变，序号重排）', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const { pipelines } = makeService(t)

      const created = pipelines.save(
        draft(target.id, [
          stepDraft({ name: '关服务', script: 'stop' }),
          stepDraft({ name: '启服务', script: 'start' })
        ])
      )
      expect(created.steps.map((s) => [s.seq, s.name])).toEqual([
        [1, '关服务'],
        [2, '启服务']
      ])
      const firstIds = created.steps.map((s) => s.stepId)
      expect(new Set(firstIds).size).toBe(2)

      // 把两步对调（界面上就是点一下"上移"），整组替换后序号重排、内容跟着走
      const updated = pipelines.save({
        ...draft(target.id, [
          stepDraft({ name: '启服务', script: 'start' }),
          stepDraft({ name: '关服务', script: 'stop' })
        ]),
        pipelineId: created.pipelineId
      })
      expect(updated.steps.map((s) => [s.seq, s.name])).toEqual([
        [1, '启服务'],
        [2, '关服务']
      ])
      // 步骤 id 变了（整组换掉），但旧行**真的被删了**，不是留一堆脏行在后面
      expect(updated.steps.map((s) => s.stepId)).not.toEqual(firstIds)
      expect(t.repo.pipelineSteps.listByPipeline(created.pipelineId)).toHaveLength(2)
      expect(pipelines.list(target.id)).toHaveLength(1)
    } finally {
      t.cleanup()
    }
  })

  it('同一目标下不允许同名（E_DUPLICATE_NAME）', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const { pipelines } = makeService(t)
      pipelines.save(draft(target.id, [stepDraft()], '发版'))
      expect(() => pipelines.save(draft(target.id, [stepDraft()], '发版'))).toThrowError(AppError)
      try {
        pipelines.save(draft(target.id, [stepDraft()], '发版'))
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.E_DUPLICATE_NAME)
      }
    } finally {
      t.cleanup()
    }
  })

  it('保存时不允许把流水线换到另一个目标（步骤内容都是针对原目标的）', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const other = t.repo.targets.create({
        environmentId: target.environmentId,
        name: '另一个目标',
        kind: 'dir',
        remotePath: '/opt/other'
      })
      const { pipelines } = makeService(t)
      const p = pipelines.save(draft(target.id, [stepDraft()]))
      try {
        pipelines.save({ ...draft(other.id, [stepDraft()]), pipelineId: p.pipelineId })
        throw new Error('应当抛错')
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.E_PARAM)
      }
    } finally {
      t.cleanup()
    }
  })

  it('删除流水线：定义与步骤都没了，但**已跑过的运行记录保留**', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const seen: string[] = []
      const { pipelines } = makeService(t)

      const p = pipelines.save(draft(target.id, [stepDraft({ script: 'echo a' })]))
      await runSpec(pipelines.runJob({ pipelineId: p.pipelineId }, { openRemote: () => Promise.resolve(recordingExec(seen)) }), makeCtx())

      expect(t.repo.scriptRuns.listByTarget(target.id)).toHaveLength(1)
      pipelines.remove(p.pipelineId)

      expect(pipelines.list(target.id)).toHaveLength(0)
      expect(t.repo.pipelineSteps.listByPipeline(p.pipelineId)).toHaveLength(0)
      // 运行记录是历史事实，不因为定义被删就消失
      expect(t.repo.scriptRuns.listByTarget(target.id)).toHaveLength(1)
    } finally {
      t.cleanup()
    }
  })
})

/* ---------------------------------------------------------------- 编排 */

describe('B21 编排：顺序、留档与失败策略', () => {
  it('跑整条：步骤按 seq 依次执行，一个流水线只建**一条**运行记录', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const seen: string[] = []
      const { pipelines } = makeService(t)
      const p = pipelines.save(
        draft(target.id, [
          stepDraft({ name: '关服务', script: 'stop-backend' }),
          stepDraft({ name: '启服务', script: 'start-backend' })
        ])
      )

      const ctx = makeCtx()
      const r = await runSpec(
        pipelines.runJob({ pipelineId: p.pipelineId }, { openRemote: () => Promise.resolve(recordingExec(seen)) }),
        ctx
      )
      expect(r.ok).toBe(true)

      // 命令按顺序发出去，一步一次
      expect(seen).toEqual(['stop-backend', 'start-backend'])

      const runs = t.repo.scriptRuns.listByTarget(target.id)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.trigger).toBe('pipeline')
      expect(runs[0]!.status).toBe('succeeded')
      expect(runs[0]!.title).toBe('流水线「一键发版」')

      const steps = t.repo.scriptStepRuns.listByRun(runs[0]!.id)
      expect(steps.map((s) => [s.seq, s.name, s.status])).toEqual([
        [1, '关服务', 'succeeded'],
        [2, '启服务', 'succeeded']
      ])
      // 输出进任务台（用户实时看到的就是这些行）
      expect(ctx.logs.some((l) => l.includes('第 1/2 步：关服务'))).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('onFailure=stop：后面的步骤**不建记录**（不是建一条"已跳过"）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const seen: string[] = []
      const { pipelines } = makeService(t)
      const p = pipelines.save(
        draft(target.id, [
          stepDraft({ name: '第一步', script: 'a' }),
          stepDraft({ name: '会失败', script: 'b', onFailure: 'stop' }),
          stepDraft({ name: '不该跑', script: 'c' })
        ])
      )

      const ctx = makeCtx()
      const r = await runSpec(
        pipelines.runJob(
          { pipelineId: p.pipelineId },
          { openRemote: () => Promise.resolve(recordingExec(seen, (cmd) => ({ code: cmd === 'b' ? 3 : 0 }))) }
        ),
        ctx
      )

      expect(r.ok).toBe(false)
      expect((r as { error: AppError }).error.code).toBe(ErrorCode.E_SCRIPT_EXIT)
      expect(seen).toEqual(['a', 'b'])

      const run = t.repo.scriptRuns.listByTarget(target.id)[0]!
      expect(run.status).toBe('failed')
      expect(run.errorMessage).toContain('第 2 步')
      expect(run.errorMessage).toContain('会失败')
      expect(t.repo.scriptStepRuns.listByRun(run.id).map((s) => s.seq)).toEqual([1, 2])
      expect(ctx.logs.some((l) => l.includes('终止整条流水线'))).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('onFailure=continue：继续跑完，但整条**仍记 failed**（记成功就是谎报）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const seen: string[] = []
      const { pipelines } = makeService(t)
      const p = pipelines.save(
        draft(target.id, [
          stepDraft({ name: '清理', script: 'clean', onFailure: 'continue' }),
          stepDraft({ name: '收尾', script: 'final' })
        ])
      )

      const ctx = makeCtx()
      const r = await runSpec(
        pipelines.runJob(
          { pipelineId: p.pipelineId },
          { openRemote: () => Promise.resolve(recordingExec(seen, (cmd) => ({ code: cmd === 'clean' ? 1 : 0 }))) }
        ),
        ctx
      )

      expect(r.ok).toBe(false)
      expect(seen).toEqual(['clean', 'final'])

      const run = t.repo.scriptRuns.listByTarget(target.id)[0]!
      expect(run.status).toBe('failed')
      expect(run.errorMessage).toContain('已按设置继续执行')
      expect(t.repo.scriptStepRuns.listByRun(run.id).map((s) => s.status)).toEqual([
        'failed',
        'succeeded'
      ])
      expect(ctx.logs.some((l) => l.includes('继续往下跑'))).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('取消：整条记 cancelled，剩余步骤不建记录并如实说明', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const controller = new AbortController()
      const { pipelines } = makeService(t)
      const p = pipelines.save(
        draft(target.id, [
          stepDraft({ name: '第一步', script: 'a' }),
          stepDraft({ name: '第二步', script: 'b' }),
          stepDraft({ name: '第三步', script: 'c' })
        ])
      )

      const seen: string[] = []
      const exec: RawExecFn = (command) => {
        seen.push(command)
        // 第一步执行到一半被取消
        controller.abort()
        return Promise.resolve({ stdout: '', stderr: '', code: 0, timedOut: false })
      }

      const ctx = makeCtx('job-cancel', controller.signal)
      await runSpec(
        pipelines.runJob({ pipelineId: p.pipelineId }, { openRemote: () => Promise.resolve(exec) }),
        ctx
      )

      expect(seen).toEqual(['a'])
      const run = t.repo.scriptRuns.listByTarget(target.id)[0]!
      expect(run.status).toBe('cancelled')
      expect(run.errorMessage).toContain('取消')
      expect(t.repo.scriptStepRuns.listByRun(run.id).map((s) => s.seq)).toEqual([1])
      expect(ctx.logs.some((l) => l.includes('剩余 2 步没有执行'))).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('只跑某一步：其余步骤的脚本**一次都没发出去**', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const seen: string[] = []
      const { pipelines } = makeService(t)
      const p = pipelines.save(
        draft(target.id, [
          stepDraft({ name: '关服务', script: 'stop' }),
          stepDraft({ name: '启服务', script: 'start' }),
          stepDraft({ name: '体检', script: 'health' })
        ])
      )

      const r = await runSpec(
        pipelines.stepRunJob(
          { pipelineId: p.pipelineId, seq: 2 },
          { openRemote: () => Promise.resolve(recordingExec(seen)) }
        ),
        makeCtx()
      )
      expect(r.ok).toBe(true)
      expect(seen).toEqual(['start'])

      const run = t.repo.scriptRuns.listByTarget(target.id)[0]!
      const steps = t.repo.scriptStepRuns.listByRun(run.id)
      // 只有一条记录，且**保留原序号**（这样用户一眼看出"这是第 2 步"）
      expect(steps.map((s) => [s.seq, s.name])).toEqual([[2, '启服务']])
      expect(run.title).toContain('只跑第 2 步')
    } finally {
      t.cleanup()
    }
  })

  it('总闸关着 → E_SCRIPT_DISABLED，且不留下任何记录', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      let flag = true
      const { pipelines } = makeService(t, { allow: () => flag })
      const p = pipelines.save(draft(target.id, [stepDraft()]))

      flag = false // 排队期间用户把开关关了
      const r = await runSpec(
        pipelines.runJob({ pipelineId: p.pipelineId }, { openRemote: () => Promise.resolve(recordingExec([])) }),
        makeCtx()
      )
      expect(r.ok).toBe(false)
      expect((r as { error: AppError }).error.code).toBe(ErrorCode.E_SCRIPT_DISABLED)
      expect(t.repo.scriptRuns.listByTarget(target.id)).toEqual([])
    } finally {
      t.cleanup()
    }
  })
})

/* -------------------------------------------------------- 发布步骤（T21.3） */

describe('B21 发布步骤：直接调 deploy，不新建任务', () => {
  it('前置校验有 error → 整步失败、报告**回显**出来，且发布一次都没被调用', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const fake = fakeDeployPort({
        precheck: () => ({
          ok: false,
          needConfirm: false,
          residue: ['/opt/svc/.sfvm-staging-old'],
          items: [
            {
              key: 'residue',
              label: '发现上次发布留下的暂存目录',
              level: 'error',
              detail: '/opt/svc/.sfvm-staging-old 还在',
              suggestion: '先清理残留再发布'
            }
          ]
        })
      })
      const { pipelines } = makeService(t, { deploy: fake.port })
      const p = pipelines.save(draft(target.id, [stepDraft({ kind: 'deploy', name: '发布', script: '' })]))

      const r = await runSpec(pipelines.runJob({ pipelineId: p.pipelineId }, {}), makeCtx())

      expect(r.ok).toBe(false)
      expect((r as { error: AppError }).error.code).toBe(ErrorCode.E_PIPELINE_PRECHECK)
      expect(fake.calls.run).toEqual([])

      const run = t.repo.scriptRuns.listByTarget(target.id)[0]!
      expect(run.status).toBe('failed')
      const step = t.repo.scriptStepRuns.listByRun(run.id)[0]!
      expect(step.kind).toBe('deploy')
      expect(step.status).toBe('failed')
      expect(step.errorMessage).toContain('前置校验未通过')
      // 报告本身要落进这一步的输出（用户展开详情就能看到为什么）
      expect(step.outputTail ?? '').toContain('发现上次发布留下的暂存目录')
      expect(step.outputTail ?? '').toContain('先清理残留再发布')
    } finally {
      t.cleanup()
    }
  })

  it('releaseId 取任务 id（"任务的 id 就是台账行的 id"这条约定在流水线里也成立）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const fake = fakeDeployPort()
      const { pipelines } = makeService(t, { deploy: fake.port })
      const p = pipelines.save(draft(target.id, [stepDraft({ kind: 'deploy', name: '发布', script: '' })]))

      const r = await runSpec(
        pipelines.runJob({ pipelineId: p.pipelineId }, {}),
        makeCtx('job-abc')
      )
      expect(r.ok).toBe(true)
      expect(fake.calls.run).toEqual(['job-abc'])

      const step = t.repo.scriptStepRuns.listByRun(
        t.repo.scriptRuns.listByTarget(target.id)[0]!.id
      )[0]!
      expect(step.status).toBe('succeeded')
      expect(step.outputTail ?? '').toContain('发布完成')
    } finally {
      t.cleanup()
    }
  })

  it('发布失败（ok:false）→ 这一步 failed，并把失败原因带回来', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const fake = fakeDeployPort({
        run: ({ releaseId }) => ({
          ...okOutcome(releaseId),
          ok: false,
          status: 'FAILED',
          failure: {
            code: ErrorCode.E_SWAP_FAILED,
            stage: 5,
            stageText: '阶段 5 换版',
            message: '换版失败',
            hint: '旧版本仍在版本库里',
            compensations: [{ action: '把归档的旧版本搬回目标', ok: true }]
          }
        })
      })
      const { pipelines } = makeService(t, { deploy: fake.port })
      const p = pipelines.save(draft(target.id, [stepDraft({ kind: 'deploy', name: '发布', script: '' })]))

      const r = await runSpec(pipelines.runJob({ pipelineId: p.pipelineId }, {}), makeCtx())
      expect(r.ok).toBe(false)

      const run = t.repo.scriptRuns.listByTarget(target.id)[0]!
      expect(run.status).toBe('failed')
      expect(run.errorMessage).toContain('换版失败')
      expect(t.repo.scriptStepRuns.listByRun(run.id)[0]!.status).toBe('failed')
    } finally {
      t.cleanup()
    }
  })

  it('发布步骤排在脚本步骤之间时，顺序与"本地构筑→关服务→发布→启服务"一致', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const seen: string[] = []
      const fake = fakeDeployPort()
      const { pipelines } = makeService(t, { deploy: fake.port })
      const p = pipelines.save(
        draft(target.id, [
          stepDraft({ name: '关服务', script: 'stop' }),
          stepDraft({ kind: 'deploy', name: '发布', script: '' }),
          stepDraft({ name: '启服务', script: 'start' })
        ])
      )

      const r = await runSpec(
        pipelines.runJob(
          { pipelineId: p.pipelineId },
          { openRemote: () => Promise.resolve(recordingExec(seen)) }
        ),
        makeCtx()
      )
      expect(r.ok).toBe(true)
      // 两条脚本命令按顺序发出去；中间那一步走的是端口，不占远端通道
      expect(seen).toEqual(['stop', 'start'])
      expect(fake.calls.run).toHaveLength(1)
    } finally {
      t.cleanup()
    }
  })
})

/* ------------------------------------------------------------ 进度与预览 */

describe('B21 进度映射与预览', () => {
  it('每一步等权、单调、永不给出 100（100 只属于"整条真的跑完了"）', () => {
    // 4 步：每步占 25 点
    expect(stepSliceOf(0, 4)).toEqual({ base: 0, span: 25 })
    expect(stepSliceOf(3, 4)).toEqual({ base: 75, span: 25 })
    // 单步流水线（"只跑这一步"）：整条就是这一步
    expect(stepSliceOf(0, 1)).toEqual({ base: 0, span: 100 })

    // 第 1 步走到 95% → 整条 24
    expect(mapStepPercent(95, 0, 25)).toBe(24)
    // 第 2 步刚开始 → 整条正好落在 25（不是 0，也不是 24.x 的舍入抖动）
    expect(mapStepPercent(0, 25, 25)).toBe(25)
    expect(mapStepPercent(50, 25, 25)).toBe(38)
    // 最后一步即使报 100%，整条也只给 99
    expect(mapStepPercent(100, 75, 25)).toBe(99)
    // 越界的输入被钳住，不外溢
    expect(mapStepPercent(-5, 0, 25)).toBe(0)
    expect(mapStepPercent(999, 60, 40)).toBe(99)
  })

  it('执行中会把带"第 x/N 步"的阶段文本推给任务台', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const { pipelines } = makeService(t)
      const p = pipelines.save(
        draft(target.id, [stepDraft({ name: '慢一点', script: 'slow' }), stepDraft({ script: 'fast' })])
      )

      const ctx = makeCtx()
      // 第一步故意跑过一个心跳周期（ticker 是 1 秒），这样一定有一次进度推送
      const exec: RawExecFn = () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ stdout: '', stderr: '', code: 0, timedOut: false }),
            1150
          )
        })

      const r = await runSpec(
        pipelines.runJob({ pipelineId: p.pipelineId }, { openRemote: () => Promise.resolve(exec) }),
        ctx
      )
      expect(r.ok).toBe(true)

      const withStage = ctx.progresses.filter((x) => (x.stage ?? '').includes('第 1/2 步'))
      expect(withStage.length).toBeGreaterThan(0)
      const percents = ctx.progresses
        .map((x) => x.percent)
        .filter((n): n is number => typeof n === 'number')
      expect(percents.length).toBeGreaterThan(0)
      expect(Math.max(...percents)).toBeLessThanOrEqual(99)
      // 第一条进度不会一上来就超过这一步的 25 点上限
      expect(Math.min(...percents)).toBeLessThanOrEqual(25)
    } finally {
      t.cleanup()
    }
  }, 20000)

  it('preview 是纯本地的"会执行什么"：含远端/发布标记、发布步骤写清目标路径', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo, { remotePath: '/opt/svc/order.jar' })
      const { pipelines } = makeService(t)
      const p = pipelines.save(
        draft(target.id, [
          stepDraft({ name: '关服务', script: 'systemctl stop order' }),
          stepDraft({ kind: 'deploy', name: '发布', script: '' })
        ])
      )

      const preview = pipelines.preview(p.pipelineId)
      expect(preview.targetName).toBe('订单服务')
      expect(preview.envType).toBe('test')
      expect(preview.requiresTypedName).toBe(false)
      expect(preview.hasRemoteStep).toBe(true)
      expect(preview.hasDeployStep).toBe(true)
      expect(preview.steps[0]!.summary).toBe('systemctl stop order')
      // 发布这一步的摘要必须说清"会替换哪些文件、旧版本还能不能回来"
      expect(preview.steps[1]!.summary).toContain('/opt/svc/order.jar')
      expect(preview.steps[1]!.summary).toContain('可回滚')
      expect(pipelines.list(target.id)[0]!.steps.length).toBe(2)
    } finally {
      t.cleanup()
    }
  })
})

/* ------------------------------------------------------ 生产环境目标名 */

describe('B21 生产环境：目标名在服务端也校验', () => {
  function prodSetup() {
    const t = makeTestDb()
    const { target, env } = seedBasic(t.repo)
    t.repo.environments.update(env.id, { envType: 'prod' })
    const { pipelines } = makeService(t)
    const p = pipelines.save(draft(target.id, [stepDraft()]))
    return { t, target, pipelines, pipelineId: p.pipelineId }
  }

  it('prod 环境不传目标名 → E_CONFIRM_REQUIRED，且**不建任务**', () => {
    const { t, target, pipelines, pipelineId } = prodSetup()
    try {
      try {
        pipelines.runJob({ pipelineId }, {})
        throw new Error('应当抛错')
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.E_CONFIRM_REQUIRED)
      }
      // 抛在建任务之前 —— 任务台里不该冒出一条"点了就被拒"的任务
      expect(t.repo.scriptRuns.listByTarget(target.id)).toEqual([])
    } finally {
      t.cleanup()
    }
  })

  it('prod 环境输入的名字不对 → 拒绝；完全一致才放行', () => {
    const { t, target, pipelines, pipelineId } = prodSetup()
    try {
      expect(() => pipelines.runJob({ pipelineId, typedName: '订单服务-v2' }, {})).toThrowError(
        AppError
      )
      expect(pipelines.preview(pipelineId).requiresTypedName).toBe(true)
      const spec = pipelines.runJob({ pipelineId, typedName: target.name }, {})
      expect(spec.type).toBe('script')
    } finally {
      t.cleanup()
    }
  })

  it('单跑一步同样要过生产环境那道确认', () => {
    const { t, target, pipelines, pipelineId } = prodSetup()
    try {
      expect(() => pipelines.stepRunJob({ pipelineId, seq: 1 }, {})).toThrowError(AppError)
      const spec = pipelines.stepRunJob({ pipelineId, seq: 1, typedName: target.name }, {})
      expect(spec.title).toContain('只跑第 1 步')
    } finally {
      t.cleanup()
    }
  })
})

/* ---------------------------------------------------------------- 守卫 */

describe('B21 目标互斥守卫（T21.7）', () => {
  function jobView(patch: Partial<JobView> = {}): JobView {
    return {
      jobId: 'j1',
      type: 'script',
      title: '脚本「关服务」',
      targetId: 't1',
      status: 'running',
      percent: 0,
      cancelRequested: false,
      createdAt: '2026-10-06T10:00:00.000Z',
      startedAt: '2026-10-06T10:00:00.000Z',
      finishedAt: null,
      error: null,
      logCount: 0,
      droppedLogs: 0,
      ...patch
    }
  }

  function fakeJobs(view?: JobView): JobService {
    return {
      activeForTarget: () => (view ? [view] : [])
    } as unknown as JobService
  }

  it('目标空闲时不拦', () => {
    expect(() => assertTargetIdle(fakeJobs(), 't1', { action: '发布' })).not.toThrow()
  })

  it('有任务在跑时拦下，且文案里带上**正在跑的那个任务**（用户才知道去哪儿取消）', () => {
    try {
      assertTargetIdle(fakeJobs(jobView()), 't1', { action: '跑流水线' })
      throw new Error('应当抛错')
    } catch (e) {
      const err = e as AppError
      expect(err.code).toBe(ErrorCode.E_TARGET_BUSY)
      expect(err.message).toContain('脚本「关服务」')
      expect(err.message).toContain('跑流水线')
      expect(err.hint ?? '').toContain('取消')
    }
  })

  it('发布期间想跑流水线同样被拦 —— 这正是 T21.7 要修的那个洞', () => {
    const deployJob = jobView({ jobId: 'j2', type: 'deploy', title: '发布「订单服务」' })
    expect(activeJobForTarget(fakeJobs(deployJob), 't1')?.type).toBe('deploy')
    expect(() => assertTargetIdle(fakeJobs(deployJob), 't1', { action: '跑流水线' })).toThrowError(
      AppError
    )
  })

  it('自定义建议文案会被采用（删往期版本的场景）', () => {
    try {
      assertTargetIdle(fakeJobs(jobView()), 't1', {
        action: '删除往期版本',
        hint: '请等它结束后再删除往期版本。'
      })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as AppError).hint).toBe('请等它结束后再删除往期版本。')
    }
  })
})

/* ---------------------------------------------------------------- 审计 */

describe('B21 审计：脚本执行可查（安全约定第 6 条）', () => {
  it('单条脚本与流水线各写"开始 + 结束"两条，失败记 warn', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const seen: string[] = []
      const { scripts, pipelines } = makeService(t)

      // ① 单条脚本（B20 的路径）
      await runSpec(
        scripts.stepJob(
          { targetId: target.id, kind: 'remote', name: '关服务', script: 'stop' },
          { openRemote: () => Promise.resolve(recordingExec(seen)) }
        ),
        makeCtx('job-single')
      )

      // ② 流水线，且中间一步失败
      const p = pipelines.save(
        draft(target.id, [stepDraft({ name: '会失败', script: 'boom' })])
      )
      await runSpec(
        pipelines.runJob(
          { pipelineId: p.pipelineId },
          { openRemote: () => Promise.resolve(recordingExec(seen, () => ({ code: 2 }))) }
        ),
        makeCtx('job-pipe')
      )

      const rows = t.repo.audit
        .listRecent()
        .filter((r) => r.scope === 'script')
        .sort((a, b) => a.ts.localeCompare(b.ts))

      // 两次执行 × (开始 + 结束)
      expect(rows).toHaveLength(4)
      expect(rows[0]!.message).toContain('开始执行：脚本「关服务」')
      expect(rows[1]!.message).toContain('脚本「关服务」：成功')
      expect(rows[1]!.level).toBe('info')
      expect(rows[2]!.message).toContain('开始执行：流水线「一键发版」')
      expect(rows[3]!.message).toContain('流水线「一键发版」：失败')
      // 失败记 warn，这样审计列表里一眼能挑出来
      expect(rows[3]!.level).toBe('warn')

      // refId 指向运行记录，排障时能从审计跳到那次运行
      const run = t.repo.scriptRuns.listByTarget(target.id).find((r) => r.jobId === 'job-pipe')!
      expect(rows[3]!.refId).toBe(run.id)

      const detail = JSON.parse(rows[2]!.detail ?? '{}') as Record<string, unknown>
      expect(detail.targetId).toBe(target.id)
      expect(detail.trigger).toBe('pipeline')
      expect(detail.steps).toBe(1)
      // 目标是哪台机器必须能查 —— 审计最常见的用法就是"这几次都动了哪个目标"
      expect(detail.jobId).toBe('job-pipe')
    } finally {
      t.cleanup()
    }
  })

  it('detail 一律先脱敏再入库（审计日志会进用户的诊断包）', () => {
    const t = makeTestDb()
    try {
      auditRunFinished(t.repo, {
        runId: 'r1',
        targetId: 't1',
        title: '脚本「x」',
        status: 'failed',
        errorMessage: '连接串 mysql://root:hunter2@db:3306/x 拒绝连接'
      })
      const row = t.repo.audit.listRecent()[0]!
      expect(row.detail ?? '').not.toContain('hunter2')
    } finally {
      t.cleanup()
    }
  })
})

/* ------------------------------------------------------------ 契约工具 */

describe('B21 契约工具：摘要与标签', () => {
  it('步骤摘要取第一行有意义的内容，过长截断', () => {
    expect(
      pipelineStepSummary({ kind: 'remote', script: '\n\n  systemctl stop x  \necho done' })
    ).toBe('systemctl stop x')
    const long = pipelineStepSummary({ kind: 'local', script: 'a'.repeat(200) })
    expect(long.length).toBeLessThanOrEqual(81)
    expect(long.endsWith('…')).toBe(true)
  })

  it('步骤类型的中文标签：deploy 是"发布"而不是"部署"', () => {
    expect(describeStepKind('deploy')).toBe('发布')
    expect(describeStepKind('local')).toBe('本机执行')
    expect(describeStepKind('remote')).toBe('服务器执行')
  })

  it('未填脚本时摘要不返回空串（界面上不能是一片空白）', () => {
    expect(pipelineStepSummary({ kind: 'remote', script: '   ' })).toBe('（未填脚本）')
  })
})
