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
import type { JobContext, JobSpec } from './job'
import type { Repositories } from '../db/repositories'
import {
  DEFAULT_SCRIPT_RUN_LIST_LIMIT,
  LOCAL_SHELLS,
  LOCAL_SHELL_LABELS,
  SCRIPT_RUN_STATUSES,
  STEP_LOG_MAX_BYTES,
  STEP_TAIL_MAX_CHARS,
  STEP_TAIL_MAX_LINES,
  clampScriptTimeout,
  defaultStepName,
  type LocalShell,
  type ScriptCapabilities,
  type ScriptRunStatus,
  type ScriptRunStepInput,
  type ScriptRunView,
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
  /** 构造"跑一条脚本"的任务规格（B21 会构造多步的） */
  stepJob(input: ScriptRunStepInput, io: ScriptJobIo): JobSpec
  list(targetId: string, limit?: number): ScriptRunView[]
  detail(runId: string): ScriptRunView
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
      kind: row.kind === 'remote' ? 'remote' : 'local',
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

  /* -------------------------------------------------------------- 任务 */

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
   */
  function heuristicPercent(elapsedMs: number): number {
    const t = Math.max(0, elapsedMs)
    return Math.min(95, Math.round((95 * t) / (t + 30_000)))
  }

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

        const startedMs = now().getTime()
        // 只有本机步骤才有解释器这个概念；远端用的是服务器上的 shell
        // （脚本里要什么解释器由用户自己写，我们只负责把这段文本交过去）
        const shellKind: LocalShell | null =
          input.kind === 'local'
            ? (input.shell ?? defaultShellForPlatform(process.platform))
            : null
        const exePath = shellKind ? resolveShell(shellKind) : null
        if (shellKind && !exePath) {
          throw new AppError(ErrorCode.E_SCRIPT_SHELL_MISSING, { shell: shellKind })
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
        const stepRow = repo.scriptStepRuns.create({
          runId: runRow.id,
          seq: 1,
          name,
          kind: input.kind,
          shell: shellKind,
          status: 'running',
          exitCode: null,
          durationMs: null,
          outputPath: null,
          outputBytes: 0,
          truncated: false,
          outputTail: null,
          errorMessage: null
        })
        logger.info(`script run ${runRow.id} started: kind=${input.kind} job=${ctx.jobId}`)

        const sink = createOutputSink(runRow.id, 1)
        const tail = createTail()
        let pending = ''
        let lineCount = 0
        /** 拿到的退出码。既进错误详情，也进运行记录 —— 别只留在报错文案里 */
        let exitCode: number | null = null

        /** 收到一段输出：原样落盘（脱敏后）+ 切行进任务日志与尾部。 */
        const onOutput = (text: string): void => {
          const safe = scrubText(text)
          sink.write(safe)
          const r = splitOutputLines(pending, safe)
          pending = r.pending
          for (const line of r.lines) {
            lineCount++
            tail.push(line)
            ctx.log(line)
          }
        }

        const ticker = setInterval(() => {
          const elapsed = now().getTime() - startedMs
          ctx.progress({
            percent: heuristicPercent(elapsed),
            stage: input.kind === 'local' ? '本机执行' : '服务器执行',
            message: `已用时 ${Math.round(elapsed / 1000)} 秒，输出 ${lineCount} 行`
          })
        }, 1000)

        let failure: unknown = null
        try {
          ctx.log(
            `开始${shellKind ? `在本机执行（${LOCAL_SHELL_LABELS[shellKind]}）` : '在服务器执行'}，超时 ${Math.round(timeoutMs / 1000)} 秒`
          )
          if (input.kind === 'remote') {
            if (!io.openRemote) {
              throw new AppError(ErrorCode.E_SCRIPT_DISABLED, { reason: 'no-remote-channel' })
            }
            const exec = await io.openRemote()
            const outcome = await runRemoteScript({
              exec,
              script: input.script,
              timeoutMs,
              signal: ctx.signal,
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
              script: input.script,
              cwd: input.cwd ?? null,
              timeoutMs,
              signal: ctx.signal,
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
          // 收尾：把最后一段没有换行的内容也吐出来（构建工具的最后一行经常没有 \n）
          if (pending) {
            tail.push(pending)
            ctx.log(pending)
            pending = ''
          }
          sink.close()
        }

        const durationMs = Math.max(0, now().getTime() - startedMs)
        const cancelled = ctx.signal.aborted
        const status: ScriptRunStatus = cancelled ? 'cancelled' : failure ? 'failed' : 'succeeded'
        const errorMessage = cancelled
          ? '已被取消'
          : failure instanceof AppError
            ? [failure.message, failure.hint].filter(Boolean).join(' ')
            : failure
              ? String(failure)
              : null

        repo.scriptStepRuns.finish(stepRow.id, {
          status,
          exitCode,
          durationMs,
          outputPath: sink.outputPath,
          outputBytes: sink.bytes,
          truncated: sink.truncated,
          outputTail: tail.text(),
          errorMessage
        })
        repo.scriptRuns.finish(runRow.id, status, errorMessage)
        logger.info(
          `script run ${runRow.id} ${status}: kind=${input.kind} exitOk=${failure === null} bytes=${sink.bytes}`
        )

        if (failure) throw failure
        return toRunView(runRow.id)
      }
    }
  }

  function list(targetId: string, limit = DEFAULT_SCRIPT_RUN_LIST_LIMIT): ScriptRunView[] {
    return repo.scriptRuns.listByTarget(targetId, limit).map((r) => toRunView(r.id))
  }

  return { capabilities, stepJob, list, detail: toRunView }
}
