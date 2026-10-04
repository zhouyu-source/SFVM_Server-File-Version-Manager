/**
 * 远端文件系统操作（T05.6）。
 *
 * 方案书 §6.5 明确：**用 SFTP 实现，不依赖 shell**。
 * 原因：不假设远端有 coreutils、不引入命令注入面、不受 shell 方言差异影响。
 *
 * 设计：只依赖一个 `SftpLike` 接口（ssh2 的 SFTPWrapper 满足它），
 * 而不是直接依赖连接池 —— 这样单测可以塞假实现，不必真连服务器。
 *
 * 安全要点：
 * - `rmrf` 有**深度上限**与**根路径拒绝**，避免误传 `/` 造成灾难
 * - `walk` 同样有深度与条目数上限，防御异常目录结构把内存吃满
 */
import type { SFTPWrapper, Stats } from 'ssh2'
import { AppError, ErrorCode } from '../infra/errors'
import { normalizeRemotePath } from '../infra/remote-path'
import { STAGING_PREFIX } from '../../shared/contracts/deploy'

/** 只用到 SFTPWrapper 的这几个方法，便于测试替身。 */
export interface SftpLike {
  stat(path: string, cb: (err: Error | undefined | null, stats: Stats) => void): void
  readdir(
    path: string,
    cb: (err: Error | undefined | null, list: Array<{ filename: string; attrs: Stats }>) => void
  ): void
  mkdir(path: string, cb: (err?: Error | null) => void): void
  rename(from: string, to: string, cb: (err?: Error | null) => void): void
  unlink(path: string, cb: (err?: Error | null) => void): void
  rmdir(path: string, cb: (err?: Error | null) => void): void
  realpath(path: string, cb: (err: Error | undefined | null, absPath: string) => void): void
}

export interface RemoteEntry {
  /** 相对 walk 起点的路径（以 / 分隔），不含起点本身 */
  relPath: string
  size: number
  /** ISO-8601；SFTP 的 mtime 是秒级 */
  mtime: string
  mode: number
}

export interface RemoteStat {
  exists: boolean
  isDirectory: boolean
  size: number
  mtime?: string
  mode?: number
  uid?: number
  gid?: number
}

/** rmrf / walk 的安全上限。 */
export const MAX_DEPTH = 64
export const MAX_ENTRIES = 200000

/**
 * 明确拒绝删除的高危路径。
 *
 * 注意：这些路径**实际上也会**被下方的"层级过浅"规则拦下（它们都只有一段）。
 * 保留这份名单是为了**可读性**：让"哪些目录绝对不能删"成为显式声明，
 * 而不是藏在"层级 < 2"这种间接规则里。检查顺序上先查名单，命中时给出更直白的报错。
 */
const FORBIDDEN_RM_PATHS = new Set([
  '/',
  '/root',
  '/home',
  '/etc',
  '/usr',
  '/var',
  '/bin',
  '/sbin',
  '/lib',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/opt',
  '/tmp',
  '/data'
])

/**
 * 允许整树删除的**最小层级**。
 *
 * 取 3 段：`/tmp/x`（2 段）仍嫌浅、容易被误用于整个临时目录；
 * `/tmp/sfvm-xxx`（3 段）才是本工具实际会创建的形态。
 * 这样 `/etc`、`/var`、`/tmp`、`/opt` 这类都不可能在"整树删除"里被误伤。
 *
 * ## 例外：本工具自己建的浅层条目
 *
 * 层级守卫有一个**刻意的例外**（`isOwnArtifactPath`）：名字以 `.sfvm-staging-`
 * 开头的条目一定是我们自己按固定格式创建的（发布暂存目录，`classifyResidue`
 * 也靠这个名字识别它），所以"父目录很浅"不构成保留它的理由 ——
 * 留着它反而会在**下一次发布**时被前置校验识别成"远端残留"，
 * 而那时清理会撞上同一个守卫，形成"残留永远删不掉"的死锁
 * （2026-10-01 真机实测：目标路径在 `/tmp` 这类浅父目录下时，
 * 发布成功后的暂存目录会永远留在父目录里，cleanResidue 报"远端路径不合法"）。
 * 守卫真正要保护的是"误删别人的东西"：非本工具前缀的浅路径照旧拒绝。
 */
const MIN_RM_DEPTH = 3

/** 本工具按固定格式创建的远端条目名前缀（配合上面的层级例外）。 */
const OWN_ARTIFACT_PREFIXES = [STAGING_PREFIX] as const

/** 路径的最后一段是否是本工具自己创建的条目（只看名字，名字即来源证明）。 */
function isOwnArtifactPath(p: string): boolean {
  const base = p.split('/').filter(Boolean).pop() ?? ''
  return OWN_ARTIFACT_PREFIXES.some((pre) => base.startsWith(pre))
}

function pathDepth(p: string): number {
  return p.split('/').filter(Boolean).length
}

function promisify<T>(
  fn: (cb: (err?: Error | null, result?: T) => void) => void
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    fn((err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
}

function toIso(mtime: number | undefined): string | undefined {
  if (typeof mtime !== 'number' || mtime <= 0) return undefined
  return new Date(mtime * 1000).toISOString()
}

/** 判断 SFTP 错误是否是"不存在"。 */
function isNoSuchFile(err: unknown): boolean {
  const e = err as { code?: number; message?: string }
  // ssh2: code 2 = SSH_FX_NO_SUCH_FILE
  return e?.code === 2 || /no such file/i.test(e?.message ?? '')
}

export function createRemoteFs(sftp: SftpLike) {
  /** stat：不存在时返回 exists:false，而不是抛错（调用方常用来探测）。 */
  async function stat(path: string): Promise<RemoteStat> {
    const p = normalizeRemotePath(path)
    try {
      const s = await new Promise<Stats>((resolve, reject) => {
        sftp.stat(p, (err, stats) => (err ? reject(err) : resolve(stats)))
      })
      return {
        exists: true,
        isDirectory: s.isDirectory(),
        size: s.size ?? 0,
        mtime: toIso(s.mtime),
        mode: s.mode,
        uid: s.uid,
        gid: s.gid
      }
    } catch (err) {
      if (isNoSuchFile(err)) return { exists: false, isDirectory: false, size: 0 }
      throw new AppError(ErrorCode.E_CONN_LOST, { path: p, original: (err as Error).message })
    }
  }

  async function exists(path: string): Promise<boolean> {
    return (await stat(path)).exists
  }

  async function readdir(
    path: string
  ): Promise<Array<{ name: string; isDirectory: boolean; size: number; mtime?: string }>> {
    const p = normalizeRemotePath(path)
    const list = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolve, reject) => {
      sftp.readdir(p, (err, entries) => (err ? reject(err) : resolve(entries)))
    })
    return list.map((e) => ({
      name: e.filename,
      isDirectory: e.attrs.isDirectory(),
      size: e.attrs.size ?? 0,
      mtime: toIso(e.attrs.mtime)
    }))
  }

  /**
   * mkdirp：逐级创建，忽略"已存在"。
   * 不用 `mkdir -p`，因为那需要 shell（方案书 §6.5 要求走 SFTP）。
   */
  async function mkdirp(path: string): Promise<void> {
    const p = normalizeRemotePath(path)
    if (p === '/') return

    const segments = p.split('/').filter(Boolean)
    let current = ''
    for (const seg of segments) {
      current += `/${seg}`
      try {
        await promisify<void>((cb) => sftp.mkdir(current, cb))
      } catch (err) {
        // 已存在属正常情况；但要区分"已存在"与"权限不足"
        const st = await stat(current)
        if (!st.exists) {
          throw new AppError(ErrorCode.E_PARENT_NOT_WRITABLE, {
            path: current,
            original: (err as Error).message
          })
        }
      }
    }
  }

  async function rename(from: string, to: string): Promise<void> {
    const a = normalizeRemotePath(from)
    const b = normalizeRemotePath(to)
    try {
      await promisify<void>((cb) => sftp.rename(a, b, cb))
    } catch (err) {
      const msg = (err as Error).message ?? ''
      // 跨文件系统 / 目标是挂载点时给出专属错误码，便于上层回退 copy 策略
      if (/EXDEV|cross-device/i.test(msg)) {
        throw new AppError(ErrorCode.E_CROSS_DEVICE, { from: a, to: b, original: msg })
      }
      if (/EBUSY|device or resource busy/i.test(msg)) {
        throw new AppError(ErrorCode.E_TARGET_BUSY_MOUNT, { from: a, to: b, original: msg })
      }
      throw new AppError(ErrorCode.E_DEPLOY_STAGE_FAILED, { from: a, to: b, original: msg })
    }
  }

  async function unlinkFile(path: string): Promise<void> {
    const p = normalizeRemotePath(path)
    await promisify<void>((cb) => sftp.unlink(p, cb))
  }

  async function rmdirEmpty(path: string): Promise<void> {
    const p = normalizeRemotePath(path)
    await promisify<void>((cb) => sftp.rmdir(p, cb))
  }

  /**
   * rmrf：递归删除。
   *
   * 三层防护（这是最容易造成不可逆破坏的操作）：
   * 1. 显式高危名单 —— 报错直白，也避免"整目录删除"被用在系统目录上
   * 2. 层级过浅（< 3 段）一律拒绝 —— 兜住名单没列到的短路径
   *    （如 `/var2`、`/srv`、`/tmp` 本身）
   * 3. 递归深度上限，防御异常目录结构
   *
   * 顺序刻意如此：先名单后层级，让名单命中时能给出更直白的错误文案。
   */
  async function rmrf(path: string): Promise<void> {
    const p = normalizeRemotePath(path)

    if (FORBIDDEN_RM_PATHS.has(p)) {
      // 具体原因放在 overrides.message：放进 detail 会被 cleanResidue 这类
      // "只读 e.message" 的调用方丢掉，用户只能看到一句毫无线索的"远端路径不合法"
      throw new AppError(
        ErrorCode.E_PATH_UNSAFE,
        { path: p, reason: 'refuse-rm-high-risk-path' },
        { message: `拒绝删除高危路径：${p}（该目录不允许通过本工具整树删除）` }
      )
    }
    if (pathDepth(p) < MIN_RM_DEPTH && !isOwnArtifactPath(p)) {
      throw new AppError(
        ErrorCode.E_PATH_UNSAFE,
        { path: p, reason: 'refuse-rm-shallow-path' },
        { message: `拒绝删除层级过浅的路径：${p}（至少需要 ${MIN_RM_DEPTH} 层，例如 /tmp/sfvm-xxx）` }
      )
    }

    await removeRecursive(p, 0)
  }

  async function removeRecursive(path: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      throw new AppError(ErrorCode.E_UNKNOWN, { path, reason: 'max-depth-exceeded' })
    }
    const st = await stat(path)
    if (!st.exists) return

    if (!st.isDirectory) {
      await unlinkFile(path)
      return
    }

    const entries = await readdir(path)
    for (const e of entries) {
      const child = `${path}/${e.name}`
      if (e.isDirectory) {
        await removeRecursive(child, depth + 1)
      } else {
        await unlinkFile(child)
      }
    }
    await rmdirEmpty(path)
  }

  /**
   * walk：递归遍历，产出**相对路径**。
   * 用生成器而不是一次性数组 —— 大目录（上万文件）不该全进内存。
   */
  async function* walk(root: string, depth = 0): AsyncGenerator<RemoteEntry> {
    if (depth > MAX_DEPTH) {
      throw new AppError(ErrorCode.E_ARTIFACT_TOO_MANY_FILES, { reason: 'max-depth-exceeded' })
    }
    const base = normalizeRemotePath(root)
    const st = await stat(base)
    if (!st.exists) return

    yield* walkDir(base, '', 0)

    async function* walkDir(dir: string, prefix: string, d: number): AsyncGenerator<RemoteEntry> {
      if (d > MAX_DEPTH)
        throw new AppError(ErrorCode.E_ARTIFACT_TOO_MANY_FILES, { reason: 'max-depth' })
      const entries = await readdir(dir)
      for (const e of entries) {
        const relPath = prefix ? `${prefix}/${e.name}` : e.name
        if (e.isDirectory) {
          yield* walkDir(`${dir}/${e.name}`, relPath, d + 1)
        } else {
          yield {
            relPath,
            size: e.size,
            mtime: e.mtime ?? new Date(0).toISOString(),
            mode: 0
          }
        }
      }
    }
  }

  /** 收集 walk 结果为数组，并施加条目数上限（供需要全量的场景使用，如哈希清单）。 */
  async function listAllFiles(root: string): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = []
    for await (const e of walk(root)) {
      out.push(e)
      if (out.length > MAX_ENTRIES) {
        throw new AppError(ErrorCode.E_ARTIFACT_TOO_MANY_FILES, {
          count: out.length,
          limit: MAX_ENTRIES
        })
      }
    }
    return out
  }

  /** 解析绝对路径（用于把 `~` 之类展开，或规范化相对路径）。 */
  async function realpath(path: string): Promise<string> {
    // 非 try/catch 里不需要 `return await`（不会改变错误传播）
    return new Promise<string>((resolve, reject) => {
      sftp.realpath(path, (err, abs) => (err ? reject(err) : resolve(abs)))
    })
  }

  return {
    stat,
    exists,
    readdir,
    mkdirp,
    rename,
    rmrf,
    walk,
    listAllFiles,
    realpath,
    unlinkFile
  }
}

export type RemoteFs = ReturnType<typeof createRemoteFs>

/** 便捷：判断 SFTPWrapper 是否满足我们的接口（编译期保证，运行时无需检查）。 */
export type CompatibleSftp = SFTPWrapper & SftpLike
