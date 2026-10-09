/**
 * B20 / T20.5 ~ T20.8 脚本服务的验收点。
 *
 * ## 为什么大量用"假远端通道"而不是真起进程
 *
 * 本机路径的真起进程部分放在文件末尾（按解释器是否可用 `skipIf`）：
 * 那种测试能验到"真的能跑、真的能杀进程树"，但依赖开发机装了什么，
 * 不适合承载"退出码怎么记、尾部怎么截、取消写成什么状态"这一类**逻辑**断言。
 *
 * 远端路径这里给的是一个几十行的假 `RawExecFn`（而不是伪造整条 ssh2 通道）：
 * 越像真的替身越会掩盖真实差异（B07 的教训）。要验真机行为走集成测试。
 *
 * 这一批盯住的是几件**只在重启后才会暴露**的事：
 * 任务与其返回值都不落库，所以"上次那步成没成、退出码多少、输出尾部是什么"
 * 只能来自 `script_runs` / `script_step_runs` —— 于是这些断言必须存在。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeTestDb, seedBasic } from '../helpers/db'
import { createScriptService, type ScriptJobIo } from '@main/services/script'
import { runLocalScript } from '@main/services/script-runner'
import { AppError, ErrorCode } from '@main/infra/errors'
import { REDACTED } from '@main/infra/log-redact'
import {
  STEP_TAIL_MAX_LINES,
  type LocalShell,
  type ScriptRunView,
  type ScriptRunStepInput
} from '@shared/contracts/script'
import type { JobContext, JobSpec } from '@main/services/job'
import type { RawExecFn } from '@main/services/script-runner'

/* ------------------------------------------------------------- 测试脚手架 */

/** 一个最小的任务上下文（任务框架那边有它自己的一整套测试）。 */
function makeCtx(signal?: AbortSignal): JobContext & { logs: string[] } {
  const logs: string[] = []
  return {
    jobId: 'job-test-1',
    signal: signal ?? new AbortController().signal,
    progress: vi.fn(),
    log: (text: string) => logs.push(text),
    logs
  }
}

function makeService(
  t: ReturnType<typeof makeTestDb>,
  opts: {
    allow?: () => boolean
    shells?: Partial<Record<LocalShell, string | null>>
    gitBashPath?: () => string | null
  } = {}
) {
  const shells = opts.shells
  return createScriptService({
    repo: t.repo,
    allowUserScripts: opts.allow ?? ((): boolean => true),
    ...(opts.gitBashPath ? { gitBashPath: opts.gitBashPath } : {}),
    runsDir: () => join(t.dataDir, 'script-runs'),
    operator: () => 'tester',
    now: () => new Date('2026-10-06T10:00:00.000Z'),
    // 不注入时走真实探测（真机测试要用）；注入时只换"解释器在哪"
    ...(shells ? { resolveShellExe: (s: LocalShell): string | null => shells[s] ?? null } : {})
  })
}

function runInput(patch: Partial<ScriptRunStepInput> & { targetId: string }): ScriptRunStepInput {
  return { kind: 'remote', script: 'echo hi', ...patch }
}

/** 跑一个 jobSpec 并把手上的错接住（任务框架会把它记成失败，这里只关心结果）。 */
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

/** 一个把给定文本流式吐出去、并以指定退出码结束的假远端通道。 */
function fakeExec(
  chunks: { stdout?: string[]; stderr?: string[] },
  result: { code: number | null; timedOut?: boolean }
): RawExecFn {
  return (_command, opts) => {
    for (const s of chunks.stdout ?? []) opts.onStdout(Buffer.from(s, 'utf8'))
    for (const s of chunks.stderr ?? []) opts.onStderr(Buffer.from(s, 'utf8'))
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: result.code,
      timedOut: result.timedOut ?? false
    })
  }
}

const remoteIo = (exec: RawExecFn): ScriptJobIo => ({ openRemote: () => Promise.resolve(exec) })

/* ------------------------------------------------------------------ 能力 */

describe('B20 能力探测', () => {
  it('总闸关着时 allowUserScripts 为 false（界面据此只显示"怎么打开"）', () => {
    const t = makeTestDb()
    try {
      const svc = makeService(t, { allow: () => false, shells: { powershell: 'C:\\ps.exe' } })
      const caps = svc.capabilities()
      expect(caps.allowUserScripts).toBe(false)
      expect(caps.shells).toHaveLength(2)
    } finally {
      t.cleanup()
    }
  })

  it('默认解释器优先取平台那一档；它不可用时退到第一个可用的', () => {
    const t = makeTestDb()
    try {
      // win32 优先 powershell
      const onlyPs = makeService(t, { shells: { powershell: 'C:\\ps.exe', gitbash: null } })
      expect(onlyPs.capabilities().defaultShell).toBe('powershell')

      const onlyGit = makeService(t, { shells: { powershell: null, gitbash: 'C:\\bash.exe' } })
      expect(onlyGit.capabilities().defaultShell).toBe('gitbash')

      const none = makeService(t, { shells: { powershell: null, gitbash: null } })
      expect(none.capabilities().defaultShell).toBeNull()
      expect(none.capabilities().shells.every((s) => !s.available)).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('手工指定的 Git Bash 路径填错时**不回退**自动探测（否则用户以为设置生效了）', () => {
    const t = makeTestDb()
    try {
      // 用一个绝对存在的路径（当前工作目录）冒充"填错了的 bash"
      const svc = createScriptService({
        repo: t.repo,
        allowUserScripts: () => true,
        gitBashPath: () => join(t.dataDir, '不存在的', 'bash.exe'),
        runsDir: () => join(t.dataDir, 'script-runs')
      })
      const git = svc.capabilities().shells.find((s) => s.shell === 'gitbash')!
      expect(git.available).toBe(false)
      expect(git.exePath).toBeNull()
    } finally {
      t.cleanup()
    }
  })
})

/* -------------------------------------------------------------- 总闸守卫 */

describe('B20 总闸', () => {
  it('总闸关着时任务直接失败，且**不留下任何记录**（连"跑过"都不该有）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t, { allow: () => false, shells: { powershell: 'C:\\ps.exe' } })
      const spec = svc.stepJob(
        runInput({ targetId: target.id, kind: 'local', shell: 'powershell' }),
        {}
      )
      const r = await runSpec(spec, makeCtx())

      expect(r.ok).toBe(false)
      expect((r as { error: AppError }).error.code).toBe(ErrorCode.E_SCRIPT_DISABLED)
      expect(svc.list(target.id)).toEqual([])
    } finally {
      t.cleanup()
    }
  })

  it('任务排队期间用户把总闸关了 → run() 里**再查一次**仍然拦得住', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      let allow = true
      const svc = makeService(t, {
        allow: () => allow,
        shells: { powershell: 'C:\\ps.exe' }
      })
      const spec = svc.stepJob(
        runInput({ targetId: target.id, kind: 'local', shell: 'powershell' }),
        {}
      )
      allow = false // 排队期间关掉
      const r = await runSpec(spec, makeCtx())
      expect(r.ok).toBe(false)
      expect((r as { error: AppError }).error.code).toBe(ErrorCode.E_SCRIPT_DISABLED)
      expect(svc.list(target.id)).toEqual([])
    } finally {
      t.cleanup()
    }
  })

  it('本机步骤找不到解释器 → E_SCRIPT_SHELL_MISSING（不是"跑了个空的"）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t, { shells: { powershell: null, gitbash: null } })
      const spec = svc.stepJob(
        runInput({ targetId: target.id, kind: 'local', shell: 'powershell' }),
        {}
      )
      const r = await runSpec(spec, makeCtx())
      expect(r.ok).toBe(false)
      expect((r as { error: AppError }).error.code).toBe(ErrorCode.E_SCRIPT_SHELL_MISSING)

      /*
       * B21 起这里**留一条失败记录**。
       *
       * 以前断言的是"一条记录都没有"—— 而那个行为本身就是毛病：用户点了执行、
       * 任务台里一条红、再回"运行记录"想复查时什么都没有。现在解释器找不到
       * 也照样建记录，并把原因写进这一步的错误与日志里，记录自解释。
       */
      const runs = svc.list(target.id)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.status).toBe('failed')
      const step = runs[0]!.steps[0]!
      expect(step.status).toBe('failed')
      expect(step.errorMessage ?? '').toContain('解释器')
      // 整条运行的原因也要写清楚 —— 列表页只显示这一行
      expect(runs[0]!.errorMessage ?? '').toContain('解释器')
    } finally {
      t.cleanup()
    }
  })
})

/* ---------------------------------------------------------------- 远端 */

describe('B20 远端执行与留档', () => {
  it('成功：状态、退出码、耗时、输出尾部与落盘文件都对得上', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      const spec = svc.stepJob(
        runInput({ targetId: target.id, kind: 'remote', name: '重启后端' }),
        remoteIo(fakeExec({ stdout: ['第一行\n', '第二行\n'], stderr: ['警告\n'] }, { code: 0 }))
      )
      const r = await runSpec(spec, makeCtx())
      expect(r.ok).toBe(true)

      const view = (r as { value: ScriptRunView }).value
      expect(view.status).toBe('succeeded')
      expect(view.title).toBe('脚本「重启后端」')
      expect(view.trigger).toBe('step')
      expect(view.operator).toBe('tester')
      expect(view.steps).toHaveLength(1)

      const step = view.steps[0]!
      expect(step.status).toBe('succeeded')
      expect(step.exitCode).toBe(0)
      expect(step.kind).toBe('remote')
      expect(step.shell).toBeNull()
      expect(step.durationMs).toBe(0)
      expect(step.errorMessage).toBeNull()
      expect(step.truncated).toBe(false)

      // 三行都进了尾部（stdout 与 stderr 合并成一路，与终端里看到的一致）
      expect(step.outputTail).toBe('第一行\n第二行\n警告')
      expect(step.outputBytes).toBeGreaterThan(0)

      // 完整输出落盘
      expect(step.outputPath).toBeTruthy()
      const onDisk = readFileSync(step.outputPath!, 'utf8')
      expect(onDisk).toContain('第一行')
      expect(onDisk).toContain('警告')

      // 台账里也读得回来（这就是"重启后还查得到"的来源）
      expect(svc.list(target.id).map((x) => x.runId)).toEqual([view.runId])
      expect(svc.detail(view.runId).status).toBe('succeeded')
    } finally {
      t.cleanup()
    }
  })

  it('非零退出码：记 failed + 退出码入库 + **抛出**（抛不出去会被记成"已完成"）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      const spec = svc.stepJob(
        runInput({ targetId: target.id, kind: 'remote', script: 'exit 3' }),
        remoteIo(fakeExec({ stdout: ['boom\n'] }, { code: 3 }))
      )
      const r = await runSpec(spec, makeCtx())

      expect(r.ok).toBe(false)
      expect((r as { error: AppError }).error.code).toBe(ErrorCode.E_SCRIPT_EXIT)
      expect((r as { error: AppError }).error.message).toContain('3')

      const view = svc.list(target.id)[0]!
      expect(view.status).toBe('failed')
      expect(view.steps[0]!.exitCode).toBe(3)
      expect(view.errorMessage).toContain('3')
    } finally {
      t.cleanup()
    }
  })

  it('超时：退出码是 null（"没拿到"），状态仍是 failed —— 不能显示成 0', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      const spec = svc.stepJob(
        runInput({ targetId: target.id, kind: 'remote', script: 'sleep 999' }),
        remoteIo(fakeExec({}, { code: null, timedOut: true }))
      )
      const r = await runSpec(spec, makeCtx())

      expect(r.ok).toBe(false)
      const view = svc.list(target.id)[0]!
      expect(view.status).toBe('failed')
      expect(view.steps[0]!.exitCode).toBeNull()
      expect(view.steps[0]!.status).toBe('failed')
    } finally {
      t.cleanup()
    }
  })

  it('取消：状态记 cancelled（与 failed 分开），原因写"已被取消"', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      const controller = new AbortController()
      /**
       * 一个"永不返回、只对 cancel 有反应"的通道。
       *
       * 必须**先查 `signal.aborted`**：`stepJob` 在调通道之前有一个 `await`
       * （懒开远端），所以 abort 很可能发生在注册监听之前。真实实现
       * （`pool.execRaw`）也是这么做的 —— 替身漏了这一步就会挂住，
       * 正是"替身不像真的就会掩盖差异"的例子。
       */
      const exec: RawExecFn = (_cmd, opts) =>
        new Promise((_resolve, reject) => {
          if (opts.signal.aborted) {
            reject(new AppError(ErrorCode.E_JOB_CANCELLED))
            return
          }
          opts.signal.addEventListener('abort', () => {
            reject(new AppError(ErrorCode.E_JOB_CANCELLED))
          })
        })

      const spec = svc.stepJob(runInput({ targetId: target.id, kind: 'remote' }), remoteIo(exec))
      const ctx = makeCtx(controller.signal)
      const p = runSpec(spec, ctx)
      // 让 run() 先跑到"等通道"那一步再取消（模拟用户在任务台点取消）
      await new Promise((r) => setTimeout(r, 20))
      controller.abort()
      const r = await p

      expect(r.ok).toBe(false)
      const view = svc.list(target.id)[0]!
      expect(view.status).toBe('cancelled')
      expect(view.steps[0]!.status).toBe('cancelled')
      expect(view.errorMessage).toContain('取消')
      // 取消不是"失败"：两者的终态要能分开（任务台与运行记录都靠这个区分）
      expect(view.status).not.toBe('failed')
    } finally {
      t.cleanup()
    }
  })

  it('信号**一开始就是 aborted** 时也立刻结束（不能挂住）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      const controller = new AbortController()
      controller.abort()
      const exec: RawExecFn = (_cmd, opts) =>
        opts.signal.aborted
          ? Promise.reject(new AppError(ErrorCode.E_JOB_CANCELLED))
          : new Promise(() => {})
      const spec = svc.stepJob(runInput({ targetId: target.id, kind: 'remote' }), remoteIo(exec))
      const r = await runSpec(spec, makeCtx(controller.signal))
      expect(r.ok).toBe(false)
      expect(svc.list(target.id)[0]!.status).toBe('cancelled')
    } finally {
      t.cleanup()
    }
  })

  it('远端通道拿不到（没接线）→ 明确失败，不静默跳过', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      const spec = svc.stepJob(runInput({ targetId: target.id, kind: 'remote' }), {})
      const r = await runSpec(spec, makeCtx())
      expect(r.ok).toBe(false)
      expect(svc.list(target.id)[0]!.status).toBe('failed')
    } finally {
      t.cleanup()
    }
  })
})

/* ------------------------------------------------------------ 输出留档 */

describe('B20 输出留档策略', () => {
  it('超过 200 行时只留**最后** 200 行（尾部要的是结尾，不是开头）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      const lines = Array.from({ length: 300 }, (_, i) => `line-${i}\n`)
      const spec = svc.stepJob(
        runInput({ targetId: target.id, kind: 'remote' }),
        remoteIo(fakeExec({ stdout: lines }, { code: 0 }))
      )
      await runSpec(spec, makeCtx())

      const tail = svc.detail(svc.list(target.id)[0]!.runId).steps[0]!.outputTail!
      const kept = tail.split('\n')
      expect(kept.length).toBe(STEP_TAIL_MAX_LINES)
      expect(kept[0]).toBe('line-100')
      expect(kept[kept.length - 1]).toBe('line-299')

      // 但落盘的是**全量**（这正是"库里只留尾部"的代价由谁承担的地方）
      const path = svc.detail(svc.list(target.id)[0]!.runId).steps[0]!.outputPath!
      expect(readFileSync(path, 'utf8').split('\n').length).toBeGreaterThan(300)
    } finally {
      t.cleanup()
    }
  })

  it('一条超长单行也不会被整个丢掉（"至少留最后一行"）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      const huge = 'x'.repeat(100_000)
      const spec = svc.stepJob(
        runInput({ targetId: target.id, kind: 'remote' }),
        remoteIo(fakeExec({ stdout: [huge + '\n'] }, { code: 0 }))
      )
      await runSpec(spec, makeCtx())

      const step = svc.detail(svc.list(target.id)[0]!.runId).steps[0]!
      expect(step.outputTail).toBeTruthy()
      expect(step.outputTail!.startsWith('xxx')).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('输出里的凭据先过脱敏再落库、落盘（日志要进用户的诊断包）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      const spec = svc.stepJob(
        runInput({ targetId: target.id, kind: 'remote' }),
        remoteIo(
          fakeExec(
            { stdout: ['connecting password=hunter2\n', 'done\n'], stderr: ['url https://u:p@h/x\n'] },
            { code: 0 }
          )
        )
      )
      await runSpec(spec, makeCtx())

      const step = svc.detail(svc.list(target.id)[0]!.runId).steps[0]!
      expect(step.outputTail).not.toContain('hunter2')
      expect(step.outputTail).toContain(REDACTED)
      const onDisk = readFileSync(step.outputPath!, 'utf8')
      expect(onDisk).not.toContain('hunter2')
      expect(onDisk).not.toContain('u:p@h')
    } finally {
      t.cleanup()
    }
  })

  it('执行中的那一步也会写进日志（用户实时看到的就是这些行）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      const spec = svc.stepJob(
        runInput({ targetId: target.id, kind: 'remote' }),
        remoteIo(fakeExec({ stdout: ['a\n', 'b\n'] }, { code: 0 }))
      )
      const ctx = makeCtx()
      await runSpec(spec, ctx)

      expect(ctx.logs).toContain('a')
      expect(ctx.logs).toContain('b')
      // 第一行说明"在哪跑、超时多久"——失败时用户靠它判断环境对不对
      expect(ctx.logs.some((l) => l.includes('超时'))).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  /**
   * L3 回归：步骤收尾之后迟到的输出**不能再落盘**。
   *
   * 旧实现里 `createOutputSink.write()` 看到 `fd === null` 就 `openSync(path,'a')`
   * 重新开一个 —— 而 `close()` 早已跑过，这个新 fd **再没有人关**。
   * 触发路径真实存在：取消/超时把 Promise 结掉之后，流上仍可能再来一块数据
   * （进程还没死透），落到这里就是稳定的句柄泄漏。
   *
   * 用"先解决 Promise、再补一块输出"的假远端通道把这件事**确定性地**复现出来，
   * 不依赖真起进程的时序。
   */
  it('L3：步骤收尾之后迟到的输出被丢弃（不再新开一个永不关闭的 fd）', async () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const svc = makeService(t)
      let lateOutput: (() => void) | null = null
      const exec: RawExecFn = (_command, opts) => {
        opts.onStdout(Buffer.from('先到的一块\n', 'utf8'))
        // 把"迟到的那一块"留到 promise 解决之后再送
        lateOutput = (): void => opts.onStdout(Buffer.from('迟到的一块\n', 'utf8'))
        return Promise.resolve({ stdout: '', stderr: '', code: 0, timedOut: false })
      }
      const spec = svc.stepJob(runInput({ targetId: target.id, kind: 'remote' }), remoteIo(exec))
      const r = await runSpec(spec, makeCtx())
      expect(r.ok).toBe(true)

      const step = (r as { value: ScriptRunView }).value.steps[0]!
      const sizeBefore = statSync(step.outputPath!).size
      expect(sizeBefore).toBeGreaterThan(0)

      // 记录已落库、文件已 close —— 此时再来一块输出
      lateOutput!()
      await new Promise((resolve) => setTimeout(resolve, 20))

      // 文件不再增长：旧实现会在这里 openSync + writeSync，把内容补进去
      expect(statSync(step.outputPath!).size).toBe(sizeBefore)
      expect(readFileSync(step.outputPath!, 'utf8')).not.toContain('迟到')
    } finally {
      t.cleanup()
    }
  })
})

/* ------------------------------------------------------------ 列表/详情 */

describe('B20 运行记录读取', () => {
  it('detail 遇到不存在的 id 抛 E_NOT_FOUND（不返回空壳）', () => {
    const t = makeTestDb()
    try {
      const svc = makeService(t)
      expect(() => svc.detail('nope')).toThrowError(AppError)
      try {
        svc.detail('nope')
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.E_NOT_FOUND)
      }
    } finally {
      t.cleanup()
    }
  })
})

/* ------------------------------------------------- 本机真起进程（按环境跳过） */

/** 找一个真的能用的 Git Bash；找不到就整体跳过这组。 */
function findRealBash(): string | null {
  const t = makeTestDb()
  try {
    const svc = createScriptService({
      repo: t.repo,
      allowUserScripts: () => true,
      runsDir: () => join(t.dataDir, 'script-runs')
    })
    return svc.capabilities().shells.find((s) => s.shell === 'gitbash')?.exePath ?? null
  } finally {
    t.cleanup()
  }
}

const realBash = findRealBash()
const bashIt = it.skipIf(realBash === null)

describe('B20 本机真起进程（Git Bash）', () => {
  it('能跑通并拿到退出码 0 与输出', async () => {
    if (!realBash) return
    const output: string[] = []
    const outcome = await runLocalScript({
      shell: 'gitbash',
      exePath: realBash,
      script: 'printf "ok-中文\\n"',
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      onOutput: (t) => output.push(t)
    })
    expect(outcome.exitCode).toBe(0)
    // 中文没被切坏（chunk 解码器的验收点）
    expect(output.join('')).toContain('ok-中文')
  })

  bashIt('非零退出码如实返回（不抛错 —— 抛不抛由服务层决定）', async () => {
    if (!realBash) return
    const outcome = await runLocalScript({
      shell: 'gitbash',
      exePath: realBash,
      script: 'exit 7',
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      onOutput: () => {}
    })
    expect(outcome.exitCode).toBe(7)
    expect(outcome.timedOut).toBe(false)
  })

  bashIt('超时会**杀进程树**并以 E_SCRIPT_TIMEOUT 结束', async () => {
    if (!realBash) return
    const p = runLocalScript({
      shell: 'gitbash',
      exePath: realBash,
      script: 'sleep 30',
      timeoutMs: 1000,
      signal: new AbortController().signal,
      onOutput: () => {}
    })
    await expect(p).rejects.toMatchObject({ code: ErrorCode.E_SCRIPT_TIMEOUT })
  }, 20_000)

  bashIt('取消：abort 之后立刻以 E_JOB_CANCELLED 结束', async () => {
    if (!realBash) return
    const controller = new AbortController()
    const p = runLocalScript({
      shell: 'gitbash',
      exePath: realBash,
      script: 'sleep 30',
      timeoutMs: 30_000,
      signal: controller.signal,
      onOutput: () => {}
    })
    controller.abort()
    await expect(p).rejects.toMatchObject({ code: ErrorCode.E_JOB_CANCELLED })
  }, 20_000)

  bashIt('工作目录不存在时报的是"路径不存在"，不是"解释器没了"', async () => {
    if (!realBash) return
    const p = runLocalScript({
      shell: 'gitbash',
      exePath: realBash,
      script: 'echo hi',
      cwd: join(process.cwd(), '这个目录不存在-xyz'),
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      onOutput: () => {}
    })
    await expect(p).rejects.toMatchObject({ code: ErrorCode.E_LOCAL_PATH_MISSING })
  })

  it('解释器路径不存在时抛 E_SCRIPT_SHELL_MISSING（不是挂住）', async () => {
    const missing = join(process.cwd(), '没有这个解释器.exe')
    expect(existsSync(missing)).toBe(false)
    const p = runLocalScript({
      shell: 'gitbash',
      exePath: missing,
      script: 'echo hi',
      timeoutMs: 5000,
      signal: new AbortController().signal,
      onOutput: () => {}
    })
    await expect(p).rejects.toMatchObject({ code: ErrorCode.E_SCRIPT_SHELL_MISSING })
  })
})
