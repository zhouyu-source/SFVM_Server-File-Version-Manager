/**
 * HashService（T07.1 ~ T07.8）。
 *
 * 方案书 §6.6。本文件是"后续所有正确性的地基"：B09 的 manifest、B10 的发布校验、
 * B13 的回滚校验、B14 的对账都调用这里。
 *
 * ## 分层
 *
 * - 本地侧：`hashLocalArtifact` 走 `node:fs` 流式读，64KB 分块，**不整文件入内存**
 * - 远端侧：`verifyRemote` 按能力挑分支（sha256sum → shasum → SFTP 流式降级）
 * - 纯逻辑（排序 / 聚合 / 清单文本 / 差异）全部在 `infra/hash-core.ts`，本文件只做 IO
 *
 * ## 为什么远端校验依赖注入成 `RemoteHashPort`
 *
 * 远端校验要同时用到三条能力（跑命令、读写远端文件、列目录）。直接依赖 ssh2
 * 会让"篡改一个字节能被检出"这类关键用例必须真机才能跑。抽成端口后，
 * 单测可以塞一个**内存文件系统**，把命令路径与降级路径都覆盖到，
 * 真机集成测试只负责验证 ssh2 语义差异（错误码、流行为）。
 */
import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { compileExclude } from '../infra/glob'
import {
  buildSha256SumFile,
  compareRelPathUtf8,
  computeRootHash,
  diffByCheckOutput,
  diffByHashes,
  isSafeRelPath,
  joinRemote,
  parseSha256SumOutput,
  sortByRelPathUtf8,
  sumBytes,
  type ParsedCheckLine
} from '../infra/hash-core'
import { pickVerifyMode, type ConnectionCapability } from '../infra/capability'
import { assertCommandAllowed, buildHashCheckCommand } from '../infra/remote-exec'
import { normalizeRemotePath } from '../infra/remote-path'
import type { TargetKind } from '../../shared/contracts/workspace'
import type {
  LocalHashResult,
  ReleaseItem,
  RemoteVerifyResult,
  VerifyDiff
} from '../../shared/contracts/hash'

/** 本地哈希的分块大小（方案书 §6.6 指定 64 KB）。 */
export const HASH_CHUNK_SIZE = 64 * 1024

/** 目录递归层级上限，防御异常目录结构。 */
export const MAX_WALK_DEPTH = 64

/** 产物文件数上限，与 `services/remote-fs.ts` 的 MAX_ENTRIES 保持一致。 */
export const MAX_LOCAL_FILES = 200000

/* ---------------------------------------------------------------- 工具 */

export type HashProgressFn = (done: number, total: number, currentFile: string) => void

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError(ErrorCode.E_JOB_CANCELLED, { reason: 'aborted' })
  }
}

/** 把 node:fs 的 errno 映射成语义明确的中文错误（方案书 §11）。 */
export function mapLocalFsError(err: unknown, absPath: string): AppError {
  const e = err as NodeJS.ErrnoException
  const code = e?.code ?? ''
  const detail = { path: absPath, errno: code, original: e?.message }
  switch (code) {
    case 'ENOENT':
      return new AppError(ErrorCode.E_LOCAL_PATH_MISSING, detail)
    case 'EACCES':
    case 'EPERM':
      return new AppError(ErrorCode.E_LOCAL_READ_DENIED, detail)
    case 'EBUSY':
    case 'ETXTBSY':
      return new AppError(ErrorCode.E_LOCAL_PATH_BUSY, detail)
    case 'EISDIR':
    case 'ENOTDIR':
      return new AppError(ErrorCode.E_LOCAL_PATH_KIND, detail)
    default:
      return new AppError(ErrorCode.E_LOCAL_READ_DENIED, detail)
  }
}

/* ------------------------------------------------------------ 本地哈希 */

/** 对一个可读流做 SHA-256。供"本地文件"与"远端 SFTP 流"两条路径共用。 */
export async function hashReadable(
  stream: NodeJS.ReadableStream,
  signal?: AbortSignal
): Promise<string> {
  const h = createHash('sha256')
  // NodeJS.ReadableStream 的类型定义不含 async 迭代器，但运行时所有 Node 流都支持
  for await (const chunk of stream as unknown as AsyncIterable<Buffer | string>) {
    checkAborted(signal)
    h.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return h.digest('hex')
}

/**
 * 单文件流式 SHA-256（T07.1）。
 *
 * 用 `highWaterMark = 64KB` 的读流 + for-await：任一时刻内存里只有一块分块，
 * 因此 300MB 文件与 3KB 文件的内存开销相同。
 *
 * 读流的错误（ENOENT / EACCES / EISDIR）在 for-await 时以异常抛出，
 * 统一交给 `mapLocalFsError` 换成中文错误码。
 */
export async function hashLocalFile(absPath: string, signal?: AbortSignal): Promise<string> {
  const stream = createReadStream(absPath, { highWaterMark: HASH_CHUNK_SIZE })
  try {
    return await hashReadable(stream, signal)
  } catch (err) {
    if (err instanceof AppError) throw err
    throw mapLocalFsError(err, absPath)
  }
}

export interface LocalFileEntry {
  relPath: string
  absPath: string
  size: number
  mtime: string
}

export interface CollectResult {
  files: LocalFileEntry[]
  excludedCount: number
  skippedSymlinks: number
}

/**
 * 目录递归收集 + `local_exclude` 过滤（T07.2）。
 *
 * 三个刻意的选择：
 * - **不跟随符号链接**：可能成环，也可能指向产物根之外，会让"本地清单"与
 *   "远端实际文件"不再一一对应。跳过数量会回报给调用方。
 * - **按 UTF-8 字节序排序遍历**：最终 rootHash 会重排，但稳定的遍历顺序让
 *   日志与进度可复现，排障时不会"每次看到不同的文件顺序"。
 * - **含隐藏文件**：产物里的 `.htaccess` / `.env.example` 是真实内容，
 *   不该被"看不见"这个理由悄悄丢掉。
 */
export async function collectLocalFiles(opts: {
  root: string
  exclude?: readonly string[] | null
  signal?: AbortSignal
  maxFiles?: number
}): Promise<CollectResult> {
  const matcher = compileExclude(opts.exclude)
  // P1-2：语法坏（正则编译失败）的排除规则会被跳过 —— 必须说出来，否则用户
  // 写的规则没生效还不知道，"排除结果与预期偏离"这类问题最难排查。
  if (matcher.skipped.length > 0) {
    logger.warn(
      `${matcher.skipped.length} 条排除规则无法解析，已忽略：` +
        matcher.skipped.map((s) => JSON.stringify(s)).join('、')
    )
  }
  const maxFiles = opts.maxFiles ?? MAX_LOCAL_FILES
  const files: LocalFileEntry[] = []
  let excludedCount = 0
  let skippedSymlinks = 0

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) {
      throw new AppError(ErrorCode.E_ARTIFACT_TOO_MANY_FILES, { reason: 'max-depth', dir })
    }
    checkAborted(opts.signal)

    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      throw mapLocalFsError(err, dir)
    }
    entries.sort((a, b) => compareRelPathUtf8(a.name, b.name))

    for (const e of entries) {
      checkAborted(opts.signal)
      const relPath = prefix ? `${prefix}/${e.name}` : e.name

      if (matcher.matches(relPath)) {
        excludedCount++
        continue
      }
      if (!isSafeRelPath(relPath)) {
        // 含换行 / 空字符的文件名无法进入行式清单，也无法可靠地远端寻址。
        // 明确报错而不是静默跳过 —— 静默跳过等于"发布了但少了个文件"。
        throw new AppError(
          ErrorCode.E_LOCAL_PATH_KIND,
          { relPath: JSON.stringify(relPath), reason: 'filename-has-control-char' },
          {
            message: '产物中存在文件名含换行或空字符的文件，无法纳入版本清单',
            hint: '请先重命名该文件（这类文件名无法可靠地上传与校验）。'
          }
        )
      }

      const abs = join(dir, e.name)
      if (e.isSymbolicLink()) {
        skippedSymlinks++
        continue
      }
      if (e.isDirectory()) {
        await walk(abs, relPath, depth + 1)
        continue
      }
      if (!e.isFile()) {
        // FIFO / socket / 设备文件：不该出现在发布产物里
        skippedSymlinks++
        continue
      }

      let st
      try {
        st = await fsp.stat(abs)
      } catch (err) {
        throw mapLocalFsError(err, abs)
      }
      files.push({ relPath, absPath: abs, size: st.size, mtime: st.mtime.toISOString() })
      if (files.length > maxFiles) {
        throw new AppError(ErrorCode.E_ARTIFACT_TOO_MANY_FILES, {
          count: files.length,
          limit: maxFiles
        })
      }
    }
  }

  await walk(opts.root, '', 0)
  return { files, excludedCount, skippedSymlinks }
}

export interface HashLocalInput {
  /** 本地绝对路径：目录型目标给目录，文件型目标给文件 */
  localPath: string
  kind: TargetKind
  exclude?: readonly string[] | null
  onProgress?: HashProgressFn
  signal?: AbortSignal
}

/**
 * 算出一个本地产物的完整清单与指纹（T07.1 ~ T07.4）。
 *
 * 文件型目标**不套用 `local_exclude`**：用户已经明确选了这一个文件，
 * 再拿排除规则把它本身排掉只会造成"发布成功但什么都没传"的困惑。
 */
export async function hashLocalArtifact(input: HashLocalInput): Promise<LocalHashResult> {
  const started = Date.now()
  const signal = input.signal
  checkAborted(signal)

  let st
  try {
    st = await fsp.stat(input.localPath)
  } catch (err) {
    throw mapLocalFsError(err, input.localPath)
  }

  let files: LocalFileEntry[]
  let excludedCount = 0
  let skippedSymlinks = 0

  if (st.isDirectory()) {
    if (input.kind === 'file') {
      throw new AppError(ErrorCode.E_LOCAL_PATH_KIND, {
        path: input.localPath,
        actual: 'dir',
        expected: 'file'
      })
    }
    const collected = await collectLocalFiles({
      root: input.localPath,
      exclude: input.exclude,
      signal
    })
    files = collected.files
    excludedCount = collected.excludedCount
    skippedSymlinks = collected.skippedSymlinks
  } else if (st.isFile()) {
    if (input.kind === 'dir') {
      throw new AppError(ErrorCode.E_LOCAL_PATH_KIND, {
        path: input.localPath,
        actual: 'file',
        expected: 'dir'
      })
    }
    files = [
      {
        relPath: basename(input.localPath),
        absPath: input.localPath,
        size: st.size,
        mtime: st.mtime.toISOString()
      }
    ]
  } else {
    throw new AppError(ErrorCode.E_LOCAL_PATH_KIND, {
      path: input.localPath,
      actual: 'special',
      expected: input.kind
    })
  }

  const ordered = sortByRelPathUtf8(files)
  const items: ReleaseItem[] = []
  for (const f of ordered) {
    checkAborted(signal)
    const hash = await hashLocalFile(f.absPath, signal)
    items.push({ relPath: f.relPath, hash, size: f.size, mtime: f.mtime })
    input.onProgress?.(items.length, ordered.length, f.relPath)
  }

  const result: LocalHashResult = {
    rootHash: computeRootHash(items),
    items,
    totalBytes: sumBytes(items),
    fileCount: items.length,
    excludedCount,
    skippedSymlinks,
    durationMs: Date.now() - started
  }
  logger.debug(
    `local hash: root=${result.rootHash.slice(0, 12)} files=${result.fileCount} ` +
      `bytes=${result.totalBytes} excluded=${excludedCount} symlinks=${skippedSymlinks} ` +
      `in ${result.durationMs}ms`
  )
  return result
}

/* -------------------------------------------------- 远端校验（T07.5~T07.8） */

/** 单文件大小上限：单个文件不允许超过 8 GB（防御整数溢出与时间估算失真）。 */
export const MAX_REMOTE_FILE_BYTES = 8 * 1024 * 1024 * 1024

/**
 * 远端哈希所需的全部副作用，全部注入。
 *
 * 这样单测可以拿一个"内存远端"把两条分支都跑到，
 * 真机集成测试只用来验证 ssh2 的真实语义。
 */
export interface RemoteHashPort {
  capability: Pick<ConnectionCapability, 'hasSha256sum' | 'hasShasum' | 'platform' | 'homeDir'>
  /** 远端临时目录（`$HOME/.sfvm-tmp`），调用方保证已创建 */
  tmpDir: string
  /** 单个远端文件的大小；不存在返回 null（归档文件型目标时要读它） */
  statSize(remoteAbsPath: string): Promise<number | null>
  /** 写一个文本文件（上传清单用） */
  writeTextFile(remoteAbsPath: string, content: string): Promise<void>
  /** 删除远端文件；失败不致命（临时目录会另行清理） */
  removeFile(remoteAbsPath: string): Promise<void>
  /** 执行一条**已经白名单化**的命令 */
  runCommand(cmd: string): Promise<{ stdout: string; stderr: string; code: number | null }>
  /** 打开远端文件读流（降级路径） */
  readStream(remoteAbsPath: string): NodeJS.ReadableStream
  /** 递归列出远端目录下的文件（相对路径 + 大小 [+ mtime]） */
  listFiles(root: string): Promise<Array<{ relPath: string; size: number; mtime?: string }>>
}

export interface VerifyRemoteInput {
  port: RemoteHashPort
  /** relPath 相对的远端目录（远端暂存/归档目录） */
  payloadDir: string
  expected: readonly ReleaseItem[]
  /** 用于生成唯一的临时清单文件名 */
  releaseId: string
  /** 目标上的"发布后校验"开关；关闭时直接返回 disabled */
  verifyRemoteEnabled?: boolean
  /**
   * 是否允许"远端没有 hash 工具时降级为 SFTP 流式计算"（B15 / T15.1 的算法兼容模式）。
   *
   * 默认 `true`（与历史行为一致）。设为 `false` 时，遇到既无 `sha256sum` 也无
   * `shasum` 的服务器**直接报错中止**，而不是悄悄换成一条慢链路 ——
   * 有些环境明确要求"宁可拒绝发布，也不接受一条慢链路跑出来的校验结果"。
   */
  allowStreamFallback?: boolean
  signal?: AbortSignal
  onProgress?: HashProgressFn
}

/** 从 stdout 尾部截一段给排障用，避免把 5 万行输出塞进错误详情。 */
function tailOf(text: string, max = 2000): string {
  if (text.length <= max) return text
  return `…（前 ${text.length - max} 字符已省略）\n${text.slice(-max)}`
}

/**
 * 远端校验主入口。
 *
 * 分支选择在 `capability.pickVerifyMode` 里（纯函数、有单测）。
 */
export async function verifyRemote(input: VerifyRemoteInput): Promise<RemoteVerifyResult> {
  const started = Date.now()
  const payload = normalizeRemotePath(input.payloadDir)
  const mode = pickVerifyMode(input.port.capability, input.verifyRemoteEnabled !== false)

  if (mode === 'disabled') {
    // 返回一份"未校验"的空结果：调用方（B10）会据此在台账标记 root_hash 来源为本地
    return {
      mode,
      diff: { missing: [], extra: [], mismatch: [], matchedCount: 0, ok: true },
      durationMs: Date.now() - started
    }
  }

  if (mode === 'sftp-stream') {
    /**
     * 算法兼容模式关闭时**不静默降级**。
     *
     * 这里刻意放在 `pickVerifyMode` 之后而不是给它加一个 `'unavailable'` 返回值：
     * 那个函数的返回值有多个消费方（UI 徽标、日志、发布分支判断），多一个取值
     * 就要在每处判断里都记得处理它，漏一处就会走进"既不是命令校验也不是流式"的
     * 缝隙。放这里则只有一条路径会到达。
     */
    if (input.allowStreamFallback === false) {
      throw new AppError(
        ErrorCode.E_NO_REMOTE_HASH_TOOL,
        { reason: 'compat-mode-disabled' },
        {
          message: '服务器上没有 sha256sum / shasum，且「算法兼容模式」已关闭',
          hint:
            '请让运维安装 coreutils（提供 sha256sum），或在「设置 → 算法兼容模式」重新开启，' +
            '让本工具用 SFTP 流式计算替代。'
        }
      )
    }
    logger.warn('远端无 sha256sum / shasum，降级为 SFTP 流式计算（速度较慢）')
    return verifyViaSftpStream({ ...input, payloadDir: payload, mode })
  }

  return verifyViaCommand({ ...input, payloadDir: payload, mode })
}

/** 命令分支：上传清单 → `<tool> -c` → 解析 → 删除清单。 */
async function verifyViaCommand(
  input: VerifyRemoteInput & { payloadDir: string; mode: 'sha256sum' | 'shasum' }
): Promise<RemoteVerifyResult> {
  const started = Date.now()
  const { port, payloadDir, expected, mode } = input
  const tmpDir = normalizeRemotePath(port.tmpDir)
  const manifestPath = joinRemote(tmpDir, `sfvm-${sanitizeId(input.releaseId)}.sha256`)

  const content = buildSha256SumFile(expected)
  if (!content) {
    // 空清单：没有任何文件要校验，直接通过（空目录是合法产物）
    return {
      mode,
      diff: { missing: [], extra: [], mismatch: [], matchedCount: 0, ok: true },
      durationMs: Date.now() - started
    }
  }

  const cmd = buildHashCheckCommand({ tool: mode, cwd: payloadDir, manifestPath })
  assertCommandAllowed(cmd)

  // 用对象承载结果：清理必须放在 finally，而 finally 之后的变量赋值
  // 会被 TS 判定为"可能未赋值"。写成属性就不会有这个问题，语义也更直白。
  const outcome: { stdout: string; stderr: string; code: number | null } = {
    stdout: '',
    stderr: '',
    code: null
  }
  try {
    await port.writeTextFile(manifestPath, content)
    const res = await port.runCommand(cmd)
    outcome.stdout = res.stdout
    outcome.stderr = res.stderr
    outcome.code = res.code
  } finally {
    // 清单里有全部文件的哈希，属于"部署细节"，校验完立刻删掉（方案书 §6.6）
    try {
      await port.removeFile(manifestPath)
    } catch (err) {
      logger.warn(`清理远端清单失败（不影响校验结果）：${(err as Error).message}`)
    }
  }

  const { stdout, stderr, code } = outcome
  const lines: ParsedCheckLine[] = parseSha256SumOutput(stdout)
  let diff = diffByCheckOutput(expected, lines)

  // 命令报错、但逐行结果看起来全对：说明输出不是我们预期的格式
  // （例如远端 coreutils 版本差异、或命令被 wrapper 打断）。
  // 这时不能报"通过" —— 宁可误报失败，也不能放过一次真实的损坏。
  if (code !== 0 && diff.ok) {
    diff = {
      ...diff,
      ok: false,
      mismatch: [
        {
          relPath: '<unparsed>',
          expected: `${expected.length} 个文件的清单`,
          actual: null
        }
      ]
    }
    logger.error(`远端校验命令退出码 ${code}，但未能解析出任何差异；stderr=${tailOf(stderr, 500)}`)
  }

  logger.info(
    `remote verify(${mode}) dir=${payloadDir} exit=${code} matched=${diff.matchedCount} ` +
      `missing=${diff.missing.length} mismatch=${diff.mismatch.length} in ${Date.now() - started}ms`
  )

  return {
    mode,
    diff,
    durationMs: Date.now() - started,
    rawTail: tailOf([stdout, stderr].filter(Boolean).join('\n--- stderr ---\n'))
  }
}

/** 降级分支：逐个文件通过 SFTP 读流算哈希。慢但正确。 */
async function verifyViaSftpStream(
  input: VerifyRemoteInput & { payloadDir: string; mode: 'sftp-stream' }
): Promise<RemoteVerifyResult> {
  const started = Date.now()
  const { port, payloadDir, expected, signal, mode } = input

  const remoteFiles = await port.listFiles(payloadDir)
  const actual = new Map<string, string>()
  /** 远端出现了清单机制之外的怪文件名（含换行等）：算作 extra，不参与哈希 */
  const unhashable: string[] = []
  let done = 0
  for (const f of remoteFiles) {
    checkAborted(signal)
    if (!isSafeRelPath(f.relPath)) {
      unhashable.push(f.relPath)
      continue
    }
    if (f.size > MAX_REMOTE_FILE_BYTES) {
      throw new AppError(ErrorCode.E_VERIFY_MISMATCH, {
        relPath: f.relPath,
        size: f.size,
        reason: 'file-too-large'
      })
    }
    const abs = joinRemote(payloadDir, f.relPath)
    const hash = await hashReadable(port.readStream(abs), signal)
    actual.set(f.relPath, hash)
    done++
    input.onProgress?.(done, remoteFiles.length, f.relPath)
  }

  const diff: VerifyDiff = diffByHashes(expected, actual)
  if (unhashable.length > 0) {
    diff.extra.push(...unhashable)
    diff.extra.sort(compareRelPathUtf8)
    diff.ok = false
  }
  logger.info(
    `remote verify(sftp-stream) dir=${payloadDir} files=${remoteFiles.length} ` +
      `matched=${diff.matchedCount} in ${Date.now() - started}ms`
  )
  return { mode, diff, durationMs: Date.now() - started }
}

/** 临时清单文件名只允许安全字符，避免 releaseId 里混进路径分隔符。 */
function sanitizeId(id: string): string {
  const s = (id ?? '').replace(/[^A-Za-z0-9_-]/g, '')
  return s || 'unknown'
}

/* ------------------------------------------------- 远端指纹计算（B09） */

export interface RemoteHashComputeResult {
  rootHash: string
  items: ReleaseItem[]
  totalBytes: number
  fileCount: number
  /**
   * 名字含换行/空字符、无法进入行式校验清单的文件（相对路径）。
   *
   * 刻意**不静默跳过**：归档一份"清单表达不全"的版本，等于让往期版本库
   * 从此对不上号。调用方（归档服务）会据此直接拒绝归档并给出文件名。
   */
  unsafeRelPaths: string[]
}

export interface HashRemoteArtifactInput {
  port: RemoteHashPort
  /** 要算指纹的远端路径：目录型给目录，文件型给文件 */
  remotePath: string
  kind: TargetKind
  signal?: AbortSignal
  onProgress?: HashProgressFn
  /**
   * 加在所有 `relPath` 前的统一前缀（归档时用）。
   *
   * 归档把目标整体 rename 到 `<storagePath>/payload/<basename>`，
   * 而 manifest 的相对根是 `payload`，于是目录型目标需要补一层 `<basename>/`。
   * 见 `shared/contracts/archive.ts` 的约定 1。
   */
  relPathPrefix?: string
}

/**
 * 对远端**现有内容**算一份完整清单与聚合指纹（B09 归档需要）。
 *
 * 与 `verifyRemote` 的分工：那个是"拿期望值去比对"，这个是"算出期望值"。
 * 归档一个首次接管的目录时必须用它 —— 本工具此前没见过这份内容，
 * 没有可比的清单，只能自己算。
 *
 * 实现走 SFTP 读流（而不是远端命令）：
 * - 命令模式需要"把哈希值喂给 sha256sum"，没有"算出哈希"的命令形态；
 * - 逐文件 `sha256sum` 等于 N 次往返，比流式读还慢；
 * - 端口只有 `listFiles` + `readStream` 两个能力，跨平台一致（BSD/macOS 同样可用）。
 *
 * **代价**：受服务器出带宽限制（实测某机器 ~0.46 MB/s）。
 * 所以 B10 在"上一版是 SVFM 自己发布的"这种情况下会把已知清单直接传进来，
 * 只有首次接管才真的走这条慢路径。
 */
export async function hashRemoteArtifact(
  input: HashRemoteArtifactInput
): Promise<RemoteHashComputeResult> {
  const root = normalizeRemotePath(input.remotePath)
  const prefix = (input.relPathPrefix ?? '').replace(/^\/+|\/+$/g, '')
  const withPrefix = (relPath: string): string => (prefix ? `${prefix}/${relPath}` : relPath)

  const items: ReleaseItem[] = []
  const unsafeRelPaths: string[] = []

  if (input.kind === 'file') {
    const size = await input.port.statSize(root)
    if (size === null) {
      throw new AppError(ErrorCode.E_TARGET_MISSING, { path: root, reason: 'file-not-found' })
    }
    const hash = await hashReadable(input.port.readStream(root), input.signal)
    items.push({ relPath: withPrefix(basename(root)), hash, size, mtime: null })
    input.onProgress?.(1, 1, root)
  } else {
    const remoteFiles = await input.port.listFiles(root)
    let done = 0
    for (const f of remoteFiles) {
      checkAborted(input.signal)
      if (!isSafeRelPath(f.relPath)) {
        unsafeRelPaths.push(f.relPath)
        continue
      }
      if (f.size > MAX_REMOTE_FILE_BYTES) {
        throw new AppError(ErrorCode.E_ARTIFACT_TOO_MANY_FILES, {
          relPath: f.relPath,
          size: f.size,
          reason: 'file-too-large'
        })
      }
      const hash = await hashReadable(input.port.readStream(joinRemote(root, f.relPath)), input.signal)
      items.push({
        relPath: withPrefix(f.relPath),
        hash,
        size: f.size,
        mtime: f.mtime ?? null
      })
      done++
      input.onProgress?.(done, remoteFiles.length, f.relPath)
    }
  }

  const ordered = sortByRelPathUtf8(items)
  const result: RemoteHashComputeResult = {
    rootHash: computeRootHash(ordered),
    items: ordered,
    totalBytes: sumBytes(ordered),
    fileCount: ordered.length,
    unsafeRelPaths
  }
  logger.info(
    `remote hash: dir=${root} kind=${input.kind} files=${result.fileCount} ` +
      `bytes=${result.totalBytes} root=${result.rootHash.slice(0, 12)}`
  )
  return result
}

/* --------------------------------------------------------- ssh2 接线层 */

/** 只声明本文件用到的 SFTP 方法，便于单测替身。 */
export interface HashSftpLike {
  stat(path: string, cb: (err: Error | null | undefined, stats: HashStatLike) => void): void
  readdir(
    path: string,
    cb: (
      err: Error | null | undefined,
      list: Array<{ filename: string; attrs: HashStatLike }>
    ) => void
  ): void
  createReadStream(path: string, options?: { highWaterMark?: number }): NodeJS.ReadableStream
  writeFile(
    path: string,
    data: Buffer,
    options: { encoding?: string } | undefined,
    cb: (err?: Error | null) => void
  ): void
  unlink(path: string, cb: (err?: Error | null) => void): void
}

export interface HashStatLike {
  isDirectory(): boolean
  isFile(): boolean
  size: number
  mtime: number
}

/** 远端递归列文件（不含目录本身；跳过符号链接与特殊文件）。 */
export async function listRemoteFiles(
  sftp: HashSftpLike,
  root: string
): Promise<Array<{ relPath: string; size: number; mtime?: string }>> {
  const out: Array<{ relPath: string; size: number; mtime?: string }> = []

  async function readdirOf(dir: string): Promise<Array<{ filename: string; attrs: HashStatLike }>> {
    return new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))
    })
  }

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) {
      throw new AppError(ErrorCode.E_ARTIFACT_TOO_MANY_FILES, { reason: 'max-depth', dir })
    }
    const entries = await readdirOf(normalizeRemotePath(dir))
    entries.sort((a, b) => compareRelPathUtf8(a.filename, b.filename))
    for (const e of entries) {
      const relPath = prefix ? `${prefix}/${e.filename}` : e.filename
      if (e.attrs.isDirectory()) {
        await walk(`${dir}/${e.filename}`, relPath, depth + 1)
        continue
      }
      if (!e.attrs.isFile()) continue
      const mtime =
        typeof e.attrs.mtime === 'number' && e.attrs.mtime > 0
          ? new Date(e.attrs.mtime * 1000).toISOString()
          : undefined
      out.push({ relPath, size: e.attrs.size ?? 0, ...(mtime === undefined ? {} : { mtime }) })
      if (out.length > MAX_LOCAL_FILES) {
        throw new AppError(ErrorCode.E_ARTIFACT_TOO_MANY_FILES, {
          count: out.length,
          limit: MAX_LOCAL_FILES
        })
      }
    }
  }

  await walk(normalizeRemotePath(root), '', 0)
  return out
}

export interface CreateSftpHashPortInput {
  /** ssh2 的 SFTPWrapper；结构性匹配由调用方断言 */
  sftp: HashSftpLike
  /** 执行已白名单化命令的函数（通常来自 SshConnectionPool.exec 的绑定版本） */
  exec: (cmd: string) => Promise<{ stdout: string; stderr: string; code: number | null }>
  capability: RemoteHashPort['capability']
  tmpDir: string
}

/**
 * 把 ssh2 的 SFTP 与 exec 包成 `RemoteHashPort`。
 *
 * 每次 `runCommand` 都过一遍 `assertCommandAllowed`：命令虽由模板生成，
 * 但这层是"如果将来有人绕开模板，会在开发阶段就炸"的兜底。
 */
export function createSftpHashPort(input: CreateSftpHashPortInput): RemoteHashPort {
  const { sftp } = input

  async function writeTextFile(remoteAbsPath: string, content: string): Promise<void> {
    const p = normalizeRemotePath(remoteAbsPath)
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(p, Buffer.from(content, 'utf8'), { encoding: 'utf8' }, (err) =>
        err
          ? reject(new AppError(ErrorCode.E_UPLOAD_INTERRUPTED, { path: p, original: err.message }))
          : resolve()
      )
    })
  }

  async function removeFile(remoteAbsPath: string): Promise<void> {
    const p = normalizeRemotePath(remoteAbsPath)
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(p, (err) => (err ? reject(err) : resolve()))
    })
  }

  return {
    capability: input.capability,
    tmpDir: normalizeRemotePath(input.tmpDir),
    async statSize(remoteAbsPath: string): Promise<number | null> {
      const p = normalizeRemotePath(remoteAbsPath)
      return new Promise<number | null>((resolve, reject) => {
        sftp.stat(p, (err, stats) => {
          if (err) {
            const e = err as { code?: number; message?: string }
            if (e.code === 2 || /no such file/i.test(e.message ?? '')) {
              resolve(null)
              return
            }
            reject(new AppError(ErrorCode.E_CONN_LOST, { path: p, original: e.message }))
            return
          }
          resolve(stats.size ?? 0)
        })
      })
    },
    writeTextFile,
    removeFile,
    async runCommand(cmd: string) {
      assertCommandAllowed(cmd)
      return input.exec(cmd)
    },
    readStream(remoteAbsPath: string) {
      return sftp.createReadStream(normalizeRemotePath(remoteAbsPath), {
        highWaterMark: HASH_CHUNK_SIZE
      })
    },
    async listFiles(root: string) {
      return listRemoteFiles(sftp, root)
    }
  }
}
