/**
 * B12 / T12.3 ~ T12.4 单测：下载计划、下载流程、失败语义。
 *
 * 三条最要紧的性质必须**真跑**才能验：
 *
 * 1. **篡改后的归档下载不下来**（MT-05）：远端内容与清单哈希不一致时要被拦住，
 *    而且台账要被标记成 corrupt。这里用 `createTransfer(memoryPort)` 跑**真实的**
 *    传输层校验（它是对"刚落盘的文件"算哈希），不是让替身直接抛错 —— 后者只能
 *    证明"错误会往上抛"，证明不了"我们确实在校验"。
 * 2. **校验失败要保留产物**（T12.4）：暂存目录必须还在，且错误信息要指出它在哪。
 * 3. **写入位置由主进程拼**：渲染进程只能传单层目录名，manifest 里的 relPath
 *    再离谱也不能写到暂存目录之外。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createArchiveDownloadService,
  type DownloadSourcePort
} from '@main/services/archive-download'
import { createTransfer, type TransferPort } from '@main/services/transfer'
import {
  buildArchiveDirName,
  downloadStageRange,
  isSafeLocalRelPath,
  joinInside,
  mapStagePercent,
  pickFreeDirName,
  sanitizeLocalName,
  stagingNameOf,
  unsafeRelPathsOf
} from '@main/infra/archive-download'
import { computeRootHash } from '@main/infra/hash-core'
import { AppError, ErrorCode } from '@main/infra/errors'
import { MANIFEST_FILE_NAME } from '@main/infra/manifest-io'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

/* ------------------------------------------------------------- 临时目录 */

const tmpDirs: string[] = []
function makeTmp(prefix = 'sfvm-b12dl-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true })
    } catch {
      /* Windows 偶发占用 */
    }
  }
})

/* --------------------------------------------------------- 内存远端传输 */

/**
 * 只实现本测试用得到的部分。
 *
 * 刻意**不**实现 fastPut/进度等无关方法的行为：这个替身越小，越容易看出
 * "被测的那条路径到底走了哪几步"。真实传输层的重试/取消/`.part` 语义
 * 已由 B07 的单测与真机集成覆盖。
 */
class MemoryRemote implements TransferPort {
  files = new Map<string, Buffer>()

  put(path: string, content: string): void {
    this.files.set(path, Buffer.from(content))
  }

  async statSize(p: string): Promise<number | null> {
    return this.files.get(p)?.length ?? null
  }

  async ensureDir(): Promise<void> {
    /* 内存里不需要 */
  }

  async fastPut(): Promise<void> {
    throw new Error('本替身不提供上传')
  }

  async fastGet(remotePath: string, localPath: string, onStep?: (n: number) => void): Promise<void> {
    const buf = this.files.get(remotePath)
    if (!buf) throw new Error(`no such file: ${remotePath}`)
    mkdirSync(dirname(localPath), { recursive: true })
    writeFileSync(localPath, buf)
    onStep?.(buf.length)
  }

  createReadStream(remotePath: string): NodeJS.ReadableStream {
    const buf = this.files.get(remotePath)
    if (!buf) throw new Error(`no such file: ${remotePath}`)
    return Readable.from([buf])
  }

  createWriteStream(): NodeJS.WritableStream {
    return new Writable({ write: (_c, _e, cb) => cb() })
  }

  async rename(): Promise<void> {
    /* 下载路径不用 */
  }

  async removeFile(): Promise<void> {
    /* 下载路径不用 */
  }
}

/* ------------------------------------------------------------ 清单构造 */

interface RelFile {
  relPath: string
  content: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 造一份与归档服务写出来的一模一样的 manifest（字段名/语义都对齐契约）。 */
function manifestOf(
  files: RelFile[],
  over: Partial<{ versionTag: string; rootHash: string; fileCount: number; totalBytes: number }> = {}
): { text: string; rootHash: string; totalBytes: number; versionTag: string } {
  const items = files.map((f) => ({ relPath: f.relPath, hash: sha256(f.content), size: f.content.length }))
  const rootHash = over.rootHash ?? computeRootHash(items)
  const totalBytes = over.totalBytes ?? items.reduce((a, i) => a + i.size, 0)
  const versionTag = over.versionTag ?? '20260901-120000_ab12cd3'
  const text = JSON.stringify(
    {
      schemaVersion: 1,
      targetName: '前端产物',
      originalPath: '/opt/app/dist',
      kind: 'dir',
      versionTag,
      archivedAt: '2026-09-01T12:00:00+08:00',
      hashAlgo: 'sha256',
      rootHash,
      totalBytes,
      fileCount: over.fileCount ?? items.length,
      operator: null,
      note: null,
      sourceReleaseId: null,
      files: items.map((i, n) => ({ ...i, mtime: files[n]?.content ? '2026-09-01T12:00:00+08:00' : null }))
    },
    null,
    2
  )
  return { text, rootHash, totalBytes, versionTag }
}

/* ------------------------------------------------------------ 夹具 */

interface Fixture extends TestDb {
  archiveId: string
  targetId: string
  saveDir: string
  storagePath: string
  payloadPath: string
  remote: MemoryRemote
  putManifest: (text: string) => void
}

function setup(files: RelFile[] = [{ relPath: 'dist/index.html', content: 'hello' }]): Fixture {
  const t = makeTestDb()
  const { target } = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/app/dist' })
  const m = manifestOf(files)

  const storagePath = `/opt/app/archives/dist-${m.versionTag}`
  const payloadPath = `${storagePath}/payload`
  const row = t.repo.archives.create({
    targetId: target.id,
    versionTag: m.versionTag,
    storagePath,
    payloadPath,
    kind: 'dir',
    rootHash: m.rootHash,
    totalBytes: m.totalBytes,
    fileCount: files.length,
    releaseId: null,
    note: null,
    status: 'valid'
  })

  const remote = new MemoryRemote()
  for (const f of files) remote.put(`${payloadPath}/${f.relPath}`, f.content)
  remote.put(`${storagePath}/${MANIFEST_FILE_NAME}`, m.text)

  const saveDir = makeTmp()

  return {
    ...t,
    archiveId: row.id,
    targetId: target.id,
    saveDir,
    storagePath,
    payloadPath,
    remote,
    putManifest: (text) => remote.put(`${storagePath}/${MANIFEST_FILE_NAME}`, text)
  }
}

/** 源端口：读 manifest + 探 payload（与接线层给的两个方法一致）。 */
function sourceOf(f: Fixture, payloadExists = true): DownloadSourcePort {
  return {
    readTextFile: async (p) => {
      const buf = f.remote.files.get(p)
      if (!buf) throw new AppError(ErrorCode.E_ARCHIVE_MISSING, { path: p })
      return buf.toString('utf8')
    },
    stat: async () => ({ exists: payloadExists, isDirectory: true, size: 0 })
  }
}

/* =============================================================== 纯逻辑 */

describe('B12 下载纯逻辑', () => {
  it('净化目录名：非法字符、结尾的点与空格、保留设备名都要处理', () => {
    // 非法字符替换成下划线（结尾那个 `*` 也变成下划线，属于预期内的"看起来有点脏"，
    // 比"整个名字被拒绝、这个版本永远下不了"要好）
    expect(sanitizeLocalName('前端:产物*')).toBe('前端_产物_')
    expect(sanitizeLocalName('a//b')).toBe('a_b')
    expect(sanitizeLocalName('名字...')).toBe('名字')
    expect(sanitizeLocalName('   ')).toBe('archive')
    // Windows 保留名：直接用作文件名会失败
    expect(sanitizeLocalName('CON')).toBe('_CON')
    expect(sanitizeLocalName('nul')).toBe('_nul')
    // 超长要截断（255 是多数文件系统的单层上限，还要留给版本号后缀）
    expect(sanitizeLocalName('x'.repeat(300)).length).toBeLessThanOrEqual(120)
  })

  it('最终目录名 = 目标名 + 版本号；暂存名带 .sfvm-part- 前缀', () => {
    expect(buildArchiveDirName('前端产物', '20260901-120000_ab12cd3')).toBe(
      '前端产物-20260901-120000_ab12cd3'
    )
    expect(stagingNameOf('abc123')).toBe('.sfvm-part-abc123')
  })

  it('同名目录存在时自动改名，全部被占则返回 null（不无限循环）', async () => {
    const taken = new Set(['a', 'a-2'])
    const r1 = await pickFreeDirName('a', async (n) => taken.has(n))
    expect(r1).toEqual({ name: 'a-3', adjustedFrom: 'a' })
    const r2 = await pickFreeDirName('b', async (n) => taken.has(n))
    expect(r2).toEqual({ name: 'b', adjustedFrom: null })
    const r3 = await pickFreeDirName('a', async () => true, 3)
    expect(r3).toBeNull()
  })

  it('拒绝把目录写到保存位置之外（分隔符 / 穿越）', () => {
    expect(() => joinInside('/tmp/dl', '../etc')).toThrow()
    expect(() => joinInside('/tmp/dl', 'a/b')).toThrow()
    expect(() => joinInside('/tmp/dl', 'a\\b')).toThrow()
    // 用 posix 比：`joinInside` 对 POSIX 形态的输入走 posix 分支，
    // 而本机 node:path 的默认实现是 win32，两者不能混着比
    expect(joinInside('/tmp/dl', 'ok-name')).toBe(posix.join('/tmp/dl', 'ok-name'))
  })

  it('阶段进度严格落在区间内且单调递增', () => {
    const ranges = (['manifest', 'fetch', 'verify', 'finalize'] as const).map(downloadStageRange)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.from).toBe(ranges[i - 1]!.to)
    }
    expect(ranges[0]!.from).toBe(0)
    expect(ranges[ranges.length - 1]!.to).toBe(100)
    expect(mapStagePercent('fetch', 0, 100)).toBe(3)
    expect(mapStagePercent('fetch', 100, 100)).toBe(92)
    // 越界的输入不越界输出
    expect(mapStagePercent('fetch', 999, 100)).toBe(92)
    expect(mapStagePercent('fetch', -1, 100)).toBe(3)
    // 总数为 0 时给区间起点，不返回 NaN
    expect(mapStagePercent('fetch', 0, 0)).toBe(3)
  })

  it('relPath 安全判据：拦住越界、绝对路径与反斜杠', () => {
    expect(isSafeLocalRelPath('dist/a.js')).toBe(true)
    expect(isSafeLocalRelPath('../secret')).toBe(false)
    expect(isSafeLocalRelPath('a/../../b')).toBe(false)
    expect(isSafeLocalRelPath('/etc/passwd')).toBe(false)
    // 归档侧允许反斜杠（远端统一用 /），下载侧必须禁 —— 它在本地是"带反斜杠的文件名"
    expect(isSafeLocalRelPath('a\\b')).toBe(false)
    expect(isSafeLocalRelPath('C:/windows')).toBe(false)
    expect(isSafeLocalRelPath('')).toBe(false)

    expect(unsafeRelPathsOf(['ok/a', '../bad', 'ok/b'])).toEqual(['../bad'])
    // 最多报 20 个（用户要的是"有问题"，不是完整清单）
    const many = Array.from({ length: 50 }, (_, i) => `../bad${i}`)
    expect(unsafeRelPathsOf(many)).toHaveLength(20)
  })
})

/* =============================================================== 下载计划 */

describe('B12 下载计划（T12.3）', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = setup()
  })

  it('给出最终目录与暂存目录，且不连服务器（源端口都没给）', async () => {
    const svc = createArchiveDownloadService({ repo: fx.repo })
    const plan = await svc.plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    expect(plan.finalName).toBe(`订单服务-${fx.repo.archives.get(fx.archiveId)!.versionTag}`)
    expect(plan.finalPath).toBe(join(fx.saveDir, plan.finalName))
    expect(plan.stagingPath).toBe(join(fx.saveDir, stagingNameOf(fx.archiveId)))
    expect(plan.adjustedFrom).toBeNull()
    expect(plan.saveDirExists).toBe(true)
  })

  it('同名目录已存在时改名，并把"原名"告诉 UI', async () => {
    const svc = createArchiveDownloadService({ repo: fx.repo })
    const first = await svc.plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    mkdirSync(first.finalPath, { recursive: true })

    const second = await svc.plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    expect(second.finalName).toBe(`${first.finalName}-2`)
    expect(second.adjustedFrom).toBe(first.finalName)
  })

  it('保存位置是个文件时报"类型不对"，而不是等到写盘才失败', async () => {
    const svc = createArchiveDownloadService({ repo: fx.repo })
    const file = join(fx.saveDir, 'not-a-dir')
    writeFileSync(file, 'x')
    await expect(svc.plan({ archiveId: fx.archiveId, saveDir: file })).rejects.toMatchObject({
      code: ErrorCode.E_LOCAL_PATH_KIND
    })
  })
})

/* =============================================================== 下载流程 */

describe('B12 下载流程（T12.3 / T12.4）', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = setup([
      { relPath: 'dist/index.html', content: 'hello' },
      { relPath: 'dist/assets/app.js', content: 'console.log(1)' }
    ])
  })

  function svc(): ReturnType<typeof createArchiveDownloadService> {
    return createArchiveDownloadService({ repo: fx.repo })
  }

  it('正常下载：逐文件校验 → 落盘到最终目录 → 暂存目录消失', async () => {
    const plan = await svc().plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    const result = await svc().download({
      archiveId: fx.archiveId,
      saveDir: fx.saveDir,
      finalName: plan.finalName,
      source: sourceOf(fx),
      transfer: createTransfer(fx.remote)
    })

    expect(result.verified).toBe(true)
    expect(result.files).toBe(2)
    expect(result.finalPath).toBe(plan.finalPath)
    // 内容真的落盘了（含嵌套目录）
    expect(readFileSync(join(result.finalPath, 'dist/index.html'), 'utf8')).toBe('hello')
    expect(readFileSync(join(result.finalPath, 'dist/assets/app.js'), 'utf8')).toBe('console.log(1)')
    // 暂存目录不能留下（改名走的同父目录 rename）
    expect(existsSync(plan.stagingPath)).toBe(false)
  })

  it('**MT-05**：归档被改坏 → 下载被拦截、台账标 corrupt、已下载的部分保留', async () => {
    // 只改 payload 里那个文件，manifest 不动 —— 这正是"手工改坏一个字节"的形态
    fx.remote.put(`${fx.payloadPath}/dist/index.html`, 'hello-tampered')

    const plan = await svc().plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    await expect(
      svc().download({
        archiveId: fx.archiveId,
        saveDir: fx.saveDir,
        finalName: plan.finalName,
        source: sourceOf(fx),
        transfer: createTransfer(fx.remote, { retryDelay: () => 1 })
      })
    ).rejects.toMatchObject({ code: ErrorCode.E_VERIFY_MISMATCH })

    // 台账要如实变成 corrupt（下次打开列表就能看到"已损坏"）
    expect(fx.repo.archives.get(fx.archiveId)!.status).toBe('corrupt')
    // 最终目录不能出现（宁可什么都没有，也不能给一份内容不可信的东西）
    expect(existsSync(plan.finalPath)).toBe(false)
    // 暂存目录保留（T12.4）：用户可能想把已下好的文件拿走
    expect(existsSync(plan.stagingPath)).toBe(true)
  })

  it('清单里的 relPath 越界 → 在下载之前就拒绝，一个字节都不写', async () => {
    fx.putManifest(manifestOf([{ relPath: '../../.ssh/authorized_keys', content: 'x' }]).text)

    const plan = await svc().plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    await expect(
      svc().download({
        archiveId: fx.archiveId,
        saveDir: fx.saveDir,
        finalName: plan.finalName,
        source: sourceOf(fx),
        transfer: createTransfer(fx.remote)
      })
    ).rejects.toMatchObject({ code: ErrorCode.E_ARCHIVE_CORRUPT })

    expect(fx.repo.archives.get(fx.archiveId)!.status).toBe('corrupt')
    // 只建了空的暂存目录，没有任何文件
    expect(existsSync(plan.stagingPath)).toBe(true)
    expect(readdirSafe(plan.stagingPath)).toEqual([])
  })

  it('清单与台账不一致（归档目录被换过）→ 拒绝下载并标 corrupt', async () => {
    // manifest 自洽，但根指纹与台账记录的不是同一份内容
    fx.putManifest(manifestOf([{ relPath: 'dist/other.html', content: 'other' }]).text)

    const plan = await svc().plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    await expect(
      svc().download({
        archiveId: fx.archiveId,
        saveDir: fx.saveDir,
        finalName: plan.finalName,
        source: sourceOf(fx),
        transfer: createTransfer(fx.remote)
      })
    ).rejects.toMatchObject({ code: ErrorCode.E_ARCHIVE_CORRUPT })
    expect(fx.repo.archives.get(fx.archiveId)!.status).toBe('corrupt')
  })

  it('manifest 不见了 → E_ARCHIVE_MISSING 并标 missing', async () => {
    fx.remote.files.delete(`${fx.storagePath}/${MANIFEST_FILE_NAME}`)
    const plan = await svc().plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    await expect(
      svc().download({
        archiveId: fx.archiveId,
        saveDir: fx.saveDir,
        finalName: plan.finalName,
        source: sourceOf(fx),
        transfer: createTransfer(fx.remote)
      })
    ).rejects.toMatchObject({ code: ErrorCode.E_ARCHIVE_MISSING })
    expect(fx.repo.archives.get(fx.archiveId)!.status).toBe('missing')
  })

  it('payload 目录不存在 → E_ARCHIVE_MISSING 并标 missing', async () => {
    const plan = await svc().plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    await expect(
      svc().download({
        archiveId: fx.archiveId,
        saveDir: fx.saveDir,
        finalName: plan.finalName,
        source: sourceOf(fx, false),
        transfer: createTransfer(fx.remote)
      })
    ).rejects.toMatchObject({ code: ErrorCode.E_ARCHIVE_MISSING })
    expect(fx.repo.archives.get(fx.archiveId)!.status).toBe('missing')
  })

  it('最终目录已被占用 → 明确拒绝，不覆盖已有内容', async () => {
    const plan = await svc().plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    mkdirSync(plan.finalPath, { recursive: true })
    writeFileSync(join(plan.finalPath, 'keep.txt'), 'do-not-touch')

    await expect(
      svc().download({
        archiveId: fx.archiveId,
        saveDir: fx.saveDir,
        finalName: plan.finalName,
        source: sourceOf(fx),
        transfer: createTransfer(fx.remote)
      })
    ).rejects.toMatchObject({ code: ErrorCode.E_LOCAL_PATH_EXISTS })

    // 已有内容必须原样还在
    expect(readFileSync(join(plan.finalPath, 'keep.txt'), 'utf8')).toBe('do-not-touch')
    expect(existsSync(plan.stagingPath)).toBe(false)
  })

  it('落盘后的文件集合与清单对不上（多出一个文件）→ 复核阶段拦下', async () => {
    const plan = await svc().plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    // 用一个"会多写一个文件"的替身：测的是服务自己的**集合复核**那一步，
    // 而不是传输层的哈希校验（那条已由 MT-05 的用例覆盖）
    const extraWriting: Pick<ReturnType<typeof createTransfer>, 'download'> = {
      async download(files) {
        for (const f of files) {
          mkdirSync(dirname(f.localPath), { recursive: true })
          writeFileSync(f.localPath, 'x')
        }
        writeFileSync(join(dirname(files[0]!.localPath), 'stray.txt'), 'not-in-manifest')
        return { bytes: files.length, files: files.length, retries: 0, elapsedMs: 1 }
      }
    }

    await expect(
      svc().download({
        archiveId: fx.archiveId,
        saveDir: fx.saveDir,
        finalName: plan.finalName,
        source: sourceOf(fx),
        transfer: extraWriting as ReturnType<typeof createTransfer>
      })
    ).rejects.toMatchObject({ code: ErrorCode.E_VERIFY_MISMATCH })
    expect(existsSync(plan.finalPath)).toBe(false)
  })

  it('上报的进度百分比单调不减，且覆盖四个阶段', async () => {
    const plan = await svc().plan({ archiveId: fx.archiveId, saveDir: fx.saveDir })
    const seen: Array<{ percent: number; stage: string }> = []
    await svc().download({
      archiveId: fx.archiveId,
      saveDir: fx.saveDir,
      finalName: plan.finalName,
      source: sourceOf(fx),
      transfer: createTransfer(fx.remote),
      onProgress: (p) => seen.push({ percent: p.percent, stage: p.stage })
    })

    expect(seen.length).toBeGreaterThan(0)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.percent).toBeGreaterThanOrEqual(seen[i - 1]!.percent)
    }
    const stages = new Set(seen.map((s) => s.stage))
    expect(stages.has('读取版本清单')).toBe(true)
    expect(stages.has('下载文件')).toBe(true)
    // 这一条真的走完整下载流程（真文件系统 + 多文件落盘），Windows 上本身就要 4 秒上下；
    // 开 v8 覆盖率插桩后会更慢，默认的 5 秒不够（B16 跑覆盖率时实测超时）。
    // 显式放宽到 30 秒：它验的是"进度单调不减"，与耗时无关，不该因为慢而红。
  }, 30_000)
})

/** 目录内容（不存在时返回空数组）。只看一层：这里断言的是"一个字节都没写"。 */
function readdirSafe(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
}
