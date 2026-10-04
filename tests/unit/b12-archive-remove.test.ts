/**
 * B12 / T12.5 ~ T12.7 单测：批量删除、台账汇总、版本明细。
 *
 * 删除这块的核心不是"能不能删掉"，而是**删不掉的时候说了什么**：
 * 哪几个没删成、为什么、台账里那行还在不在。所以这里重点覆盖
 * "部分失败""id 不存在""远端 rmrf 抛错"三条路径 —— 它们在生产里
 * 都比"全部成功"更常见（服务器上被人手工动过目录是常态）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createArchiveService, type ArchiveFsPort } from '@main/services/archive'
import { AppError, ErrorCode } from '@main/infra/errors'
import { computeRootHash } from '@main/infra/hash-core'
import { MANIFEST_FILE_NAME } from '@main/infra/manifest-io'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

const dbs: TestDb[] = []
function makeDb(): TestDb {
  const t = makeTestDb()
  dbs.push(t)
  return t
}
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.cleanup()
})

interface Row {
  id: string
  versionTag: string
  storagePath: string
  payloadPath: string
  rootHash: string
  totalBytes: number
}

/** 造一条归档台账（内容无关紧要，删除/明细用例只关心路径与记录本身）。 */
function seedArchive(
  t: TestDb,
  targetId: string,
  tag: string,
  over: { bytes?: number; status?: string; archivedAt?: string } = {}
): Row {
  const rootHash = computeRootHash([{ relPath: 'a.txt', hash: 'a'.repeat(64) }])
  const row = t.repo.archives.create({
    targetId,
    versionTag: tag,
    storagePath: `/opt/app/archives/dist-${tag}`,
    payloadPath: `/opt/app/archives/dist-${tag}/payload`,
    kind: 'dir',
    rootHash,
    totalBytes: over.bytes ?? 100,
    fileCount: 1,
    releaseId: null,
    note: null,
    status: over.status ?? 'valid'
  })
  if (over.archivedAt) t.repo.archives.update(row.id, { archivedAt: over.archivedAt })
  return {
    id: row.id,
    versionTag: row.versionTag,
    storagePath: row.storagePath,
    payloadPath: row.payloadPath,
    rootHash,
    totalBytes: row.totalBytes
  }
}

/** 只有 rmrf 会被删除用到的"远端"。 */
function rmrfPort(
  impl: (path: string) => Promise<void>
): ArchiveFsPort {
  return { rmrf: impl } as unknown as ArchiveFsPort
}

/* =============================================================== 删除 */

describe('B12 批量删除往期版本（T12.5）', () => {
  it('全部成功：逐条返回、释放字节数正确、台账行被摘掉', async () => {
    const t = makeDb()
    const { target } = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/app/dist' })
    const a = seedArchive(t, target.id, '20260901-120000_aaaaaaa', { bytes: 10 })
    const b = seedArchive(t, target.id, '20260902-120000_bbbbbbb', { bytes: 20 })

    const gone: string[] = []
    const svc = createArchiveService({ repo: t.repo })
    const r = await svc.removeVersions({
      archiveIds: [a.id, b.id],
      fs: rmrfPort(async (p) => {
        gone.push(p)
      })
    })

    expect(r.removed.map((x) => x.versionTag).sort()).toEqual([a.versionTag, b.versionTag].sort())
    expect(r.failed).toEqual([])
    expect(r.freedBytes).toBe(30)
    // 删的是归档目录本身，不是 payload
    expect(gone.sort()).toEqual([a.storagePath, b.storagePath].sort())
    expect(t.repo.archives.get(a.id)).toBeUndefined()
    expect(t.repo.archives.get(b.id)).toBeUndefined()
  })

  it('部分失败：成功的删掉、失败的**保留台账行**并给出原因', async () => {
    const t = makeDb()
    const { target } = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/app/dist' })
    const ok = seedArchive(t, target.id, '20260901-120000_aaaaaaa', { bytes: 10 })
    const bad = seedArchive(t, target.id, '20260902-120000_bbbbbbb', { bytes: 20 })

    const svc = createArchiveService({ repo: t.repo })
    const r = await svc.removeVersions({
      archiveIds: [ok.id, bad.id],
      fs: rmrfPort(async (p) => {
        if (p === bad.storagePath) throw new Error('Permission denied')
        // 另一个正常删除
      })
    })

    expect(r.removed.map((x) => x.id)).toEqual([ok.id])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]).toMatchObject({ id: bad.id, versionTag: bad.versionTag })
    expect(r.failed[0]!.reason).toContain('Permission denied')
    expect(r.freedBytes).toBe(10)

    // 关键：服务器上还在的东西，台账里不能假装没了
    expect(t.repo.archives.get(bad.id)).toBeDefined()
    expect(t.repo.archives.get(ok.id)).toBeUndefined()
  })

  it('台账里不存在的 id 算失败，而不是静默跳过', async () => {
    const t = makeDb()
    const { target } = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/app/dist' })
    const a = seedArchive(t, target.id, '20260901-120000_aaaaaaa')

    const svc = createArchiveService({ repo: t.repo })
    const r = await svc.removeVersions({
      archiveIds: [a.id, 'not-exist-id'],
      fs: rmrfPort(async () => undefined)
    })

    expect(r.removed.map((x) => x.id)).toEqual([a.id])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]).toMatchObject({ id: 'not-exist-id', versionTag: '(未知)' })
  })

  it('重复 id 只删一次（否则第二次会报"台账里没有"这种假失败）', async () => {
    const t = makeDb()
    const { target } = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/app/dist' })
    const a = seedArchive(t, target.id, '20260901-120000_aaaaaaa')

    let calls = 0
    const svc = createArchiveService({ repo: t.repo })
    const r = await svc.removeVersions({
      archiveIds: [a.id, a.id, a.id],
      fs: rmrfPort(async () => {
        calls++
      })
    })

    expect(calls).toBe(1)
    expect(r.removed).toHaveLength(1)
    expect(r.failed).toEqual([])
  })
})

/* =============================================================== 汇总 */

describe('B12 台账占用汇总（T12.6）', () => {
  it('条数 / 总字节 / 状态分布 / 时间跨度都来自台账，且不连服务器', () => {
    const t = makeDb()
    const { target } = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/app/dist' })
    seedArchive(t, target.id, '20260901-120000_aaaaaaa', { bytes: 100, archivedAt: '2026-09-01T10:00:00.000Z' })
    seedArchive(t, target.id, '20260902-120000_bbbbbbb', {
      bytes: 200,
      status: 'missing',
      archivedAt: '2026-09-02T10:00:00.000Z'
    })
    seedArchive(t, target.id, '20260903-120000_ccccccc', {
      bytes: 300,
      status: 'corrupt',
      archivedAt: '2026-09-03T10:00:00.000Z'
    })

    const svc = createArchiveService({ repo: t.repo })
    const s = svc.summary(target.id)

    expect(s.count).toBe(3)
    expect(s.totalBytes).toBe(600)
    expect(s.byStatus).toEqual({ valid: 1, missing: 1, corrupt: 1 })
    expect(s.oldestAt).toBe('2026-09-01T10:00:00.000Z')
    expect(s.newestAt).toBe('2026-09-03T10:00:00.000Z')
  })

  it('没有版本时给零值而不是 undefined（UI 不必再判空）', () => {
    const t = makeDb()
    const { target } = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/app/dist' })
    const svc = createArchiveService({ repo: t.repo })
    const s = svc.summary(target.id)
    expect(s).toEqual({
      count: 0,
      totalBytes: 0,
      byStatus: { valid: 0, missing: 0, corrupt: 0 },
      oldestAt: null,
      newestAt: null
    })
  })

  it('别的目标的版本不计入（聚合必须按 targetId 过滤）', () => {
    const t = makeDb()
    const a = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/app/dist' })
    const b = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/other/dist' })
    seedArchive(t, a.target.id, '20260901-120000_aaaaaaa', { bytes: 100 })
    seedArchive(t, b.target.id, '20260901-120000_bbbbbbb', { bytes: 999 })

    const svc = createArchiveService({ repo: t.repo })
    expect(svc.summary(a.target.id).totalBytes).toBe(100)
    expect(svc.summary(a.target.id).count).toBe(1)
  })
})

/* =============================================================== 明细 */

describe('B12 版本明细（T12.7）', () => {
  function fixture(fileCount: number): {
    t: TestDb
    row: Row
    fs: ArchiveFsPort
  } {
    const t = makeDb()
    const { target } = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/app/dist' })
    const row = seedArchive(t, target.id, '20260901-120000_aaaaaaa')
    const files = Array.from({ length: fileCount }, (_, i) => ({
      relPath: `dist/f${String(i).padStart(3, '0')}.js`,
      hash: 'a'.repeat(64),
      size: 10 + i,
      mtime: '2026-09-01T12:00:00+08:00'
    }))
    const text = JSON.stringify({
      schemaVersion: 1,
      targetName: '前端产物',
      originalPath: '/opt/app/dist',
      kind: 'dir',
      versionTag: row.versionTag,
      archivedAt: '2026-09-01T12:00:00+08:00',
      hashAlgo: 'sha256',
      rootHash: row.rootHash,
      totalBytes: files.reduce((a, f) => a + f.size, 0),
      fileCount: files.length,
      operator: 'zhouyu',
      note: '手工归档',
      sourceReleaseId: null,
      futureField: 'v2 才认识的字段',
      files
    })
    const fs = {
      readTextFile: async (p: string) => {
        if (!p.endsWith(MANIFEST_FILE_NAME)) throw new AppError(ErrorCode.E_ARCHIVE_MISSING, { p })
        return text
      }
    } as unknown as ArchiveFsPort
    return { t, row, fs }
  }

  it('分页：offset/limit 生效，total 是清单里的真实条数', async () => {
    const { t, row, fs } = fixture(5)
    const svc = createArchiveService({ repo: t.repo })

    const page1 = await svc.readDetail({
      archiveId: row.id,
      offset: 0,
      limit: 2,
      ports: { fs, hash: {} as never }
    })
    expect(page1.total).toBe(5)
    expect(page1.files.map((f) => f.relPath)).toEqual(['dist/f000.js', 'dist/f001.js'])

    const page3 = await svc.readDetail({
      archiveId: row.id,
      offset: 4,
      limit: 2,
      ports: { fs, hash: {} as never }
    })
    // 最后一页只给剩下的那一条（不是补空、也不是重复）
    expect(page3.files.map((f) => f.relPath)).toEqual(['dist/f004.js'])
  })

  it('摘要字段齐全，且把"不认识的字段"作为 unknownKeys 报出来', async () => {
    const { t, row, fs } = fixture(3)
    const svc = createArchiveService({ repo: t.repo })
    const d = await svc.readDetail({ archiveId: row.id, ports: { fs, hash: {} as never } })

    expect(d.manifest).toMatchObject({
      targetName: '前端产物',
      originalPath: '/opt/app/dist',
      kind: 'dir',
      fileCount: 3,
      operator: 'zhouyu',
      note: '手工归档',
      hashAlgo: 'sha256'
    })
    expect(d.unknownKeys).toEqual(['futureField'])
  })

  it('清单自相矛盾（fileCount 与明细对不上）→ 照读，但把矛盾写进 warnings', async () => {
    const { t, row } = fixture(2)
    const bad = JSON.stringify({
      schemaVersion: 1,
      targetName: 'x',
      originalPath: '/opt/app/dist',
      kind: 'dir',
      versionTag: row.versionTag,
      archivedAt: '2026-09-01T12:00:00+08:00',
      hashAlgo: 'sha256',
      rootHash: row.rootHash,
      totalBytes: 0,
      fileCount: 9,
      files: []
    })
    const fs = { readTextFile: async () => bad } as unknown as ArchiveFsPort
    const svc = createArchiveService({ repo: t.repo })

    // 明细是**只读展示**：这份归档已经可疑，但"把它到底写了什么摊开给用户看"
    // 才是此刻最有用的事。要不要判死是「校验」的职责（它会标 corrupt）。
    const d = await svc.readDetail({ archiveId: row.id, ports: { fs, hash: {} as never } })
    expect(d.warnings.join('；')).toContain('fileCount=9')
    expect(d.total).toBe(0)
  })

  it('读明细不改台账状态（只读操作不该有副作用）', async () => {
    const { t, row } = fixture(1)
    const fs = {
      readTextFile: async () => {
        throw new AppError(ErrorCode.E_ARCHIVE_MISSING, {})
      }
    } as unknown as ArchiveFsPort
    const svc = createArchiveService({ repo: t.repo })

    await expect(
      svc.readDetail({ archiveId: row.id, ports: { fs, hash: {} as never } })
    ).rejects.toBeInstanceOf(AppError)
    // 仍然是 valid：要改状态得走「校验」
    expect(t.repo.archives.get(row.id)!.status).toBe('valid')
  })
})
