/**
 * T09.1 / T09.3 单测：manifest 的 schema、解析宽容度、流式序列化。
 *
 * 这些用例守护的是"归档目录是真相来源"这条性质：只要 manifest 的读写
 * 出现任何一处不对称（少字段、多字段、转义错、截断），往期版本库就再也无法自证。
 */
import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  archiveManifestSchema,
  type ArchiveManifest
} from '@shared/contracts/archive'
import {
  MANIFEST_CHUNK_BYTES,
  buildManifestHeader,
  checkManifestConsistency,
  manifestChunks,
  manifestToItems,
  parseManifestText,
  serializeManifest
} from '@main/infra/manifest-io'

const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const H3 = '0'.repeat(64)

const HEADER_INPUT = {
  targetName: '订单服务',
  originalPath: '/opt/svc/order.jar',
  kind: 'file' as const,
  versionTag: '20250612-143015_a1b2c3d',
  archivedAt: '2025-06-12T14:30:15+08:00',
  rootHash: H1,
  totalBytes: 5,
  fileCount: 1
}

function header(over: Partial<typeof HEADER_INPUT> = {}) {
  return buildManifestHeader({ ...HEADER_INPUT, ...over })
}

const FILES = [{ relPath: 'order.jar', hash: H2, size: 5, mtime: '2025-06-12T14:29:58+08:00' }]

describe('manifest schema（T09.1）', () => {
  it('合法样例可以通过校验', () => {
    const manifest = { ...header(), files: FILES }
    const r = archiveManifestSchema.safeParse(manifest)
    expect(r.success, JSON.stringify(r.success ? '' : r.error.issues)).toBe(true)
  })

  it('非法样例被拒：缺字段 / 哈希格式错 / kind 非法 / 版本号非法 / files 不是数组', () => {
    const cases: Array<[string, unknown]> = [
      ['缺少 rootHash', { ...header(), files: FILES, rootHash: undefined }],
      ['哈希不是 64 位十六进制', { ...header(), files: [{ ...FILES[0], hash: 'abc' }] }],
      ['kind 非法', { ...header(), kind: 'zip', files: FILES }],
      ['versionTag 非法', { ...header(), versionTag: '2025-06-12_abc', files: FILES }],
      ['files 不是数组', { ...header(), files: 'nope' }],
      ['schemaVersion 为 0', { ...header(), schemaVersion: 0, files: FILES }]
    ]
    for (const [label, value] of cases) {
      expect(archiveManifestSchema.safeParse(value).success, label).toBe(false)
    }
  })

  it('容忍未知字段（保留而不是抹掉）', () => {
    const raw = { ...header(), files: FILES, futureField: { a: 1 }, anotherOne: 2 }
    const r = archiveManifestSchema.safeParse(raw)
    expect(r.success).toBe(true)
    // passthrough 的意义：将来对账修复时读一遍再写回，不会把新字段弄丢
    expect((r.success ? r.data : {}) as unknown as Record<string, unknown>).toMatchObject({
      futureField: { a: 1 },
      anotherOne: 2
    })
  })

  it('更高的 schemaVersion 只告警、不失败（跨版本升级不能读不了归档）', () => {
    const raw = { ...header(), schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION + 4, files: FILES }
    const parsed = parseManifestText(JSON.stringify(raw))
    expect(parsed.manifest.schemaVersion).toBe(ARCHIVE_MANIFEST_SCHEMA_VERSION + 4)
    expect(parsed.warnings.join()).toMatch(/更新版本的应用写入/)
  })

  it('未知字段会在 warnings 里点名（让用户知道有东西被忽略了）', () => {
    const raw = { ...header(), files: FILES, strangeKey: true }
    const parsed = parseManifestText(JSON.stringify(raw))
    expect(parsed.warnings.join()).toMatch(/strangeKey/)
  })
})

describe('manifest 解析（T09.1）', () => {
  it('空内容 / 坏 JSON / 形状不符 一律抛 E_ARCHIVE_CORRUPT', () => {
    const inputs = ['', '   ', '{ not json', JSON.stringify({ schemaVersion: 1 })]
    for (const text of inputs) {
      try {
        parseManifestText(text)
        throw new Error(`本应失败：${JSON.stringify(text)}`)
      } catch (err) {
        expect((err as { code?: string }).code, JSON.stringify(text)).toBe('E_ARCHIVE_CORRUPT')
      }
    }
  })

  it('带 BOM 的 manifest 也能解析（远端编辑器常见）', () => {
    const text = `\uFEFF${JSON.stringify({ ...header(), files: FILES })}`
    expect(parseManifestText(text).manifest.versionTag).toBe(HEADER_INPUT.versionTag)
  })

  it('汇总字段与明细对不上会被点名（这类错误最容易在截断中悄悄发生）', () => {
    const raw: ArchiveManifest = { ...header({ totalBytes: 999, fileCount: 7 }), files: FILES }
    const issues = checkManifestConsistency(raw)
    expect(issues.join()).toMatch(/fileCount=7/)
    expect(issues.join()).toMatch(/totalBytes=999/)
    // 也应当出现在解析告警里，让校验流程能把这份归档判成可疑
    expect(parseManifestText(JSON.stringify(raw)).warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('relPath 重复会被点名', () => {
    const raw = { ...header({ fileCount: 2, totalBytes: 10 }), files: [FILES[0], FILES[0]] }
    expect(checkManifestConsistency(raw as ArchiveManifest).join()).toMatch(/relPath 重复/)
  })

  it('manifestToItems 直接给出 B07 的 ReleaseItem（校验复用同一套比对）', () => {
    const items = manifestToItems({ ...header(), files: FILES } as ArchiveManifest)
    expect(items).toEqual([
      { relPath: 'order.jar', hash: H2, size: 5, mtime: '2025-06-12T14:29:58+08:00' }
    ])
  })
})

describe('manifest 序列化（T09.3）', () => {
  it('往返一致，且中文/特殊字符路径不被破坏', () => {
    const files = [
      { relPath: 'dist/中文 名称.js', hash: H1, size: 1, mtime: null },
      { relPath: 'dist/quote"and\\back.js', hash: H2, size: 2, mtime: '2025-01-01T00:00:00+08:00' },
      { relPath: 'dist/line\nbreak.js', hash: H3, size: 3, mtime: null }
    ]
    const text = serializeManifest(header({ fileCount: 3, totalBytes: 6 }), files)
    const parsed = parseManifestText(text)
    expect(parsed.manifest.files).toEqual(files)
    expect(parsed.manifest.operator).toBeNull()
    expect(parsed.manifest.sourceReleaseId).toBeNull()
    // 手写序列化必须产出合法 JSON 对象（而不是靠"看起来像"）
    expect(JSON.parse(text)).toMatchObject({ versionTag: HEADER_INPUT.versionTag })
  })

  it('字段顺序稳定：同样输入产出完全相同的字节', () => {
    const a = serializeManifest(header(), FILES)
    const b = serializeManifest(header(), FILES)
    expect(a).toBe(b)
    expect(a.indexOf('"schemaVersion"')).toBeLessThan(a.indexOf('"targetName"'))
    expect(a.indexOf('"sourceReleaseId"')).toBeLessThan(a.indexOf('"files"'))
  })

  it('大 files 数组被切成多块，且没有单块超过阈值太多', () => {
    const files = Array.from({ length: 4000 }, (_, i) => ({
      relPath: `dist/chunk-${String(i).padStart(6, '0')}.js`,
      hash: H1,
      size: i,
      mtime: null
    }))
    const chunks = [...manifestChunks(header({ fileCount: files.length, totalBytes: 0 }), files)]
    expect(chunks.length).toBeGreaterThan(1)
    // 逐块检查：每块大小都应落在阈值附近（最多超出一行的长度）
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MANIFEST_CHUNK_BYTES + 400)
    // 拼接后仍是完整可解析的 JSON —— 分块绝不能影响正确性
    const parsed = parseManifestText(chunks.join(''))
    expect(parsed.manifest.files.length).toBe(files.length)
    expect(parsed.manifest.files[3999]?.relPath).toBe('dist/chunk-003999.js')
  })

  it('空目录（无文件）也是合法 manifest', () => {
    const text = serializeManifest(header({ fileCount: 0, totalBytes: 0 }), [])
    const parsed = parseManifestText(text)
    expect(parsed.manifest.files).toEqual([])
    expect(parsed.warnings).toEqual([])
  })

  it('files 是惰性消费的：不在序列化前把整个数组展开成字符串', () => {
    // 用一个"记账"的迭代器：只有被真正消费的条数才会增加
    let consumed = 0
    function* gen(): Generator<{ relPath: string; hash: string; size: number; mtime: null }> {
      for (let i = 0; i < 100000; i++) {
        consumed++
        yield { relPath: `f${i}`, hash: H1, size: 0, mtime: null }
      }
    }
    const it = manifestChunks(header({ fileCount: 100000 }), gen())
    it.next() // 只取第一块
    expect(consumed).toBeLessThan(100000)
  })
})
