/**
 * TransferService（T07.9 ~ T07.11）。
 *
 * 方案书 §6.5。上传/下载的实现要点与理由：
 *
 * ## 为什么大小文件走两条路
 *
 * `ssh2` 的 `fastPut` 内部按 `chunkSize`（默认 32 KB）× `concurrency`（默认 64）
 * 并发写块，小文件因此比"自己 pipe"快得多。但它**不给出可暂停的背压信号**，
 * 300 MB 的产物在慢链路上容易把 SSH 通道灌满、拖垮同连接的 keepalive。
 * 所以 > 32 MB 改走 `createReadStream` → `createWriteStream` + `highWaterMark`
 * 的显式背压路径：任一时刻内存里只有 `highWaterMark` 那么多数据。
 *
 * ## 为什么下载必须落 `.part`
 *
 * "中断后不产生半截正式文件"（T07.10）是**回滚场景的底线**：
 * 用户从往期版本下载一个 jar，如果中断时直接写到了正式文件名，
 * 本地就多了一个看起来完整、实际被截断的文件 —— 比下载失败危险得多。
 * 落 `.part` + 校验 + `rename` 之后，要么是完整的新文件，要么什么都没变。
 *
 * ## 取消与重试的边界
 *
 * - 取消（`AbortSignal`）**不重试**：用户意图明确，立刻销毁流并清理 `.part`
 * - 其它错误按 `1s → 2s → 5s` 退避重试 3 次（复用 `infra/backoff` 的序列）
 */
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { dirname as localDirname, posix } from 'node:path'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { backoffDelay } from '../infra/backoff'
import { hashLocalFile } from './hash'

/** 超过这个大小改走显式背压的流式传输（方案书 §6.5）。 */
export const SMALL_FILE_THRESHOLD = 32 * 1024 * 1024

/**
 * 源读分块大小（单块交给目标流的字节数）。
 *
 * **这个值必须显著小于 `TRANSFER_HIGH_WATER_MARK`**，否则吞吐会被 ssh2 的
 * 串行写拖垮：`WriteStream.prototype._write` 是"发一笔 → 等服务器 ack → 再发下一笔"，
 * 于是吞吐 = `chunkSize / RTT`；只有让目标流攒下**多块**，Node 才会改走
 * `WriteStream.prototype._writev`，而 ssh2 的 `_writev` 会在一个 for 循环里
 * **并发提交全部缓冲块**，这才拿到流水线吞吐。
 *
 * 实测（公网 RTT ≈ 200 ms、服务器 OpenCloudOS 9）：
 *   64 KB 块 + 2 MB 水位 → 约 13 MB/s；256 KB 块 + 256 KB 水位（凑不满一批）→ 约 1.3 MB/s。
 * 即"块大小 == 水位"这种看着最自然的取值，恰好会退化成最慢的串行路径。
 */
export const TRANSFER_CHUNK_SIZE = 64 * 1024

/**
 * 目标缓冲水位。
 *
 * 取值必须远大于 `TRANSFER_CHUNK_SIZE`（这里约 32 块），
 * 目的就是让 `clearBuffer` 每次都能一次性交给 `_writev`。
 * 2 MB × 并发 4 ≈ 8 MB 上限，远低于"300MB 峰值 < 200MB"的门槛。
 */
export const TRANSFER_HIGH_WATER_MARK = 2 * 1024 * 1024

/** 单连接内并发传输数（方案书 §6.5：避免打满 SSH 通道导致 keepalive 超时）。 */
export const DEFAULT_CONCURRENCY = 4

/** 进度上报节流间隔。200 ms 是"看起来连续"与"不刷屏"的折中。 */
export const DEFAULT_PROGRESS_INTERVAL_MS = 200

/** 单文件失败重试次数。 */
export const DEFAULT_FILE_RETRIES = 3

export interface TransferProgress {
  /** 已传字节（含已完成文件与所有在途文件的当前进度） */
  transferred: number
  /** 总字节（调用方未提供大小时会先做一次探测，保证这是准确值） */
  total: number
  currentFile: string
  filesDone: number
  filesTotal: number
}

export interface UploadFile {
  localPath: string
  remotePath: string
  /** 已知大小；省略时会自行 stat 本地文件 */
  size?: number
}

export interface DownloadFile {
  remotePath: string
  localPath: string
  /** 已知大小；省略时会自行 stat 远端文件 */
  size?: number
  /** 期望的 SHA-256；提供时会在 rename 前校验，不一致则整体失败 */
  expectedHash?: string
}

export interface TransferOptions {
  concurrency?: number
  progressIntervalMs?: number
  retries?: number
  signal?: AbortSignal
  onProgress?: (p: TransferProgress) => void
}

export interface TransferSummary {
  bytes: number
  files: number
  /** 实际发生过的重试总次数，用于 UI 提示"链路不稳" */
  retries: number
  elapsedMs: number
}

/** 远端侧的全部 IO，注入以便单测用内存实现覆盖重试/取消语义。 */
export interface TransferPort {
  /** 远端文件大小；不存在返回 null */
  statSize(absPath: string): Promise<number | null>
  /** 逐级创建目录，已存在视为成功 */
  ensureDir(absPath: string): Promise<void>
  fastPut(localPath: string, remotePath: string, onStep?: (written: number) => void): Promise<void>
  fastGet(remotePath: string, localPath: string, onStep?: (read: number) => void): Promise<void>
  createReadStream(absPath: string, highWaterMark?: number): NodeJS.ReadableStream
  createWriteStream(absPath: string, highWaterMark?: number): NodeJS.WritableStream
  rename(from: string, to: string): Promise<void>
  removeFile(absPath: string): Promise<void>
}

function abortError(): AppError {
  return new AppError(ErrorCode.E_JOB_CANCELLED, { reason: 'aborted' })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(v)))
}

/** 可被取消的 sleep（重试退避期间取消要能立刻停）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 尽力销毁流；流可能已经关掉，或类型上不含 destroy（如某些替身实现）。 */
function destroyQuietly(s: unknown): void {
  try {
    const d = (s as { destroy?: (err?: Error) => void } | null | undefined)?.destroy
    if (typeof d === 'function') d.call(s)
  } catch {
    /* 已经关掉了 */
  }
}

/**
 * 把 `src` 管到 `dst`，同时统计字节、响应取消。
 *
 * 用 `pipe` 而不是手写 read/write 循环：`pipe` 自带背压，
 * 上游会按 `dst` 的 `highWaterMark` 暂停 —— 这正是"300MB 上传内存峰值 < 200MB"
 * 能成立的原因。
 */
export function pipeWithProgress(
  src: NodeJS.ReadableStream,
  dst: NodeJS.WritableStream,
  onBytes: (n: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let bytes = 0
    let settled = false

    const finish = (err?: unknown): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (err) {
        destroyQuietly(src)
        destroyQuietly(dst)
        reject(err)
      } else {
        resolve()
      }
    }

    function onAbort(): void {
      finish(abortError())
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    src.on('data', (chunk: Buffer | string) => {
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      onBytes(bytes)
    })
    let srcEnded = false
    src.on('end', () => {
      srcEnded = true
    })
    src.on('error', (err: Error) => finish(err))
    dst.on('error', (err: Error) => finish(err))
    // 注意：不能用"close 早于 finish"当异常判据。
    // ssh2 的 `WriteStream.prototype._final` 是「先 destroy()（→ 'close'）再调 cb（→ 'finish'）」，
    // 于是**正常结束**时 'close' 也会先到，判据会把成功当失败（真机上表现为"数据传完了却报上传中断"）。
    // 真正的不变量是"源是否已经读完"：源读完 ⇒ 数据已全部交给目标流；
    // 源没读完就 close ⇒ 才是链路真的断了。截断风险由调用方的哈希校验兜底。
    dst.on('close', () => {
      if (srcEnded) return finish()
      finish(new AppError(ErrorCode.E_UPLOAD_INTERRUPTED, { reason: 'stream-closed-early', bytes }))
    })
    dst.on('finish', () => finish())

    src.pipe(dst)
  })
}

/**
 * 进度聚合：维护"已完成字节"与"在途文件进度"，并按 200 ms 节流上报。
 *
 * 在途进度存的是**该文件的累计字节**而不是增量，因此某个文件重试时
 * 进度会原地回退再前进 —— 这是对的，"重试"本身就该被看见。
 */
function createProgressReporter(
  filesTotal: number,
  total: number,
  onProgress?: (p: TransferProgress) => void,
  intervalMs = DEFAULT_PROGRESS_INTERVAL_MS
): {
  setInflight: (key: string, bytes: number) => void
  finishFile: (bytes: number) => void
  dropInflight: (key: string) => void
  flush: (force?: boolean) => void
} {
  let doneBytes = 0
  let filesDone = 0
  let currentFile = ''
  let lastEmit = 0
  const inflight = new Map<string, number>()

  function snapshot(): TransferProgress {
    let extra = 0
    for (const v of inflight.values()) extra += v
    const transferred = doneBytes + extra
    return {
      transferred: total > 0 ? Math.min(transferred, total) : transferred,
      total,
      currentFile,
      filesDone,
      filesTotal
    }
  }

  function flush(force = false): void {
    if (!onProgress) return
    const now = Date.now()
    if (!force && now - lastEmit < intervalMs) return
    lastEmit = now
    onProgress(snapshot())
  }

  return {
    setInflight(key, bytes) {
      inflight.set(key, bytes)
      currentFile = key
      flush(false)
    },
    finishFile(bytes) {
      doneBytes += bytes
      filesDone++
      flush(true)
    },
    dropInflight(key) {
      inflight.delete(key)
      flush(false)
    },
    flush
  }
}

/** 简单的并发池：首个错误即停止派发后续任务（其余在途任务自然结束）。 */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0
  const errors: unknown[] = []
  const width = Math.max(1, Math.min(concurrency, items.length))

  async function run(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length || errors.length > 0) return
      try {
        await worker(items[i] as T, i)
      } catch (err) {
        errors.push(err)
        return
      }
    }
  }

  await Promise.all(Array.from({ length: width }, () => run()))
  if (errors.length > 0) throw errors[0]
}

async function withRetry<T>(
  label: string,
  attempts: number,
  fn: (attempt: number) => Promise<T>,
  signal?: AbortSignal,
  onRetry?: () => void,
  delayOf: (attempt: number) => number = backoffDelay
): Promise<T> {
  let attempt = 0
  for (;;) {
    throwIfAborted(signal)
    try {
      return await fn(attempt)
    } catch (err) {
      // 取消是用户意图，绝不重试
      if (err instanceof AppError && err.code === ErrorCode.E_JOB_CANCELLED) throw err
      attempt++
      if (attempt >= attempts) throw err
      onRetry?.()
      const delay = delayOf(attempt - 1)
      logger.warn(
        `传输失败，${delay}ms 后重试（第 ${attempt}/${attempts - 1} 次）：${label} — ${
          (err as Error)?.message
        }`
      )
      await sleep(delay, signal)
    }
  }
}

/**
 * 覆盖式 rename。
 *
 * POSIX 的 `rename(2)` 本来就允许覆盖；Windows 上目标存在会报 EEXIST/EPERM，
 * 于是退化成"先删再改名"。这一步只在**校验通过后**执行，
 * 因此"删了旧的、新的没改名成功"这个窗口极短，且失败会抛出原始错误。
 */
async function replaceFile(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw err
    await fsp.rm(to, { force: true })
    await fsp.rename(from, to)
  }
}

export interface TransferDeps {
  /** 覆盖下载后的校验实现（单测可换成恒定值） */
  hashFile?: (absPath: string, signal?: AbortSignal) => Promise<string>
  /** 覆盖重试退避（默认 `infra/backoff` 的 1s→2s→5s；单测传 1ms 以免拖慢用例） */
  retryDelay?: (attempt: number) => number
}

export function createTransfer(port: TransferPort, deps: TransferDeps = {}) {
  const hashFile = deps.hashFile ?? hashLocalFile
  const retryDelay = deps.retryDelay ?? backoffDelay

  function normalizeOptions(
    o: TransferOptions = {}
  ): Required<Omit<TransferOptions, 'signal' | 'onProgress'>> &
    Pick<TransferOptions, 'signal' | 'onProgress'> {
    return {
      concurrency: clampInt(o.concurrency, DEFAULT_CONCURRENCY, 1, 8),
      progressIntervalMs: clampInt(o.progressIntervalMs, DEFAULT_PROGRESS_INTERVAL_MS, 50, 5000),
      retries: clampInt(o.retries, DEFAULT_FILE_RETRIES, 1, 10),
      signal: o.signal,
      onProgress: o.onProgress
    }
  }

  /** 上传（T07.9）。 */
  async function upload(
    files: readonly UploadFile[],
    options: TransferOptions = {}
  ): Promise<TransferSummary> {
    const started = Date.now()
    const o = normalizeOptions(options)
    throwIfAborted(o.signal)

    // 先把大小定下来，进度条的 total 才准（否则会一路跳）
    const sized: Array<UploadFile & { size: number }> = []
    for (const f of files) {
      throwIfAborted(o.signal)
      let size = f.size
      if (size === undefined) {
        try {
          size = (await fsp.stat(f.localPath)).size
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          throw new AppError(
            code === 'ENOENT' ? ErrorCode.E_LOCAL_PATH_MISSING : ErrorCode.E_LOCAL_READ_DENIED,
            { path: f.localPath, original: (err as Error).message }
          )
        }
      }
      sized.push({ ...f, size })
    }

    const total = sized.reduce((a, f) => a + f.size, 0)
    const reporter = createProgressReporter(sized.length, total, o.onProgress, o.progressIntervalMs)
    let retries = 0

    try {
      await runPool(sized, o.concurrency, async (f) => {
        await withRetry(
          `上传 ${f.remotePath}`,
          o.retries,
          async () => {
            await uploadOne(f, reporter, o.signal)
          },
          o.signal,
          () => {
            retries++
          },
          retryDelay
        )
      })
    } catch (err) {
      // 取消原样抛出（文案是"任务已取消"）；其余包成"上传中断"
      if (err instanceof AppError && err.code === ErrorCode.E_JOB_CANCELLED) throw err
      if (err instanceof AppError) throw err
      throw new AppError(ErrorCode.E_UPLOAD_INTERRUPTED, {
        original: (err as Error)?.message
      })
    } finally {
      reporter.flush(true)
    }

    const summary: TransferSummary = {
      bytes: total,
      files: sized.length,
      retries,
      elapsedMs: Date.now() - started
    }
    logger.info(
      `upload done: ${summary.files} 个文件 / ${summary.bytes} 字节` +
        `${retries ? `（重试 ${retries} 次）` : ''} in ${summary.elapsedMs}ms`
    )
    return summary
  }

  async function uploadOne(
    f: UploadFile & { size: number },
    reporter: ReturnType<typeof createProgressReporter>,
    signal?: AbortSignal
  ): Promise<void> {
    const key = f.remotePath
    const remoteDir = posix.dirname(f.remotePath)
    if (remoteDir && remoteDir !== '.') await port.ensureDir(remoteDir)
    throwIfAborted(signal)

    let lastBytes = 0
    try {
      if (f.size <= SMALL_FILE_THRESHOLD) {
        await port.fastPut(f.localPath, f.remotePath, (written) => {
          lastBytes = written
          reporter.setInflight(key, written)
        })
      } else {
        const src = createReadStream(f.localPath, { highWaterMark: TRANSFER_CHUNK_SIZE })
        const dst = port.createWriteStream(f.remotePath, TRANSFER_HIGH_WATER_MARK)
        await pipeWithProgress(
          src,
          dst,
          (n) => {
            lastBytes = n
            reporter.setInflight(key, n)
          },
          signal
        )
      }
    } catch (err) {
      reporter.dropInflight(key)
      // 取消要保留原始错误码，不能降级成 E_UPLOAD_INTERRUPTED
      if (err instanceof AppError && err.code === ErrorCode.E_JOB_CANCELLED) throw err
      throw new AppError(ErrorCode.E_UPLOAD_INTERRUPTED, {
        remotePath: f.remotePath,
        bytes: lastBytes,
        original: (err as Error)?.message
      })
    }

    if (lastBytes > 0 && lastBytes !== f.size) {
      // 本地文件在传输过程中被改写了：记账按探测到的大小，但必须留痕
      logger.warn(
        `上传字节数与探测到的大小不一致：${f.localPath} 实际 ${lastBytes} vs 期望 ${f.size}`
      )
    }
    reporter.finishFile(f.size)
  }

  /** 下载（T07.10）：写 `.part` → 校验 → rename。 */
  async function download(
    files: readonly DownloadFile[],
    options: TransferOptions = {}
  ): Promise<TransferSummary> {
    const started = Date.now()
    const o = normalizeOptions(options)
    throwIfAborted(o.signal)

    const sized: Array<DownloadFile & { size: number }> = []
    for (const f of files) {
      throwIfAborted(o.signal)
      let size = f.size
      if (size === undefined) {
        const remoteSize = await port.statSize(f.remotePath)
        if (remoteSize === null) {
          throw new AppError(ErrorCode.E_ARCHIVE_MISSING, { remotePath: f.remotePath })
        }
        size = remoteSize
      }
      sized.push({ ...f, size })
    }

    const total = sized.reduce((a, f) => a + f.size, 0)
    const reporter = createProgressReporter(sized.length, total, o.onProgress, o.progressIntervalMs)
    let retries = 0

    try {
      await runPool(sized, o.concurrency, async (f) => {
        await withRetry(
          `下载 ${f.remotePath}`,
          o.retries,
          async () => {
            await downloadOne(f, reporter, o.signal)
          },
          o.signal,
          () => {
            retries++
          },
          retryDelay
        )
      })
    } catch (err) {
      if (err instanceof AppError) throw err
      throw new AppError(ErrorCode.E_DOWNLOAD_INTERRUPTED, { original: (err as Error)?.message })
    } finally {
      reporter.flush(true)
    }

    const summary: TransferSummary = {
      bytes: total,
      files: sized.length,
      retries,
      elapsedMs: Date.now() - started
    }
    logger.info(
      `download done: ${summary.files} 个文件 / ${summary.bytes} 字节` +
        `${retries ? `（重试 ${retries} 次）` : ''} in ${summary.elapsedMs}ms`
    )
    return summary
  }

  async function downloadOne(
    f: DownloadFile & { size: number },
    reporter: ReturnType<typeof createProgressReporter>,
    signal?: AbortSignal
  ): Promise<void> {
    const key = f.remotePath
    const partPath = `${f.localPath}.part`

    try {
      await fsp.mkdir(localDirname(f.localPath), { recursive: true })
    } catch (err) {
      throw new AppError(ErrorCode.E_LOCAL_READ_DENIED, {
        path: f.localPath,
        original: (err as Error).message
      })
    }
    // 清掉上一次尝试留下的半截文件
    await fsp.rm(partPath, { force: true }).catch(() => undefined)
    throwIfAborted(signal)

    let lastBytes = 0
    try {
      if (f.size <= SMALL_FILE_THRESHOLD) {
        await port.fastGet(f.remotePath, partPath, (read) => {
          lastBytes = read
          reporter.setInflight(key, read)
        })
      } else {
        const src = port.createReadStream(f.remotePath, TRANSFER_HIGH_WATER_MARK)
        const dst = createWriteStream(partPath, { highWaterMark: TRANSFER_HIGH_WATER_MARK })
        await pipeWithProgress(
          src,
          dst,
          (n) => {
            lastBytes = n
            reporter.setInflight(key, n)
          },
          signal
        )
      }

      if (f.expectedHash) {
        const got = await hashFile(partPath, signal)
        if (got !== f.expectedHash) {
          throw new AppError(ErrorCode.E_VERIFY_MISMATCH, {
            relPath: f.remotePath,
            expected: f.expectedHash,
            actual: got
          })
        }
      }

      // 校验（或大小核对）通过，才让正式文件名出现
      await replaceFile(partPath, f.localPath)
    } catch (err) {
      reporter.dropInflight(key)
      // 关键不变量：失败/取消后本地不留下半截正式文件
      await fsp.rm(partPath, { force: true }).catch(() => undefined)
      if (err instanceof AppError) throw err
      throw new AppError(ErrorCode.E_DOWNLOAD_INTERRUPTED, {
        remotePath: f.remotePath,
        bytes: lastBytes,
        original: (err as Error)?.message
      })
    }

    if (lastBytes > 0 && lastBytes !== f.size) {
      logger.warn(
        `下载字节数与探测到的大小不一致：${f.remotePath} 实际 ${lastBytes} vs 期望 ${f.size}`
      )
    }
    reporter.finishFile(f.size)
  }

  return { upload, download }
}

export type Transfer = ReturnType<typeof createTransfer>

/* --------------------------------------------------------- ssh2 接线层 */

/** 只声明本文件用到的 SFTP 方法。 */
export interface TransferSftpLike {
  stat(path: string, cb: (err: Error | null | undefined, stats: { size: number }) => void): void
  mkdir(path: string, cb: (err?: Error | null) => void): void
  rename(from: string, to: string, cb: (err?: Error | null) => void): void
  unlink(path: string, cb: (err?: Error | null) => void): void
  fastPut(
    localPath: string,
    remotePath: string,
    options: { step?: (total: number, nb: number, fsize: number) => void },
    cb: (err?: Error | null) => void
  ): void
  fastGet(
    remotePath: string,
    localPath: string,
    options: { step?: (total: number, nb: number, fsize: number) => void },
    cb: (err?: Error | null) => void
  ): void
  createReadStream(path: string, options?: { highWaterMark?: number }): NodeJS.ReadableStream
  createWriteStream(path: string, options?: { highWaterMark?: number }): NodeJS.WritableStream
}

/** 把 ssh2 的 SFTPWrapper 包成 `TransferPort`。 */
export function createSftpTransferPort(sftp: TransferSftpLike): TransferPort {
  async function statSize(absPath: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
      sftp.stat(absPath, (err, stats) => {
        if (err) {
          const e = err as { code?: number; message?: string }
          if (e.code === 2 || /no such file/i.test(e.message ?? '')) resolve(null)
          else reject(new AppError(ErrorCode.E_CONN_LOST, { path: absPath, original: e.message }))
          return
        }
        resolve(stats.size ?? 0)
      })
    })
  }

  /** 逐级 mkdir，已存在忽略 —— 与 remote-fs 的 mkdirp 同语义（不依赖 shell）。 */
  async function ensureDir(absPath: string): Promise<void> {
    const segments = absPath.split('/').filter(Boolean)
    let current = ''
    for (const seg of segments) {
      current += `/${seg}`
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(current, (err) => (err ? reject(err) : resolve()))
        })
      } catch (mkdirErr) {
        // `mkdir` 失败有两种完全不同的原因：目录已存在（正常）与**别的故障**
        // （连接断了、真没权限）。靠"再 stat 一次"区分：能 stat 到就不管，
        // stat 不到才算"建不出来"。
        //
        // 但 stat 本身也可能失败 —— 断链之后它就必然失败。此时**必须报真实原因**：
        // 早期版本在这里一律抛 `E_PARENT_NOT_WRITABLE`，于是"发布中断网"被报成
        // "父目录不可写，请联系运维授权"，把人往完全错误的方向引（B10 真机实测踩到）。
        let size: number | null
        try {
          size = await statSize(current)
        } catch (statErr) {
          throw statErr instanceof AppError ? statErr : mkdirErr
        }
        if (size === null) {
          throw new AppError(ErrorCode.E_PARENT_NOT_WRITABLE, { path: current })
        }
      }
    }
  }

  return {
    statSize,
    ensureDir,
    fastPut(localPath, remotePath, onStep) {
      return new Promise<void>((resolve, reject) => {
        sftp.fastPut(
          localPath,
          remotePath,
          { step: onStep ? (total) => onStep(total) : undefined },
          (err) => (err ? reject(err) : resolve())
        )
      })
    },
    fastGet(remotePath, localPath, onStep) {
      return new Promise<void>((resolve, reject) => {
        sftp.fastGet(
          remotePath,
          localPath,
          { step: onStep ? (total) => onStep(total) : undefined },
          (err) => (err ? reject(err) : resolve())
        )
      })
    },
    createReadStream(absPath, highWaterMark) {
      return sftp.createReadStream(absPath, { highWaterMark })
    },
    createWriteStream(absPath, highWaterMark) {
      return sftp.createWriteStream(absPath, { highWaterMark })
    },
    rename(from, to) {
      return new Promise<void>((resolve, reject) => {
        sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
      })
    },
    removeFile(absPath) {
      return new Promise<void>((resolve, reject) => {
        sftp.unlink(absPath, (err) => (err ? reject(err) : resolve()))
      })
    }
  }
}
