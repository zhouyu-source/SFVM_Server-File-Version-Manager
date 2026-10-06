/**
 * 自定义脚本服务（B20 / T20.5 ~ T20.8）。
 *
 * ## 职责
 *
 * 1. **能力探测**：这台机器上有没有 PowerShell / Git Bash，总闸开没开 —— 界面据此渲染。
 * 2. **把"跑一条脚本"包成任务**（`stepJob`）。任务化不是形式主义：它白拿三件事 ——
 *    可取消、进度与日志进底部任务台、与同目标的发布/回滚**天然互斥**
 *    （任务按 `t:<targetId>` 分车道、同车道串行）。
 * 3. **留档**：把每次运行写进 `script_runs` / `script_step_runs`。任务框架不保留
 *    `run()` 的返回值、也不落库，所以**这里**才是"上次那步成没成、退出码多少"的答案。
 *
 * ## 输出怎么存（两条通道，各有各的理由）
 *
 * - **完整输出落文件**：`<数据目录>/log/script-runs/<runId>/<seq>.log`，单步上限 8MB，
 *   超了截断并**在文件尾写一行说明**（静默截断会让人以为脚本就输出到那儿）。
 * - **库里只留尾部**：最后 200 行 / 32KB，用于列表页与快速预览。
 *
 * 两处都先过 `scrubText`：脚本输出里经常夹着 token、密码、连接串，
 * 而日志文件与运行记录都会进用户反馈的诊断包。**宁可日志不逐字，也不能漏凭据。**
 *
 * ## 一个刻意的"不做"
 *
 * 远端脚本执行期间**不**把连接标记为 busy（发布才需要那样做）。发布期间禁自动重连
 * 的理由是"换版前后目标路径可能是空的，重连重试会把真实状态搅乱"；脚本不是那个窗口期，
 * 断线后自动重连反而有益。
 */
import { existsSync, mkdirSync, openSync, closeSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { hostname as osHostname } from 'node:os'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { scrubText } from '../infra/log-redact'
import {
  SHELL_EXE_CANDIDATES,
  defaultShellForPlatform,
  isAbsoluteCandidate,
  isLocalShell,
  normalizeShellPath,
  splitOutputLines
} from '../infra/local-exec'
import { runLocalScript, runRemoteScript, type RawExecFn } from './script-runner'
import { auditRunFinished, auditRunStarted } from './script-audit'
import type { JobContext, JobSpec } from './job'
import type { JobLogLevel } from '../../shared/contracts/job'
import type { Repositories } from '../db/repositories'
import {
  DEFAULT_SCRIPT_RUN_LIST_LIMIT,
  LOCAL_SHELLS,
  LOCAL_SHELL_LABELS,
  SCRIPT_RUN_STATUSES,
  SCRIPT_STEP_RUN_KINDS,
  STEP_LOG_MAX_BYTES,
  STEP_TAIL_MAX_CHARS,
  STEP_TAIL_MAX_LINES,
  clampScriptTimeout,
  defaultStepName,
  type LocalShell,
  type ScriptCapabilities,
  type ScriptKind,
  type ScriptRunStatus,
  type ScriptRunStepInput,
  type ScriptRunView,
  type ScriptStepRunKind,
  type ScriptStepRunView
} from '../../shared/contracts/script'

export interface ScriptServiceDeps {
  repo: Repositories
  /** 「允许执行自定义脚本」总闸（**现取**，因为用户随时可能关掉） */
  allowUserScripts: () => boolean
  /** 设置项 `gitBashPath`：手工指定 Git Bash 的位置（null = 自动探测） */
  gitBashPath?: () => string | null
  /** 运行输出目录（`<数据目录>/log/script-runs`） */
  runsDir: () => string
  /** 写进运行记录，多人共用一台机器时才有意义；默认取本机 hostname */
  operator?: () => string
  /**
   * 解释器探测（**仅供单测注入**）。
   *
   * 生产实现要走文件系统与 PATH，而"找不到 Git Bash 时界面灰掉哪一项"这类行为
   * 值得被钉住 —— 用一个可注入的函数比在测试里伪造整个文件系统干净得多。
   */
  resolveShellExe?: (shell: LocalShell) => string | null
  now?: () => Date
}

/** 跑一条（或多条，B21）脚本时的外部依赖。 */
export interface ScriptJobIo {
  /**
   * 打开远端执行通道。**懒开**：只有任务真的跑起来才连服务器。
   *
   * 若在 `scripts.runStep` 的 IPC 里就连服务器，那么"连不上"会变成一次普通的
   * IPC 失败 —— 任务台里什么都不留，用户看不到任何线索。放进 `run()` 里则
   * 变成一次**任务失败**，带日志、带错误码，与发布的行为一致。
   */
  openRemote?: () => Promise<RawExecFn>
}

export interface ScriptService {
  capabilities(): ScriptCapabilities
  /** 构造"跑一条脚本"的任务规格（B21 的流水线用 `pipelineJob`，不走这里） */
  stepJob(input: ScriptRunStepInput, io: ScriptJobIo): JobSpec
  list(targetId: string, limit?: number): ScriptRunView[]
  detail(runId: string): ScriptRunView
  /**
   * 单步执行的**留档器**（B20 的单步与 B21 的每一个步骤共用）。
   *
   * 为什么把它暴露出来而不是各写一份：它内部包着三件踩过坑的事 ——
   * 完整输出落盘（含截断说明）、库内只留尾部、每一行先过 `scrubText`。
   * 抄第二份就等于把这三个坑重新踩一遍。B21 的发布步骤尤其需要它：
   * 发布自己的日志是"文本行"而不是进程输出，但落档方式应当**完全一致**，
   * 否则用户在两种运行记录里会看到两套行为。
   */
  recorder(args: StepRecorderArgs): StepRunRecorder
  /**
   * 跑一步"填脚本"的步骤（`local` / `remote`），自带留档。
   *
   * **不抛错**，用返回值报告失败：调用方（流水线）要根据这一步的 `onFailure`
   * 决定"终止整条"还是"继续往下跑"，抛错会把那个决定权抢走。
   * 真正的失败原因仍在 `errorMessage` 里如实带回来。
   */
  runScriptStep(args: ScriptStepRunArgs): Promise<ScriptStepOutcome>
}

/** 留档器的入参：一条步骤运行记录的描述。 */
export interface StepRecorderArgs {
  runId: string
  /** 1 起；B20 恒为 1，B21 是流水线里的序号 */
  seq: number
  name: string
  kind: ScriptStepRunKind
  /** 本机步骤的解释器；其余传 null */
  shell: LocalShell | null
  /** 行回流（进任务台日志）。不传则只落档，不进任务台 */
  log?: (line: string, level?: JobLogLevel) => void
}

export interface StepRunRecorder {
  readonly stepRunId: string
  /** 已写出的字节数（含被截断之后的部分 —— 它表示"实际产生了多少输出"） */
  readonly bytes: number
  /** 收到一段输出：脱敏后落盘，并按行回吐到日志与库内尾部 */
  feed(text: string): void
  /** 把最后一段没有换行的内容吐出来（进程/步骤结束时必须调） */
  flush(): void
  /** 落终态并关文件。**必须最后调用，且只调一次** */
  close(patch: {
    status: ScriptRunStatus
    exitCode: number | null
    durationMs: number
    errorMessage: string | null
  }): void
}

/** 跑一步脚本的入参。 */
export interface ScriptStepRunArgs {
  runId: string
  seq: number
  name: string
  kind: ScriptKind
  script: string
  /** 仅本机步骤：不传则用平台默认解释器 */
  shell?: LocalShell | null
  /** 仅本机步骤 */
  cwd?: string | null
  timeoutMs: number
  signal: AbortSignal
  io: ScriptJobIo
  log: (line: string, level?: JobLogLevel) => void
  /** 步骤内的百分比与消息（0~100 是**这一步**的进度，不是整条流水线的） */
  progress: (percent: number, message: string) => void
}

export interface ScriptStepOutcome {
  status: ScriptRunStatus
  exitCode: number | null
  errorMessage: string | null
  /**
   * 原始异常（成功时为 null）。
   *
   * 留着它是为了**保住错误码**：`E_SCRIPT_TIMEOUT` 与 `E_SCRIPT_EXIT` 在界面上
   * 的文案与建议完全不同，而 `errorMessage` 只是一句话。调用方直接把这个
   * 对象抛出去，错误码就不会在"返回值 → 异常"的转换里丢掉。
   */
  error: AppError | null
  stepRunId: string
  outputBytes: number
}

/**
 * 「未知长度」的进度近似。
 *
 * 一条脚本要跑多久，事前无从知道（`mvn package` 可能 20 秒也可能 3 分钟）。
 * 直接把百分比钉在 0 会让进度条看起来像卡死，而按"已用时间 / 超时"线性推进
 * 又说谎（脚本在 10% 处成功时会突然跳到 100）。
 *
 * 所以用一条**单调、永远到不了 95** 的曲线：`95 * t / (t + 30s)`。
 * 30 秒时约 47%，2 分钟约 76%，10 分钟约 90%。它只表达"还在动"，
 * 真正的 100% 只在脚本真的结束（且成功）时给。消息里始终带着实际用时，
 * 用户看到的是事实而不是猜测。
 *
 * 放在模块级（而不是 `createScriptService` 里）是因为 B21 的流水线也要用它，
 * 好让"单条脚本"与"流水线里的一步"在界面上的推进手感一致。
 */
export function heuristicPercent(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs)
  return Math.min(95, Math.round((95 * t) / (t + 30_000)))
}

export function createScriptService(deps: ScriptServiceDeps): ScriptService {
  const { repo } = deps
  const now = deps.now ?? ((): Date => new Date())
  const operator = deps.operator ?? ((): string => osHostname())

  /* ---------------------------------------------------------- 解释器探测 */

  /** 在 PATH 里找一个可执行文件（Windows 还要按 PATHEXT 试各个扩展名）。 */
  function findInPath(name: string, env: NodeJS.ProcessEnv): string | null {
    const dirs = (env.PATH ?? env.Path ?? '').split(process.platform === 'win32' ? ';' : ':')
    const exts =
      process.platform === 'win32'
        ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : ['']
    for (const dir of dirs) {
      if (!dir) continue
      for (const ext of exts) {
        const p = join(dir, name + ext)
        if (existsSync(p)) return p
      }
    }
    return null
  }

  function detectShell(shell: LocalShell): string | null {
    // 手工指定的路径优先：Git for Windows 可以装在任意目录，
    // "探测不到"必须有一条自救路径
    if (shell === 'gitbash') {
      const manual = deps.gitBashPath?.()
      if (manual) {
        const p = normalizeShellPath(manual)
        // 用户填错了时**不静默回退到自动探测**：那会让人以为设置生效了
        return existsSync(p) ? p : null
      }
    }
    for (const c of SHELL_EXE_CANDIDATES[shell]) {
      // 绝对路径就直接查文件；其余（`pwsh`、`bash` 这类裸名字）交给 PATH
      if (isAbsoluteCandidate(c)) {
        if (existsSync(c)) return c
        continue
      }
      const found = findInPath(c, process.env)
      if (found) return found
    }
    return null
  }

  const resolveShell = deps.resolveShellExe ?? detectShell

  function shellAvailability(): Array<{
    shell: LocalShell
    available: boolean
    exePath: string | null
  }> {
    return LOCAL_SHELLS.map((shell) => {
      const exePath = resolveShell(shell)
      return { shell, available: exePath !== null, exePath }
    })
  }

  function capabilities(): ScriptCapabilities {
    const shells = shellAvailability()
    const preferred = defaultShellForPlatform(process.platform)
    const preferredOk = shells.find((s) => s.shell === preferred && s.available)
    const firstOk = shells.find((s) => s.available)
    return {
      allowUserScripts: deps.allowUserScripts(),
      shells,
      defaultShell: preferredOk?.shell ?? firstOk?.shell ?? null
    }
  }

  /* -------------------------------------------------------------- 视图 */

  function toStatus(raw: string): ScriptRunStatus {
    return (SCRIPT_RUN_STATUSES as readonly string[]).includes(raw)
      ? (raw as ScriptRunStatus)
      : 'failed'
  }

  /**
   * 步骤类型兜底。
   *
   * 库里存的可能是历史值，也可能被外部工具改坏 —— 认不出来时按 `local` 展示
   * 而不是抛错：一条记录因为一个枚举值读不出来就整条打不开，是更坏的结果。
   */
  function toStepRunKind(raw: string): ScriptStepRunKind {
    return (SCRIPT_STEP_RUN_KINDS as readonly string[]).includes(raw)
      ? (raw as ScriptStepRunKind)
      : 'local'
  }

  function toStepView(row: {
    id: string
    runId: string
    seq: number
    name: string
    kind: string
    shell: string | null
    status: string
    exitCode: number | null
    startedAt: string
    finishedAt: string | null
    durationMs: number | null
    outputPath: string | null
    outputBytes: number
    truncated: boolean
    outputTail: string | null
    errorMessage: string | null
  }): ScriptStepRunView {
    return {
      stepRunId: row.id,
      runId: row.runId,
      seq: row.seq,
      name: row.name,
      kind: toStepRunKind(row.kind),
      shell: isLocalShell(row.shell) ? row.shell : null,
      status: toStatus(row.status),
      exitCode: row.exitCode,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      outputPath: row.outputPath,
      outputBytes: row.outputBytes,
      truncated: row.truncated,
      outputTail: row.outputTail,
      errorMessage: row.errorMessage
    }
  }

  function toRunView(runId: string): ScriptRunView {
    const run = repo.scriptRuns.get(runId)
    if (!run) throw new AppError(ErrorCode.E_NOT_FOUND, { runId })
    return {
      runId: run.id,
      targetId: run.targetId,
      jobId: run.jobId,
      trigger: run.trigger === 'pipeline' ? 'pipeline' : 'step',
      title: run.title,
      status: toStatus(run.status),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      operator: run.operator,
      errorMessage: run.errorMessage,
      steps: repo.scriptStepRuns.listByRun(run.id).map(toStepView)
    }
  }

  /* ---------------------------------------------------------- 输出收集 */

  /**
   * 输出收集器：一条通道同时伺候"落盘"与"库内尾部"。
   *
   * 用同步写入（`writeSync`）而不是流：单步上限 8MB，而流的收尾顺序（何时
   * `finish`、何时 `close`）在"取消/超时"路径上极易出现"记录已落库、文件还差尾巴"。
   * 同步写在小体量下代价可接受，换来确定性。
   */
  function createOutputSink(runId: string, seq: number): {
    outputPath: string | null
    bytes: number
    truncated: boolean
    write: (text: string) => void
    close: () => void
  } {
    let fd: number | null = null
    let path: string | null = null
    let bytes = 0
    let truncated = false

    return {
      get outputPath() {
        return path
      },
      get bytes() {
        return bytes
      },
      get truncated() {
        return truncated
      },
      write(text: string): void {
        bytes += Buffer.byteLength(text, 'utf8')
        if (truncated) return
        try {
          if (fd === null) {
            const dir = join(deps.runsDir(), runId)
            mkdirSync(dir, { recursive: true })
            path = join(dir, `${seq}.log`)
            fd = openSync(path, 'a')
          }
          // 上限按"累计已写入的字节"判定（`bytes` 已经含这一次），
          // 而不是按这一次的块大小 —— 否则一块大输出就能把上限冲过去
          if (bytes > STEP_LOG_MAX_BYTES) {
            truncated = true
            writeSync(
              fd,
              Buffer.from(`\n[输出超过 ${STEP_LOG_MAX_BYTES} 字节，后续内容未保存]\n`, 'utf8')
            )
            return
          }
          writeSync(fd, Buffer.from(text, 'utf8'))
        } catch (err) {
          // 落盘失败不该让脚本本身失败：主进程照跑，只是没有完整日志
          logger.warn(`script output file write failed: ${(err as Error).message}`)
          truncated = true
        }
      },
      close(): void {
        if (fd !== null) {
          try {
            closeSync(fd)
          } catch {
            /* noop */
          }
          fd = null
        }
      }
    }
  }

  /** 库内保留的输出尾部：行数与字符数**两个上限都要**。 */
  function createTail(): { push: (line: string) => void; text: () => string | null } {
    const lines: string[] = []
    let chars = 0
    return {
      push(line: string): void {
        lines.push(line)
        chars += line.length + 1
        // 至少保留最后一行：一条超长单行如果被整个丢掉，尾部就什么都没了
        while (
          lines.length > 1 &&
          (lines.length > STEP_TAIL_MAX_LINES || chars > STEP_TAIL_MAX_CHARS)
        ) {
          const dropped = lines.shift()
          if (dropped !== undefined) chars -= dropped.length + 1
        }
      },
      text(): string | null {
        return lines.length > 0 ? lines.join('\n') : null
      }
    }
  }

  /* ------------------------------------------------------------ 留档器 */

  /**
   * 单步留档器：一条通道同时伺候"落盘"与"库内尾部"，并负责那条步骤运行记录的建与收。
   *
   * B20 的单步与 B21 的每一个步骤都走它 —— **包括发布步骤**。发布没有进程输出，
   * 但它自己的日志行同样要落档，而且形状必须一致：否则用户在"单条脚本"与
   * "流水线"两种记录里会看到两套行为（一个有完整日志、一个只有尾部）。
   */
  function recorder(args: StepRecorderArgs): StepRunRecorder {
    const sink = createOutputSink(args.runId, args.seq)
    const tail = createTail()
    let pending = ''
    let closed = false

    const row = repo.scriptStepRuns.create({
      runId: args.runId,
      seq: args.seq,
      name: args.name,
      kind: args.kind,
      shell: args.shell,
      status: 'running',
      exitCode: null,
      durationMs: null,
      outputPath: null,
      outputBytes: 0,
      truncated: false,
      outputTail: null,
      errorMessage: null
    })

    return {
      stepRunId: row.id,
      get bytes() {
        return sink.bytes
      },
      feed(text: string): void {
        // 顺序很关键：**先脱敏再切行**。反过来的话，一个跨行的 token
        // 会先被切成两半，脱敏规则再也认不出它
        const safe = scrubText(text)
        sink.write(safe)
        const r = splitOutputLines(pending, safe)
        pending = r.pending
        for (const line of r.lines) {
          tail.push(line)
          args.log?.(line)
        }
      },
      flush(): void {
        // 最后一段没有换行的内容也算一行 —— 构建工具的最后一行经常没有 \n
        if (!pending) return
        tail.push(pending)
        args.log?.(pending)
        pending = ''
      },
      close(patch): void {
        // 幂等：失败路径与 finally 都可能走到收尾，重复落终态会把 finishedAt 往前推
        if (closed) return
        closed = true
        sink.close()
        repo.scriptStepRuns.finish(row.id, {
          status: patch.status,
          exitCode: patch.exitCode,
          durationMs: patch.durationMs,
          outputPath: sink.outputPath,
          outputBytes: sink.bytes,
          truncated: sink.truncated,
          outputTail: tail.text(),
          errorMessage: patch.errorMessage
        })
      }
    }
  }

  /* ------------------------------------------------------------ 单步执行 */

  /** 把异常整理成"给人看的一句话"：错误码文案 + 建议一起给，别只留底层 message。 */
  function errorMessageOf(err: unknown): string | null {
    if (err instanceof AppError) return [err.message, err.hint].filter(Boolean).join(' ')
    return err ? String(err) : null
  }

  /**
   * 跑一步"填脚本"的步骤（`local` / `remote`），自带留档。
   *
   * 返回而不是抛错 —— 见 `ScriptService.runScriptStep` 的说明。调用方负责三件事：
   * ① 进总闸检查；② 给出远程通道（`io`）；③ 把返回值翻译成"整条流水线失败还是继续"。
   */
  async function runScriptStep(args: ScriptStepRunArgs): Promise<ScriptStepOutcome> {
    const startedMs = now().getTime()
    // 只有本机步骤才有"解释器"这个概念；远端用的是服务器上的 shell
    // （脚本里要什么解释器由用户自己写，我们只负责把这段文本交过去）
    const shellKind: LocalShell | null =
      args.kind === 'local' ? (args.shell ?? defaultShellForPlatform(process.platform)) : null
    const exePath = shellKind ? resolveShell(shellKind) : null

    const rec = recorder({
      runId: args.runId,
      seq: args.seq,
      name: args.name,
      kind: args.kind,
      shell: shellKind,
      log: args.log
    })

    /**
     * 解释器找不到：**没有东西可跑**，但记录要留下。
     *
     * B20 最初的做法是在建记录之前就抛错，于是"点了执行、任务台里一条红、
     * 运行记录里什么都没有" —— 用户回头想查"那次到底怎么了"时无处可查。
     * 现在留一条写着"没找到解释器"的失败记录，并把它**写进这一步自己的日志**，
     * 让记录自解释。
     */
    if (shellKind && !exePath) {
      const e = new AppError(ErrorCode.E_SCRIPT_SHELL_MISSING, { shell: shellKind })
      const msg = errorMessageOf(e)
      args.log(`没找到 ${LOCAL_SHELL_LABELS[shellKind]}：${msg ?? ''}`, 'error')
      rec.flush()
      rec.close({ status: 'failed', exitCode: null, durationMs: 0, errorMessage: msg })
      return {
        status: 'failed',
        exitCode: null,
        errorMessage: msg,
        error: e,
        stepRunId: rec.stepRunId,
        outputBytes: rec.bytes
      }
    }

    let lineCount = 0
    let exitCode: number | null = null
    let failure: unknown = null

    const onOutput = (text: string): void => {
      // 行数只数**收到的换行**：尾部那段没有换行的内容在 flush 时才成为一行，
      // 提前把它算进去会让人以为输出比实际多一行
      lineCount += (text.match(/\n/g) ?? []).length
      rec.feed(text)
    }

    const ticker = setInterval(() => {
      const elapsed = now().getTime() - startedMs
      args.progress(
        heuristicPercent(elapsed),
        `已用时 ${Math.round(elapsed / 1000)} 秒，输出 ${lineCount} 行`
      )
    }, 1000)

    try {
      args.log(
        shellKind
          ? `开始在本机执行（${LOCAL_SHELL_LABELS[shellKind]}），超时 ${Math.round(args.timeoutMs / 1000)} 秒`
          : `开始在服务器执行，超时 ${Math.round(args.timeoutMs / 1000)} 秒`
      )
      if (args.kind === 'remote') {
        if (!args.io.openRemote) {
          // 这是接线错误（调用方漏给了通道），不是用户的问题 —— 直接抛
          throw new AppError(ErrorCode.E_SCRIPT_DISABLED, { reason: 'no-remote-channel' })
        }
        const exec = await args.io.openRemote()
        const outcome = await runRemoteScript({
          exec,
          script: args.script,
          timeoutMs: args.timeoutMs,
          signal: args.signal,
          onOutput
        })
        exitCode = outcome.exitCode
        if (outcome.exitCode !== 0) {
          throw new AppError(
            ErrorCode.E_SCRIPT_EXIT,
            { exitCode: outcome.exitCode, kind: 'remote' },
            { message: `服务器脚本以退出码 ${outcome.exitCode ?? '(未知)'} 结束` }
          )
        }
      } else {
        const outcome = await runLocalScript({
          shell: shellKind as LocalShell,
          exePath: exePath as string,
          script: args.script,
          cwd: args.cwd ?? null,
          timeoutMs: args.timeoutMs,
          signal: args.signal,
          onOutput
        })
        exitCode = outcome.exitCode
        if (outcome.exitCode !== 0) {
          throw new AppError(
            ErrorCode.E_SCRIPT_EXIT,
            { exitCode: outcome.exitCode, kind: 'local' },
            { message: `本机脚本以退出码 ${outcome.exitCode ?? '(未知)'} 结束` }
          )
        }
      }
    } catch (err) {
      failure = err
    } finally {
      clearInterval(ticker)
      rec.flush()
    }

    const durationMs = Math.max(0, now().getTime() - startedMs)
    const cancelled = args.signal.aborted
    const status: ScriptRunStatus = cancelled ? 'cancelled' : failure ? 'failed' : 'succeeded'
    const errorMessage = cancelled ? '已被取消' : errorMessageOf(failure)

    rec.close({ status, exitCode, durationMs, errorMessage })

    return {
      status,
      exitCode,
      errorMessage,
      error: failure instanceof AppError ? failure : failure ? new AppError(ErrorCode.E_UNKNOWN, { original: String(failure) }) : null,
      stepRunId: rec.stepRunId,
      outputBytes: rec.bytes
    }
  }

  /* -------------------------------------------------------------- 任务 */

  function stepJob(input: ScriptRunStepInput, io: ScriptJobIo): JobSpec {
    const name = input.name ?? defaultStepName(input.kind)
    const timeoutMs = clampScriptTimeout(input.timeoutMs)
    const title = `脚本「${name}」`

    return {
      type: 'script',
      title,
      targetId: input.targetId,
      async run(ctx: JobContext): Promise<ScriptRunView> {
        // 总闸**再查一次**：任务可能在车道里排了一会儿，期间用户可能把开关关了
        if (!deps.allowUserScripts()) {
          throw new AppError(ErrorCode.E_SCRIPT_DISABLED, { targetId: input.targetId })
        }

        const runRow = repo.scriptRuns.create({
          targetId: input.targetId,
          jobId: ctx.jobId,
          trigger: 'step',
          pipelineId: null,
          title,
          status: 'running',
          operator: operator()
        })
        logger.info(`script run ${runRow.id} started: kind=${input.kind} job=${ctx.jobId}`)
        auditRunStarted(repo, {
          runId: runRow.id,
          targetId: input.targetId,
          jobId: ctx.jobId,
          title,
          pipelineId: null,
          steps: 1
        })

        const outcome = await runScriptStep({
          runId: runRow.id,
          seq: 1,
          name,
          kind: input.kind,
          script: input.script,
          shell: input.shell ?? null,
          cwd: input.cwd ?? null,
          timeoutMs,
          signal: ctx.signal,
          io,
          log: (text, level) => ctx.log(text, level),
          progress: (percent, message) =>
            ctx.progress({
              percent,
              stage: input.kind === 'local' ? '本机执行' : '服务器执行',
              message
            })
        })

        repo.scriptRuns.finish(runRow.id, outcome.status, outcome.errorMessage)
        auditRunFinished(repo, {
          runId: runRow.id,
          targetId: input.targetId,
          title,
          status: outcome.status,
          errorMessage: outcome.errorMessage
        })
        logger.info(
          `script run ${runRow.id} ${outcome.status}: kind=${input.kind} bytes=${outcome.outputBytes}`
        )

        /**
         * **失败必须抛错**，不能返回一个"失败的结果对象"。
         *
         * `JobService.execute()` 只把抛出来的异常当作失败 —— 返回对象会被记成
         * `succeeded`：底部任务条变绿、任务列表显示"已完成"，而脚本其实没跑成。
         * 抛**原来那个**异常（而不是新造一个）是为了保住错误码：超时与"非零退出"
         * 在界面上的文案与建议完全不同（B11 的静默失败教训，B20 的 code 复用教训）。
         */
        if (outcome.error) throw outcome.error
        return toRunView(runRow.id)
      }
    }
  }

  function list(targetId: string, limit = DEFAULT_SCRIPT_RUN_LIST_LIMIT): ScriptRunView[] {
    return repo.scriptRuns.listByTarget(targetId, limit).map((r) => toRunView(r.id))
  }

  return {
    capabilities,
    stepJob,
    list,
    detail: toRunView,
    recorder,
    runScriptStep
  }
}
