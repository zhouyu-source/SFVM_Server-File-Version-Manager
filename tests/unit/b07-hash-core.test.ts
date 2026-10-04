/**
 * B07 / T07.3 / T07.7 / T07.8 验收点：目录指纹聚合、清单文本、结果解析、差异比对。
 *
 * 这块的价值全在"两端必须算出同一个指纹"上，所以排序与拼接的每个选择
 * 都单独断言，而不是只测一次端到端结果。
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  EMPTY_ROOT_HASH,
  buildSha256SumFile,
  compareRelPathUtf8,
  computeRootHash,
  describeDiff,
  diffByCheckOutput,
  diffByHashes,
  escapeSha256SumPath,
  isSafeRelPath,
  joinRemote,
  normalizeRelPath,
  parseSha256SumOutput,
  sortByRelPathUtf8,
  sumBytes,
  unescapeSha256SumPath
} from '@main/infra/hash-core'
import type { ReleaseItem } from '@shared/contracts/hash'

const h = (seed: string): string => createHash('sha256').update(seed).digest('hex')

function item(relPath: string, seed: string, size = 10): ReleaseItem {
  return { relPath, hash: h(seed), size }
}

describe('computeRootHash（T07.3）', () => {
  it('空集合等于 sha256("")，是确定值而不是报错', () => {
    expect(computeRootHash([])).toBe(EMPTY_ROOT_HASH)
    expect(EMPTY_ROOT_HASH).toBe(createHash('sha256').update('').digest('hex'))
  })

  it('顺序不同的相同集合得到相同指纹（核心验收点）', () => {
    const a = [item('b.js', '2'), item('a.js', '1'), item('sub/c.js', '3')]
    const b = [item('sub/c.js', '3'), item('a.js', '1'), item('b.js', '2')]
    expect(computeRootHash(a)).toBe(computeRootHash(b))
  })

  it('内容变化会改变指纹', () => {
    const a = [item('a.js', '1')]
    const b = [item('a.js', '2')]
    expect(computeRootHash(a)).not.toBe(computeRootHash(b))
  })

  it('路径变化会改变指纹（即使内容相同）', () => {
    expect(computeRootHash([item('a.js', 'x')])).not.toBe(computeRootHash([item('b.js', 'x')]))
  })

  it('size / mtime 不参与指纹：换个文件系统不该导致指纹变化', () => {
    const a: ReleaseItem[] = [{ relPath: 'a.js', hash: h('x'), size: 1 }]
    const b: ReleaseItem[] = [
      { relPath: 'a.js', hash: h('x'), size: 999, mtime: '2020-01-01T00:00:00.000Z' }
    ]
    expect(computeRootHash(a)).toBe(computeRootHash(b))
  })

  it('拼接格式与方案书一致：relPath \\0 hash \\n', () => {
    const items = [item('a.js', '1'), item('b.js', '2')]
    const manual = createHash('sha256')
      .update('a.js\0' + h('1') + '\n' + 'b.js\0' + h('2') + '\n', 'utf8')
      .digest('hex')
    expect(computeRootHash(items)).toBe(manual)
  })

  it('分隔符能区分"路径拼接"的歧义', () => {
    // 若不用 \0 分隔，('ab','c') 与 ('a','bc') 会撞
    const a: ReleaseItem[] = [{ relPath: 'ab', hash: h('c'), size: 0 }]
    const b: ReleaseItem[] = [{ relPath: 'a', hash: h('bc'), size: 0 }]
    expect(computeRootHash(a)).not.toBe(computeRootHash(b))
  })
})

describe('UTF-8 字节序排序（T07.3）', () => {
  it('用 UTF-8 字节序而不是 JS 默认的 UTF-16 码元序', () => {
    // UTF-16: '！'(FF01) > '😀'(D83D DE00) → JS 默认把 😀 排前面
    // UTF-8 : '！'(EF BC 81) < '😀'(F0 9F 98 80) → 字节序把 ！ 排前面
    expect(compareRelPathUtf8('！', '😀')).toBeLessThan(0)
    expect('！' < '😀').toBe(false) // 证明两种排序确实不同
  })

  it('中文按 UTF-8 字节序排列（与码位序一致）', () => {
    // 丙 U+4E19 < 乙 U+4E59 < 甲 U+7532
    const items = [item('订单/甲.txt', '3'), item('订单/乙.txt', '1'), item('订单/丙.txt', '2')]
    const sorted = sortByRelPathUtf8(items).map((i) => i.relPath)
    expect(sorted).toEqual(['订单/丙.txt', '订单/乙.txt', '订单/甲.txt'])
  })

  it('不修改入参数组', () => {
    const items = [item('b', '1'), item('a', '2')]
    sortByRelPathUtf8(items)
    expect(items.map((i) => i.relPath)).toEqual(['b', 'a'])
  })

  it('sumBytes 求和', () => {
    expect(sumBytes([{ size: 1 }, { size: 2 }, { size: 3 }])).toBe(6)
    expect(sumBytes([])).toBe(0)
  })
})

describe('relPath 校验', () => {
  it('接受常规相对路径', () => {
    expect(isSafeRelPath('a.js')).toBe(true)
    expect(isSafeRelPath('dist/静态资源/x 空格.js')).toBe(true)
  })

  it('拒绝绝对路径、. / .. 段、换行与空字符', () => {
    expect(isSafeRelPath('/etc/passwd')).toBe(false)
    expect(isSafeRelPath('a/../b')).toBe(false)
    expect(isSafeRelPath('a/./b')).toBe(false)
    expect(isSafeRelPath('a//b')).toBe(false)
    expect(isSafeRelPath('a\nb')).toBe(false)
    expect(isSafeRelPath('a\rb')).toBe(false)
    expect(isSafeRelPath('a\0b')).toBe(false)
    expect(isSafeRelPath('')).toBe(false)
  })

  it('normalizeRelPath 统一分隔符并去掉前导斜杠', () => {
    expect(normalizeRelPath('a\\b\\c.js')).toBe('a/b/c.js')
    expect(normalizeRelPath('/a/b.js')).toBe('a/b.js')
    expect(normalizeRelPath('a/../b')).toBeNull()
    expect(normalizeRelPath('')).toBeNull()
  })

  it('joinRemote 只做去尾斜杠拼接', () => {
    expect(joinRemote('/opt/app/payload', 'a/b.js')).toBe('/opt/app/payload/a/b.js')
    expect(joinRemote('/opt/app/payload/', 'a.js')).toBe('/opt/app/payload/a.js')
  })
})

describe('sha256sum 清单文本（T07.7）', () => {
  it('生成 coreutils 可消费的两空格格式，并按 UTF-8 字节序排列', () => {
    const items = [item('b.js', '2', 1), item('a.js', '1', 1)]
    expect(buildSha256SumFile(items)).toBe(`${h('1')}  a.js\n${h('2')}  b.js\n`)
  })

  it('空清单生成空串（而不是一个换行）', () => {
    expect(buildSha256SumFile([])).toBe('')
  })

  it('含反斜杠或换行的文件名按 coreutils 规则转义', () => {
    expect(escapeSha256SumPath('a\\b.js')).toEqual({ text: 'a\\\\b.js', escaped: true })
    expect(escapeSha256SumPath('a\nb.js')).toEqual({ text: 'a\\nb.js', escaped: true })
    expect(escapeSha256SumPath('plain.js')).toEqual({ text: 'plain.js', escaped: false })

    const text = buildSha256SumFile([{ relPath: 'a\\b.js', hash: h('1') }])
    expect(text).toBe(`\\${h('1')}  a\\\\b.js\n`)
  })

  it('转义可往返', () => {
    for (const name of ['a\\b.js', 'a\nb.js', 'a\\\\b.js', '普通.js']) {
      const e = escapeSha256SumPath(name)
      expect(unescapeSha256SumPath(e.text, e.escaped)).toBe(name)
    }
  })
})

describe('parseSha256SumOutput（T07.7）', () => {
  it('解析 OK / FAILED / FAILED open or read 三种行', () => {
    const out = [
      'a.js: OK',
      'b.js: FAILED',
      'c.js: FAILED open or read',
      'sha256sum: WARNING: 2 computed checksums did NOT match',
      ''
    ].join('\n')
    expect(parseSha256SumOutput(out)).toEqual([
      { relPath: 'a.js', status: 'ok', raw: 'a.js: OK' },
      { relPath: 'b.js', status: 'failed', raw: 'b.js: FAILED' },
      { relPath: 'c.js', status: 'unreadable', raw: 'c.js: FAILED open or read' }
    ])
  })

  it('忽略诊断行与 stderr 泄漏进来的行', () => {
    const out = [
      'sha256sum: /opt/x: No such file or directory',
      'sha256sum: WARNING: 1 listed file could not be read',
      'a.js: OK'
    ].join('\n')
    expect(parseSha256SumOutput(out)).toHaveLength(1)
  })

  it('解析转义行（名字含反斜杠 / 换行 / 空格）', () => {
    // coreutils 的 `-c` 回显格式是 `<可能被转义的名字>: OK`，**不回显哈希**
    const out = ['\\a\\\\b.js: OK', '\\a\\nb.js: FAILED', '带 空格.js: OK'].join('\n')
    expect(parseSha256SumOutput(out)).toEqual([
      { relPath: 'a\\b.js', status: 'ok', raw: '\\a\\\\b.js: OK' },
      { relPath: 'a\nb.js', status: 'failed', raw: '\\a\\nb.js: FAILED' },
      { relPath: '带 空格.js', status: 'ok', raw: '带 空格.js: OK' }
    ])
  })

  it('名字里含 ": " 时取最后一个冒号分隔（贪婪匹配）', () => {
    const parsed = parseSha256SumOutput('weird: name.js: OK')
    expect(parsed).toEqual([{ relPath: 'weird: name.js', status: 'ok', raw: 'weird: name.js: OK' }])
  })

  it('空输出返回空数组（调用方据此判定"无法解析"）', () => {
    expect(parseSha256SumOutput('')).toEqual([])
  })
})

describe('差异比对（T07.8）', () => {
  const expected: ReleaseItem[] = [item('a.js', '1'), item('b.js', '2'), item('sub/c.js', '3')]

  it('全部一致 → ok，matchedCount 正确', () => {
    const actual = new Map([
      ['a.js', h('1')],
      ['b.js', h('2')],
      ['sub/c.js', h('3')]
    ])
    const diff = diffByHashes(expected, actual)
    expect(diff.ok).toBe(true)
    expect(diff.matchedCount).toBe(3)
    expect(diff.missing).toEqual([])
    expect(diff.extra).toEqual([])
    expect(diff.mismatch).toEqual([])
    expect(describeDiff(diff)).toContain('校验通过')
  })

  it('能同时判出三类差异', () => {
    const actual = new Map([
      ['a.js', h('1')], // ok
      ['b.js', h('CHANGED')], // mismatch
      ['orphan.js', h('x')] // extra
      // sub/c.js 缺失
    ])
    const diff = diffByHashes(expected, actual)
    expect(diff.ok).toBe(false)
    expect(diff.matchedCount).toBe(1)
    expect(diff.missing).toEqual(['sub/c.js'])
    expect(diff.extra).toEqual(['orphan.js'])
    expect(diff.mismatch).toEqual([{ relPath: 'b.js', expected: h('2'), actual: h('CHANGED') }])
    expect(describeDiff(diff)).toContain('内容不一致 1 个')
  })

  it('明细按 UTF-8 字节序稳定排序', () => {
    const exp: ReleaseItem[] = [item('c', '1'), item('a', '1'), item('b', '1')]
    const diff = diffByHashes(exp, new Map())
    expect(diff.missing).toEqual(['a', 'b', 'c'])
  })

  it('命令路径：FAILED → mismatch（actual 为 null），open or read → missing', () => {
    const diff = diffByCheckOutput(expected, [
      { relPath: 'a.js', status: 'ok', raw: '' },
      { relPath: 'b.js', status: 'failed', raw: '' },
      { relPath: 'sub/c.js', status: 'unreadable', raw: '' }
    ])
    expect(diff.matchedCount).toBe(1)
    expect(diff.mismatch).toEqual([{ relPath: 'b.js', expected: h('2'), actual: null }])
    expect(diff.missing).toEqual(['sub/c.js'])
  })

  it('命令路径：清单里列了但命令没报的行，按缺失处理（清单可能被截断）', () => {
    const diff = diffByCheckOutput(expected, [])
    expect(diff.missing).toEqual(['a.js', 'b.js', 'sub/c.js'])
    expect(diff.ok).toBe(false)
  })

  it('命令路径：命令回显里多出来的行算 extra', () => {
    const diff = diffByCheckOutput(expected, [
      { relPath: 'a.js', status: 'ok', raw: '' },
      { relPath: 'b.js', status: 'ok', raw: '' },
      { relPath: 'sub/c.js', status: 'ok', raw: '' },
      { relPath: 'ghost.js', status: 'ok', raw: '' }
    ])
    expect(diff.extra).toEqual(['ghost.js'])
    expect(diff.ok).toBe(false)
  })
})
