/**
 * DeployService（T10.1 ~ T10.12，方案书 §6.8）。
 *
 * ## 两阶段提交式发布
 *
 * ```
 * 阶段 0 前置校验  连接 / 本地产物 / 远端目标 / 父目录可写 / 残留 / 锁 / 挂载点
 * 阶段 1 本地指纹  算 rootHash + 文件数 + 体积，定下这次发布的版本号
 * 阶段 2 上传暂存  磁盘余量校验 → 上锁 → 传到 <父目录>/.sfvm-staging-<id>/payload
 * 阶段 3 远端校验  远端逐文件比对清单，失败输出差异明细
 * 阶段 4 归档旧版  调用 ArchiveService；**失败则禁止继续**（不允许跳过归档）
 * 阶段 5 换版      把暂存 payload 搬到目标路径（rename；跨设备时回退 copy）
 * 阶段 6 收尾      删暂存、放锁、写台账、异步跑保留策略
 * ```
 *
 * ## 一条贯穿全文的安全语义：**目标路径为空的那个窗口**
 *
 * 阶段 4 的动作就是"把目标路径上的当前版本搬进版本库"，也就是**把目标清空**，
 * 直到阶段 5 把新版本就位。这中间目标路径是空的。因此本文件里每一处失败处理
 * 都必须回答同一个问题：
 *
 * > **此刻目标路径是空的，如果现在失败，用户还剩什么？**
 *
 * 答不上来的分支就是 bug。具体地：
 * - 阶段 0/1 失败 → 远端零改动，什么都不用收拾；
 * - 阶段 2/3 失败 → 删暂存即可，目标从未被摸过；
 * - 阶段 4 失败 → 归档服务自己保证"目标要么原封不动、要么内容在归档目录里"，
 *   我们只需删暂存；
 * - **阶段 5 失败 → 目标此刻是空的（rename）或半新半旧（copy），
 *   必须调用 `archive.undoArchive()` 把归档的旧版本搬回来**。全流程最关键的一处补偿。
 * - 阶段 6 的动作全部"尽力而为"，**不允许抛错** —— 走到这里新版本已经就位，
 *   任何清理失败都只该记日志，不该把一次成功的发布改成失败。
 *
 * ## 为什么磁盘余量校验放在阶段 2 的开头而不是阶段 0
 *
 * 方案书 §6.8 把"磁盘剩余 ≥ 产物 × 2.2"列在阶段 0。但那个数字**依赖产物大小**，
 * 而产物大小是阶段 1 算出来的 —— 要么在阶段 0 提前算一遍指纹（白算一次），
 * 要么把这一项挪到"知道大小之后、动远端之前"。选后者：阶段 2 的第一件事就是
 * 这条校验，此时远端仍然零改动，"不碰服务器就先失败"的意图完整保留。
 *
 * ## 端口注入
 *
 * 本文件不 import electron、不 import ssh2。副作用全经 `DeployPorts` 注入，
 * 因此单测可以用内存远端把**各阶段的失败注入**真实跑一遍（T10.10 的验收点）。
 */
import { join as joinLocal } from 'node:path'
import { stat as statLocal } from 'node:fs/promises'
import { AppError, ErrorCode, type ErrorCodeValue } from '../infra/errors'
import { logger } from '../infra/logger'
import { newId } from '../db/id'
import { assertSafeRemotePath, normalizeRemotePath } from '../infra/remote-path'
import { parentDirOf, resolveArchiveDir, posixBasename } from '../infra/archive-dir'
import { joinRemote } from '../infra/hash-core'
import {
  buildChmodCommand,
  buildChownCommand,
  buildDfCommand,
  buildWriteProbeCommand,
  parseDfOutput
} from '../infra/remote-exec'
import {
  alignArtifactItems,
  checkSpace,
  classifyResidue,
  decideSwapStrategy,
  describeResidue,
  detectMountPoint,
  isAutoCleanable,
  lockPathOf,
  parseLockPayload,
  stagingPayloadOf,
  stagingRootOf,
  swapSourceOf
} from '../infra/deploy-plan'
import { copyArtifactInto } from '../infra/copy-tree'
import { MAX_RELEASE_ITEMS_PERSIST } from '../../shared/contracts/archive'
import type { DeployCurrentVersion, DeployCurrentVersionInput } from '../../shared/contracts/deploy'
import { assertTransition, stageText } from '../infra/deploy-state'
import { acquireRemoteLock, releaseRemoteLock } from '../infra/deploy-lock'
import {
  describeNameMismatch,
  fileNameAlignmentOf,
  isArtifactStale,
  newestMtimeOf
} from '../infra/local-artifact'
import { computePublishDiff } from '../infra/deploy-diff'
import { resolveVersionTagDetailed } from '../infra/version-tag'
import { createRemoteFs, type SftpLike } from './remote-fs'
import {
  createSftpHashPort,
  hashLocalArtifact,
  verifyRemote,
  type RemoteHashPort
} from './hash'
import {
  DEFAULT_CONCURRENCY,
  createTransfer,
  createSftpTransferPort,
  type TransferPort
} from './transfer'
import {
  createSftpArchivePort,
  type ArchiveFsPort,
  type ArchivePorts,
  type ArchiveService
} from './archive'
import type { Repositories } from '../db/repositories'
import type { ConnectionCapability } from '../infra/capability'
import type { JobLogLevel } from '../../shared/contracts/job'
import type { ReleaseItem } from '../../shared/contracts/hash'
import { describeRetainPolicy, parseRetainPolicy } from '../../shared/contracts/workspace'
import {
  DEPLOY_STAGE_PROGRESS,
  requiredBytesFor,
  type DeployFailure,
  type DeployOutcome,
  type DeployPrecheckReport,
  type DeployPreview,
  type DeployResidueCleanResult,
  type DeployStrategy,
  type PrecheckItem,
  type RemoteLockInfo,
  type ReleaseStatus
} from '../../shared/contracts/deploy'



/* ------------------------------------------------------------ 远端端口 */

/**
 * 发布流程用到的远端文件操作。
 *
 * 与 `ArchiveFsPort` 高度重叠（同一套 SFTP 原语），差异只有两点：
 * - `readdir`：探测残留要列目录名（归档只列文件）；
 * - `writeNewFile`：用 `flags:'wx'` **独占创建**锁文件，这是跨机器互斥的唯一机制。
 */
export interface DeployFsPort extends ArchiveFsPort {
  readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>>
  /**
   * 独占创建并写入一个文件（`O_CREAT|O_EXCL`）。已存在时**必须失败**。
   *
   * 调用方**不靠错误码判断**"是不是被别人占了"：各版本 OpenSSH 对 `O_EXCL` 失败
   * 返回的 SFTP 状态码并不统一（`SSH_FX_FAILURE` / `SSH_FX_FILE_ALREADY_EXISTS` 都见过）。
   * 统一做法是失败后回头读一次锁文件（见 `acquireLock`）。
   */
  writeNewFile(path: string, content: string): Promise<void>
}

/** 发布需要的全部远端能力。 */
export interface DeployPorts {
  fs: DeployFsPort
  /** 传给 ArchiveService 的端口（同一套 SFTP 上另包一层，语义不同） */
  archiveFs: ArchiveFsPort
  hash: RemoteHashPort
  transfer: TransferPort
  /** 执行白名单命令（`test -w` / `df` / `chmod` / `chown`） */
  exec(command: string): Promise<{ stdout: string; stderr: string; code: number | null }>
  capability: Pick<ConnectionCapability, 'hasSha256sum' | 'hasShasum' | 'platform' | 'homeDir'>
  /** 写进锁文件，便于用户判断"是谁在发布" */
  hostname: string
}

/**
 * 只声明本文件用到的 SFTP 方法，便于接线与单测替身。
 *
 * 为什么**不**写成 `extends ArchiveSftpLike, HashSftpLike`：那两个接口各自声明了
 * `createReadStream`，返回类型分别是 `ArchiveReadStream` 与 `NodeJS.ReadableStream`。
 * TS 对"多重继承里同名成员"要求类型**完全相同**（不接受结构相容），于是直接编译失败。
 * 这里改为按"最宽的那个类型"统一声明一次，并把 `fastPut/fastGet`（传输）与
 * `readFile`（归档）这些分属不同模块的方法一并列出 —— 四个端口共用同一条通道，
 * 一个接口描述完整就够。
 */
export interface DeploySftpLike extends SftpLike {
  /** transfer：ssh2 的加速通道（B07 实测比手写流快很多） */
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
  /** archive：读整文件（原文改写前的旧版本内容等） */
  readFile(path: string, cb: (err: Error | null | undefined, data: Buffer) => void): void
  /** hash：上传校验清单 */
  writeFile(
    path: string,
    data: Buffer,
    options: { encoding?: string } | undefined,
    cb: (err?: Error | null) => void
  ): void
  /** 锁文件用独占创建（`flags:'wx'`） */
  open(
    path: string,
    flags: string,
    cb: (err: Error | null | undefined, handle: Buffer) => void
  ): void
  write(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err?: Error | null) => void
  ): void
  close(handle: Buffer, cb: (err?: Error | null) => void): void
}

/** 在 `ArchiveFsPort` 之上补齐 `DeployFsPort` 需要的方法。 */
export function createSftpDeployPort(sftp: DeploySftpLike): DeployFsPort {
  const remoteFs = createRemoteFs(sftp)
  const base = createSftpArchivePort(sftp)

  return {
    stat: (path) => base.stat(path),
    mkdirp: (path) => base.mkdirp(path),
    rename: (from, to) => base.rename(from, to),
    removeFile: (path) => base.removeFile(path),
    rmrf: (path) => base.rmrf(path),
    readTextFile: (path) => base.readTextFile(path),
    writeTextChunks: (path, chunks) => base.writeTextChunks(path, chunks),
    listFiles: (root) => base.listFiles(root),
    copyFile: (src, dst) => base.copyFile(src, dst),
    readdir: async (path) => {
      const list = await remoteFs.readdir(path)
      return list.map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: e.size }))
    },
    writeNewFile(path, content) {
      const p = normalizeRemotePath(path)
      const buf = Buffer.from(content, 'utf8')
      return new Promise<void>((resolve, reject) => {
        // 'wx' = O_CREAT | O_EXCL：已存在就失败。这是锁的全部意义所在。
        sftp.open(p, 'wx', (err, handle) => {
          if (err) {
            reject(new AppError(ErrorCode.E_CONN_LOST, { path: p, original: err.message }))
            return
          }
          sftp.write(handle, buf, 0, buf.byteLength, 0, (werr) => {
            sftp.close(handle, () => {
              if (werr) {
                reject(new AppError(ErrorCode.E_CONN_LOST, { path: p, original: werr.message }))
                return
              }
              resolve()
            })
          })
        })
      })
    }
  }
}

/**
 * 一次性把 `pool.sftp()` 得到的通道包成发布需要的全部端口。
 *
 * 四次 `sftp(...)` 调用**共用同一条 SFTP 通道**：通道上的请求互相独立，
 * 多开一条通道就多一次握手、多一个失败点，没有收益。
 */
export function createSftpDeployPorts(input: {
  sftp: DeploySftpLike
  capability: DeployPorts['capability']
  tmpDir: string
  exec: DeployPorts['exec']
  hostname: string
}): DeployPorts {
  return {
    fs: createSftpDeployPort(input.sftp),
    archiveFs: createSftpArchivePort(input.sftp),
    hash: createSftpHashPort({
      sftp: input.sftp,
      exec: input.exec,
      capability: input.capability,
      tmpDir: input.tmpDir
    }),
    transfer: createSftpTransferPort(input.sftp),
    exec: input.exec,
    capability: input.capability,
    hostname: input.hostname
  }
}

/* ------------------------------------------------------------ 运行上下文 */

export interface DeployProgressInput {
  percent?: number
  stage?: string
  message?: string
  bytes?: number
  totalBytes?: number
  files?: number
  totalFiles?: number
}

/** 与 `JobContext` 结构一致，方便 IPC 层把任务上下文直接透传进来。 */
export interface DeployContext {
  readonly signal: AbortSignal
  progress(p: DeployProgressInput): void
  log(text: string, level?: JobLogLevel): void
}

/* ---------------------------------------------------------------- 入参 */

export interface DeployServiceDeps {
  repo: Repositories
  archive: ArchiveService
  /** 便于测试注入固定时间与 id */
  now?: () => Date
  newReleaseId?: () => string
  /**
   * 覆盖上传重试退避。
   *
   * 生产用 `infra/backoff` 的 1s→2s→5s（链路抖一下不该让整个发布失败）；
   * 但"上传中断"这种用例在单测里要真的跑到失败，等 8 秒没有意义 ——
   * 单测传 `() => 1`。与 `createTransfer` 自己的 `TransferDeps.retryDelay` 同一动机。
   */
  transferRetryDelay?: (attempt: number) => number
  /**
   * 传输并发数（B15 / T15.1）。
   *
   * 做成**函数**而不是数值：设置在运行期随时可改，发布任务启动时才该取值。
   * 传数值的话，启动时接进去的那个值会一直用到进程结束 —— 用户改了设置
   * 却发现"下次发布还是老样子"，只能重启。
   */
  transferConcurrency?: () => number
  /** 算法兼容模式（B15 / T15.1）：远端无 hash 工具时是否允许降级为流式计算。 */
  hashCompat?: () => boolean
}

export interface DeployRunInput {
  targetId: string
  ports: DeployPorts
  ctx: DeployContext
  /** 调用方可指定（JobService 的车道键与台账行 id 需要一致）；不传则自动生成 */
  releaseId?: string
  note?: string | null
  operator?: string | null
  strategy?: DeployStrategy
  alignOwnership?: boolean
  /** 确认清理探测到的远端残留（默认拒绝，只提示） */
  confirmCleanResidue?: boolean
  /** 确认清理陈旧的远端锁（默认拒绝，只提示 — 方案书 §6.8） */
  cleanStaleLock?: boolean
}

export interface DeployResidueCleanInput {
  targetId: string
  paths: string[]
  fs: DeployFsPort
}

export interface DeployPreviewInput {
  targetId: string
  /** 每类差异最多列多少条路径（计数永远准确）。默认 200 */
  limit?: number
}

export interface DeployService {
  precheck(input: { targetId: string; ports: DeployPorts }): Promise<DeployPrecheckReport>
  /**
   * 发布确认弹窗需要的"会发生什么"（B11 / T11.3）。
   *
   * 与 `precheck` 分开：precheck 回答"能不能发"（要连服务器），
   * 这里回答"发出去会变成什么样"（**纯本地**：只读台账 + 算一次本地指纹）。
   * 因此它在离线时也能给出差异摘要 —— 用户可以先看清楚再决定要不要连。
   */
  preview(input: DeployPreviewInput): Promise<DeployPreview>
  /**
   * 当前线上版本（**纯台账**：最近一次成功操作，发布或回滚都算）。
   *
   * 与 `preview` 分开的理由见 `contracts/deploy.ts` 里 `deployCurrentVersionSchema`
   * 上面的说明：`preview` 要求配了本地产物路径、还要算一次全量本地指纹，
   * 而"当前版本是哪个"只需要读一行台账。
   */
  currentVersion(input: DeployCurrentVersionInput): DeployCurrentVersion
  run(input: DeployRunInput): Promise<DeployOutcome>
  cleanResidue(input: DeployResidueCleanInput): Promise<DeployResidueCleanResult>
  /** 当前被本地互斥占住的目标（UI/测试可观测） */
  busyTargets(): string[]
  /** 等待后台任务（发布成功后异步执行的保留策略）结束 */
  whenIdle(): Promise<void>
}

/** 一次运行中在阶段之间传递的状态。 */
interface StageState {
  releaseId: string
  remotePath: string
  parentDir: string
  archiveDir: string
  base: string
  kind: 'dir' | 'file'
  stagingRoot: string
  stagingPayload: string
  strategy: DeployStrategy
  moveMode: 'rename' | 'copy'
  mountInfo: { isMountPoint: boolean; crossDevice: boolean; reason?: string }
  local: {
    localPath: string
    rootHash: string
    items: ReleaseItem[]
    totalBytes: number
    fileCount: number
    excludedCount: number
    skippedSymlinks: number
  } | null
  /** 阶段 0 记录的目标 mode/uid/gid（阶段 5 之后用来恢复） */
  originalMode: { mode: number; uid: number; gid: number } | null
  /** 阶段 4 成功后的归档记录 id（阶段 5 失败时用它复位） */
  archiveId: string | null
  swapFallbackReason: string | null
  lockHeld: boolean
}

function abortError(): AppError {
  return new AppError(ErrorCode.E_JOB_CANCELLED, { reason: 'aborted' })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/** 把 SFTP `Stats.mode`（含文件类型位）转成 `chmod` 要的八进制字符串。 */
export function toModeBits(mode: number): string {
  return (mode & 0o7777).toString(8)
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function parseExcludeRaw(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function stagePrecheckCode(key: string): ErrorCodeValue {
  switch (key) {
    case 'local-artifact':
      return ErrorCode.E_LOCAL_PATH_MISSING
    case 'parent-writable':
      return ErrorCode.E_PARENT_NOT_WRITABLE
    case 'disk-space':
      return ErrorCode.E_DISK_SPACE
    case 'remote-target':
      return ErrorCode.E_TARGET_MISSING
    case 'active-release':
      return ErrorCode.E_DEPLOY_BLOCKED
    default:
      return ErrorCode.E_PARAM
  }
}

/* ---------------------------------------------------------------- 服务 */

export function createDeployService(deps: DeployServiceDeps): DeployService {
  const { repo, archive } = deps
  const now = deps.now ?? ((): Date => new Date())
  const makeReleaseId = deps.newReleaseId ?? newId

  /** 本地互斥：同一 target 同时只能有一次发布（JobService 的车道是第二道保险） */
  const localBusy = new Set<string>()
  const background = new Set<Promise<void>>()

  function trackBackground(p: Promise<void>): void {
    background.add(p)
    void p.finally(() => background.delete(p))
  }

  function resolvePaths(targetId: string): {
    remotePath: string
    parentDir: string
    archiveDir: string
    base: string
    kind: 'dir' | 'file'
    /**
     * 已确定存在的目标。
     *
     * `targets.get()` 的类型是 `Target | undefined`，这里判空后立刻抛错；
     * 用 `NonNullable<...>` 把"已经过校验"这件事写进类型，避免下游每一处引用
     * 都要再写一次 `target!` 或 `?? `（那种重复噪声会掩盖真正的判空点）。
     */
    target: NonNullable<ReturnType<Repositories['targets']['get']>>
  } {
    const target = repo.targets.get(targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId })
    const kind: 'dir' | 'file' = target.kind === 'file' ? 'file' : 'dir'
    const remotePath = normalizeRemotePath(target.remotePath)
    return {
      target,
      kind,
      remotePath,
      parentDir: parentDirOf(remotePath),
      archiveDir: resolveArchiveDir({ remotePath, archiveDir: target.archiveDir, kind }),
      base: posixBasename(remotePath)
    }
  }

  async function dfOf(
    ports: DeployPorts,
    p: string
  ): Promise<ReturnType<typeof parseDfOutput>> {
    try {
      const r = await ports.exec(buildDfCommand(p))
      return parseDfOutput(r.stdout)
    } catch (err) {
      logger.debug(`df ${p} 失败：${(err as Error).message}`)
      return null
    }
  }

  /* -------------------------------------------------- 阶段 0：前置校验 */

  async function precheckInternal(input: {
    targetId: string
    ports: DeployPorts
    /** full 模式额外算本地指纹与磁盘余量（给 UI 的确认弹窗用） */
    mode: 'quick' | 'full'
    /**
     * 台账里**这一次**发布的记录 id，检查"未结束的发布"时要跳过它。
     *
     * `run()` 必须先建台账行（失败也要能在发布历史里看见），而这条刚建出来的行
     * 状态就是 PENDING —— 不排除它的话，阶段 0 会把自己刚写的那一条当成
     * "上次中断留下的未结束发布"，**每一次发布都会立刻失败**。
     * `service.precheck()`（发布前的独立探测）没有对应记录，不传即可。
     */
    ignoreReleaseId?: string
  }): Promise<{
    report: DeployPrecheckReport
    mountInfo: { isMountPoint: boolean; crossDevice: boolean; reason?: string }
    lock: RemoteLockInfo | null
    lockUnreadable: boolean
    residue: ReturnType<typeof classifyResidue>
  }> {
    const { ports } = input
    const { target, kind, remotePath, parentDir, archiveDir, base } = resolvePaths(input.targetId)

    /**
     * `parentDir` 由 `remotePath` 推出来，而 `remotePath` 在写库时已过 `safePath`；
     * 这里在**动远端之前**再显式过一遍 `assertSafeRemotePath`（P2-11 顺带）。
     *
     * 单靠 `buildWriteProbeCommand` 内部的 `quoteRemotePath` 也能拦住，但那条路径在
     * `try/catch` 里，抛错会被吞成一句 warn，最后呈现为"父目录不可写" —— 一句
     * 与真实原因（路径根本不合法）不符的结论。所以在入口就把它变成明确错误。
     */
    const parentCheck = assertSafeRemotePath(parentDir)
    if (!parentCheck.ok) {
      throw new AppError(ErrorCode.E_PATH_UNSAFE, {
        parentDir,
        reason: parentCheck.reason
      })
    }

    const items: PrecheckItem[] = []

    /* 1) 连接：能走到这里说明连接已就绪（IPC 层保证），仍显式呈现 */
    items.push({
      key: 'connection',
      label: '连接可用',
      level: 'ok',
      detail: `已连接（${ports.capability.platform}）`
    })

    /* 2) 本地产物 */
    let localSummary: DeployPrecheckReport['artifactSummary'] | undefined
    const localPath = target.localPath?.trim() ?? ''
    if (!localPath) {
      items.push({
        key: 'local-artifact',
        label: '本地产物',
        level: 'error',
        detail: '该目标还没有配置本地构建产物路径',
        suggestion: '请先在目标详情里选择本地产物（目录型选目录、文件型选文件）。'
      })
    } else {
      try {
        const st = await statLocal(localPath)
        const kindOk = kind === 'dir' ? st.isDirectory() : st.isFile()
        if (!kindOk) {
          items.push({
            key: 'local-artifact',
            label: '本地产物',
            level: 'error',
            detail:
              `路径类型与目标不符：目标是${kind === 'dir' ? '目录' : '文件'}型，` +
              `而 ${localPath} 是${st.isDirectory() ? '目录' : '文件'}`,
            suggestion: '请修正本地路径，或调整目标的类型。'
          })
        } else {
          const possiblyStale = now().getTime() - st.mtimeMs > 24 * 60 * 60 * 1000
          items.push({
            key: 'local-artifact',
            label: '本地产物',
            level: possiblyStale ? 'warn' : 'ok',
            detail: possiblyStale
              ? `${localPath} 最近 24 小时没有变动，可能已过期`
              : `${localPath} 存在`,
            ...(possiblyStale
              ? { suggestion: '请确认这是你要发布的版本（仅提示，不会阻止发布）。' }
              : {}),
            data: { localPath, mtime: st.mtime.toISOString() }
          })
          if (input.mode === 'full') {
            const hashed = await hashLocalArtifact({ localPath, kind })
            /**
             * 指纹口径与发布链路对齐（B17）：确认弹窗上显示的"本地指纹"必须等于
             * 阶段 1 真正会写进台账、并随版本号露出的那一个，否则用户会看到
             * "弹窗说 A、发布记录里是 B"，进而怀疑我们算错了。
             */
            const aligned = alignArtifactItems({
              kind,
              remotePath,
              items: hashed.items,
              rootHash: hashed.rootHash
            })
            localSummary = {
              localPath,
              kind,
              fileCount: hashed.fileCount,
              totalBytes: hashed.totalBytes,
              rootHash: aligned.rootHash,
              excludedCount: hashed.excludedCount,
              skippedSymlinks: hashed.skippedSymlinks,
              possiblyStale,
              newestMtime: st.mtime.toISOString()
            }
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        items.push({
          key: 'local-artifact',
          label: '本地产物',
          level: 'error',
          detail:
            code === 'ENOENT'
              ? `本地产物不存在：${localPath}`
              : `无法读取本地产物：${(err as Error).message}`,
          suggestion: '请先构建产物，或修正路径。'
        })
      }
    }

    /* 2.5) 文件型目标的文件名对齐（B17 / T17.2）—— **只提示，不阻止发布** */
    /**
     * 本地产物名与服务器端文件名不一致不是错误：阶段 1 会按配置里的名字上传
     * （见 `alignArtifactItems`），发布照样成功。但用户必须知道"发上去以后叫
     * 什么名字" —— 否则他会在服务器上找一个不存在的文件，然后怀疑没发布成功。
     *
     * 与「本地产物」项分开成一个条目，而不是把这句话追加到那一项上：
     * 两者回答的问题不同（"产物能不能用" vs "发上去会叫什么名"），
     * 而且 `PrecheckItem.key` 是列表渲染的 key，同类项不能出现两条。
     */
    const nameAlign = fileNameAlignmentOf({
      targetKind: kind,
      localPath,
      remotePath
    })
    if (nameAlign) {
      items.push({
        key: 'file-name',
        label: '文件名对齐',
        level: 'warn',
        detail: describeNameMismatch(nameAlign),
        suggestion: '不需要改配置；若希望服务器上沿用本地产物的文件名，请修改目标的服务器端路径。',
        data: { localName: nameAlign.localName, remoteName: nameAlign.remoteName }
      })
    }

    /* 3) 远端目标 */
    const remoteTarget = await ports.fs.stat(remotePath)
    items.push(
      remoteTarget.exists
        ? {
            key: 'remote-target',
            label: '远端目标',
            level: 'ok',
            detail: `${remotePath}（${remoteTarget.isDirectory ? '目录' : '文件'}）`
          }
        : {
            key: 'remote-target',
            label: '远端目标',
            level: 'warn',
            detail: `${remotePath} 目前不存在，将作为首次发布创建`,
            data: { remotePath }
          }
    )

    /* 4) 父目录可写（要在这里建暂存目录与往期版本目录） */
    //
    // 走 `buildWriteProbeCommand`（与 ssh-client 同一来源）：路径先过
    // `assertSafeRemotePath` 再过 `quoteShellArg`。旧实现自己做了 `'` → `'\''`
    // 转义，但**没有**先校验路径，带换行的路径能截断单引号参数。
    let parentWritable = false
    try {
      const r = await ports.exec(buildWriteProbeCommand(parentDir))
      parentWritable = r.code === 0
    } catch (err) {
      logger.warn(`父目录可写探测失败：${(err as Error).message}`)
    }
    if (!parentWritable) {
      // 父目录可能还不存在（首次发布到新目录），先建出来再探
      try {
        await ports.fs.mkdirp(parentDir)
        const r = await ports.exec(buildWriteProbeCommand(parentDir))
        parentWritable = r.code === 0
      } catch (err) {
        logger.warn(`创建/探测父目录失败：${(err as Error).message}`)
      }
    }
    items.push(
      parentWritable
        ? {
            key: 'parent-writable',
            label: '父目录可写',
            level: 'ok',
            detail: `${parentDir} 可写`
          }
        : {
            key: 'parent-writable',
            label: '父目录可写',
            level: 'error',
            detail: `${parentDir} 不可写`,
            suggestion: `发布需要在 ${parentDir} 下创建暂存目录与 ${archiveDir}。请联系运维授权。`
          }
    )

    /* 5) 挂载点 / 跨设备（决定换版与归档能否用原子 rename） */
    const [targetDf, parentDf] = await Promise.all([
      dfOf(ports, remotePath),
      dfOf(ports, parentDir)
    ])
    const mountInfo = detectMountPoint({ remotePath, targetDf, parentDf })
    if (mountInfo.isMountPoint || mountInfo.crossDevice) {
      items.push({
        key: 'disk-space',
        label: '文件系统',
        level: 'warn',
        detail: `${mountInfo.reason ?? '目标与暂存不在同一文件系统'}，将使用复制模式（耗时较长）`,
        suggestion: '复制模式会在服务器上多占一份产物的空间，请确认磁盘余量。'
      })
    }

    /* 6) 磁盘余量（只有 full 模式知道产物大小） */
    if (input.mode === 'full' && localSummary) {
      const available = (await dfOf(ports, parentDir))?.availableBytes ?? null
      const required = requiredBytesFor({ totalBytes: localSummary.totalBytes })
      const space = checkSpace({ requiredBytes: required, availableBytes: available })
      items.push(
        space.unknown
          ? {
              key: 'disk-space',
              label: '磁盘余量',
              level: 'warn',
              detail: `无法探测 ${parentDir} 的剩余空间（df 未给出结果）`,
              suggestion: `发布需要约 ${fmtBytes(required)}。空间不足时会在上传阶段失败。`
            }
          : space.ok
            ? {
                key: 'disk-space',
                label: '磁盘余量',
                level: 'ok',
                detail: `剩余 ${fmtBytes(space.availableBytes)}，需要 ${fmtBytes(required)}（产物 × 2.2）`
              }
            : {
                key: 'disk-space',
                label: '磁盘余量',
                level: 'error',
                detail:
                  `剩余 ${fmtBytes(space.availableBytes)}，不足所需的 ${fmtBytes(required)}` +
                  `（产物 ${fmtBytes(localSummary.totalBytes)} × 2.2：暂存一份 + 归档旧版一份）`,
                suggestion: '请先清理服务器空间，或调低保留策略里保留的版本数。'
              }
      )
    }

    /* 7) 残留 */
    let residue: ReturnType<typeof classifyResidue> = []
    try {
      residue = classifyResidue({
        parentDir,
        targetBase: base,
        entries: await ports.fs.readdir(parentDir)
      })
    } catch (err) {
      logger.debug(`残留探测失败（父目录可能刚创建）：${(err as Error).message}`)
    }
    if (residue.length > 0) {
      const cleanable = residue.filter(isAutoCleanable)
      const manual = residue.filter((r) => !isAutoCleanable(r))
      items.push({
        key: 'residue',
        label: '远端残留',
        level: manual.length > 0 ? 'warn' : 'error',
        detail:
          `发现 ${residue.length} 项上次发布留下的东西：` +
          residue.map((r) => `${r.name}（${describeResidue(r.kind)}）`).join('、'),
        suggestion:
          cleanable.length > 0
            ? `确认清理后可继续发布（会删除 ${cleanable.map((r) => r.name).join('、')}）。` +
              (manual.length > 0
                ? ` ${manual.map((r) => r.name).join('、')} 不会被自动删除，请人工确认。`
                : '')
            : '这些文件不会被自动删除，请人工确认后再发布。',
        data: { residue: residue.map((r) => r.path) }
      })
    }

    /* 8) 远端锁 */
    const lockPath = lockPathOf(remotePath)
    // 两个分支（try / catch）都会赋值，所以不写 `= null` 这种"无人读取"的初值
    let lock: RemoteLockInfo | null
    let lockUnreadable = false
    try {
      const text = await ports.fs.readTextFile(lockPath)
      lock = parseLockPayload(text, now())
      if (lock) lock.path = lockPath
      else lockUnreadable = true
    } catch {
      // 读不到锁文件 = 没有锁（读失败最常见的原因就是它不存在）
      lock = null
    }
    if (lock || lockUnreadable) {
      const stale = lock?.stale ?? false
      items.push({
        key: 'lock',
        label: '远端发布锁',
        level: stale || lockUnreadable ? 'warn' : 'error',
        detail: lock
          ? `${lockPath} 存在（由 ${lock.hostname} 于 ${lock.ts} 创建，releaseId=${lock.releaseId}）` +
            (stale ? '，且已超过 30 分钟' : '')
          : `${lockPath} 存在但内容无法解析`,
        suggestion: stale
          ? '锁已陈旧，通常是上次发布异常中断。确认没有其他人在发布后，可确认清理该锁。'
          : lockUnreadable
            ? '锁文件内容异常。请人工查看后再决定是否清理。'
            : '可能有另一台机器正在发布同一个目标，请等待其结束。',
        data: { lockPath, lock }
      })
    }

    /* 9) 本地台账里是否有未结束的发布 */
    const unfinished = repo.releases
      .listUnfinishedByTarget(target.id)
      .filter((r) => r.id !== input.ignoreReleaseId)
    if (unfinished.length > 0) {
      items.push({
        key: 'active-release',
        label: '未结束的发布记录',
        level: 'error',
        detail: `台账里有 ${unfinished.length} 条未结束的发布记录（最近一条状态 ${unfinished[0]!.status}）`,
        suggestion: '请先处理这些记录（B14 的「对账」会引导你），再发起新的发布。'
      })
    }

    const ok = items.every((i) => i.level !== 'error')
    return {
      report: {
        ok,
        items,
        needConfirm: items.some(
          (i) => (i.key === 'residue' || i.key === 'lock') && i.level !== 'ok'
        ),
        residue: residue.map((r) => r.path),
        ...(localSummary ? { artifactSummary: localSummary } : {})
      },
      mountInfo,
      lock,
      lockUnreadable,
      residue
    }
  }

  /* ------------------------------------------------------- 锁 */

  async function acquireLock(
    ports: DeployPorts,
    state: StageState,
    log: (t: string, l?: JobLogLevel) => void,
    cleanStaleLock: boolean
  ): Promise<void> {
    /**
     * 锁的实现搬到了 `infra/deploy-lock.ts`：**回滚要抢同一把锁**。
     *
     * 两边各自实现一份的后果不是"代码重复"，而是"哪天只改了一边" —— 那时发布与
     * 回滚就可能同时进行，两次归档互相把对方的内容搬走，目标路径最后是什么全凭时序。
     * 而这类漏判在测试里极难暴露。
     */
    await acquireRemoteLock({
      fs: ports.fs,
      remotePath: state.remotePath,
      releaseId: state.releaseId,
      hostname: ports.hostname,
      pid: process.pid,
      now: now(),
      cleanStaleLock,
      log,
      onCleanStaleLock: ({ lockPath, previous }) => {
        repo.audit.write({
          level: 'warn',
          scope: 'deploy',
          refId: state.releaseId,
          message: `清理陈旧远端锁 ${lockPath}`,
          detail: JSON.stringify({ lockPath, previous })
        })
      }
    })
    state.lockHeld = true
  }

  /** 放锁：尽力而为，失败只记日志（锁本身会因陈旧而失效）。 */
  async function releaseLock(ports: DeployPorts, state: StageState): Promise<void> {
    if (!state.lockHeld) return
    state.lockHeld = false
    await releaseRemoteLock(ports.fs, state.remotePath, (t) => logger.warn(t))
  }

  /* ------------------------- 上一次发布的清单与版本号（提速 + 号数对齐） */

  /**
   * 上一次成功发布的逐文件清单**与它的版本号** —— 一起返回是因为两件事必须同源。
   *
   * ## 清单：让归档跳过"重算整个目标的哈希"
   *
   * 这一步很值钱：远端读受服务器**出带宽**限制（实测某机器只有 ~0.46 MB/s），
   * 几百 MB 的产物重算一次要几十分钟。
   *
   * 但**绝不能无脑信台账**：用户完全可能在两次发布之间手工往目标目录里塞过东西。
   * 那样传进去的清单与现网内容对不上，归档出来的 manifest 会把错误的哈希写进版本库
   * （等于往版本库里埋一份坏数据）。所以先用一次**便宜的**目录遍历
   * （只比 `(relPath, size)` 集合，不读文件内容）核对，对不上就返回 null，
   * 让归档老老实实现场算。
   *
   * ## 版本号：让同一份内容在「发布历史」与「往期版本」里是同一个号
   *
   * 方案书 §5.4 的版本号形态是 `YYYYMMDD-HHMMSS_<rootHash 前 7 位>`，**号里带指纹**。
   * 上一版内容 X 是在它自己的那次发布里拿到版本号的；现在我们要归档 X，
   * 如果让归档自己按"归档时刻 + 指纹"重新生成，X 就会有两个号
   * （发布记录里一个、往期版本里一个），用户在两个页面之间对不上。
   * 所以把 X 那次发布的版本号当 `preferredTag` 传进去 —— 归档沿用它。
   *
   * 也正因此两个返回值必须一起给出：只有清单被现网核对通过，
   * 才能确定"要归档的就是 X 那份内容"，才敢给它贴 X 的号。
   *
   * ## 顺带把"上一版是什么类型的操作"带回去
   *
   * 回滚恢复出来的内容在版本库里本来就有一份 —— 发布成功后要用这个事实去重
   * （见 run() 末尾的 `discardDuplicateArchive`）。`action` 与 `archiveId` 只有
   * 在清单核对通过时才有意义，所以必须与清单/版本号同进同出。
   */
  async function prevRelease(
    ports: DeployPorts,
    targetId: string,
    currentReleaseId: string,
    state: StageState
  ): Promise<{
    versionTag: string
    items: ReleaseItem[]
    /** 上一版那次操作的类型：只有回滚恢复出来的内容才可能与版本库里的某一份重复 */
    action: string
    /** 上一版是回滚时，它指向的来源归档（去重要用；其余情况为 null） */
    archiveId: string | null
  } | null> {
    const prev = repo.releases
      .listByTarget(targetId, 20)
      .find((r) => r.id !== currentReleaseId && r.status === 'SUCCESS')
    if (!prev) return null

    const rows = repo.releaseItems.listByRelease(prev.id)
    if (rows.length === 0) return null
    const expected = rows.map((i) => ({
      relPath: i.relPath,
      hash: i.hash,
      size: i.size,
      mtime: i.mtime ?? null
    }))

    if (!(await ports.fs.stat(state.remotePath)).exists) return null
    let actual: Array<{ relPath: string; size: number }>
    try {
      if (state.kind === 'dir') {
        actual = (await ports.fs.listFiles(state.remotePath)).map((f) => ({
          relPath: f.relPath,
          size: f.size
        }))
      } else {
        const st = await ports.fs.stat(state.remotePath)
        actual = [{ relPath: state.base, size: st.size }]
      }
    } catch (err) {
      logger.debug(`核对上次发布清单失败，改为现场计算：${(err as Error).message}`)
      return null
    }

    const key = (x: { relPath: string; size: number }): string => `${x.relPath}\0${x.size}`
    const actualSet = new Set(actual.map(key))
    if (actualSet.size !== expected.length) return null
    for (const e of expected) if (!actualSet.has(key(e))) return null
    // action / archiveId 必须与清单一起返回：只有清单核对通过，
    // "现网就是上次回滚恢复的那份内容"才站得住，发布成功后的去重才敢动手
    return {
      versionTag: prev.versionTag,
      items: expected,
      action: prev.action,
      archiveId: prev.archiveId ?? null
    }
  }

  /* ------------------------------------------------------ 发布主流程 */

  async function run(input: DeployRunInput): Promise<DeployOutcome> {
    const started = Date.now()
    const { ctx, ports } = input
    const { target, kind, remotePath, parentDir, archiveDir, base } = resolvePaths(input.targetId)

    if (localBusy.has(input.targetId)) {
      throw new AppError(ErrorCode.E_TARGET_BUSY, { targetId: input.targetId })
    }
    // `add` 刻意放在下面紧邻 `try` 的位置（P0-2）：add 与 try 之间原本夹着
    // `releases.create` 等非保护代码，那里抛错会让 finally 永不执行，
    // targetId 就永久卡在 busy。现在这段（建台账行 + 组装 state）先跑，
    // 抛错时 busy 尚未置位，无需清理；add 之后到 try 之间全是同步闭包定义，
    // JS 单线程下不存在被并发插入的窗口。

    const releaseId = input.releaseId ?? makeReleaseId()
    const strategy: DeployStrategy =
      input.strategy ?? (target.deployStrategy === 'copy' ? 'copy' : 'rename')

    const state: StageState = {
      releaseId,
      remotePath,
      parentDir,
      archiveDir,
      base,
      kind,
      stagingRoot: stagingRootOf(remotePath, releaseId),
      stagingPayload: stagingPayloadOf(remotePath, releaseId),
      strategy,
      moveMode: strategy === 'copy' ? 'copy' : 'rename',
      mountInfo: { isMountPoint: false, crossDevice: false },
      local: null,
      originalMode: null,
      archiveId: null,
      swapFallbackReason: null,
      lockHeld: false
    }

    // 台账行先建出来（失败也要能在「发布历史」里看见），版本号在阶段 1 补上。
    //
    // `id: releaseId` 是刻意的：**任务 id、台账行 id、远端暂存目录后缀三者必须相等**。
    // 不然 `out.releaseId` 与服务器上的 `.sfvm-staging-<X>` 对不上，
    // "按发行记录去找残留"这条链路就断了（B14 对账、以及 MT-02 之后的清理都靠它）。
    let release = repo.releases.create({
      id: releaseId,
      targetId: target.id,
      action: 'deploy',
      versionTag: releaseId,
      status: 'PENDING',
      source: 'local',
      localPath: target.localPath ?? null,
      note: input.note ?? null,
      operator: input.operator ?? null,
      rootHash: null,
      totalBytes: 0,
      fileCount: 0,
      currentStep: '0'
    })

    let status: ReleaseStatus = 'PENDING'
    let stage = 0
    const compensations: Array<{ action: string; ok: boolean; detail?: string }> = []

    /** 迁移状态并落库（非法迁移会当场炸出来 —— 那属于代码错误，不是运行时故障）。 */
    const goto = (to: ReleaseStatus, stageIndex: number): void => {
      assertTransition(status, to)
      status = to
      stage = stageIndex
      release = repo.releases.update(release.id, {
        status: to,
        currentStep: String(stageIndex)
      })!
    }

    /** 阶段内进度：把区间 [from,to] 按 ratio 插值。 */
    const progressAt = (stageIndex: number, ratio: number, message: string): void => {
      const r = DEPLOY_STAGE_PROGRESS[stageIndex] ?? { from: 0, to: 100 }
      const pct = Math.max(0, Math.min(100, Math.round(r.from + (r.to - r.from) * ratio)))
      ctx.progress({ percent: pct, stage: stageText(stageIndex), message })
    }

    localBusy.add(input.targetId)

    try {
      /* =============== 阶段 0：前置校验 =============== */
      ctx.log(`开始发布「${target.name}」→ ${remotePath}`)
      ctx.progress({ percent: 0, stage: stageText(0), message: '前置校验' })
      const pre = await precheckInternal({
        targetId: target.id,
        ports,
        mode: 'quick',
        ignoreReleaseId: release.id
      })
      state.mountInfo = pre.mountInfo

      for (const i of pre.report.items) {
        if (i.level !== 'ok') ctx.log(`${i.label}：${i.detail}`, i.level === 'warn' ? 'warn' : 'info')
      }

      // 锁：陈旧锁可以在用户确认后清掉；被占用必须等
      const lockItem = pre.report.items.find((i) => i.key === 'lock' && i.level !== 'ok')
      if (lockItem && !input.cleanStaleLock) {
        throw new AppError(
          pre.lock?.stale ? ErrorCode.E_LOCK_STALE : ErrorCode.E_TARGET_BUSY,
          { lockPath: lockPathOf(remotePath), lock: pre.lock },
          { message: lockItem.detail, ...(lockItem.suggestion ? { hint: lockItem.suggestion } : {}) }
        )
      }
      if (lockItem && pre.lockUnreadable) {
        ctx.log('远端锁文件内容无法解析，按用户确认予以清理', 'warn')
        await ports.fs.removeFile(lockPathOf(remotePath))
      }

      // 残留：默认拒绝；用户确认后只清"自己能证明来源"的那部分
      const residueItem = pre.report.items.find((i) => i.key === 'residue')
      if (residueItem && residueItem.level !== 'ok') {
        if (!input.confirmCleanResidue) {
          throw new AppError(
            ErrorCode.E_REMOTE_RESIDUE,
            { residue: pre.residue.map((r) => r.path) },
            {
              message: residueItem.detail,
              ...(residueItem.suggestion ? { hint: residueItem.suggestion } : {})
            }
          )
        }
        const auto = pre.residue.filter(isAutoCleanable)
        if (auto.length > 0) {
          const cleaned = await cleanResidue({
            targetId: target.id,
            paths: auto.map((r) => r.path),
            fs: ports.fs
          })
          for (const p of cleaned.removed) ctx.log(`已清理残留 ${p}`, 'warn')
          if (cleaned.failed.length > 0) {
            throw new AppError(
              ErrorCode.E_REMOTE_RESIDUE,
              { failed: cleaned.failed },
              {
                message: `清理残留失败：${cleaned.failed.map((f) => f.path).join('、')}`,
                hint: '请人工清理后再发布。'
              }
            )
          }
        }
        const manual = pre.residue.filter((r) => !isAutoCleanable(r))
        if (manual.length > 0) {
          ctx.log(
            `${manual.map((r) => r.name).join('、')} 不会被自动清理，若影响发布请人工处理`,
            'warn'
          )
        }
      }

      // 其余 error（本地产物 / 父目录 / 未结束的发布 …）
      const otherError = pre.report.items.find(
        (i) => i.level === 'error' && i.key !== 'residue' && i.key !== 'lock'
      )
      if (otherError) {
        throw new AppError(
          stagePrecheckCode(otherError.key),
          { key: otherError.key, detail: otherError.detail },
          {
            message: otherError.detail,
            ...(otherError.suggestion ? { hint: otherError.suggestion } : {})
          }
        )
      }

      // 记录目标原始权限/属主（阶段 5 之后恢复）。拿不到就算了，不是致命项。
      const st = await ports.fs.stat(remotePath)
      if (st.exists && st.mode !== undefined && st.uid !== undefined && st.gid !== undefined) {
        state.originalMode = { mode: st.mode, uid: st.uid, gid: st.gid }
      }

      /* =============== 阶段 1：本地指纹 =============== */
      progressAt(1, 0, '计算本地指纹')
      const localPath = target.localPath
      if (!localPath) throw new AppError(ErrorCode.E_LOCAL_PATH_MISSING, { targetId: target.id })

      const hashed = await hashLocalArtifact({
        localPath,
        kind,
        exclude: parseExcludeRaw(target.localExclude),
        signal: ctx.signal,
        onProgress: (done, total, file) => {
          progressAt(1, total > 0 ? done / total : 1, `计算指纹 ${done}/${total} ${file}`)
          ctx.progress({ files: done, totalFiles: total })
        }
      })
      throwIfAborted(ctx.signal)

      /**
       * 文件名对齐（B17 / T17.1）：文件型目标把清单里唯一那条 `relPath` 换成
       * **服务器端文件名**。这一步之后，上传落盘路径、阶段 3 的校验期望值、
       * 台账的逐文件清单、阶段 5 的换版源路径全部同口径 ——
       * 服务器上得到的文件名就是配置里的那个，而不是本地产物的文件名。
       *
       * 放在算指纹之后、**定版本号之前**：`rootHash` 会随 `relPath` 变化，
       * 版本号（`yyyyMMdd-HHmmss_<hash7>`）里含的是这个指纹的前 7 位，
       * 必须先对齐再定号，否则"号里的指纹"与"清单的指纹"不一致。
       */
      const aligned = alignArtifactItems({
        kind,
        remotePath,
        items: hashed.items,
        rootHash: hashed.rootHash
      })
      if (aligned.renamedFrom) {
        ctx.log(
          `本地产物 ${aligned.renamedFrom} 与服务器端文件名不一致，` +
            `发布时将以 ${base} 上传（与目标配置一致）`,
          'warn'
        )
      }

      const resolvedTag = await resolveVersionTagDetailed({
        rootHash: aligned.rootHash,
        now: now(),
        exists: async (tag) =>
          repo.releases.listByTarget(target.id, 500).some((r) => r.versionTag === tag)
      })
      state.local = {
        localPath,
        rootHash: aligned.rootHash,
        items: aligned.items,
        totalBytes: hashed.totalBytes,
        fileCount: hashed.fileCount,
        excludedCount: hashed.excludedCount,
        skippedSymlinks: hashed.skippedSymlinks
      }
      release = repo.releases.update(release.id, {
        versionTag: resolvedTag.versionTag,
        // 台账里的指纹必须与上面定版本号用的那一个是同一个口径（对齐后的）
        rootHash: aligned.rootHash,
        totalBytes: hashed.totalBytes,
        fileCount: hashed.fileCount
      })!
      /**
       * 逐文件清单落库：下一次发布归档旧版本时可以直接用，省掉一次全量远端哈希。
       *
       * 存的是**对齐后**的清单（`relPath` = 服务器端文件名）。这一点对文件型目标
       * 尤其重要：归档时这份清单要原样写进 manifest，而 manifest 的相对根是
       * `payload`、磁盘上的文件也叫服务器端文件名 —— 存本地名会让往期版本
       * **刚归档就被判 corrupt**（清单说 `order-v2.jar`、磁盘上却是 `order.jar`）。
       */
      if (aligned.items.length <= MAX_RELEASE_ITEMS_PERSIST) {
        repo.releaseItems.addMany(
          aligned.items.map((i) => ({
            releaseId: release.id,
            relPath: i.relPath,
            hash: i.hash,
            size: i.size,
            mtime: i.mtime ?? null
          }))
        )
      } else {
        ctx.log(
          `文件数 ${aligned.items.length} 超过 ${MAX_RELEASE_ITEMS_PERSIST}，本次不落逐文件清单` +
            `（下次发布归档旧版本时会现场计算远端指纹，会慢一些）`,
          'warn'
        )
      }

      ctx.log(
        `本地指纹 ${aligned.rootHash.slice(0, 12)}…（${hashed.fileCount} 个文件 / ` +
          `${fmtBytes(hashed.totalBytes)}）` +
          (hashed.excludedCount > 0 ? `，已排除 ${hashed.excludedCount} 个文件` : '') +
          (hashed.skippedSymlinks > 0 ? `，跳过 ${hashed.skippedSymlinks} 个符号链接` : '')
      )
      if (resolvedTag.attempts > 1) {
        ctx.log(
          `版本号发生 ${resolvedTag.attempts - 1} 次冲突，已使用 ${resolvedTag.versionTag}`,
          'warn'
        )
      }

      /* =============== 阶段 2：上传暂存 =============== */
      goto('UPLOADING', 2)
      progressAt(2, 0, '检查磁盘余量')
      const required = requiredBytesFor({ totalBytes: hashed.totalBytes })
      const available = (await dfOf(ports, parentDir))?.availableBytes ?? null
      const space = checkSpace({ requiredBytes: required, availableBytes: available })
      if (!space.ok) {
        throw new AppError(
          ErrorCode.E_DISK_SPACE,
          { required, available: space.availableBytes, parentDir },
          {
            message:
              `服务器空间不足：需要 ${fmtBytes(required)}（产物 × 2.2），` +
              `可用 ${fmtBytes(space.availableBytes)}`,
            hint: '请清理服务器空间，或调低保留策略里保留的版本数。'
          }
        )
      }
      if (space.unknown) ctx.log('无法探测服务器剩余空间（df 未给出结果），继续发布', 'warn')

      await acquireLock(
        ports,
        state,
        (t, l) => ctx.log(t, l),
        input.cleanStaleLock === true
      )
      ctx.log(`已获取远端发布锁（releaseId=${releaseId}）`)

      await ports.fs.mkdirp(state.stagingPayload)
      const up = await createTransfer(
        ports.transfer,
        deps.transferRetryDelay ? { retryDelay: deps.transferRetryDelay } : {}
      ).upload(
        aligned.items.map((it) => ({
          // 本地路径用系统分隔符（Windows 上是 \），远端路径用 / —— 两者不能混。
          //
          // 文件型目标要特别小心：此时清单唯一一条 item 的 `relPath` 就是**服务器端
          // 文件名**（阶段 1 已用 `alignArtifactItems` 对齐过），而 `localPath`
          // **就是那个本地文件**。再拼一次会得到 `<...>/order.jar/order.jar`
          // （不存在的路径）。
          // 远端照旧拼 —— `payload/<服务器端文件名>` 正是 `swapSourceOf` 要搬的东西，
          // 所以本地产物叫什么名字都不影响：落盘时用的就是配置里的名字。
          localPath: kind === 'file' ? localPath : joinLocal(localPath, it.relPath),
          remotePath: joinRemote(state.stagingPayload, it.relPath),
          size: it.size
        })),
        {
          concurrency: deps.transferConcurrency?.() ?? DEFAULT_CONCURRENCY,
          signal: ctx.signal,
          onProgress: (p) => {
            progressAt(
              2,
              p.total > 0 ? p.transferred / p.total : 0,
              `上传 ${p.filesDone}/${p.filesTotal} ${p.currentFile}`
            )
            ctx.progress({
              bytes: p.transferred,
              totalBytes: p.total,
              files: p.filesDone,
              totalFiles: p.filesTotal
            })
          }
        }
      )
      ctx.log(`上传完成：${up.files} 个文件 / ${fmtBytes(up.bytes)}，耗时 ${fmtMs(up.elapsedMs)}`)
      throwIfAborted(ctx.signal)

      /* =============== 阶段 3：远端校验 =============== */
      goto('VERIFYING', 3)
      progressAt(3, 0, '远端逐文件校验')
      /**
       * 校验清单要写到 `ports.hash.tmpDir`（一般是 `$HOME/.sfvm-tmp`），
       * 而**发布这条路径上没有人负责创建它** —— 归档那边的 `verifyArchive`
       * 自己建了（它也只覆盖归档场景）。结果就是：一台全新的服务器上第一次发布
       * 会卡在"写校验清单"这一步，报一个是上传中断、看着像链路问题的错。
       * `mkdirp` 幂等（已存在直接通过），所以这里无条件补一下。
       */
      await ports.fs.mkdirp(ports.hash.tmpDir)
      const verify = await verifyRemote({
        port: ports.hash,
        payloadDir: state.stagingPayload,
        expected: aligned.items,
        releaseId,
        verifyRemoteEnabled: target.verifyRemote,
        // 算法兼容模式关闭时，遇到没有 hash 工具的服务器直接报错（不静默降级）
        allowStreamFallback: deps.hashCompat?.() ?? true,
        signal: ctx.signal,
        onProgress: (done, total) => progressAt(3, total > 0 ? done / total : 1, `校验 ${done}/${total}`)
      })
      if (verify.mode === 'disabled') {
        ctx.log('该目标关闭了发布后远端校验，跳过（台账的 rootHash 来源为本地）', 'warn')
      } else if (!verify.diff.ok) {
        throw new AppError(
          ErrorCode.E_VERIFY_MISMATCH,
          {
            missing: verify.diff.missing.slice(0, 20),
            extra: verify.diff.extra.slice(0, 20),
            mismatch: verify.diff.mismatch.slice(0, 20).map((m) => m.relPath),
            matchedCount: verify.diff.matchedCount
          },
          {
            message:
              `远端校验未通过：缺失 ${verify.diff.missing.length} 个、` +
              `多出 ${verify.diff.extra.length} 个、哈希不符 ${verify.diff.mismatch.length} 个`,
            hint: '暂存目录会被清理，目标路径未做任何改动。请重试或检查链路稳定性。'
          }
        )
      } else {
        ctx.log(
          `远端校验通过（${verify.mode}，${verify.diff.matchedCount} 个文件一致，` +
            `${verify.durationMs}ms）`
        )
      }

      /* =============== 阶段 4：归档旧版本 =============== */
      goto('ARCHIVING', 4)
      progressAt(4, 0, '归档当前版本')
      // 换版/归档能否用原子 rename：目标是挂载点或跨设备时不能（见 decideSwapStrategy）
      state.moveMode =
        strategy === 'copy' || state.mountInfo.isMountPoint || state.mountInfo.crossDevice
          ? 'copy'
          : 'rename'
      const prev = await prevRelease(ports, target.id, release.id, state)

      /**
       * 首次发布：目标路径还不存在，**没有"当前版本"可归档**。
       *
       * 阶段 0 对这种情况给的是 warn（"将作为首次发布创建"），所以走到这里是
       * 合法路径；而 `archiveVersion` 对一个不存在的路径会直接抛
       * `E_TARGET_MISSING`/`E_ARCHIVE_FAILED` —— 不先判断就会出现
       * "precheck 说可以发布、阶段 4 必然失败"的自相矛盾。
       *
       * 这不属于 T10.6 禁止的"跳过归档"：那条禁令针对的是"目标上有内容、
       * 归档却失败了还硬往下走"（那会把现网版本弄丢）。这里是真的没有内容 ——
       * 目标是空的，`rename` 过去也不会覆盖任何东西。
       *
       * `archived` 为 null 时 `state.archiveId` 保持 null，于是阶段 5 失败时
       * 补偿逻辑不会去调 `undoArchive`（没有归档可复位），只清掉换版残留 ——
       * 正好回到"发布前目标不存在"的状态。
       */
      const targetExists = (await ports.fs.stat(state.remotePath)).exists

      /**
       * 上一版是一次**回滚恢复**吗？是的话，归档的清单与版本号要换一种给法：
       *
       * - 常规路径：上一版清单核对通过就一起传 —— 免一次全量远端哈希（慢链路上
       *   这一步要以分钟计），版本号也沿用上一版的；
       * - 回滚恢复：**清单不传**（宁可贵一次全量哈希）。那份清单描述的是"版本库
       *   里那一份"，而"现网是否仍是它"必须重新证明 —— 回滚到发布之间有人动过
       *   服务器的话，只有完整哈希能发现；而且这次归档的指纹马上要拿去与来源
       *   归档比对去重（见成功之后的 `discardDuplicateArchive`），指纹必须是真的。
       *   版本号照旧沿用：内容一致时号就该一致，去重之后留下来的也正是它。
       *
       * 前提是来源归档**还在**（回滚时选了"不保留来源"它就没了）—— 不在的话
       * 根本不会去重，也就不值得为此多花一次哈希。
       */
      const rollbackRestored = Boolean(
        prev?.action === 'rollback' && prev.archiveId && repo.archives.get(prev.archiveId)
      )
      const archived = targetExists
        ? await archive.archiveVersion({
            targetId: target.id,
            ports: { fs: ports.archiveFs, hash: ports.hash } satisfies ArchivePorts,
            // 清单与版本号同源：核对通过才同时传，"要归档的就是上一版那份内容"才成立
            ...(prev
              ? rollbackRestored
                ? { preferredTag: prev.versionTag }
                : { items: prev.items, preferredTag: prev.versionTag }
              : {}),
            releaseId: release.id,
            operator: input.operator ?? null,
            note: input.note ?? null,
            moveMode: state.moveMode,
            signal: ctx.signal,
            log: (text, level) => ctx.log(text, level),
            onProgress: (done, total) =>
              progressAt(4, total > 0 ? done / total : 1, `归档 ${done}/${total}`)
          })
        : null
      if (archived) {
        state.archiveId = archived.archive.id
        ctx.log(
          `已归档当前版本为 ${archived.archive.versionTag}` +
            (rollbackRestored
              ? '（上一版由回滚恢复，指纹已重新现场计算）'
              : archived.hashedRemotely
                ? '（指纹由远端现场计算）'
                : '') +
            '，归档后目标路径为空'
        )
      } else {
        ctx.log('目标路径尚不存在（首次发布），没有可归档的当前版本，直接进入换版')
      }

      /* =============== 阶段 5：换版 =============== */
      goto('SWAPPING', 5)
      progressAt(5, 0, '换版')
      throwIfAborted(ctx.signal)
      await swapIn(ports, state, (done, total, what) =>
        progressAt(5, total > 0 ? done / total : 1, what)
      )
      if (state.swapFallbackReason) {
        // 用户配的是 rename 却走了 copy —— 必须说出来，否则"为什么这次这么慢"无从解释
        ctx.log(`换版改用 copy：${state.swapFallbackReason}`, 'warn')
      }
      const align = await alignOwnership(ports, state, ctx, input.alignOwnership !== false)

      /* =============== 阶段 6：收尾（不允许抛错） =============== */
      goto('SUCCESS', 6)
      progressAt(6, 0, '收尾')
      await cleanupAfterSuccess(ports, state, ctx)
      // P0-1：这两条是**成功后的记账**，任何一条抛错都不能进补偿 —— 补偿会把
      // 目标路径上刚发成功的新版本删掉。记账失败只留错误日志，台账与事实的
      // 偏差交给 B14 对账修正（服务器上的内容才是事实）。
      // 两条各自兜底：第一条失败不能连累第二条继续记账。
      try {
        repo.targets.markDeployed(target.id)
      } catch (err) {
        logger.error(
          `发布已成功但 markDeployed 失败（releaseId=${release.id}），请执行对账修正：` +
            `${(err as Error).message}`
        )
        ctx.log(`警告：发布成功，但更新目标状态失败（${(err as Error).message}）`, 'warn')
      }
      try {
        release = repo.releases.finish(release.id, 'SUCCESS')!
      } catch (err) {
        logger.error(
          `发布已成功但台账收尾失败（releaseId=${release.id}），请执行对账修正：` +
            `${(err as Error).message}`
        )
        ctx.log(`警告：发布成功，但写台账终态失败（${(err as Error).message}）`, 'warn')
      }
      progressAt(6, 1, '发布完成')
      ctx.log(`发布成功：${remotePath} 已更新为 ${resolvedTag.versionTag}`)

      /**
       * 回滚之后紧跟的发布：刚归档出来的这份，多半就是上次回滚**恢复**出来的
       * 内容 —— 它在版本库里本来就有一份（回滚默认保留来源）。不去重的话，
       * 「往期版本」里会出现两份一模一样的版本。
       *
       * 刻意放在**成功之后**而不是在阶段 4 跳过归档：阶段 4 的"目标上有内容就
       * 必须归档、归档失败禁止继续"是整条补偿链的前提。发布已经成功，这时才摘
       * 掉重复的那份，任何失败都只是"多留了一份重复"，绝不会丢内容 ——
       * 所以 `discardDuplicateArchive` 的失败在这里只记警告，不上抛。
       *
       * 前提是 `prev` 的清单核对通过了（否则 `prev` 为 null，根本走不到这里）：
       * 现网内容与台账对不上时不去重，照常归档 —— 那种情况下的这份归档是
       * "台账不知道的改动"，必须完整保留。
       */
      let dedupeKeptTag: string | null = null
      if (archived && prev?.action === 'rollback' && prev.archiveId) {
        // 为什么没去重的各种情形由 archive 自己按严重程度说明（info/warn）
        const deduped = await archive.discardDuplicateArchive({
          archiveId: archived.archive.id,
          keepArchiveId: prev.archiveId,
          fs: ports.archiveFs,
          log: (text, level) => ctx.log(text, level)
        })
        if (deduped.discarded) {
          // 台账里"本次归档的版本"已经不在了；对用户有意义的是**保留下来**的那份
          dedupeKeptTag = deduped.keptVersionTag
        }
      }

      // 保留策略：发布成功后异步执行（方案书 §6.7），不阻塞成功信号
      trackBackground(
        (async () => {
          try {
            const r = await archive.applyRetention({
              targetId: target.id,
              fs: ports.archiveFs,
              log: (text, level) => ctx.log(`[保留策略] ${text}`, level)
            })
            ctx.log(`保留策略执行完毕：${r.policyText}`)
          } catch (err) {
            logger.warn(`保留策略执行失败（不影响发布结果）：${(err as Error).message}`)
            ctx.log(`保留策略执行失败（不影响发布结果）：${(err as Error).message}`, 'warn')
          }
        })()
      )

      return {
        ok: true,
        releaseId: release.id,
        targetId: target.id,
        versionTag: resolvedTag.versionTag,
        status: 'SUCCESS',
        // 首次发布没有归档这一步，这里就不该有版本号（不要让 UI 显示一个不存在的往期版本）；
        // 去重之后那份归档已被摘除，报的是**保留下来**的那份
        ...(archived
          ? { archivedVersionTag: dedupeKeptTag ?? archived.archive.versionTag }
          : {}),
        strategy,
        ...(state.swapFallbackReason
          ? {
              strategyFallback: {
                from: 'rename' as const,
                to: 'copy' as const,
                reason: state.swapFallbackReason
              }
            }
          : {}),
        rootHash: aligned.rootHash,
        fileCount: hashed.fileCount,
        totalBytes: hashed.totalBytes,
        durationMs: Date.now() - started,
        alignment: align
      }
    } catch (err) {
      /* ================= 失败：补偿 ================= */
      const failure = await compensate(err, stage, state, ports, ctx, compensations)
      try {
        repo.releases.finish(release.id, 'FAILED', `${failure.code}: ${failure.message}`)
        if (err instanceof AppError && err.code === ErrorCode.E_JOB_CANCELLED) {
          // 取消不是"失败"：用 current_step 区分开，UI 给的建议完全不同
          repo.releases.update(release.id, { currentStep: 'cancelled' })
        }
      } catch (e) {
        logger.error(`写失败状态到台账时出错：${(e as Error).message}`)
      }
      return {
        ok: false,
        releaseId: release.id,
        targetId: target.id,
        versionTag: release.versionTag,
        status: 'FAILED',
        strategy,
        rootHash: state.local?.rootHash ?? '',
        fileCount: state.local?.fileCount ?? 0,
        totalBytes: state.local?.totalBytes ?? 0,
        durationMs: Date.now() - started,
        failure
      }
    } finally {
      localBusy.delete(input.targetId)
    }
  }

  /* ------------------------------------------------------ 阶段 5 的实现 */

  async function swapIn(
    ports: DeployPorts,
    state: StageState,
    onCopyFile: (done: number, total: number, what: string) => void
  ): Promise<void> {
    const src = swapSourceOf(state.remotePath, state.releaseId, state.kind)
    const decision = decideSwapStrategy({ configured: state.strategy, preflight: state.mountInfo })

    if (decision.strategy === 'rename') {
      try {
        await ports.fs.rename(src, state.remotePath)
        state.moveMode = 'rename'
        return
      } catch (err) {
        // 真去 rename 却失败了 —— 只有"这一种情况"值得回退到 copy（EXDEV / EBUSY）。
        // 权限之类的问题 copy 同样会失败，硬回退只会掩盖真实原因。
        const retry = decideSwapStrategy({ configured: state.strategy, renameError: err })
        if (retry.strategy !== 'copy') {
          throw new AppError(
            ErrorCode.E_SWAP_FAILED,
            { src, target: state.remotePath, original: (err as Error).message },
            { message: `换版失败：${(err as Error).message}` }
          )
        }
        state.swapFallbackReason = retry.fallbackReason ?? (err as Error).message
      }
    } else if (decision.fallbackReason) {
      // 阶段 0 已探明 rename 不可用（目标是挂载点 / 跨设备）——不调用必然失败的 rename。
      // 只有"本该 rename 却走了 copy"才算回退；用户自己配置成 copy 时没有 reason，不记回退。
      state.swapFallbackReason = decision.fallbackReason
    }

    state.moveMode = 'copy'
    await copyArtifactInto({
      fs: ports.fs,
      src,
      dst: state.remotePath,
      kind: state.kind,
      onFile: (done, total, rel) => onCopyFile(done, total, `复制 ${rel}`)
    })
  }

  /** 换版成功后的权限/属主对齐（T10.9）。任何失败都只告警，不影响发布结果。 */
  async function alignOwnership(
    ports: DeployPorts,
    state: StageState,
    ctx: DeployContext,
    enabled: boolean
  ): Promise<Array<{ action: 'chmod' | 'chown'; ok: boolean; detail?: string }>> {
    if (!enabled || !state.originalMode) return []
    const out: Array<{ action: 'chmod' | 'chown'; ok: boolean; detail?: string }> = []
    const { mode, uid, gid } = state.originalMode

    /**
     * 只对齐**目标路径自身**的权限/属主，不做递归。
     *
     * 理由：递归 `chmod -R` 会把**目录的**权限位套到所有文件上 ——
     * 原本 755 的脚本会被改成 644 而失去可执行位。而"恢复归档前的 mode"
     * 本身只能表达一个值，表达不了"目录 755 / 文件 644 / 脚本 755"这组事实。
     * 目标目录自身的权限才是 nginx 遍历时真正需要的（DoD 也是这么写的）。
     */
    const tryRun = async (
      action: 'chmod' | 'chown',
      cmd: string,
      okText: string,
      failText: string
    ): Promise<void> => {
      try {
        const r = await ports.exec(cmd)
        const ok = r.code === 0
        out.push({
          action,
          ok,
          ...(ok ? {} : { detail: r.stderr.trim() || `退出码 ${r.code}` })
        })
        ctx.log(ok ? okText : failText, ok ? 'info' : 'warn')
      } catch (err) {
        out.push({ action, ok: false, detail: (err as Error).message })
        ctx.log(`${failText}：${(err as Error).message}`, 'warn')
      }
    }

    await tryRun(
      'chmod',
      buildChmodCommand({ mode: toModeBits(mode), path: state.remotePath }),
      `已恢复权限 ${toModeBits(mode)}`,
      '恢复权限失败（仅告警）'
    )
    await tryRun(
      'chown',
      buildChownCommand({ uid, gid, path: state.remotePath }),
      `已恢复属主 ${uid}:${gid}`,
      '恢复属主失败（仅告警；非 root 账号下属正常）'
    )
    return out
  }

  /** 阶段 6：删暂存、放锁。**全部尽力而为**，不允许把成功的发布改成失败。 */
  async function cleanupAfterSuccess(
    ports: DeployPorts,
    state: StageState,
    ctx: DeployContext
  ): Promise<void> {
    try {
      if ((await ports.fs.stat(state.stagingRoot)).exists) {
        await ports.fs.rmrf(state.stagingRoot)
        ctx.log('已清理暂存目录')
      }
    } catch (err) {
      logger.warn(`清理暂存目录失败：${(err as Error).message}`)
      ctx.log(`警告：暂存目录 ${state.stagingRoot} 未能删除，请手工清理`, 'warn')
    }
    await releaseLock(ports, state)
  }

  /* ------------------------------------------------------ 失败补偿 */

  async function compensate(
    err: unknown,
    stage: number,
    state: StageState,
    ports: DeployPorts,
    ctx: DeployContext,
    out: Array<{ action: string; ok: boolean; detail?: string }>
  ): Promise<DeployFailure> {
    const appErr = err instanceof AppError ? err : null
    const code = appErr?.code ?? ErrorCode.E_UNKNOWN
    const message = (err as Error)?.message ?? String(err)
    const log = (text: string, level: JobLogLevel = 'info'): void => ctx.log(text, level)

    logger.warn(`发布在阶段 ${stage}（${stageText(stage)}）失败：${code} ${message}`)
    log(`发布失败（阶段 ${stage} ${stageText(stage)}）：${message}`, 'error')

    /**
     * 补偿顺序是**由外到内**的：先清掉可能存在的半个新版本，
     * 再把旧版本放回目标路径，最后才清暂存、放锁。
     * 反过来会出现"目标路径已被别的内容占着，旧版本搬不回来"的死局。
     *
     * 条件是 `=== 5` 而不是 `>= 5`（P0-1）：只有**换版本身没完成**才允许碰目标路径。
     * `goto('SUCCESS', 6)` 之后，目标路径上就是刚交付的新版本——阶段 6 的任何失败
     * 都无权把它删掉（那等于"失败处理比原故障更破坏"）。
     */
    if (stage === 5) {
      try {
        if ((await ports.fs.stat(state.remotePath)).exists) {
          await ports.fs.rmrf(state.remotePath)
          out.push({
            action: '清理换版残留',
            ok: true,
            detail: '目标路径上的不完整新版本已清除'
          })
        }
      } catch (e) {
        out.push({ action: '清理换版残留', ok: false, detail: (e as Error).message })
      }
      if (state.archiveId) {
        try {
          await archive.undoArchive({
            archiveId: state.archiveId,
            ports: { fs: ports.archiveFs, hash: ports.hash },
            moveMode: state.moveMode,
            log
          })
          out.push({ action: '归档复位', ok: true, detail: '已把旧版本搬回目标路径' })
        } catch (e) {
          const detail = (e as Error).message
          out.push({ action: '归档复位', ok: false, detail })
          log(`归档复位失败：${detail}`, 'error')
        }
      }
    }

    if (stage >= 2) {
      try {
        if ((await ports.fs.stat(state.stagingRoot)).exists) {
          await ports.fs.rmrf(state.stagingRoot)
          out.push({ action: '清理暂存目录', ok: true })
        }
      } catch (e) {
        out.push({
          action: '清理暂存目录',
          ok: false,
          detail: `暂存目录 ${state.stagingRoot} 未能删除（${(e as Error).message}），可手工清理`
        })
      }
      if (state.lockHeld) {
        try {
          await releaseLock(ports, state)
          out.push({ action: '释放远端锁', ok: true })
        } catch (e) {
          out.push({ action: '释放远端锁', ok: false, detail: (e as Error).message })
        }
      }
    } else {
      log('远端未做任何改动')
      out.push({ action: '远端状态', ok: true, detail: '未做任何改动' })
    }

    const manualCleanup = out.filter((c) => !c.ok).map((c) => c.detail ?? c.action)
    return {
      stage,
      stageText: stageText(stage),
      code,
      message,
      ...(appErr?.hint ? { hint: appErr.hint } : {}),
      compensations: out,
      ...(manualCleanup.length > 0 ? { manualCleanup } : {})
    }
  }

  /* ------------------------------------------------------ 残留清理 */

  async function cleanResidue(input: DeployResidueCleanInput): Promise<DeployResidueCleanResult> {
    const { parentDir, base } = resolvePaths(input.targetId)
    // 只允许删"父目录下、被残留识别器认出来的东西"，不接受任意路径 ——
    // 否则这个入口就变成"删任意远端路径"的开关了。
    const known = classifyResidue({
      parentDir,
      targetBase: base,
      entries: await input.fs.readdir(parentDir)
    })
    const removable = new Set(known.filter(isAutoCleanable).map((r) => joinRemote(parentDir, r.name)))

    const removed: string[] = []
    const failed: Array<{ path: string; reason: string }> = []
    for (const p of input.paths) {
      const norm = normalizeRemotePath(p)
      if (!removable.has(norm)) {
        failed.push({ path: norm, reason: '不在可自动清理的残留清单里' })
        continue
      }
      try {
        await input.fs.rmrf(norm)
        removed.push(norm)
      } catch (e) {
        failed.push({ path: norm, reason: (e as Error).message })
      }
    }
    if (removed.length > 0) {
      repo.audit.write({
        level: 'warn',
        scope: 'deploy',
        refId: input.targetId,
        message: `清理远端发布残留：${removed.join('、')}`,
        detail: JSON.stringify({ targetId: input.targetId, removed })
      })
    }
    return { removed, failed }
  }

  /* ---------------------------------------------- 当前线上版本（纯台账） */

  /**
   * 最近一次**成功操作**的版本号（发布或回滚都算）。
   *
   * 只读台账，不连服务器、不算本地指纹 —— 所以目标没配本地产物路径也能回答，
   * 也不会让"切一次目标页"变成"hash 一遍整个产物目录"。
   *
   * 与 `preview().lastVersionTag` 的关系：两者取的是同一行，但 `preview` 还要
   * 算一次全量本地指纹才能返回（它的主业是差异摘要）。界面上的「当前版本」
   * 用这个通道就够了。
   */
  function currentVersion(input: DeployCurrentVersionInput): DeployCurrentVersion {
    const target = repo.targets.get(input.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: input.targetId })

    // 取最近一次 SUCCESS：回滚也会写一条，所以这同时覆盖"回滚后的当前版本"
    const row = repo.releases.listByTarget(input.targetId, 20).find((r) => r.status === 'SUCCESS')
    if (!row) {
      return { versionTag: null, action: null, at: null, fileCount: 0, totalBytes: 0 }
    }
    return {
      versionTag: row.versionTag,
      action: row.action,
      at: row.finishedAt ?? row.startedAt,
      fileCount: row.fileCount,
      totalBytes: row.totalBytes
    }
  }

  /* ------------------------------------------------------ 发布预览（T11.3） */

  /**
   * "这次发布会改动什么" —— **纯本地**：只读台账 + 算一次本地指纹，不碰服务器。
   *
   * 之所以敢在用户点"发布"时同步算一次完整本地指纹：本地读盘比远端快两个数量级
   * （B07 实测远端出带宽 ~0.46 MB/s，而本地 SSD 上百 MB/s），
   * 而且这份指纹本来在阶段 1 还要再算一遍 —— 两处口径都来自 `hashLocalArtifact`，
   * 不会出现"预览说 1200 个文件、上传却传了 1180 个"。
   */
  async function preview(input: { targetId: string; limit?: number }): Promise<DeployPreview> {
    const { target, kind } = resolvePaths(input.targetId)
    const localPath = target.localPath?.trim() ?? ''
    if (!localPath) {
      throw new AppError(
        ErrorCode.E_LOCAL_PATH_MISSING,
        { targetId: target.id },
        {
          message: '该目标还没有配置本地构建产物路径',
          hint: kind === 'dir' ? '请先选择要发布的目录。' : '请先选择要发布的文件。'
        }
      )
    }

    const hashed = await hashLocalArtifact({
      localPath,
      kind,
      exclude: parseExcludeRaw(target.localExclude)
    })

    /**
     * 指纹与差异都按**服务器端文件名**的口径算（B17）。
     *
     * 差异摘要的比对基准是上一次发布存下的逐文件清单 —— 那一份也是对齐后的
     * （`relPath` = 服务器端文件名）。两边同口径才有两个好处：
     * ① 弹窗里的指纹与发布记录里的一致；
     * ② 用户给本地产物改名（业务上很常见的 `app-v2.jar` 之类）不会在界面上
     *    伪造成"删掉一个、新增一个"，而是如实显示"改了 1 个文件"。
     */
    const aligned = alignArtifactItems({
      kind,
      remotePath: target.remotePath,
      items: hashed.items,
      rootHash: hashed.rootHash
    })

    // "最近一次变动"取路径自身与全部文件 mtime 的较新者（规则与详情页的徽标一致）
    const st = await statLocal(localPath).catch(() => null)
    const mtimeMs = newestMtimeOf([
      st?.mtimeMs ?? null,
      ...hashed.items.map((i) => (i.mtime ? Date.parse(i.mtime) : null))
    ])
    const nowMs = now().getTime()

    /**
     * 比对基准取"最近一次**成功**发布"，不是"最近一次发布"。
     *
     * 失败的那次可能根本没写逐文件清单（阶段 1 之后就炸了），拿它当基准会得出
     * "全部都是新增"这种假结论。也刻意**不复用** `prevRelease()`：
     * 那个函数还会去远端核对现网内容（为了决定归档用不用传清单），
     * 而这里离线要求可用 —— 用户在没连服务器时也要能看见"这次改了哪些文件"。
     */
    const prev = repo.releases.listByTarget(target.id, 50).find((r) => r.status === 'SUCCESS')
    const prevRows = prev ? repo.releaseItems.listByRelease(prev.id) : []
    const previous: ReleaseItem[] | null =
      prev && prevRows.length > 0
        ? prevRows.map((i) => ({
            relPath: i.relPath,
            hash: i.hash,
            size: i.size,
            mtime: i.mtime ?? null
          }))
        : null

    const diff = computePublishDiff({
      previous,
      current: aligned.items,
      previousVersionTag: prev?.versionTag ?? null,
      ...(input.limit === undefined ? {} : { limit: input.limit })
    })

    return {
      targetId: target.id,
      artifact: {
        localPath,
        kind,
        fileCount: hashed.fileCount,
        totalBytes: hashed.totalBytes,
        rootHash: aligned.rootHash,
        excludedCount: hashed.excludedCount,
        skippedSymlinks: hashed.skippedSymlinks,
        possiblyStale: isArtifactStale(mtimeMs, nowMs),
        newestMtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString()
      },
      diff,
      /**
       * 当前线上版本号 = 最近一次**成功操作**的版本号（发布或回滚）。
       *
       * **刻意与 `previous` 解耦**：`previous` 是"差异摘要的基准清单"，
       * 它拿不到（逐文件清单没落库：文件数超过上限、或是回滚写入的那一条早期版本）
       * 只该让**差异摘要**退化成"无法比对"，不该让"当前版本"变成空 ——
       * 后者是用户判断"线上到底是什么"的唯一依据。
       * 这个耦合是 B13 回滚上线后暴露的：回滚当时不写逐文件清单，
       * 于是回滚完详情页的"当前版本"直接变空。
       */
      lastVersionTag: prev?.versionTag ?? null,
      // 台账里存的是原始 JSON 字符串，必须先解析（与归档服务同一套解析器）
      retainPolicyText: describeRetainPolicy(parseRetainPolicy(target.retainPolicy))
    }
  }

  return {
    precheck: (input) => precheckInternal({ ...input, mode: 'full' }).then((r) => r.report),
    preview,
    currentVersion,
    run,
    cleanResidue,
    busyTargets: () => [...localBusy],
    whenIdle: async () => {
      while (background.size > 0) await Promise.all([...background])
    }
  }
}
