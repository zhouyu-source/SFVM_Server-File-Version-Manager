/**
 * 脚本的执行通道（B20 / T20.2 ~ T20.4）。
 *
 * 两个 runner：`runLocalScript`（本机 `spawn`）与 `runRemoteScript`（远端一条 SSH 通道）。
 * 两者都只做"跑 + 把输出递出来"，**不碰数据库、不写文件、不拼日志行**：
 * 留档策略（落盘、留尾部、脱敏、进任务日志）统一在 `services/script.ts` 里做，
 * 这样"输出怎么存"只有一处答案。
 *
 * ## 关于"命令"这件事的边界
 *
 * 这个文件是**唯一**一处会把用户填写的字符串当命令执行的地方。
 * 它对应的是设置项 `allowUserScripts`（默认关）与界面上那句
 * 「确保登录的服务器账户权限足够」。而 `infra/remote-exec.ts` 那条
 * "调用方永远不能提供命令字符串"的内部通道**一个字符都没有改动** ——
 * 内部命令依然不可能被注入，这里放开的是用户明确要求的能力。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import {
  buildChildEnv,
  buildKillTreeCommand,
  buildLocalCommand,
  createChunkDecoder
} from '../infra/local-exec'
import type { LocalShell } from '../../shared/contracts/script'

/* ------------------------------------------------------------------ 结果 */

export interface ScriptExecOutcome {
  /** 进程 / 通道的退出码；`null` = 没拿到 */
  exitCode: number | null
  /** 是否被超时终止（与"进程自己以非零码退出"是两回事） */
  timedOut: boolean
  /** 输出字节数（含最后没有换行的那一段） */
  bytes: number
}

/**
 * 收到一段输出。
 *
 * 传**文本块**而不是"已切好的行"，是因为调用方同时要做两件粒度不同的事：
 * 原样落盘（块粒度，省内存）与按行记日志（行粒度）。切行是纯逻辑
 * （`infra/local-exec.ts` 的 `splitOutputLines`），由调用方持有 `pending` 状态。
 */
export type OutputSink = (text: string) => void

/* ------------------------------------------------------------ 本机执行 */

export interface RunLocalScriptInput {
  shell: LocalShell
  /** 解释器可执行文件路径（由服务层探测/设置项决定） */
  exePath: string
  script: string
  cwd?: string | null
  timeoutMs: number
  signal: AbortSignal
  onOutput: OutputSink
}

/** 强制结束一个进程树；失败只记日志（进程可能已经自己退了）。 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  const { command, args } = buildKillTreeCommand(process.platform, pid)
  try {
    const killer = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    killer.on('error', (err) => logger.debug(`kill tree failed: ${err.message}`))
    killer.unref()
  } catch (err) {
    logger.debug(`kill tree spawn failed: ${(err as Error).message}`)
  }
}

/**
 * 在本机跑一条脚本。
 *
 * 取消与超时的收尾**都走"杀进程树"**（而不是只 `child.kill()`）：
 * 见 `infra/local-exec.ts` 的 `buildKillTreeCommand` —— `mvn` 这类工具会拉起
 * 一整个 JVM 进程组，只杀直接子进程会留下孤儿占端口。
 *
 * 取消时**抛错**（`E_JOB_CANCELLED`）而不是返回结果：任务框架把"抛异常"当作
 * 失败/取消的唯一信号，返回一个对象会被记成"已完成"（B11 的教训）。
 */
export function runLocalScript(input: RunLocalScriptInput): Promise<ScriptExecOutcome> {
  return new Promise<ScriptExecOutcome>((resolve, reject) => {
    const { command, args } = buildLocalCommand({
      shell: input.shell,
      exePath: input.exePath,
      script: input.script
    })

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: buildChildEnv(input.shell, process.env),
        // POSIX 下要让整组一起被杀，必须自成进程组（见 buildKillTreeCommand）
        detached: process.platform !== 'win32',
        // stdin 关掉 = **非交互**：`sudo` 这类要读密码的程序会立刻失败，
        // 而不是把任务挂在这里等一个永远不会来的输入
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      reject(
        new AppError(ErrorCode.E_SCRIPT_SHELL_MISSING, { shell: input.shell }, {
          message: `无法启动 ${input.shell}：${(err as Error).message}`
        })
      )
      return
    }

    let settled = false
    let timedOut = false
    let bytes = 0
    let exitCode: number | null = null
    let timer: NodeJS.Timeout | null = null
    let forceTimer: NodeJS.Timeout | null = null

    /**
     * stdout / stderr **各一个**解码器。
     *
     * 不能直接 `chunk.toString('utf8')`：分块边界可能落在多字节字符中间，
     * 中文输出会"偶尔乱一下"。两个流也不能共用解码器（各自独立分块）。
     */
    const outputDecoder = createChunkDecoder()
    const errorDecoder = createChunkDecoder()
    const flushDecoders = (): void => {
      const rest = outputDecoder.end() + errorDecoder.end()
      if (rest) input.onOutput(rest)
    }

    const settle = (err: Error | null, outcome?: ScriptExecOutcome): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      try {
        input.signal.removeEventListener('abort', onAbort)
      } catch {
        /* noop */
      }
      if (err) reject(err)
      else resolve(outcome ?? { exitCode, timedOut, bytes })
    }

    function onAbort(): void {
      killTree(child.pid)
      settle(new AppError(ErrorCode.E_JOB_CANCELLED, { pid: child.pid }))
    }

    timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      // 给 `close` 一点时间把输出交回来；子进程不理会时兜底强结
      forceTimer = setTimeout(() => {
        killTree(child.pid)
        settle(new AppError(ErrorCode.E_SCRIPT_TIMEOUT, { pid: child.pid }))
      }, 3000)
    }, input.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      const text = outputDecoder.push(chunk)
      if (text) input.onOutput(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      // stderr 与 stdout 合并成一路：用户在终端里看到的也是合并的，
      // 分开存反而让"报错夹在正常输出中间"这种最常见的形态看不出上下文
      const text = errorDecoder.push(chunk)
      if (text) input.onOutput(text)
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      /**
       * ENOENT 有两种可能：解释器没了，或工作目录不存在 —— 提示完全不同。
       *
       * **必须实测一下 cwd**，不能"配了 cwd 就赖 cwd"：解释器路径写错时
       * cwd 往往是好端端的，旧写法会把用户支去查一个根本没问题的目录。
       */
      if (err.code === 'ENOENT' && input.cwd && !existsSync(input.cwd)) {
        settle(
          new AppError(ErrorCode.E_LOCAL_PATH_MISSING, { cwd: input.cwd }, {
            message: `工作目录不存在或不可用：${input.cwd}`
          })
        )
        return
      }
      settle(
        new AppError(
          err.code === 'ENOENT' ? ErrorCode.E_SCRIPT_SHELL_MISSING : ErrorCode.E_UNKNOWN,
          { shell: input.shell, exePath: input.exePath, original: err.message },
          { message: `无法启动 ${input.shell}：${err.message}` }
        )
      )
    })

    child.on('close', (code: number | null) => {
      exitCode = code
      // 先把解码器里压着的尾巴交出去，再判终态 —— 否则最后半个字符（以及
      // 最后一段没有换行的输出）会丢
      flushDecoders()
      if (timedOut) {
        settle(new AppError(ErrorCode.E_SCRIPT_TIMEOUT, { pid: child.pid }))
        return
      }
      settle(null, { exitCode, timedOut: false, bytes })
    })

    if (input.signal.aborted) {
      onAbort()
      return
    }
    input.signal.addEventListener('abort', onAbort, { once: true })
  })
}

/* ------------------------------------------------------------ 远端执行 */

/**
 * 一个"把命令送到远端并流式收输出"的函数（由接线层用连接池实现）。
 *
 * 刻意声明成函数类型而不是直接收 `SshConnectionPool`：单测可以给一个几十行的
 * 假实现，而不必伪造整条 ssh2 通道（B07 的教训：越像真的替身越会掩盖真实差异）。
 */
export type RawExecFn = (
  command: string,
  opts: {
    timeoutMs: number
    signal: AbortSignal
    onStdout: (chunk: Buffer) => void
    onStderr: (chunk: Buffer) => void
  }
) => Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>

export interface RunRemoteScriptInput {
  exec: RawExecFn
  script: string
  timeoutMs: number
  signal: AbortSignal
  onOutput: OutputSink
}

/**
 * 在服务器上跑一条脚本。
 *
 * 结束判据用**退出码 + timedOut 标志**，不用事件顺序 —— 与项目里
 * "ssh2 的 `close` 会先于 `finish`"那条教训同源：事件顺序不是协议。
 */
export async function runRemoteScript(input: RunRemoteScriptInput): Promise<ScriptExecOutcome> {
  let bytes = 0
  // 与本地那条路同源：分块边界可能落在多字节字符中间，必须增量解码；
  // stdout / stderr 各一个实例（两条流独立分块）
  const outDecoder = createChunkDecoder()
  const errDecoder = createChunkDecoder()
  try {
    const r = await input.exec(input.script, {
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onStdout: (chunk) => {
        bytes += chunk.length
        const text = outDecoder.push(chunk)
        if (text) input.onOutput(text)
      },
      onStderr: (chunk) => {
        bytes += chunk.length
        const text = errDecoder.push(chunk)
        if (text) input.onOutput(text)
      }
    })
    return { exitCode: r.code, timedOut: r.timedOut, bytes }
  } finally {
    // 通道结束（正常或异常）都要把解码器里压着的字节交出去
    const rest = outDecoder.end() + errDecoder.end()
    if (rest) input.onOutput(rest)
  }
}
