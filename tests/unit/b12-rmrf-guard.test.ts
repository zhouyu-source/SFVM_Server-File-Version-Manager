/**
 * B12 回归单测：`remote-fs.rmrf` 的"层级过浅"守卫对**本工具自己建的条目**放行。
 *
 * ## 背景（2026-10-01 真机实测发现的 bug）
 *
 * 目标路径在浅父目录下（如 `/tmp/dist`）时，发布暂存目录是 `/tmp/.sfvm-staging-<id>`
 * （只有 2 层）。`rmrf` 的层级守卫（≥3 层）把它也拒了：
 * - 发布收尾的暂存清理失败（只记警告）→ **残留留在父目录**；
 * - 下一次发布前置校验认出这个"远端残留"→ 用户点清理 → `cleanResidue` 撞上同一个
 *   守卫 → 报"远端路径不合法" → **残留永远删不掉**。
 *
 * 修复：层级守卫对**名字能证明是本工具自建**的条目（`.sfvm-staging-` 前缀）放行 ——
 * 守卫要保护的是"误删别人的东西"，不是"留下自己造的垃圾"。
 *
 * 用内存 SFTP 替身而不是真机：守卫是纯路径判断，替身越小越能看清判断依据。
 */
import { describe, expect, it } from 'vitest'
import { AppError, ErrorCode } from '@main/infra/errors'
import { createRemoteFs, type SftpLike } from '@main/services/remote-fs'
import type { Stats } from 'ssh2'

/** 内存远端：只要能让 rmrf 走通"stat → readdir → unlink/rmdir"即可。 */
class FakeSftp implements SftpLike {
  dirs = new Set<string>(['/'])
  files = new Set<string>()
  /** 符号链接：path → 指向的路径（`stat` 跟随、`lstat` 不跟随） */
  links = new Map<string, string>()

  putDir(p: string): void {
    this.dirs.add(p)
  }

  putFile(p: string): void {
    this.files.add(p)
  }

  putLink(p: string, target: string): void {
    this.links.set(p, target)
  }

  exists(p: string): boolean {
    return this.dirs.has(p) || this.files.has(p) || this.links.has(p)
  }

  /** 跟随链接找到真正指向的路径（限 8 层，防御自环）。 */
  private resolve(p: string): string {
    let cur = p
    for (let i = 0; i < 8 && this.links.has(cur); i++) cur = this.links.get(cur) as string
    return cur
  }

  private statOf(p: string, follow = true): Stats {
    if (!follow && this.links.has(p)) {
      return {
        isDirectory: (): boolean => false,
        isSymbolicLink: (): boolean => true,
        size: 0
      } as unknown as Stats
    }
    const real = this.resolve(p)
    return {
      isDirectory: (): boolean => this.dirs.has(real),
      isSymbolicLink: (): boolean => false,
      size: 0
    } as unknown as Stats
  }

  stat(path: string, cb: (err: Error | null | undefined, stats: Stats) => void): void {
    if (!this.exists(path)) {
      cb(Object.assign(new Error('no such file'), { code: 2 }), this.statOf(path))
      return
    }
    cb(null, this.statOf(path))
  }

  lstat(path: string, cb: (err: Error | null | undefined, stats: Stats) => void): void {
    if (!this.exists(path)) {
      cb(Object.assign(new Error('no such file'), { code: 2 }), this.statOf(path, false))
      return
    }
    cb(null, this.statOf(path, false))
  }

  readdir(
    path: string,
    cb: (err: Error | null | undefined, list: Array<{ filename: string; attrs: Stats }>) => void
  ): void {
    if (!this.dirs.has(path)) {
      cb(new Error('not a directory'), [])
      return
    }
    const prefix = `${path}/`
    const out: Array<{ filename: string; attrs: Stats }> = []
    for (const d of this.dirs) {
      if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) {
        out.push({ filename: d.slice(prefix.length), attrs: this.statOf(d) })
      }
    }
    for (const f of this.files) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        out.push({ filename: f.slice(prefix.length), attrs: this.statOf(f) })
      }
    }
    // 真实服务端（OpenSSH sftp-server）的 readdir 返回的是 lstat 属性 ——
    // 符号链接不会被说成目录。替身照此实现，里层的链接才会走 unlink 而不是递归。
    for (const l of this.links.keys()) {
      if (l.startsWith(prefix) && !l.slice(prefix.length).includes('/')) {
        out.push({ filename: l.slice(prefix.length), attrs: this.statOf(l, false) })
      }
    }
    cb(null, out)
  }

  mkdir(path: string, cb: (err?: Error | null) => void): void {
    this.dirs.add(path)
    cb()
  }

  rename(_from: string, _to: string, cb: (err?: Error | null) => void): void {
    cb()
  }

  unlink(path: string, cb: (err?: Error | null) => void): void {
    this.files.delete(path)
    this.links.delete(path)
    cb()
  }

  rmdir(path: string, cb: (err?: Error | null) => void): void {
    this.dirs.delete(path)
    cb()
  }

  realpath(path: string, cb: (err: Error | null | undefined, absPath: string) => void): void {
    cb(null, path)
  }
}

function makeFs() {
  const fake = new FakeSftp()
  return { fake, fs: createRemoteFs(fake) }
}

/**
 * S3 回归：`rmrf` **不得顺着符号链接删东西**。
 *
 * 成因是 `stat` 用 SSH_FXP_STAT（跟随链接）：目标被配成
 * `current -> releases/20261009-xxx`（生产上极常见的"当前版本指针"写法）时，
 * 三层字符串守卫全都看不见这次空间重定向 —— `stat` 报它是个普通目录，
 * 递归就顺着链接读进 `releases/xxx` 把内容逐个删掉：链接还在，内容没了。
 */
describe('rmrf 符号链接守卫（S3）', () => {
  it('顶层是符号链接 → 拒绝，且被指向的目录内容完好', async () => {
    const { fake, fs } = makeFs()
    fake.putDir('/opt/app/releases/20261009-aaa')
    fake.putFile('/opt/app/releases/20261009-aaa/index.html')
    fake.putLink('/opt/app/current', '/opt/app/releases/20261009-aaa')

    // 先钉住"为什么必须 lstat"：stat 会把它说成一个普通目录
    expect((await fs.stat('/opt/app/current')).isDirectory).toBe(true)
    expect((await fs.lstat('/opt/app/current')).isSymbolicLink).toBe(true)

    await expect(fs.rmrf('/opt/app/current')).rejects.toMatchObject({
      code: ErrorCode.E_PATH_UNSAFE
    })
    // 被指向的内容一个都不能少
    expect(fake.exists('/opt/app/releases/20261009-aaa/index.html')).toBe(true)
    // 链接本身也不替用户删（"要不要删这个指针"只有人判断得了）
    expect(fake.exists('/opt/app/current')).toBe(true)
  })

  it('报错文案说清楚是符号链接（用户得知道下一步该看什么）', async () => {
    const { fake, fs } = makeFs()
    fake.putDir('/opt/app/releases/20261009-aaa')
    fake.putLink('/opt/app/current', '/opt/app/releases/20261009-aaa')
    try {
      await fs.rmrf('/opt/app/current')
      expect.unreachable('应当拒绝')
    } catch (e) {
      const msg = (e as AppError).message
      expect(msg).toContain('符号链接')
      expect(msg).toContain('/opt/app/current')
      expect((e as AppError).hint).toBeTruthy()
    }
  })

  it('里层的符号链接只删链接本身，不递归进被指向的目录', async () => {
    const { fake, fs } = makeFs()
    fake.putDir('/opt/app/releases/20261009-bbb')
    fake.putFile('/opt/app/releases/20261009-bbb/index.html')
    fake.putDir('/tmp/sfvm-t/dir')
    fake.putLink('/tmp/sfvm-t/dir/ptr', '/opt/app/releases/20261009-bbb')

    await fs.rmrf('/tmp/sfvm-t/dir')

    expect(fake.exists('/tmp/sfvm-t/dir')).toBe(false)
    // 链接没了，但被指向的目录与内容都还在
    expect(fake.exists('/opt/app/releases/20261009-bbb/index.html')).toBe(true)
  })
})

describe('rmrf 层级守卫（浅路径）', () => {
  it('拒绝删除 2 层的**外来**路径（守卫仍然有效）', async () => {
    const { fake, fs } = makeFs()
    fake.putDir('/tmp/x')
    await expect(fs.rmrf('/tmp/x')).rejects.toMatchObject({
      code: ErrorCode.E_PATH_UNSAFE
    })
    expect(fake.exists('/tmp/x')).toBe(true)
  })

  it('拒绝删除 1 层的路径', async () => {
    const { fs } = makeFs()
    await expect(fs.rmrf('/srv2')).rejects.toMatchObject({
      code: ErrorCode.E_PATH_UNSAFE
    })
  })

  it('高危名单仍然优先（/etc 之类的绝对不许碰）', async () => {
    const { fs } = makeFs()
    await expect(fs.rmrf('/etc')).rejects.toMatchObject({
      code: ErrorCode.E_PATH_UNSAFE
    })
  })

  it('**放行 2 层的本工具自建暂存目录**（`.sfvm-staging-*`）', async () => {
    const { fake, fs } = makeFs()
    // 模拟发布后的残留：浅父目录下的暂存树，里面还留着校验清单
    fake.putDir('/tmp/.sfvm-staging-job1')
    fake.putFile('/tmp/.sfvm-staging-job1/files.sha256')
    fake.putDir('/opt/.sfvm-staging-job2')

    await fs.rmrf('/tmp/.sfvm-staging-job1')
    await fs.rmrf('/opt/.sfvm-staging-job2')

    expect(fake.exists('/tmp/.sfvm-staging-job1')).toBe(false)
    expect(fake.exists('/opt/.sfvm-staging-job2')).toBe(false)
  })

  it('放行**只认前缀**：同深度但名字不是本工具建的条目仍拒绝', async () => {
    const { fake, fs } = makeFs()
    // 根目录下的外来条目 —— 浅、且不是我们的命名格式，照旧拒绝
    fake.putDir('/dist')
    await expect(fs.rmrf('/dist')).rejects.toMatchObject({
      code: ErrorCode.E_PATH_UNSAFE
    })
    expect(fake.exists('/dist')).toBe(true)

    // 同深度、但名字确实是我们的暂存格式 —— 按设计放行（名字即来源证明）
    fake.putDir('/.sfvm-staging-root-job')
    await fs.rmrf('/.sfvm-staging-root-job')
    expect(fake.exists('/.sfvm-staging-root-job')).toBe(false)
  })

  it('失败信息带**具体原因**（不再只剩"远端路径不合法"）', async () => {
    const { fake, fs } = makeFs()
    fake.putDir('/tmp/x')
    try {
      await fs.rmrf('/tmp/x')
      expect.unreachable('应当拒绝')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      const msg = (e as AppError).message
      expect(msg).toContain('层级过浅')
      expect(msg).toContain('/tmp/x')
    }
  })
})
