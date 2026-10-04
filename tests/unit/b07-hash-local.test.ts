/**
 * B07 / T07.1 ~ T07.4 验收点：本地哈希覆盖全部边界（空目录 / 中文名 / 大文件 / 排除规则 / 符号链接）。
 *
 * 刻意用**真实文件系统**（temp 目录）而不是 mock：哈希写错、遍历顺序不稳定、
 * errno 映射错位这类问题只在真实 fs 语义下才暴露。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  HASH_CHUNK_SIZE,
  collectLocalFiles,
  hashLocalArtifact,
  hashLocalFile,
  hashReadable
} from '@main/services/hash'
import { EMPTY_ROOT_HASH, computeRootHash, isSafeRelPath } from '@main/infra/hash-core'
import { ErrorCode } from '@main/infra/errors'
import { Readable } from 'node:stream'

const dirs: string[] = []

function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sfvm-b07-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop() as string
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* Windows 上偶发占用，忽略 */
    }
  }
})

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 造一个目录树。键是相对路径，值是内容。 */
function makeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

describe('hashLocalFile（T07.1）', () => {
  it('与 sha256sum / crypto 的结果一致', async () => {
    const root = makeTmp()
    const p = join(root, 'a.bin')
    writeFileSync(p, Buffer.from('hello 世界'))
    const expected = createHash('sha256').update(Buffer.from('hello 世界')).digest('hex')
    expect(await hashLocalFile(p)).toBe(expected)
  })

  it('空文件得到 sha256("")', async () => {
    const root = makeTmp()
    const p = join(root, 'empty.bin')
    writeFileSync(p, '')
    expect(await hashLocalFile(p)).toBe(EMPTY_ROOT_HASH)
  })

  it('跨分块边界的文件（> 64KB，且非整块）结果正确', async () => {
    const root = makeTmp()
    const p = join(root, 'big.bin')
    const buf = randomBytes(HASH_CHUNK_SIZE * 3 + 12345)
    writeFileSync(p, buf)
    expect(await hashLocalFile(p)).toBe(createHash('sha256').update(buf).digest('hex'))
    expect(await hashLocalFile(p)).toBe(sha256OfFile(p))
  })

  it('中文文件名可直接哈希', async () => {
    const root = makeTmp()
    const p = join(root, '订单服务 v1.2.3 构建产物.bin')
    writeFileSync(p, '中文内容')
    expect(await hashLocalFile(p)).toBe(
      createHash('sha256').update(Buffer.from('中文内容')).digest('hex')
    )
  })

  it('文件不存在 → E_LOCAL_PATH_MISSING', async () => {
    const root = makeTmp()
    await expect(hashLocalFile(join(root, 'nope.bin'))).rejects.toMatchObject({
      code: ErrorCode.E_LOCAL_PATH_MISSING
    })
  })

  it('把目录当文件哈希 → E_LOCAL_PATH_KIND（不是 E_UNKNOWN）', async () => {
    const root = makeTmp()
    const sub = join(root, 'sub')
    mkdirSync(sub)
    await expect(hashLocalFile(sub)).rejects.toMatchObject({
      code: ErrorCode.E_LOCAL_PATH_KIND
    })
  })

  it('已被取消的信号 → E_JOB_CANCELLED', async () => {
    const root = makeTmp()
    const p = join(root, 'a.bin')
    writeFileSync(p, 'x')
    const ac = new AbortController()
    ac.abort()
    await expect(hashLocalFile(p, ac.signal)).rejects.toMatchObject({
      code: ErrorCode.E_JOB_CANCELLED
    })
  })
})

describe('hashReadable', () => {
  it('对任意可读流求哈希（远端降级路径复用同一个实现）', async () => {
    const buf = randomBytes(200000)
    const got = await hashReadable(Readable.from([buf]))
    expect(got).toBe(createHash('sha256').update(buf).digest('hex'))
  })

  it('分多次推送的流结果一致', async () => {
    const parts = [randomBytes(1000), randomBytes(1000), randomBytes(1000)]
    const got = await hashReadable(Readable.from(parts))
    expect(got).toBe(createHash('sha256').update(Buffer.concat(parts)).digest('hex'))
  })
})

describe('collectLocalFiles（T07.2）', () => {
  it('递归收集并给出相对路径与大小', async () => {
    const root = makeTmp()
    makeTree(root, {
      'index.html': 'a',
      'assets/app.js': 'bb',
      'assets/css/app.css': 'ccc'
    })
    const { files } = await collectLocalFiles({ root })
    expect(files.map((f) => f.relPath)).toEqual([
      'assets/app.js',
      'assets/css/app.css',
      'index.html'
    ])
    expect(files.map((f) => f.size)).toEqual([2, 3, 1])
    expect(files.every((f) => f.absPath.startsWith(root))).toBe(true)
  })

  it('空目录得到空集合', async () => {
    const root = makeTmp()
    const { files, excludedCount, skippedSymlinks } = await collectLocalFiles({ root })
    expect(files).toEqual([])
    expect(excludedCount).toBe(0)
    expect(skippedSymlinks).toBe(0)
  })

  it('应用排除规则并统计命中数', async () => {
    const root = makeTmp()
    makeTree(root, {
      'app.js': 'a',
      'app.js.map': 'b',
      'logs/app.log': 'c',
      'node_modules/react/index.js': 'd'
    })
    const { files, excludedCount } = await collectLocalFiles({
      root,
      exclude: ['.map', '*.log', 'node_modules']
    })
    expect(files.map((f) => f.relPath)).toEqual(['app.js'])
    expect(excludedCount).toBe(3)
  })

  it('中文目录名与文件名正常收集', async () => {
    const root = makeTmp()
    makeTree(root, { '静态资源/图片/logo.png': 'x', '订单服务.jar': 'y' })
    const { files } = await collectLocalFiles({ root })
    expect(files.map((f) => f.relPath).sort()).toEqual(['订单服务.jar', '静态资源/图片/logo.png'])
  })

  // Windows 文件系统不允许文件名含换行，只能在其它的平台上验证这条防线
  it.skipIf(process.platform === 'win32')('文件名含换行时明确报错，而不是静默跳过', async () => {
    const root = makeTmp()
    makeTree(root, { 'ok.txt': 'a' })
    writeFileSync(join(root, 'bad\nname.txt'), 'b')
    await expect(collectLocalFiles({ root })).rejects.toMatchObject({
      code: ErrorCode.E_LOCAL_PATH_KIND
    })
  })

  it.skipIf(process.platform === 'win32')('文件名含空字符时明确报错', async () => {
    const root = makeTmp()
    makeTree(root, { 'ok.txt': 'a' })
    // 空字符无法直接建文件，改为验证纯逻辑判定（fs 层与纯逻辑共用 isSafeRelPath）
    expect(isSafeRelPath('bad\0name.txt')).toBe(false)
    const { files } = await collectLocalFiles({ root })
    expect(files.map((f) => f.relPath)).toEqual(['ok.txt'])
  })

  it('不跟随符号链接（避免成环或指向产物外）', async () => {
    const root = makeTmp()
    makeTree(root, { 'real.txt': 'a' })
    const linkPath = join(root, 'link.txt')

    /**
     * 这里**验效果、不验调用**：只判"`symlinkSync` 没抛错"是不够的。
     * 2026-10-01 实测：本机的文件系统过滤驱动会把**文件符号链接**静默降级成一个
     * 0 字节的普通文件（`lstat().isSymbolicLink() === false`，但目录项照样出现）。
     * 那种情况下目录里根本没有符号链接，下面的断言测到的就不是"'跳过符号链接'
     * 这个行为"，而只是平台差异 —— 会让一个仓库外的原因把整条测试变红。
     */
    let linked = false
    try {
      symlinkSync(join(root, 'real.txt'), linkPath)
      linked = lstatSync(linkPath).isSymbolicLink()
    } catch {
      // Windows 无开发者模式/管理员权限时无法建符号链接，跳过该断言
    }
    if (!linked) rmSync(linkPath, { force: true })

    const { files, skippedSymlinks } = await collectLocalFiles({ root })
    expect(files.map((f) => f.relPath)).toEqual(['real.txt'])
    if (linked) {
      expect(skippedSymlinks).toBe(1)
    } else {
      console.warn('本机建立文件符号链接被降级为空文件，跳过 skippedSymlinks 断言')
    }
  })

  it('超过文件数上限时报 E_ARTIFACT_TOO_MANY_FILES', async () => {
    const root = makeTmp()
    makeTree(root, { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' })
    await expect(collectLocalFiles({ root, maxFiles: 2 })).rejects.toMatchObject({
      code: ErrorCode.E_ARTIFACT_TOO_MANY_FILES
    })
  })
})

describe('hashLocalArtifact（T07.1 ~ T07.4）', () => {
  it('目录型：指纹与逐文件清单一致', async () => {
    const root = makeTmp()
    makeTree(root, { 'b.js': 'BBB', 'a.js': 'AAA', 'sub/c.js': 'CCC' })
    const r = await hashLocalArtifact({ localPath: root, kind: 'dir' })

    expect(r.fileCount).toBe(3)
    expect(r.totalBytes).toBe(9)
    // items 已按 UTF-8 字节序排好
    expect(r.items.map((i) => i.relPath)).toEqual(['a.js', 'b.js', 'sub/c.js'])
    expect(r.rootHash).toBe(computeRootHash(r.items))
    expect(r.rootHash).not.toBe(EMPTY_ROOT_HASH)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('空目录：fileCount=0 且指纹为确定值', async () => {
    const root = makeTmp()
    const r = await hashLocalArtifact({ localPath: root, kind: 'dir' })
    expect(r.fileCount).toBe(0)
    expect(r.totalBytes).toBe(0)
    expect(r.rootHash).toBe(EMPTY_ROOT_HASH)
  })

  it('文件型：relPath 用 basename（与 manifest 契约一致）', async () => {
    const root = makeTmp()
    const jar = join(root, 'order-service-1.2.3.jar')
    writeFileSync(jar, 'JAR')
    const r = await hashLocalArtifact({ localPath: jar, kind: 'file' })
    expect(r.fileCount).toBe(1)
    expect(r.items[0]?.relPath).toBe('order-service-1.2.3.jar')
    expect(r.items[0]?.size).toBe(3)
    expect(r.rootHash).toBe(computeRootHash(r.items))
  })

  it('文件型目标不套用 local_exclude（用户已明确选了这一个文件）', async () => {
    const root = makeTmp()
    const p = join(root, 'app.log')
    writeFileSync(p, 'x')
    const r = await hashLocalArtifact({ localPath: p, kind: 'file', exclude: ['*.log'] })
    expect(r.fileCount).toBe(1)
    expect(r.excludedCount).toBe(0)
  })

  it('类型不匹配时明确报 E_LOCAL_PATH_KIND', async () => {
    const root = makeTmp()
    makeTree(root, { 'a.txt': 'x' })
    await expect(hashLocalArtifact({ localPath: root, kind: 'file' })).rejects.toMatchObject({
      code: ErrorCode.E_LOCAL_PATH_KIND
    })
    await expect(
      hashLocalArtifact({ localPath: join(root, 'a.txt'), kind: 'dir' })
    ).rejects.toMatchObject({ code: ErrorCode.E_LOCAL_PATH_KIND })
  })

  it('内容不变时指纹稳定（多次调用一致）', async () => {
    const root = makeTmp()
    makeTree(root, { 'a.js': 'A', 'b/c.js': 'C' })
    const first = await hashLocalArtifact({ localPath: root, kind: 'dir' })
    const second = await hashLocalArtifact({ localPath: root, kind: 'dir' })
    expect(second.rootHash).toBe(first.rootHash)
  })

  it('内容变化时指纹变化', async () => {
    const root = makeTmp()
    makeTree(root, { 'a.js': 'A' })
    const before = await hashLocalArtifact({ localPath: root, kind: 'dir' })
    writeFileSync(join(root, 'a.js'), 'B')
    const after = await hashLocalArtifact({ localPath: root, kind: 'dir' })
    expect(after.rootHash).not.toBe(before.rootHash)
  })

  it('汇总字段与明细自洽', async () => {
    const root = makeTmp()
    makeTree(root, { 'a.js': 'AAAA', 'b.js': 'BB' })
    const r = await hashLocalArtifact({ localPath: root, kind: 'dir' })
    expect(r.totalBytes).toBe(r.items.reduce((a, i) => a + i.size, 0))
    expect(r.fileCount).toBe(r.items.length)
  })

  it('进度回调按文件推进，最后一次的 done 等于总数', async () => {
    const root = makeTmp()
    makeTree(root, { 'a.js': 'A', 'b.js': 'B', 'c.js': 'C' })
    const seen: Array<[number, number, string]> = []
    await hashLocalArtifact({
      localPath: root,
      kind: 'dir',
      onProgress: (done, total, file) => seen.push([done, total, file])
    })
    expect(seen.map((s) => s[0])).toEqual([1, 2, 3])
    expect(seen.every((s) => s[1] === 3)).toBe(true)
    expect(seen[2]?.[2]).toBe('c.js')
  })

  it('取消后不再继续算：E_JOB_CANCELLED', async () => {
    const root = makeTmp()
    makeTree(root, { 'a.js': 'A', 'b.js': 'B' })
    const ac = new AbortController()
    ac.abort()
    await expect(
      hashLocalArtifact({ localPath: root, kind: 'dir', signal: ac.signal })
    ).rejects.toMatchObject({ code: ErrorCode.E_JOB_CANCELLED })
  })
})
