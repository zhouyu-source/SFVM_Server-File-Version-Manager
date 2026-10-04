/**
 * 发布流程的**纯逻辑**部分（T10.2 / T10.8 / T10.11 的可测内核）。
 *
 * 这里放的全是"给定输入就能算出结论"的函数：路径推导、锁载荷的读写、
 * 陈旧锁判定、磁盘余量判断、换版策略决策、残留识别。
 * 把它们从 `services/deploy.ts` 里拆出来，是为了**穷举式单测** ——
 * 发布是本项目唯一会改动生产服务器的流程，靠"真机跑一遍"覆盖不了
 * "磁盘差 1 字节"、"锁刚好 30 分钟"、"父目录与目标不同设备"这类边界。
 *
 * ## 远端目录布局（与方案书 §6.8 / 附录 C 一致）
 *
 * ```
 * /opt/web/
 * ├─ .sfvm-staging-<releaseId>/         ← 暂存根（与目标同父目录 ⇒ 同文件系统）
 * │  ├─ payload/                        ← 阶段 2 把新版本传到这里
 * │  │  └─ dist/{index.html,…}          ← 目录型：payload 本身就是新版本目录
 * │  └─ files.sha256                    ← 阶段 3 的校验清单
 * ├─ .sfvm.lock                         ← 跨机器互斥
 * ├─ dist/                              ← 受管目标（当前版本）
 * └─ dist.versions/                     ← 往期版本库
 * ```
 *
 * 文件型目标的结构完全相同，只是 `payload/` 里只有一个 `<basename>`：
 *
 * ```
 * /opt/svc/.sfvm-staging-<id>/payload/order.jar
 * ```
 *
 * **为什么文件型也要多包一层 `payload/`**：换版动作统一成
 * "把 payload 里的东西搬到目标路径"。目录型搬的是 `payload` 这个目录本身，
 * 文件型搬的是 `payload/<basename>` 这个文件。两者都只需一次 rename，
 * 而 `payload/` 这一层让两者共享同一套校验、清理与回滚路径 ——
 * 少一套分支就少一类"只在某一种目标上才复现"的 bug。
 */
import { posix } from 'node:path'
import {
  LOCK_FILE_NAME,
  LOCK_STALE_MS,
  STAGING_PREFIX,
  remoteLockSchema,
  type RemoteLockInfo
} from '../../shared/contracts/deploy'
import { normalizeRemotePath } from './remote-path'
import { computeRootHash, joinRemote } from './hash-core'
import { parentDirOf, posixBasename } from './archive-dir'
import { AppError, ErrorCode } from './errors'

/* -------------------------------------------------------------- 路径推导 */

/** 暂存根：`<父目录>/.sfvm-staging-<releaseId>`。 */
export function stagingRootOf(remotePath: string, releaseId: string): string {
  const parent = parentDirOf(normalizeRemotePath(remotePath))
  return posix.join(parent, `${STAGING_PREFIX}${releaseId}`)
}

/** 暂存里的新版本内容根（阶段 2 的目的地、阶段 3 的校验根）。 */
export function stagingPayloadOf(remotePath: string, releaseId: string): string {
  return joinRemote(stagingRootOf(remotePath, releaseId), 'payload')
}

/** 暂存里的校验清单文件（阶段 3 上传，校验完由暂存清理一并删除）。 */
export function stagingManifestOf(remotePath: string, releaseId: string): string {
  return joinRemote(stagingRootOf(remotePath, releaseId), 'files.sha256')
}

/** 跨机器互斥锁：`<父目录>/.sfvm.lock`。 */
export function lockPathOf(remotePath: string): string {
  return joinRemote(parentDirOf(normalizeRemotePath(remotePath)), LOCK_FILE_NAME)
}

/**
 * 阶段 5 真正要 rename 的源路径。
 *
 * 目录型 → `payload` 目录本身；文件型 → `payload/<basename>`。
 * 见文件头的说明：两种目标共用"一次 rename 就位"的路径。
 */
export function swapSourceOf(
  remotePath: string,
  releaseId: string,
  kind: 'dir' | 'file'
): string {
  const payload = stagingPayloadOf(remotePath, releaseId)
  return kind === 'dir' ? payload : joinRemote(payload, posixBasename(remotePath))
}

/* -------------------------------------- 本地产物与目标的文件名对齐（B17） */

export interface AlignArtifactResult<T> {
  /** 对齐后的逐文件清单（文件型目标会换掉那唯一一条的 `relPath`） */
  items: T[]
  /** 与 `items` 同口径的聚合指纹 */
  rootHash: string
  /** 发生了改名时的**原文件名**；没改名（含目录型）为 null */
  renamedFrom: string | null
}

/**
 * 把本地产物的逐文件清单**对齐到目标的文件名口径**（B17 / T17.1）。
 *
 * ## 它修的是什么
 *
 * 文件型目标的换版要把 `payload/<服务器端文件名>` 搬到目标路径
 * （见 `swapSourceOf`），而 `hashLocalArtifact` 给出的 `relPath` 是**本地产物的
 * 文件名**。两处名字不一致时，上传落到 `payload/<本地名>`、换版去找
 * `payload/<服务器端名>` → 第 5 阶段报"找不到文件"，而阶段 3 的远端校验
 * **两边都用本地名，反而会通过** —— 于是错误一直到换版才爆出来。
 *
 * 修法不是在换版前补一次 rename（那会多一个远端操作与中断窗口），而是在**阶段 1
 * 就把口径统一**：清单里的 `relPath` 直接写成服务器端文件名，于是
 * 上传路径、远端校验的期望值、台账里的逐文件清单、换版的源路径**天然一致** ——
 * 服务器上落地的就是配置里的文件名。
 *
 * ## 为什么必须**同时**重算 `rootHash`
 *
 * 聚合指纹是按 `relPath` 排序后拼出来算的（`computeRootHash`），改了 `relPath`
 * 却不重算，台账里的 `releases.root_hash` 就会与"归档时按同一份清单重算出来的
 * manifest.rootHash"对不上 —— 而往期版本的可信度全靠这两个值互相印证。
 *
 * ## 目录型目标为什么原样返回
 *
 * 目录型搬的是整个 `payload` 目录，目标目录名与产物内部的文件名无关，
 * 不存在需要对齐的东西。这里刻意返回**复制后的数组**（而不是原引用），
 * 让调用方无论哪种类型都拿到一份可安全改动的数据。
 */
export function alignArtifactItems<T extends { relPath: string; hash: string }>(input: {
  kind: 'dir' | 'file'
  remotePath: string
  items: readonly T[]
  rootHash: string
}): AlignArtifactResult<T> {
  const items = input.items.map((it) => ({ ...it }))
  if (input.kind !== 'file') {
    return { items, rootHash: input.rootHash, renamedFrom: null }
  }

  const remoteName = posixBasename(input.remotePath)
  if (!remoteName) {
    // 正常途径构造不出来（`normalizeRemotePath` 会折叠末尾斜杠、根目录又被拒），
    // 但台账里的路径可能来自旧版本或被手工改过 —— 这里显式拦住，
    // 而不是让 `payload/` 变成一个目录级路径去搬。
    throw new AppError(
      ErrorCode.E_TARGET_NAME_MISSING,
      { remotePath: input.remotePath },
      {
        message: `文件型目标的服务器端路径没有文件名：${input.remotePath}`,
        hint: '请把目标的服务器端路径改成以文件名结尾（例如 /opt/svc/order.jar）。'
      }
    )
  }
  if (items.length !== 1) {
    // 文件型目标必然只有一条（`hashLocalArtifact` 对文件只产出一条）。
    // 多于一条时改名会产生重名条目，宁可报错也不要写出一份自相矛盾的清单。
    throw new AppError(
      ErrorCode.E_PARAM,
      { count: items.length, remotePath: input.remotePath },
      {
        message: `文件型目标应当只对应一个文件，实际得到 ${items.length} 个`,
        hint: '请检查本地产物配置；若产物确实是多个文件，请把目标改成目录型。'
      }
    )
  }

  const from = items[0].relPath
  if (from === remoteName) return { items, rootHash: input.rootHash, renamedFrom: null }
  items[0].relPath = remoteName
  return { items, rootHash: computeRootHash(items), renamedFrom: from }
}

/* ---------------------------------------------------------------- 锁 */

export interface BuildLockPayloadInput {
  releaseId: string
  hostname: string
  pid: number
  now: Date
}

/** 生成锁文件内容（单行 JSON，便于 `cat` 出来看）。 */
export function buildLockPayload(input: BuildLockPayloadInput): string {
  return JSON.stringify({
    releaseId: input.releaseId,
    hostname: input.hostname,
    pid: input.pid,
    ts: input.now.toISOString()
  })
}

/** 锁是否陈旧：写入时间距今超过 `LOCK_STALE_MS`。 */
export function isLockStale(ts: string, now: Date): boolean {
  const t = Date.parse(ts)
  // 时间解析不出来时**当作陈旧**：锁的 `ts` 是我们自己写的 ISO 字符串，
  // 读不懂说明它被改坏了；此时"当作没过期"会让用户彻底无法发布
  // （提示"有发布正在进行中"，且永远不消失），而"当作陈旧"至少给出可操作的提示。
  if (!Number.isFinite(t)) return true
  return now.getTime() - t > LOCK_STALE_MS
}

/**
 * 解析锁文件。
 *
 * 返回 `null` = "锁文件存在但读不懂"。调用方必须把它与"没有锁"区分开：
 * 前者要给用户看内容（他需要判断是不是该手工删），后者直接放行。
 */
export function parseLockPayload(text: string | null | undefined, now: Date): RemoteLockInfo | null {
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return null
  }
  const r = remoteLockSchema.safeParse(parsed)
  if (!r.success) return null
  return {
    releaseId: r.data.releaseId,
    hostname: r.data.hostname,
    pid: r.data.pid,
    ts: r.data.ts,
    stale: isLockStale(r.data.ts, now),
    path: ''
  }
}

/* -------------------------------------------------------------- 磁盘空间 */

export interface SpaceCheck {
  ok: boolean
  requiredBytes: number
  availableBytes: number
  /** 探测失败时为 true —— 调用方要按"无法确认"处理，而不是"空间为 0" */
  unknown: boolean
}

/**
 * 磁盘余量判断（方案书 §6.8 阶段 0 的 `≥ 产物 × 2.2`）。
 *
 * `availableBytes === null` 表示 `df` 没解析出结果。这时**不阻止发布**，
 * 而是按 warn 呈现：探测失败可能是目标路径还不存在（首次发布）、
 * `df` 不支持该路径等；把它当成"空间不足"会直接卡死首次发布。
 * 真正空间不够时阶段 2 的上传会失败，届时错误信息更准确。
 */
export function checkSpace(input: {
  requiredBytes: number
  availableBytes: number | null
}): SpaceCheck {
  if (input.availableBytes === null) {
    return {
      ok: true,
      requiredBytes: input.requiredBytes,
      availableBytes: 0,
      unknown: true
    }
  }
  return {
    ok: input.availableBytes >= input.requiredBytes,
    requiredBytes: input.requiredBytes,
    availableBytes: input.availableBytes,
    unknown: false
  }
}

/* ------------------------------------------------------------ 挂载点识别 */

/**
 * 目标路径本身是不是挂载点。
 *
 * POSIX 语义：`df -Pk <path>` 回报的是**承载该路径的文件系统**，
 * 其 `Mounted-on` 列等于该路径 ⇔ 该路径就是一个挂载点。
 * 这是不依赖远端 shell 也能判断挂载点的标准做法（SFTP 的 stat 给不出这个信息）。
 *
 * 顺带用 `filesystem` 交叉验证：目标与其父目录若在不同设备上，
 * 暂存（建在父目录）与目标之间的 `rename` 必然 `EXDEV`，
 * 提前识别出来就能避免"传到一半才发现要回退到 copy"。
 */
export function detectMountPoint(input: {
  remotePath: string
  targetDf: { filesystem: string; mountPoint: string } | null
  parentDf: { filesystem: string; mountPoint: string } | null
}): { isMountPoint: boolean; crossDevice: boolean; reason?: string } {
  const target = normalizeRemotePath(input.remotePath)
  const t = input.targetDf
  const p = input.parentDf
  if (!t) return { isMountPoint: false, crossDevice: false }

  const mountEqTarget = normalizeRemotePath(t.mountPoint) === target
  const crossDevice = Boolean(p && p.filesystem !== t.filesystem)

  if (mountEqTarget) {
    return {
      isMountPoint: true,
      crossDevice,
      reason: `${target} 本身是挂载点（挂载于 ${t.filesystem}）`
    }
  }
  if (crossDevice && p) {
    return {
      isMountPoint: false,
      crossDevice: true,
      reason: `目标位于 ${t.filesystem}，而其父目录位于 ${p.filesystem}`
    }
  }
  return { isMountPoint: false, crossDevice: false }
}

/* ------------------------------------------------------------ 换版策略 */

export interface SwapDecision {
  strategy: 'rename' | 'copy'
  /** 从 rename 回退到 copy 的原因；直接用配置的 copy 时为 undefined */
  fallbackReason?: string
}

/**
 * 从 SFTP 报错里判断是不是"rename 不可用"。
 *
 * ssh2 把服务端的 SFTP 状态码放在 `err.code` 里：
 * - 18 = `SSH_FX_EXDEV`（跨设备）
 * - 4/`SSH_FX_FAILURE` = 笼统失败，`EBUSY` 通常以这个码 + `errno` 出现在 message 里
 *
 * 之所以还要匹配 message：不同 OpenSSH 版本对 `EBUSY`（挂载点被占用）
 * 的映射不一致，有的报 `SSH_FX_FAILURE`，有的直接透传 `errno`。
 */
export function isSwapUnsupportedError(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string } | null | undefined
  if (!e) return false
  if (e.code === 18) return true
  const msg = `${e.message ?? ''}`
  return /\bEXDEV\b|\bEBUSY\b|Invalid cross-device link|Device or resource busy/i.test(msg)
}

/**
 * 决定换版策略（T10.8）。
 *
 * 三种来源按优先级：
 * 1. 目标配置成 `copy` → 直接用 copy（不发 rename，避免必然失败的调用）；
 * 2. 配置是 `rename`，但阶段 0 已经探明"目标是挂载点 / 跨设备" → 直接 copy，
 *    并说明原因（用户需要知道"我配了 rename 为什么走了 copy"）；
 * 3. 配置是 `rename`，真去 rename 却失败了 → 由 `isSwapUnsupportedError`
 *    判断是否值得回退。**其他错误（权限、路径不存在）不回退** ——
 *    那些错误 copy 也会失败，硬回退只会把真实原因（比如没写权限）掩盖掉。
 */
export function decideSwapStrategy(input: {
  configured: 'rename' | 'copy'
  preflight?: { isMountPoint: boolean; crossDevice: boolean; reason?: string } | null
  renameError?: unknown
}): SwapDecision {
  if (input.configured === 'copy') return { strategy: 'copy' }
  const pf = input.preflight
  if (pf && (pf.isMountPoint || pf.crossDevice)) {
    return { strategy: 'copy', fallbackReason: pf.reason ?? '目标不支持原子 rename' }
  }
  if (input.renameError !== undefined && isSwapUnsupportedError(input.renameError)) {
    const e = input.renameError as { message?: string }
    return { strategy: 'copy', fallbackReason: e?.message ?? 'rename 不被支持' }
  }
  return { strategy: 'rename' }
}

/* ------------------------------------------------------------ 残留识别 */

export interface ResidueEntry {
  name: string
  path: string
  kind: 'staging' | 'partial'
}

/**
 * 识别父目录里属于**上一次中断的发布**留下的东西（方案书 §6.8 并发控制第 3 条）。
 *
 * 两类：
 * - `staging`：`.sfvm-staging-*` —— 上传中途断开（MT-02 的主要残留形态）；
 * - `partial`：`*.part` —— 半成品文件（B07 下载用的 `.part` 约定）。
 *
 * ## 刻意**不**识别 `<目标>.old-*`
 *
 * 方案书 §6.8 的 `copy` 策略写了一步 `rename(remotePath, remotePath + '.old-' + releaseId)`，
 * 但这一步在它要解决的问题上**不成立**：会用 copy 策略的场合就是"目标与暂存不同设备"
 * （目标本身是挂载点），而 `<父目录>/<目标>.old-x` 与暂存同在父目录的设备上 ——
 * 这个 rename 同样会 `EXDEV`。而且真把它做出来，旧版本会同时存在于归档目录与 `.old-*`
 * 两处，占两份空间，而 §6.8 阶段 0 的磁盘余量正是按"暂存 1× + 归档 1×"算的 2.2×，
 * 多出来的那一份会把余量算爆。
 *
 * 所以本工具的 copy 流程里**旧版本一律进归档目录**（用复制而不是 rename），
 * 换版失败时再从归档复制回原位。详见 `services/deploy.ts` 的阶段 4/5。
 *
 * ## 只识别、不删除
 *
 * 删除是不可逆的，而且这里可能混着别的工具/别人留下的东西。本函数只负责
 * 把"有什么"讲清楚，删什么由调用方（用户在确认弹窗里）决定。
 */
export function classifyResidue(input: {
  parentDir: string
  targetBase: string
  entries: readonly { name: string; isDirectory: boolean }[]
}): ResidueEntry[] {
  void input.targetBase
  const out: ResidueEntry[] = []
  for (const e of input.entries) {
    const name = e.name
    if (name.startsWith(STAGING_PREFIX)) {
      out.push({ name, path: joinRemote(input.parentDir, name), kind: 'staging' })
    } else if (name.endsWith('.part')) {
      out.push({ name, path: joinRemote(input.parentDir, name), kind: 'partial' })
    }
  }
  return out
}

/** 残留条目的中文说明，UI 与日志共用。 */
export function describeResidue(kind: ResidueEntry['kind']): string {
  switch (kind) {
    case 'staging':
      return '上次发布中断留下的暂存目录'
    case 'partial':
      return '未完成的传输文件（.part）'
  }
}

/**
 * 该残留条目是否**可以安全地由本工具自动清理**。
 *
 * 只有 `.sfvm-staging-*` 这种"我们自己按固定格式建、名字能证明是我们建的"
 * 条目才敢自动删。`*.part` 一律**不**自动删 —— 本工具的上传不产生远端 `.part`
 * （上传中断的形态是暂存目录），所以远端出现 `.part` 更可能是别的进程或别人留下的东西，
 * 替别人做决定地删掉它是不负责任的。
 */
export function isAutoCleanable(entry: ResidueEntry): boolean {
  return entry.kind === 'staging'
}

/** 暂存目录名是否属于本次发布（清理时用它确认"删的是自己建的"）。 */
export function isStagingOf(name: string, releaseId: string): boolean {
  return name === `${STAGING_PREFIX}${releaseId}`
}
