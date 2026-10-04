/**
 * T09.4 ~ T09.8 单测：归档服务的完整流程、冲突、失败回滚、校验、保留策略。
 *
 * 用**内存远端**而不是 mock 断言，理由与 B07 一致：本批次最要紧的几条性质
 * （"归档后目标路径为空但内容没丢"、"写 manifest 失败要把内容搬回去"、
 * "篡改一个字节会被校验发现"）只有在真实跑完整流程时才有意义。
 *
 * 校验分支刻意让能力探测报"既没有 sha256sum 也没有 shasum"，从而走 SFTP 流式
 * 降级路径 —— 命令分支（`sha256sum -c`）的语义已由 B07 的单测与真机集成覆盖，
 * 这里要验的是接线与状态落库。
 */
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createArchiveService, type ArchiveFsPort, type ArchivePorts } from '@main/services/archive'
import { normalizeRemotePath } from '@main/infra/remote-path'
import { AppError, ErrorCode } from '@main/infra/errors'
import { computeRootHash } from '@main/infra/hash-core'
import { MANIFEST_FILE_NAME, MANIFEST_TMP_NAME, parseManifestText } from '@main/infra/manifest-io'
import { formatVersionTag } from '@main/infra/version-tag'
import type { RemoteHashPort } from '@main/services/hash'
import type { RemoteStat } from '@main/services/remote-fs'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/* ------------------------------------------------------- 内存远端文件系统 */

const MUTIME = '2025-06-12T06:29:58.000Z'

class FakeRemote {
  private files = new Map<string, { data: Buffer; mtime: string }>()
  private dirs = new Set<string>(['/'])

  /** 写流在第 N 块之后中断（模拟链路断 / 磁盘满） */
  failWriteAfterChunks: number | null = null
  /** rename 的目标命中这些路径时抛错 */
  failRenameTo = new Set<string>()
  /** 远端读流次数：用来判断"是否真的重算了一遍哈希" */
  readCount = 0

  putFile(path: string, content: string | Buffer): void {
    const p = normalizeRemotePath(path)
    // 文件隐含其父目录存在（真实的 SFTP 也是这样：父子目录必须先建好）
    const idx = p.lastIndexOf('/')
    if (idx > 0) this.putDir(p.slice(0, idx))
    this.files.set(p, {
      data: Buffer.isBuffer(content) ? content : Buffer.from(content),
      mtime: MUTIME
    })
  }

  putDir(path: string): void {
    const segs = normalizeRemotePath(path).split('/').filter(Boolean)
    let cur = ''
    for (const s of segs) {
      cur += `/${s}`
      this.dirs.add(cur)
    }
  }

  has(path: string): boolean {
    const p = normalizeRemotePath(path)
    return this.files.has(p) || this.dirs.has(p)
  }

  read(path: string): Buffer {
    const e = this.files.get(normalizeRemotePath(path))
    if (!e) throw new Error(`no such file: ${path}`)
    return e.data
  }

  /** 归档目录下的全部条目（目录以 `/` 结尾），用于断言"有没有半截文件" */
  ls(dir: string): string[] {
    const base = normalizeRemotePath(dir)
    const prefix = `${base}/`
    const out = new Set<string>()
    for (const f of this.files.keys()) if (f.startsWith(prefix)) out.add(f.slice(prefix.length))
    for (const d of this.dirs) {
      if (d !== base && d.startsWith(prefix)) out.add(`${d.slice(prefix.length)}/`)
    }
    return [...out].sort()
  }

  stat(path: string): RemoteStat {
    const p = normalizeRemotePath(path)
    const f = this.files.get(p)
    if (f) return { exists: true, isDirectory: false, size: f.data.length, mtime: f.mtime }
    if (this.dirs.has(p)) return { exists: true, isDirectory: true, size: 0 }
    return { exists: false, isDirectory: false, size: 0 }
  }

  rename(from: string, to: string): void {
    const a = normalizeRemotePath(from)
    const b = normalizeRemotePath(to)
    if (this.failRenameTo.has(b)) throw new Error(`模拟 rename 失败：${b}`)

    const f = this.files.get(a)
    if (f) {
      this.files.delete(a)
      this.files.set(b, f)
      return
    }
    if (!this.dirs.has(a)) throw new Error(`rename 源不存在：${a}`)
    if (this.has(b)) throw new Error(`rename 目标已存在：${b}`)

    const prefix = `${a}/`
    for (const d of [...this.dirs]) {
      if (d !== a && d.startsWith(prefix)) {
        this.dirs.delete(d)
        this.putDir(`${b}${d.slice(a.length)}`)
      }
    }
    this.dirs.delete(a)
    this.dirs.add(b)
    for (const [k, v] of [...this.files]) {
      if (k.startsWith(prefix)) {
        this.files.delete(k)
        this.files.set(`${b}${k.slice(a.length)}`, v)
      }
    }
  }

  removeFile(path: string): void {
    this.files.delete(normalizeRemotePath(path))
  }

  rmrf(path: string): void {
    const p = normalizeRemotePath(path)
    this.files.delete(p)
    const prefix = `${p}/`
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k)
    for (const d of [...this.dirs]) if (d === p || d.startsWith(prefix)) this.dirs.delete(d)
  }

  /** 递归列出（相对 root 的 relPath） */
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
    for (const d of this.dirs) {
      if (!d.startsWith(base)) continue
      const rel = d.slice(base.length)
      if (rel.includes('/')) continue
      this.list(root, prefix ? `${prefix}/${rel}` : rel, out)
    }
    return out
  }

  /* -------------------------------------------------- 两个端口 */

  asFsPort(): ArchiveFsPort {
    return {
      stat: async (p) => this.stat(p),
      mkdirp: async (p) => this.putDir(p),
      rename: async (from, to) => this.rename(from, to),
      removeFile: async (p) => this.removeFile(p),
      rmrf: async (p) => this.rmrf(p),
      readTextFile: async (p) => {
        const e = this.files.get(normalizeRemotePath(p))
        if (!e) throw new AppError(ErrorCode.E_ARCHIVE_MISSING, { path: p })
        return e.data.toString('utf8')
      },
      writeTextChunks: async (p, chunks) => {
        let text = ''
        let n = 0
        for (const c of chunks) {
          text += c
          n++
          if (this.failWriteAfterChunks !== null && n >= this.failWriteAfterChunks) {
            // 半截落盘：正是"不能产生半截 manifest"要防的情形
            this.putFile(p, text)
            throw new Error('模拟写流中断')
          }
        }
        this.putFile(p, text)
      },
      listFiles: async (root) => this.list(root),
      // B10 给 ArchiveFsPort 加了 copyFile（copy 策略要把目标内容复制进归档目录）。
      // 这里补上实现，让替身与接口保持一致 —— 缺了它在 TS 上是"没实现接口"，
      // 只是单测不走 copy 分支所以运行时看不出来。
      copyFile: async (src, dst) => {
        this.putFile(dst, this.read(src))
      }
    }
  }

  asHashPort(): RemoteHashPort {
    return {
      // 两个哈希工具都报 false → verifyRemote 走 SFTP 流式降级分支
      capability: { hasSha256sum: false, hasShasum: false, platform: 'linux', homeDir: '/root' },
      tmpDir: '/root/.sfvm-tmp',
      statSize: async (p) => (this.stat(p).exists ? this.stat(p).size : null),
      writeTextFile: async (p, c) => this.putFile(p, c),
      removeFile: async (p) => this.removeFile(p),
      runCommand: async () => {
        throw new Error('本用例不应走到远端命令分支')
      },
      readStream: (p) => {
        this.readCount++
        return Readable.from([this.read(p)])
      },
      listFiles: async (root) => this.list(root).map((f) => ({ relPath: f.relPath, size: f.size }))
    }
  }

  ports(): ArchivePorts {
    return { fs: this.asFsPort(), hash: this.asHashPort() }
  }
}

/* --------------------------------------------------------------- 夹具 */

const CLOCK = new Date(2025, 5, 12, 14, 30, 15)
const FILE_ITEMS = [{ relPath: 'order.jar', hash: sha256('hello'), size: 5, mtime: null }]
const BASE_TAG = formatVersionTag(CLOCK, computeRootHash(FILE_ITEMS))

describe('ArchiveService', () => {
  let t: TestDb
  let fake: FakeRemote
  let archive: ReturnType<typeof createArchiveService>
  let targetId: string
  let clock: Date

  /** 让时钟前进 1 秒，制造"另一个版本"的时间戳 */
  function advance(): void {
    clock = new Date(clock.getTime() + 1000)
  }

  beforeEach(() => {
    t = makeTestDb()
    fake = new FakeRemote()
    clock = CLOCK
    archive = createArchiveService({ repo: t.repo, now: () => clock })
    targetId = seedBasic(t.repo, { kind: 'file', remotePath: '/opt/svc/order.jar' }).target.id
  })

  afterEach(() => t.cleanup())

  /* ------------------------------------------------------ T09.4 归档 */

  it('文件型目标：归档后目标路径为空，归档目录里有完整内容 + manifest', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    const r = await archive.archiveVersion({ targetId, ports: fake.ports() })

    expect(r.archive.versionTag).toBe(BASE_TAG)
    expect(r.archive.storagePath).toBe(`/opt/svc/order.jar.versions/${BASE_TAG}`)
    expect(r.archive.payloadPath).toBe(`/opt/svc/order.jar.versions/${BASE_TAG}/payload`)
    expect(r.tagConflicts).toBe(0)

    // 1) 目标路径已被清空（内容搬走了），归档目录里有完整内容
    expect(fake.has('/opt/svc/order.jar')).toBe(false)
    expect(fake.ls(r.archive.storagePath)).toEqual([
      'manifest.json',
      'payload/',
      'payload/order.jar'
    ])

    // 2) manifest 完整、自洽
    const { manifest, warnings } = parseManifestText(
      fake.read(`${r.archive.storagePath}/${MANIFEST_FILE_NAME}`).toString()
    )
    expect(warnings).toEqual([])
    expect(manifest).toMatchObject({
      targetName: '订单服务',
      originalPath: '/opt/svc/order.jar',
      kind: 'file',
      versionTag: BASE_TAG,
      fileCount: 1,
      totalBytes: 5,
      operator: null,
      sourceReleaseId: null
    })
    // relPath 相对 payload（文件型就是文件名本身，与方案书 §5.3 示例一致）。
    // mtime 为 null 是刻意的：单文件目标不额外探测 mtime，避免多一次往返换一个展示字段
    expect(manifest.files).toEqual(FILE_ITEMS)
    expect(manifest.rootHash).toBe(computeRootHash(FILE_ITEMS))

    // 3) 台账
    expect(archive.count(targetId)).toBe(1)
    expect(archive.list(targetId)[0]).toMatchObject({ status: 'valid', fileCount: 1, totalBytes: 5 })
  })

  it('目录型目标：relPath 相对 payload，因此带一层 <basename>/ 前缀', async () => {
    fake.putFile('/opt/app/dist/a.js', 'aaa')
    fake.putFile('/opt/app/dist/sub/b.css', 'bb')
    const dirTarget = t.repo.targets.create({
      environmentId: t.repo.targets.get(targetId)!.environmentId,
      name: '前端产物',
      kind: 'dir',
      remotePath: '/opt/app/dist'
    })

    const r = await archive.archiveVersion({ targetId: dirTarget.id, ports: fake.ports() })
    const { manifest } = parseManifestText(
      fake.read(`${r.archive.storagePath}/${MANIFEST_FILE_NAME}`).toString()
    )

    expect(manifest.files.map((f) => f.relPath)).toEqual(['dist/a.js', 'dist/sub/b.css'])
    expect(manifest.rootHash).toBe(
      computeRootHash([
        { relPath: 'dist/a.js', hash: sha256('aaa') },
        { relPath: 'dist/sub/b.css', hash: sha256('bb') }
      ])
    )
    // 归档目录按「父目录 + <basename>.versions」推导（同父目录才能原子 rename）
    expect(r.archive.payloadPath).toBe('/opt/app/dist.versions/' + manifest.versionTag + '/payload')
    expect(fake.has('/opt/app/dist')).toBe(false)
    expect(fake.has(`${r.archive.payloadPath}/dist/a.js`)).toBe(true)
  })

  it('传入已知清单时不重算远端哈希（这是"几百 MB 产物不重算"的关键优化）', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    const r = await archive.archiveVersion({
      targetId,
      ports: fake.ports(),
      items: FILE_ITEMS,
      releaseId: 'rel-1',
      note: '修复订单超时'
    })
    expect(fake.readCount).toBe(0)
    expect(r.hashedRemotely).toBe(false)

    const { manifest } = parseManifestText(
      fake.read(`${r.archive.storagePath}/${MANIFEST_FILE_NAME}`).toString()
    )
    expect(manifest.sourceReleaseId).toBe('rel-1')
    expect(manifest.note).toBe('修复订单超时')
  })

  it('不传清单时会现场算远端指纹，并在日志里说明', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    const logs: string[] = []
    const r = await archive.archiveVersion({
      targetId,
      ports: fake.ports(),
      log: (text) => logs.push(text)
    })
    expect(r.hashedRemotely).toBe(true)
    expect(fake.readCount).toBe(1)
    expect(logs.join('\n')).toMatch(/指纹/)
    expect(r.archive.rootHash).toBe(computeRootHash(FILE_ITEMS))
  })

  it('文件名含换行时拒绝归档（清单表达不全的版本不能进版本库），且目标毫发无损', async () => {
    fake.putFile('/opt/app/dist/weird\nname.js', 'x')
    const dirTarget = t.repo.targets.create({
      environmentId: t.repo.targets.get(targetId)!.environmentId,
      name: '前端产物',
      kind: 'dir',
      remotePath: '/opt/app/dist'
    })
    await expect(
      archive.archiveVersion({ targetId: dirTarget.id, ports: fake.ports() })
    ).rejects.toMatchObject({ code: 'E_ARCHIVE_FAILED' })
    expect(fake.has('/opt/app/dist/weird\nname.js')).toBe(true)
    expect(archive.count(dirTarget.id)).toBe(0)
  })

  /* ------------------------------------------------------ T09.5 冲突 */

  it('同名目录已存在时追加序号（绝不覆盖已有版本）', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    const first = await archive.archiveVersion({ targetId, ports: fake.ports() })
    // 把内容放回目标路径，模拟"同一秒内又归档了一次"
    fake.rename(`${first.archive.payloadPath}/order.jar`, '/opt/svc/order.jar')

    const second = await archive.archiveVersion({ targetId, ports: fake.ports() })
    expect(second.archive.versionTag).toBe(`${BASE_TAG}-2`)
    expect(second.tagConflicts).toBe(1)
    // 两个版本同时存在，谁也不影响谁
    expect(fake.has(first.archive.storagePath)).toBe(true)
    expect(fake.has(second.archive.storagePath)).toBe(true)
    expect(archive.count(targetId)).toBe(2)
  })

  it('连续 5 次冲突时明确报错，且目标未被搬动', async () => {
    // 预先把基础版本号与 -2..-5 都占上
    for (const tag of [BASE_TAG, `${BASE_TAG}-2`, `${BASE_TAG}-3`, `${BASE_TAG}-4`, `${BASE_TAG}-5`]) {
      fake.putDir(`/opt/svc/order.jar.versions/${tag}`)
    }
    fake.putFile('/opt/svc/order.jar', 'hello')

    await expect(archive.archiveVersion({ targetId, ports: fake.ports() })).rejects.toMatchObject({
      code: 'E_VERSION_TAG_CONFLICT'
    })
    // 失败发生在 rename 之前 —— 目标必须原封不动
    expect(fake.read('/opt/svc/order.jar').toString()).toBe('hello')
    expect(archive.count(targetId)).toBe(0)
  })

  /* ------------------------------------------------ T09.3 失败与回滚 */

  it('写 manifest 中断：不产生半截 manifest，并把内容搬回目标路径', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    fake.failWriteAfterChunks = 1 // 第一块写下去就抛错

    await expect(archive.archiveVersion({ targetId, ports: fake.ports() })).rejects.toMatchObject({
      code: 'E_ARCHIVE_FAILED'
    })

    // 1) 目标恢复原状（最要紧的一条：归档失败不能顺手把现网版本弄没）
    expect(fake.read('/opt/svc/order.jar').toString()).toBe('hello')
    // 2) 归档目录里没有 manifest.json，也没有半成品
    const dir = `/opt/svc/order.jar.versions/${BASE_TAG}`
    expect(fake.has(`${dir}/${MANIFEST_FILE_NAME}`)).toBe(false)
    expect(fake.has(`${dir}/${MANIFEST_TMP_NAME}`)).toBe(false)
    // 3) 台账里没有这条记录
    expect(archive.count(targetId)).toBe(0)
  })

  it('回滚也失败时明确说明内容还在哪里（不能让人以为内容丢了）', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    fake.failWriteAfterChunks = 1
    fake.failRenameTo.add('/opt/svc/order.jar') // 回滚那一次 rename 也失败

    const err = await archive
      .archiveVersion({ targetId, ports: fake.ports() })
      .catch((e: Error & { code?: string }) => e)

    expect((err as { code?: string }).code).toBe('E_ARCHIVE_FAILED')
    expect((err as Error).message).toMatch(/内容仍在/)
    // 回滚失败时绝不能删掉 payload —— 内容确实还在那里
    expect(
      fake.read(`/opt/svc/order.jar.versions/${BASE_TAG}/payload/order.jar`).toString()
    ).toBe('hello')
  })

  /* ------------------------------------------------------ T09.7 校验 */

  it('校验通过：内容与 manifest 一致', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    const r = await archive.archiveVersion({ targetId, ports: fake.ports() })

    const v = await archive.verifyArchive({ archiveId: r.archive.id, ports: fake.ports() })
    expect(v.ok).toBe(true)
    expect(v.status).toBe('valid')
    expect(v.mode).toBe('sftp-stream')
    expect(v.message).toMatch(/一致/)
    expect(t.repo.archives.get(r.archive.id)!.status).toBe('valid')
  })

  it('篡改归档文件后校验报 corrupt，并指出是哪个文件', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    const r = await archive.archiveVersion({ targetId, ports: fake.ports() })

    fake.putFile(`${r.archive.payloadPath}/order.jar`, 'hello!') // 多了一个字节
    const v = await archive.verifyArchive({ archiveId: r.archive.id, ports: fake.ports() })

    expect(v.ok).toBe(false)
    expect(v.status).toBe('corrupt')
    expect(v.diff.mismatch.map((m) => m.relPath)).toEqual(['order.jar'])
    expect(v.message).toMatch(/不一致/)
    // 状态要落库（下次打开 UI 就能看到"已损坏"）
    expect(t.repo.archives.get(r.archive.id)!.status).toBe('corrupt')
  })

  it('manifest 丢失 → missing；内容目录丢失 → missing', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    const r = await archive.archiveVersion({ targetId, ports: fake.ports() })
    const manifestPath = `${r.archive.storagePath}/${MANIFEST_FILE_NAME}`
    const text = fake.read(manifestPath).toString()

    fake.removeFile(manifestPath)
    const v1 = await archive.verifyArchive({ archiveId: r.archive.id, ports: fake.ports() })
    expect(v1.status).toBe('missing')
    expect(v1.mode).toBe('missing')
    expect(v1.message).toMatch(/没有 manifest/)

    fake.putFile(manifestPath, text)
    fake.rmrf(r.archive.payloadPath)
    const v2 = await archive.verifyArchive({ archiveId: r.archive.id, ports: fake.ports() })
    expect(v2.status).toBe('missing')
    expect(v2.message).toMatch(/内容目录不存在/)
  })

  it('manifest 解析不了 / 自相矛盾时判为 corrupt（不拿它当真值继续比）', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    const r = await archive.archiveVersion({ targetId, ports: fake.ports() })
    const manifestPath = `${r.archive.storagePath}/${MANIFEST_FILE_NAME}`
    // 先把好内容收好：后面要拿它做"只改一个汇总字段"的对照
    const goodText = fake.read(manifestPath).toString()

    fake.putFile(manifestPath, '{ 这不是 JSON')
    const v1 = await archive.verifyArchive({ archiveId: r.archive.id, ports: fake.ports() })
    expect(v1.status).toBe('corrupt')
    expect(v1.message).toMatch(/无法解析/)

    const tweaked = JSON.parse(goodText) as Record<string, unknown>
    tweaked.fileCount = 99
    fake.putFile(manifestPath, JSON.stringify(tweaked))
    const v2 = await archive.verifyArchive({ archiveId: r.archive.id, ports: fake.ports() })
    expect(v2.status).toBe('corrupt')
    expect(v2.message).toMatch(/自相矛盾/)
  })

  /* -------------------------------------------------- T09.8 保留策略 */

  it('count 模式：保留 3 个时删掉多余的，并真的删除远端目录', async () => {
    const tags: string[] = []
    for (let i = 0; i < 4; i++) {
      fake.putFile('/opt/svc/order.jar', 'hello')
      const r = await archive.archiveVersion({ targetId, ports: fake.ports() })
      tags.push(r.archive.versionTag)
      advance()
    }
    expect(new Set(tags).size).toBe(4)
    t.repo.targets.update(targetId, { retainPolicy: JSON.stringify({ mode: 'count', value: 3 }) })

    const result = await archive.applyRetention({ targetId, fs: fake.ports().fs })
    expect(result.removed.map((r) => r.versionTag)).toEqual([tags[0]])
    expect(result.failed).toEqual([])
    expect(result.policyText).toMatch(/保留最近 3 个/)
    // 远端目录真的没了，台账也只剩 3 条（倒序）
    expect(fake.has(`/opt/svc/order.jar.versions/${tags[0]}`)).toBe(false)
    expect(archive.count(targetId)).toBe(3)
    expect(archive.list(targetId).map((a) => a.versionTag)).toEqual([tags[3], tags[2], tags[1]])
  })

  it('没有策略时不删任何东西', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    await archive.archiveVersion({ targetId, ports: fake.ports() })
    const result = await archive.applyRetention({ targetId, fs: fake.ports().fs })
    expect(result.removed).toEqual([])
    expect(result.policyText).toMatch(/未设置/)
    expect(archive.count(targetId)).toBe(1)
  })

  it('策略非法时一个都不删（坏策略的后果必须是"不清理"）', async () => {
    fake.putFile('/opt/svc/order.jar', 'hello')
    await archive.archiveVersion({ targetId, ports: fake.ports() })
    t.repo.targets.update(targetId, { retainPolicy: '{"mode":"count","value":0}' })

    const result = await archive.applyRetention({ targetId, fs: fake.ports().fs })
    expect(result.invalidReason).toBeTruthy()
    expect(result.removed).toEqual([])
    expect(archive.count(targetId)).toBe(1)
  })

  it('单个版本删除失败时如实上报，台账行保留（服务器上还在的东西不能假装没了）', async () => {
    for (let i = 0; i < 2; i++) {
      fake.putFile('/opt/svc/order.jar', `hello-${i}`)
      await archive.archiveVersion({ targetId, ports: fake.ports() })
      advance()
    }
    t.repo.targets.update(targetId, { retainPolicy: JSON.stringify({ mode: 'count', value: 1 }) })

    const failingFs: ArchiveFsPort = {
      ...fake.ports().fs,
      rmrf: async () => {
        throw new Error('远端拒绝删除')
      }
    }
    const result = await archive.applyRetention({ targetId, fs: failingFs })
    expect(result.removed).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.reason).toMatch(/拒绝删除/)
    expect(archive.count(targetId)).toBe(2)
  })

  it('目标不存在时给出明确错误', async () => {
    await expect(
      archive.applyRetention({ targetId: 'nope', fs: fake.ports().fs })
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    await expect(
      archive.archiveVersion({ targetId: 'nope', ports: fake.ports() })
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })
})
