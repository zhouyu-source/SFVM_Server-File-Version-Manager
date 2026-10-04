/**
 * B11 / T11.2 本地产物探测的单测：纯逻辑 + 真实文件系统。
 *
 * 为什么这里用**真实临时目录**而不是替身：这一段代码的全部价值就在于
 * "目录遍历 + mtime 取值"这类与文件系统打交道的细节（B07/B09 的教训：
 * 手写替身越像真实 API，越容易把真实语义差异盖住）。临时目录建一个
 * 十几字节的文件很快，没必要替身。
 */
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARTIFACT_STALE_MS,
  describeAge,
  describeKindMismatch,
  isArtifactStale,
  newestMtimeOf
} from '@main/infra/local-artifact'
import { statLocalArtifact } from '@main/services/local-artifact'

const tempDirs: string[] = []

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 造一个目录产物；`mtimes` 可指定每个文件的 mtime（用于制造"过期"）。 */
function makeDir(files: Record<string, string>, mtimes?: Record<string, Date>): string {
  const root = mkdtempSync(join(tmpdir(), 'sfvm-b11-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
    const t = mtimes?.[rel]
    if (t) utimesSync(p, t, t)
  }
  return root
}

function makeFile(name: string, content: string, mtime?: Date): string {
  const root = mkdtempSync(join(tmpdir(), 'sfvm-b11f-'))
  tempDirs.push(root)
  const p = join(root, name)
  writeFileSync(p, content)
  if (mtime) utimesSync(p, mtime, mtime)
  return p
}

const HOUR = 60 * 60 * 1000

/* ------------------------------------------------ 纯逻辑：过期判定 */

describe('isArtifactStale（T11.2 的 24 小时规则）', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z')

  it('刚好 24 小时**不算**过期（边界取"严格大于"）', () => {
    expect(isArtifactStale(now - ARTIFACT_STALE_MS, now)).toBe(false)
    expect(isArtifactStale(now - ARTIFACT_STALE_MS - 1, now)).toBe(true)
  })

  it('刚刚构建过的不算过期', () => {
    expect(isArtifactStale(now - 1000, now)).toBe(false)
  })

  it('时间戳非法（null / undefined / NaN）→ 不说过期', () => {
    // 拿不到 mtime 就说"过期"会让用户去查一个根本不存在的文件
    expect(isArtifactStale(null, now)).toBe(false)
    expect(isArtifactStale(undefined, now)).toBe(false)
    expect(isArtifactStale(Number.NaN, now)).toBe(false)
    expect(isArtifactStale(Number.POSITIVE_INFINITY, now)).toBe(false)
  })

  it('mtime 在未来（时钟回拨）→ 不说过期', () => {
    expect(isArtifactStale(now + 10 * HOUR, now)).toBe(false)
  })
})

describe('describeAge', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z')
  it('按量级给人类可读文案', () => {
    expect(describeAge(now - 30 * 1000, now)).toBe('刚刚')
    expect(describeAge(now - 5 * 60 * 1000, now)).toBe('5 分钟前')
    expect(describeAge(now - 3 * HOUR, now)).toBe('3 小时前')
    expect(describeAge(now - 3 * 24 * HOUR, now)).toBe('3 天前')
    expect(describeAge(now - 70 * 24 * HOUR, now)).toBe('2 个月前')
    expect(describeAge(now - 800 * 24 * HOUR, now)).toBe('2 年前')
  })
  it('时间戳不可用 → null（UI 显示"—"而不是"NaN 天前"）', () => {
    expect(describeAge(null, now)).toBeNull()
    expect(describeAge(Number.NaN, now)).toBeNull()
  })
  it('未来时间单独给文案（不冒充"刚刚"）', () => {
    expect(describeAge(now + HOUR, now)).toBe('时间在未来')
  })
})

describe('newestMtimeOf', () => {
  it('取较新者并忽略非法值', () => {
    expect(newestMtimeOf([100, 300, 200])).toBe(300)
    expect(newestMtimeOf([null, 300, Number.NaN, undefined])).toBe(300)
    expect(newestMtimeOf([null, Number.NaN])).toBeNull()
    expect(newestMtimeOf([])).toBeNull()
  })
})

describe('describeKindMismatch', () => {
  it('类型一致或不知道类型时不给提示', () => {
    expect(describeKindMismatch({ targetKind: 'dir', localKind: 'dir' })).toBeNull()
    expect(describeKindMismatch({ targetKind: 'dir', localKind: null })).toBeNull()
  })
  it('不一致时直说两边是什么', () => {
    expect(describeKindMismatch({ targetKind: 'dir', localKind: 'file' })).toContain('目录')
    expect(describeKindMismatch({ targetKind: 'file', localKind: 'dir' })).toContain('文件')
  })
})

/* ------------------------------------------- IO：statLocalArtifact */

describe('statLocalArtifact（T11.1 / T11.2 的探测）', () => {
  const now = new Date('2026-10-01T12:00:00.000Z')

  it('未配置本地路径 → 不是错误，只是 exists:false', async () => {
    const info = await statLocalArtifact({ localPath: null, targetKind: 'dir', now })
    expect(info).toMatchObject({ path: null, exists: false, kind: null, fileCount: null })
  })

  it('路径不存在 → exists:false（用户还没构建，不该报错）', async () => {
    const info = await statLocalArtifact({
      localPath: join(tmpdir(), 'sfvm-不存在-的目录-xyz'),
      targetKind: 'dir',
      now
    })
    expect(info.exists).toBe(false)
    expect(info.kindMismatch).toBeNull()
  })

  it('目录型：给出文件数、体积与"最近一次变动"（取最新文件 mtime）', async () => {
    const old = new Date(now.getTime() - 3 * HOUR)
    const root = makeDir({ 'index.html': 'a'.repeat(10), 'assets/app.js': 'bb' }, {
      'assets/app.js': old
    })

    const info = await statLocalArtifact({ localPath: root, targetKind: 'dir', now })
    expect(info.exists).toBe(true)
    expect(info.kind).toBe('dir')
    expect(info.fileCount).toBe(2)
    expect(info.totalBytes).toBe(12)
    expect(info.possiblyStale).toBe(false) // 刚写的 index.html 把它拉回"新鲜"
  })

  it('目录型：整个产物都是 5 天前的 → possiblyStale=true，且给出"几天前"', async () => {
    const old = new Date(now.getTime() - 5 * 24 * HOUR)
    const root = makeDir({ 'index.html': 'x'.repeat(10) }, { 'index.html': old })
    // 目录自身的 mtime 也要回拨：真实的"5 天前构建"就是当时创建了目录与文件。
    // （只回拨文件、让目录保持"刚刚"，等价于"5 天前的产物今天刚被碰过" —— 那样不算过期才对。）
    utimesSync(root, old, old)

    const info = await statLocalArtifact({ localPath: root, targetKind: 'dir', now })
    expect(info.possiblyStale).toBe(true)
    expect(info.ageText).toBe('5 天前')
  })

  it('目录型：`local_exclude` 命中时不计入（与发布会用的文件集合保持一致）', async () => {
    const root = makeDir({ 'index.html': 'x', 'app.js.map': 'y'.repeat(100) })

    const info = await statLocalArtifact({
      localPath: root,
      targetKind: 'dir',
      exclude: ['*.map'],
      now
    })
    expect(info.fileCount, '被排除的文件不该计入文件数').toBe(1)
    expect(info.totalBytes).toBe(1)
  })

  it('目录型目标配了文件路径 → 给出类型不符的说明', async () => {
    const f = makeFile('order.jar', 'jar')
    const info = await statLocalArtifact({ localPath: f, targetKind: 'dir', now })
    expect(info.kind).toBe('file')
    expect(info.kindMismatch).toContain('目标是目录型')
  })

  it('文件型：fileCount 恒为 1，体积取文件本身', async () => {
    const f = makeFile('order.jar', 'jar-content')
    const info = await statLocalArtifact({ localPath: f, targetKind: 'file', now })
    expect(info).toMatchObject({ kind: 'file', fileCount: 1, totalBytes: 'jar-content'.length })
    expect(info.kindMismatch).toBeNull()
  })

  it('文件数超过上限：如实说"数不出来"，而不是把徽标变成错误', async () => {
    const root = makeDir({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' })
    const info = await statLocalArtifact({ localPath: root, targetKind: 'dir', now, maxFiles: 2 })
    expect(info.exists).toBe(true)
    expect(info.fileCount).toBeNull()
    expect(info.kindMismatch).toContain('无法统计目录内容')
  })
})
