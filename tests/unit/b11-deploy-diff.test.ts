/**
 * B11 / T11.3 差异摘要的单测。
 *
 * 覆盖重点是"视角转换对不对"：`diffByHashes` 的三个桶（missing / extra / mismatch）
 * 到"删除 / 新增 / 修改"的映射一旦搞反，用户在确认弹窗上看到的
 * 就是**完全相反**的结论（"这次会删掉 40 个文件" vs "这次会新增 40 个文件"），
 * 而这类错误在界面上看起来完全正常。
 */
import { describe, expect, it } from 'vitest'
import { computePublishDiff, describePublishDiff, isNoopDiff } from '@main/infra/deploy-diff'
import type { ReleaseItem } from '@shared/contracts/hash'

function item(relPath: string, hash = 'h-' + relPath, size = relPath.length): ReleaseItem {
  return { relPath, hash, size, mtime: null }
}

describe('computePublishDiff', () => {
  it('首次发布：全部算新增，且明确标记 firstPublish', () => {
    const d = computePublishDiff({ previous: null, current: [item('a'), item('b')] })
    expect(d.firstPublish).toBe(true)
    expect(d.counts).toEqual({ added: 2, modified: 0, deleted: 0, unchanged: 0 })
    expect(d.added).toEqual(['a', 'b'])
    expect(d.previousVersionTag).toBeNull()
  })

  it('三类差异的映射：本地多出→新增、哈希不同→修改、上版有本地没有→删除', () => {
    const previous = [item('keep', 'h1'), item('changed', 'h-old'), item('gone', 'h3')]
    const current = [item('keep', 'h1'), item('changed', 'h-new'), item('brand-new', 'h4')]

    const d = computePublishDiff({ previous, current, previousVersionTag: '20260930-120000_abcdef0' })

    expect(d.counts).toEqual({ added: 1, modified: 1, deleted: 1, unchanged: 1 })
    expect(d.added).toEqual(['brand-new'])
    expect(d.modified).toEqual(['changed'])
    expect(d.deleted).toEqual(['gone'])
    expect(d.unchangedCount).toBe(1)
    expect(d.firstPublish).toBe(false)
    expect(d.previousVersionTag).toBe('20260930-120000_abcdef0')
  })

  it('内容完全没变 → 三个计数都是 0（UI 据此提示"与上次发布一致"）', () => {
    const previous = [item('a', 'h1'), item('b', 'h2')]
    const current = [item('a', 'h1'), item('b', 'h2')]
    const d = computePublishDiff({ previous, current })
    expect(d.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 2 })
    expect(isNoopDiff(d)).toBe(true)
  })

  it('大小变了但内容哈希没变 → 不算修改（判据只有哈希，与远端校验同一套）', () => {
    const d = computePublishDiff({
      previous: [{ relPath: 'a', hash: 'h1', size: 1, mtime: null }],
      current: [{ relPath: 'a', hash: 'h1', size: 999, mtime: null }]
    })
    expect(d.counts.modified).toBe(0)
    expect(d.counts.unchanged).toBe(1)
  })

  it('超过上限时：列表截断，但计数永远准确', () => {
    const current = Array.from({ length: 10 }, (_, i) => item(`f${i}`))
    const d = computePublishDiff({ previous: null, current, limit: 3 })

    expect(d.added).toHaveLength(3)
    expect(d.counts.added, '计数不能被截断影响 —— 否则用户会以为只发 3 个文件').toBe(10)
    expect(d.truncated).toBe(true)
  })

  it('发布一定会删掉的文件排在 deleted 里（这是最需要用户注意的一类）', () => {
    const previous = [item('assets/old-chunk.js', 'h1')]
    const current: ReleaseItem[] = []
    const d = computePublishDiff({ previous, current })
    expect(d.deleted).toEqual(['assets/old-chunk.js'])
    expect(d.counts.deleted).toBe(1)
  })
})

describe('describePublishDiff', () => {
  it('首次发布 / 无变化 / 有变化三种文案', () => {
    expect(
      describePublishDiff(computePublishDiff({ previous: null, current: [item('a')] }))
    ).toContain('首次发布')

    expect(
      describePublishDiff(
        computePublishDiff({ previous: [item('a')], current: [item('a')] })
      )
    ).toContain('完全一致')

    const text = describePublishDiff(
      computePublishDiff({ previous: [item('a'), item('b')], current: [item('b'), item('c')] })
    )
    expect(text).toContain('新增 1 个')
    expect(text).toContain('删除 1 个')
    expect(text).toContain('未变 1 个')
  })
})
