/**
 * 主进程日志（T01.1）。
 *
 * 基于 electron-log：文件传输按大小切割（10 MB）并归档，日志保留 14 天。
 * 所有输出都先经 log-redact 脱敏（T01.2），调用方拿到的 log 对象自带这一步，
 * 避免出现「有的地方记得脱敏、有的地方忘了」。
 *
 * 架构说明（为什么不是顶层 `import log from 'electron-log/main'`）：
 * electron-log 是 CJS 包，其 `main` 入口内部会 `require('electron')`。
 * 顶层导入会让**任何**间接引用本模块的代码（例如 credential 的单测）
 * 都被拖进真实 electron 的解析链，在单测环境里报
 *   "Named export 'BrowserWindow' not found"
 * 因此默认实现改为**延迟获取**：只有真正调用 initLogger() 时才 require 它。
 * 顺带好处是 logger 可注入（单测可传记录型替身）。
 */
import { createRequire } from 'node:module'
import { readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { redact, scrubText } from './log-redact'
import { MAIN_LOG_FILENAME } from './data-location'

export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'

/** 日志保留天数（T01.1 要求 14 天）。 */
export const LOG_RETENTION_DAYS = 14

/**
 * 脚本运行输出的目录名（`<数据目录>/log/script-runs`）。
 *
 * 它是日志目录的**子目录**，所以 `pruneOldLogs()` 那句 `endsWith('.log')` 扫不到它
 * —— 以前这套输出只增不减（单步最大 8 MB，一条 20 步的流水线一次就能产出 20 个文件）。
 * 名字放在这里、由 `main/index.ts` 与 `pruneOldLogs()` 共用，是为了让"写到哪"
 * 与"从哪清"只有一个来源（M13）。
 */
export const SCRIPT_RUNS_DIR_NAME = 'script-runs'

/** 单文件切割阈值。 */
export const LOG_MAX_SIZE = 10 * 1024 * 1024

/** 日志实现的抽象，便于注入与测试。 */
export interface LogImpl {
  error: (...a: unknown[]) => void
  warn: (...a: unknown[]) => void
  info: (...a: unknown[]) => void
  verbose: (...a: unknown[]) => void
  debug: (...a: unknown[]) => void
  silly: (...a: unknown[]) => void
  transports: {
    file: {
      level: string | false
      format: string
      maxSize: number
      archiveLogFn?: (file: { path: string }) => string
      /**
       * 日志文件落点（B18）。
       *
       * electron-log 默认写到 `<userData>/logs/main.log`；数据目录可配之后
       * 必须把它**钉到 `<数据目录>/log/`**，否则"日志跟着数据目录走"这条就假了。
       * 做成可选：单测的替身不需要它（替身的 `getFile()` 直接给固定路径）。
       */
      resolvePathFn?: (vars: unknown) => string
      getFile: () => { path: string }
    }
    console: { level: string | false; format: string }
  }
  errorHandler: { startCatching: (opts?: { showDialog?: boolean }) => void }
}

let impl: LogImpl | null = null
let initialized = false

/** 仅供测试/自定义：注入日志实现。传 null 恢复默认。 */
export function setLogImpl(next: LogImpl | null): void {
  impl = next
  initialized = false
}

/**
 * 延迟加载默认实现（electron-log）。
 * 放在函数里而不是顶层，是为了不把真实 electron 拖进单测的模块图。
 */
function defaultImpl(): LogImpl {
  // 运行时 require：Vite 不静态解析，单测因此不会被动加载 electron-log
  const req = createRequire(import.meta.url)
  const mod = req('electron-log/main') as { default?: LogImpl } & LogImpl
  return (mod.default ?? mod) as LogImpl
}

function getImpl(): LogImpl {
  if (!impl) impl = defaultImpl()
  return impl
}

export interface InitLoggerOptions {
  /**
   * 日志目录（B18）。传了就把日志钉到 `<logDir>/main.log`；
   * 不传则沿用 electron-log 的默认目录（`<userData>/logs`）。
   *
   * 为什么是"钉死一个目录"而不是拼完整文件名：electron-log 自己会管
   * 切割归档（`main.2026-10-02.log`），文件名得留在它手里。
   */
  logDir?: string
}

/**
 * 初始化主进程日志。应在 app ready 之后尽早调用一次。
 * 重复调用安全（幂等）。
 */
export function initLogger(opts: InitLoggerOptions = {}): void {
  if (initialized) return
  initialized = true

  const log = getImpl()

  /**
   * 必须在**任何** `getFile()` 之前设置：electron-log 会缓存解析结果，
   * 一旦先读到默认路径，再改 resolvePathFn 也不会挪窝。
   * 下面紧跟的 `pruneOldLogs()` 与末尾的 `log.info(...)` 都会读它。
   */
  if (opts.logDir) {
    const dir = opts.logDir
    log.transports.file.resolvePathFn = () => join(dir, MAIN_LOG_FILENAME)
  }

  const d = defaultLogLevels()
  // 若在初始化之前就有过级别选择（设置页在启动早期被读到），以它为准
  const chosen = pendingLevel ?? d.file
  log.transports.file.level = chosen
  log.transports.console.level = pendingLevel ? (chosen === 'silly' ? 'debug' : d.console) : d.console

  // 文件格式：时间 + 级别 + 内容，便于人工排查
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {text}'

  // 单文件超过 10 MB 时切割；归档名带日期前缀。
  // 注意：LogFile.path 是 readonly，归档回调要**返回**新路径。
  log.transports.file.maxSize = LOG_MAX_SIZE
  log.transports.file.archiveLogFn = (oldLogFile) => {
    const stamp = new Date().toISOString().slice(0, 10)
    const base = oldLogFile.path.replace(/\.log$/, '')
    return `${base}.${stamp}.log`
  }

  pruneOldLogs()

  // 全局捕获，避免未处理异常悄无声息地丢掉
  log.errorHandler.startCatching({ showDialog: false })

  log.info(
    `logger ready: electron=${process.versions.electron} node=${process.versions.node} ` +
      `level=${log.transports.file.level} retention=${LOG_RETENTION_DAYS}d ` +
      `path=${log.transports.file.getFile().path}`
  )
}

/** 删除超过保留期的日志归档（T01.1）与脚本输出目录（M13）。 */
function pruneOldLogs(): void {
  try {
    const file = getImpl().transports.file.getFile()
    const dir = dirname(file.path)
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000

    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.log')) continue
        const full = join(dir, name)
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
      }
    } catch {
      /* 清理失败不影响主流程 */
    }

    /**
     * M13：脚本运行输出是**子目录**（`script-runs/<runId>/<seq>.log`），上面那句
     * `endsWith('.log')` 永远扫不到它 —— 这套输出以前只增不减。这里按**目录**的
     * mtime 判过期并整棵树删掉（一次运行的所有步骤一起清，不留半棵）。
     *
     * 单独一层 try/catch：`script-runs` 可能还没建出来（`readdirSync` 抛 ENOENT），
     * 也可能某个条目正好被并发写 —— 任何一种都不该让日志文件那条清理白做。
     */
    try {
      const runsDir = join(dir, SCRIPT_RUNS_DIR_NAME)
      for (const name of readdirSync(runsDir)) {
        const full = join(runsDir, name)
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true })
      }
    } catch {
      /* 脚本输出目录尚不存在 / 条目正好在写 —— 忽略 */
    }
  } catch {
    /* 日志目录尚不可用时忽略 */
  }
}

type LogFn = (...args: unknown[]) => void

/** 把任意参数脱敏后展开成可读内容。 */
function sanitizedArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (typeof a === 'string') return scrubText(a)
    return redact(a)
  })
}

/**
 * 已脱敏的 logger。业务代码统一用这个，不要直接用 electron-log。
 *
 * 这些方法在 initLogger() 之前也**安全可调用**：未初始化时退回 console，
 * 早期启动日志不应丢，也不应抛错。
 */
function emit(level: LogLevel, args: unknown[]): void {
  const safe = sanitizedArgs(args)
  if (!impl) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn('[pre-init]', ...safe)
    return
  }
  impl[level](...safe)
}

export const logger = {
  error: ((...a: unknown[]) => emit('error', a)) as LogFn,
  warn: ((...a: unknown[]) => emit('warn', a)) as LogFn,
  info: ((...a: unknown[]) => emit('info', a)) as LogFn,
  verbose: ((...a: unknown[]) => emit('verbose', a)) as LogFn,
  debug: ((...a: unknown[]) => emit('debug', a)) as LogFn,
  silly: ((...a: unknown[]) => emit('silly', a)) as LogFn
}

/** 供设置页展示 / 打开日志目录用。 */
export function logFilePath(): string {
  try {
    return getImpl().transports.file.getFile().path
  } catch {
    return ''
  }
}

/** 默认级别（`level` 传 null 时用它）：开发全给，生产只留 info 以上。 */
export function defaultLogLevels(): { file: LogLevel; console: LogLevel } {
  return { file: is.dev ? 'debug' : 'info', console: is.dev ? 'debug' : 'warn' }
}

/**
 * 运行时切换日志级别（B15 / T15.1：改完立即生效，不用重启）。
 *
 * 传 `null` 表示"跟随默认"（开发 debug / 生产 info）。
 *
 * 两个 transport 一起改，是刻意的：只改文件而把控制台留在 `warn`，
 * 用户在设置里选"调试"之后打开终端什么也看不到，会以为没生效。
 */
export function setLogLevel(level: LogLevel | null): void {
  const d = defaultLogLevels()
  const file = level ?? d.file
  const console = level ?? d.console
  if (!impl) {
    // 未初始化（启动早期）时不主动加载实现：这里只是把选择记下来，
    // `initLogger()` 会用 `pendingLevel` 覆盖默认值
    pendingLevel = level
    return
  }
  impl.transports.file.level = file
  // 控制台不要比文件还安静：选了冗长级别时控制台跟着放开，否则设置看起来没生效
  impl.transports.console.level = file === 'silly' ? 'debug' : console
  impl.info(`log level set: file=${file} console=${impl.transports.console.level}`)
}

/** 启动时若在 `initLogger()` 之前就设过级别，先存这里。 */
let pendingLevel: LogLevel | null = null

/** 当前文件日志级别（设置页回显用；未初始化时给默认）。 */
export function currentLogLevel(): LogLevel {
  if (!impl) return pendingLevel ?? defaultLogLevels().file
  const v = impl.transports.file.level
  return (v === false ? 'error' : v) as LogLevel
}
