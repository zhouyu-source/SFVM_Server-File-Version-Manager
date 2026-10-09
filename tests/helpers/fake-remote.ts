/**
 * 内存远端 + 测试夹具（B10 建立，B13 复用）。
 *
 * ## 为什么要有这么一份"假的服务器"
 *
 * 发布与回滚最关键的性质全都藏在**过程**里：阶段 5 失败时旧版本有没有被搬回来、
 * 暂存目录清没清干净、锁放没放开、取消之后目标路径还剩什么。
 * 用 `vi.fn()` 断言"调用了 archiveVersion"只能证明代码走到了那一步，
 * 证明不了补偿真的做对了。所以这里把一条完整的远端（文件树 + exec + 四个端口）
 * 放在内存里，让整条链路**真跑一遍**，断言最后"服务器上剩了什么"。
 *
 * B13 起它被抽成公共 helper：回滚与发布必须用**同一套**替身跑，
 * 否则"发布能做的、回滚做不到"这类不对称 bug 会漏掉。
 *
 * 依赖的模块也是真的：`createArchiveService` / `createDeployService` /
 * `createRollbackService` 都不打桩，于是这些测试同时覆盖三者的接线。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile as readFileAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { normalizeRemotePath } from '@main/infra/remote-path'
import { AppError, ErrorCode } from '@main/infra/errors'
import type { ArchiveFsPort, ArchivePorts } from '@main/services/archive'
import type {
  DeployContext,
  DeployFsPort,
  DeployPorts,
  DeployProgressInput
} from '@main/services/deploy'
import type { RemoteHashPort } from '@main/services/hash'
import type { TransferPort } from '@main/services/transfer'
import type { RemoteStat } from '@main/services/remote-fs'
import type { RollbackPorts } from '@main/services/rollback'
import type { JobLogLevel } from '@shared/contracts/job'

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/* ------------------------------------------------------- 内存远端文件系统 */

export const MUTIME = '2025-06-12T06:29:58.000Z'
export const DIR_MODE = 0o40755
export const FILE_MODE = 0o100644

export interface FakeEntry {
  data: Buffer
  mtime: string
  mode: number
  uid: number
  gid: number
}

/** 单次生效的注入（用于"只让第一次 rename 失败"这种场景）。 */
export interface OneShot {
  err: Error
  remaining: number
}

export class FakeRemote {
  private files = new Map<string, FakeEntry>()
  private dirs = new Map<string, { mode: number; uid: number; gid: number }>()

  /* ---- 注入点 ---- */
  /** rename 到这些**精确路径**时失败（`remaining` 次后自动失效） */
  renameFailures = new Map<string, OneShot>()
  /** rename 到这些**前缀**下的路径时失败 */
  renamePrefixFailures = new Map<string, OneShot>()
  /** rmrf 这些精确路径时失败 */
  rmrfFailures = new Set<string>()
  /**
   * 删这些精确文件时失败（模拟权限不足 / 文件被占用）。
   *
   * 用于钉住"释放远端锁失败"这条路径（M2）：`releaseRemoteLock` 不抛错，
   * 如果没有这个注入点，"放锁失败"只会走成一次静默的 warn —— 补偿清单会谎报成功。
   */
  removeFileFailures = new Set<string>()
  /** 上传到这些精确路径时失败（模拟链路中断 / 磁盘满） */
  putFailures = new Set<string>()
  /** 建这些精确路径时失败 */
  mkdirpFailures = new Set<string>()
  /**
   * 复制到这些精确路径时失败（B13）。
   *
   * 发布与回滚都可能走复制路径（目标挂了挂载点、或用户选择"保留来源版本"），
   * 而"复制失败时目标路径上会留下半个版本"正是补偿逻辑要处理的场景 ——
   * 没有这个注入点，那条分支就只能靠读代码相信它写对了。
   *
   * 与 `renameFailures` 一样支持"只失败 N 次"：很多用例要的是
   * "换版那一步的复制失败、补偿那一步的复制成功"，永久失败就表达不了。
   */
  copyFileFailures = new Map<string, OneShot>()
  /** `test -w` 的结论 */
  parentWritable = true
  /** `df` 报的可用字节；`dfOverride` 可以对某个路径单独覆盖 */
  dfAvailableBytes = 40 * 1024 * 1024 * 1024
  fsName = '/dev/vda1'
  dfOverride = new Map<string, { filesystem: string; mountPoint: string; availableBytes?: number }>()
  chmodExitCode = 0
  chownExitCode = 0

  /* ---- 观测点 ---- */
  execLog: string[] = []
  renameLog: Array<{ from: string; to: string }> = []
  /** 远端读流次数：用来判断"归档有没有真的重算一遍远端哈希" */
  hashReadCount = 0
  /** 被读过的远端路径（按路径判断比按次数判断更准：阶段 3 也会读暂存） */
  hashReadPaths: string[] = []
  /** 上传闸门：用来在"上传到一半"的时刻做别的事（取消用例） */
  uploadGate: { onEnter: () => void; wait: Promise<void> } | null = null
  /** 每个文件上传落盘后的钩子（用来模拟"传到服务器上坏了"） */
  afterPut: ((remotePath: string) => void) | null = null

  /* ------------------------------- 内容操作 */

  putFile(path: string, content: string | Buffer): void {
    const p = normalizeRemotePath(path)
    const idx = p.lastIndexOf('/')
    if (idx > 0) this.putDir(p.slice(0, idx))
    this.files.set(p, {
      data: Buffer.isBuffer(content) ? content : Buffer.from(content),
      mtime: MUTIME,
      mode: FILE_MODE,
      uid: 0,
      gid: 0
    })
  }

  putDir(path: string): void {
    const segs = normalizeRemotePath(path).split('/').filter(Boolean)
    let cur = ''
    for (const s of segs) {
      cur += `/${s}`
      if (!this.dirs.has(cur)) this.dirs.set(cur, { mode: DIR_MODE, uid: 0, gid: 0 })
    }
  }

  has(path: string): boolean {
    const p = normalizeRemotePath(path)
    return this.files.has(p) || this.dirs.has(p)
  }

  /**
   * 覆盖某个目录的 mode（默认 `DIR_MODE`）。
   *
   * 用来构造"原权限位不足 3 位"这种真实但少见的现场（如 `0o40040` → 权限位 `0o40`）：
   * 发布阶段 5 会把它捕获成 `originalMode`，再拿去恢复权限（L10/A1）。
   */
  setDirMode(path: string, mode: number): void {
    const p = normalizeRemotePath(path)
    this.putDir(p)
    const cur = this.dirs.get(p) ?? { mode, uid: 0, gid: 0 }
    this.dirs.set(p, { ...cur, mode })
  }

  read(path: string): Buffer {
    const e = this.files.get(normalizeRemotePath(path))
    if (!e) throw new Error(`no such file: ${path}`)
    return e.data
  }

  text(path: string): string {
    return this.read(path).toString('utf8')
  }

  /** 目录下的全部条目（目录以 `/` 结尾），用于断言"有没有半截东西留下" */
  ls(dir: string): string[] {
    const base = normalizeRemotePath(dir)
    const prefix = `${base}/`
    const out = new Set<string>()
    for (const f of this.files.keys()) if (f.startsWith(prefix)) out.add(f.slice(prefix.length))
    for (const d of this.dirs.keys()) {
      if (d !== base && d.startsWith(prefix)) out.add(`${d.slice(prefix.length)}/`)
    }
    return [...out].sort()
  }

  stat(path: string): RemoteStat {
    const p = normalizeRemotePath(path)
    const f = this.files.get(p)
    if (f) {
      return {
        exists: true,
        isDirectory: false,
        size: f.data.length,
        mtime: f.mtime,
        mode: f.mode,
        uid: f.uid,
        gid: f.gid
      }
    }
    const d = this.dirs.get(p)
    if (d) {
      return { exists: true, isDirectory: true, size: 0, mode: d.mode, uid: d.uid, gid: d.gid }
    }
    return { exists: false, isDirectory: false, size: 0 }
  }

  /** 挑出"该不该失败"：一次性的注入命中后自动递减。 */
  private take(map: Map<string, OneShot>, key: string): Error | null {
    const hit = map.get(key)
    if (!hit || hit.remaining <= 0) return null
    hit.remaining -= 1
    return hit.err
  }

  private takePrefix(map: Map<string, OneShot>, key: string): Error | null {
    for (const [prefix, hit] of map) {
      if (hit.remaining <= 0 || !key.startsWith(prefix)) continue
      hit.remaining -= 1
      return hit.err
    }
    return null
  }

  rename(from: string, to: string): void {
    const a = normalizeRemotePath(from)
    const b = normalizeRemotePath(to)
    const injected = this.take(this.renameFailures, b) ?? this.takePrefix(this.renamePrefixFailures, b)
    if (injected) throw injected
    this.renameLog.push({ from: a, to: b })

    const f = this.files.get(a)
    if (f) {
      this.files.delete(a)
      this.files.set(b, f)
      return
    }
    if (!this.dirs.has(a)) throw new Error(`rename 源不存在：${a}`)
    if (this.has(b)) throw new Error(`rename 目标已存在：${b}`)

    const prefix = `${a}/`
    for (const d of [...this.dirs.keys()]) {
      if (d !== a && d.startsWith(prefix)) {
        const v = this.dirs.get(d)!
        this.dirs.delete(d)
        this.dirs.set(`${b}${d.slice(a.length)}`, v)
      }
    }
    const self = this.dirs.get(a)!
    this.dirs.delete(a)
    this.dirs.set(b, self)
    for (const [k, v] of [...this.files]) {
      if (k.startsWith(prefix)) {
        this.files.delete(k)
        this.files.set(`${b}${k.slice(a.length)}`, v)
      }
    }
  }

  removeFile(path: string): void {
    const p = normalizeRemotePath(path)
    if (this.removeFileFailures.has(p)) throw new Error(`模拟删除文件失败：${p}`)
    this.files.delete(p)
  }

  rmrf(path: string): void {
    const p = normalizeRemotePath(path)
    if (this.rmrfFailures.has(p)) throw new Error(`模拟删除失败：${p}`)
    this.files.delete(p)
    const prefix = `${p}/`
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k)
    for (const d of [...this.dirs.keys()]) if (d === p || d.startsWith(prefix)) this.dirs.delete(d)
  }

  mkdirp(path: string): void {
    const p = normalizeRemotePath(path)
    if (this.mkdirpFailures.has(p)) throw new Error(`模拟建目录失败：${p}`)
    this.putDir(p)
  }

  copyFile(src: string, dst: string): void {
    const s = normalizeRemotePath(src)
    const d = normalizeRemotePath(dst)
    const injected = this.take(this.copyFileFailures, d)
    if (injected) throw injected
    const f = this.files.get(s)
    if (!f) throw new Error(`copyFile 源不是文件：${s}`)
    this.putFile(dst, f.data)
  }

  /** 递归列出（relPath 相对 root） */
  list(
    root: string,
    prefix = '',
    out: Array<{ relPath: string; size: number; mtime?: string }> = []
  ): Array<{ relPath: string; size: number; mtime?: string }> {
    const dir = normalizeRemotePath(prefix ? `${root}/${prefix}` : root)
    const base = `${dir}/`
    for (const [k, v] of this.files) {
      if (!k.startsWith(base)) continue
      const rel = k.slice(base.length)
      if (rel.includes('/')) continue // 由下一层递归产出
      out.push({ relPath: prefix ? `${prefix}/${rel}` : rel, size: v.data.length, mtime: v.mtime })
    }
    for (const d of this.dirs.keys()) {
      if (!d.startsWith(base)) continue
      const rel = d.slice(base.length)
      if (rel.includes('/')) continue
      this.list(root, prefix ? `${prefix}/${rel}` : rel, out)
    }
    return out
  }

  /** 列出目录的**直接**子项（残留探测用） */
  readdir(path: string): Array<{ name: string; isDirectory: boolean; size: number }> {
    const dir = normalizeRemotePath(path)
    const base = `${dir}/`
    const out = new Map<string, { name: string; isDirectory: boolean; size: number }>()
    for (const [k, v] of this.files) {
      if (!k.startsWith(base)) continue
      const rel = k.slice(base.length)
      if (rel.includes('/')) continue
      out.set(rel, { name: rel, isDirectory: false, size: v.data.length })
    }
    for (const d of this.dirs.keys()) {
      if (d === dir || !d.startsWith(base)) continue
      const rel = d.slice(base.length)
      if (rel.includes('/')) continue
      out.set(rel, { name: rel, isDirectory: true, size: 0 })
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async fastPut(
    localPath: string,
    remotePath: string,
    onStep?: (written: number) => void
  ): Promise<void> {
    if (this.uploadGate) {
      this.uploadGate.onEnter()
      await this.uploadGate.wait
    }
    if (this.putFailures.has(normalizeRemotePath(remotePath))) {
      throw new Error('模拟上传中断')
    }
    const data = await readFileAsync(localPath)
    this.putFile(remotePath, data)
    this.afterPut?.(normalizeRemotePath(remotePath))
    onStep?.(data.length)
  }

  async exec(cmd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    this.execLog.push(cmd)
    if (cmd.startsWith('test -w ')) {
      return { stdout: '', stderr: '', code: this.parentWritable ? 0 : 1 }
    }
    if (cmd.startsWith('df -Pk ')) {
      const p = normalizeRemotePath(cmd.slice('df -Pk '.length).replace(/^'|'$/g, ''))
      const ov = this.dfOverride.get(p)
      const filesystem = ov?.filesystem ?? this.fsName
      const mountPoint = ov?.mountPoint ?? '/'
      const availK = Math.floor((ov?.availableBytes ?? this.dfAvailableBytes) / 1024)
      const usedK = 1024
      return {
        stdout:
          'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
          `${filesystem} ${usedK + availK} ${usedK} ${availK} 10% ${mountPoint}\n`,
        stderr: '',
        code: 0
      }
    }
    if (cmd.startsWith('chmod ')) {
      return { stdout: '', stderr: this.chmodExitCode === 0 ? '' : 'chmod: 权限不足', code: this.chmodExitCode }
    }
    if (cmd.startsWith('chown ')) {
      return { stdout: '', stderr: this.chownExitCode === 0 ? '' : 'chown: 权限不足', code: this.chownExitCode }
    }
    throw new Error(`未预期的远端命令：${cmd}`)
  }

  /* ------------------------------- 四个端口 */

  private fsMethods(): ArchiveFsPort {
    return {
      stat: async (p: string) => this.stat(p),
      mkdirp: async (p: string) => this.mkdirp(p),
      rename: async (from: string, to: string) => this.rename(from, to),
      removeFile: async (p: string) => this.removeFile(p),
      rmrf: async (p: string) => this.rmrf(p),
      readTextFile: async (p: string) => {
        const e = this.files.get(normalizeRemotePath(p))
        if (!e) throw new AppError(ErrorCode.E_ARCHIVE_MISSING, { path: p })
        return e.data.toString('utf8')
      },
      writeTextChunks: async (p: string, chunks: Iterable<string>) => {
        // 逐块累加而不是 join：`ArchiveFsPort` 的入参是 `Iterable<string>`，
        // 实际传进来的是生成器（归档的 manifest 是流式产出的），没有 join 方法。
        let text = ''
        for (const c of chunks) text += c
        this.putFile(p, text)
      },
      listFiles: async (root: string) =>
        this.list(root).map((f) => ({ relPath: f.relPath, size: f.size, mtime: f.mtime ?? MUTIME })),
      copyFile: async (src: string, dst: string) => this.copyFile(src, dst)
    }
  }

  asArchiveFsPort(): ArchiveFsPort {
    return this.fsMethods()
  }

  asDeployFsPort(): DeployFsPort {
    return {
      ...this.fsMethods(),
      readdir: async (p: string) => this.readdir(p),
      writeNewFile: async (p: string, content: string) => {
        const key = normalizeRemotePath(p)
        // 'wx'（O_CREAT|O_EXCL）语义：已存在必须失败
        if (this.files.has(key) || this.dirs.has(key)) throw new Error('EEXIST: 锁文件已存在')
        this.putFile(p, content)
      }
    }
  }

  asHashPort(): RemoteHashPort {
    return {
      // 两个工具都报 false → verifyRemote 走 SFTP 流式分支（不碰远端命令）
      capability: { hasSha256sum: false, hasShasum: false, platform: 'linux', homeDir: '/root' },
      tmpDir: '/root/.sfvm-tmp',
      statSize: async (p) => (this.stat(p).exists ? this.stat(p).size : null),
      writeTextFile: async (p) => this.putFile(p, ''),
      removeFile: async (p) => this.removeFile(p),
      runCommand: async () => {
        throw new Error('本用例不应走到远端命令分支')
      },
      readStream: (p) => {
        this.hashReadCount += 1
        this.hashReadPaths.push(normalizeRemotePath(p))
        return Readable.from([this.read(p)])
      },
      listFiles: async (root) =>
        this.list(root).map((f) => ({ relPath: f.relPath, size: f.size, mtime: f.mtime }))
    }
  }

  asTransferPort(): TransferPort {
    return {
      statSize: async (p) => (this.stat(p).exists ? this.stat(p).size : null),
      ensureDir: async (p) => this.mkdirp(p),
      fastPut: async (l, r, onStep) => this.fastPut(l, r, onStep),
      fastGet: async (r, l, onStep) => {
        const d = this.read(r)
        await writeFileAsync(l, d)
        onStep?.(d.length)
      },
      createReadStream: (p) => Readable.from([this.read(p)]),
      createWriteStream: (p) => {
        const chunks: Buffer[] = []
        const ws = new Writable({
          write(chunk: Buffer, _enc, cb) {
            chunks.push(Buffer.from(chunk))
            cb()
          },
          final: (cb) => {
            this.putFile(p, Buffer.concat(chunks))
            cb()
          }
        })
        return ws as unknown as NodeJS.WritableStream
      },
      rename: async (a, b) => this.rename(a, b),
      removeFile: async (p) => this.removeFile(p)
    }
  }

  ports(): DeployPorts {
    return {
      fs: this.asDeployFsPort(),
      archiveFs: this.asArchiveFsPort(),
      hash: this.asHashPort(),
      transfer: this.asTransferPort(),
      exec: (cmd) => this.exec(cmd),
      capability: { hasSha256sum: false, hasShasum: false, platform: 'linux', homeDir: '/root' },
      hostname: 'builder.local'
    }
  }

  archivePorts(): ArchivePorts {
    return { fs: this.asArchiveFsPort(), hash: this.asHashPort() }
  }

  /**
   * 回滚的端口（B13）。
   *
   * 与 `ports()` 的差别只有"没有 transfer" —— 回滚不往服务器上传任何东西。
   * 单独留一个方法而不是让调用方自己拼，是为了让"回滚到底需要哪些能力"
   * 在替身这边也一目了然：哪天它偷偷用上了 transfer，这里会立刻缺方法。
   */
  rollbackPorts(): RollbackPorts {
    return {
      fs: this.asDeployFsPort(),
      hash: this.asHashPort(),
      exec: (cmd) => this.exec(cmd),
      capability: { hasSha256sum: false, hasShasum: false, platform: 'linux', homeDir: '/root' },
      hostname: 'builder.local'
    }
  }
}

/* ------------------------------------------------------------------ 夹具 */

export const CLOCK = new Date(2025, 5, 12, 14, 30, 15)

/** 造一个真实的本地产物目录（`hashLocalArtifact` 走的是真 fs）。 */
export function makeLocalDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfvm-local-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  return dir
}

export function makeLocalFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfvm-file-'))
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

export interface LogLine {
  text: string
  level?: JobLogLevel
}

export function makeCtx(): {
  ctx: DeployContext
  logs: LogLine[]
  progress: DeployProgressInput[]
  ac: AbortController
  text: () => string
} {
  const logs: LogLine[] = []
  const progress: DeployProgressInput[] = []
  const ac = new AbortController()
  return {
    logs,
    progress,
    ac,
    text: () => logs.map((l) => `${l.level ?? 'info'}\t${l.text}`).join('\n'),
    ctx: {
      signal: ac.signal,
      progress: (p) => progress.push(p),
      log: (text, level) => logs.push({ text, ...(level ? { level } : {}) })
    }
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
