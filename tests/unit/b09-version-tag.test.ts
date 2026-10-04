/**
 * T09.2 / T09.5 单测：版本号生成与同秒冲突处理。
 *
 * 版本号是归档目录的物理名字，一旦生成有误（时区错、哈希前缀错、冲突被覆盖），
 * 后果都是"服务器上少了一个历史版本"或"目录名与内容对不上"，
 * 而这两种都不会当场报错。所以这里把边界逐条钉死。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_VERSION_TAG_ATTEMPTS,
  ROOT_HASH_PREFIX_LENGTH,
  formatTagTime,
  formatVersionTag,
  isVersionTag,
  resolveVersionTag,
  resolveVersionTagDetailed,
  rootHashPrefix,
  toLocalIso,
  withSequence
} from '@main/infra/version-tag'
import { VERSION_TAG_PATTERN } from '@shared/contracts/archive'

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdef123456'

/** 用本地时间构造，避开"测试机时区不是 UTC+8"导致的假失败。 */
const LOCAL_TIME = new Date(2025, 5, 12, 14, 30, 15)

describe('versionTag 生成（T09.2）', () => {
  it('按 yyyyMMdd-HHmmss_<hash7> 生成，且时间取**本地**时区', () => {
    expect(formatTagTime(LOCAL_TIME)).toBe('20250612-143015')
    expect(formatVersionTag(LOCAL_TIME, HASH)).toBe('20250612-143015_a1b2c3d')
    expect(formatVersionTag(LOCAL_TIME, HASH)).toMatch(VERSION_TAG_PATTERN)
  })

  it('哈希前缀固定 7 位并转小写（大写输入也认）', () => {
    expect(rootHashPrefix(HASH)).toHaveLength(ROOT_HASH_PREFIX_LENGTH)
    expect(rootHashPrefix(HASH.toUpperCase())).toBe('a1b2c3d')
  })

  it('rootHash 不是十六进制时明确报错（而不是生成一个假版本号）', () => {
    for (const bad of ['', 'xyz1234', 'abc', 'a1b2c3']) {
      expect(() => rootHashPrefix(bad), bad).toThrow(/rootHash/)
    }
  })

  it('toLocalIso 带时区偏移（方案书 §5.4 要求），而不是 UTC 的 Z', () => {
    const iso = toLocalIso(LOCAL_TIME)
    expect(iso.startsWith('2025-06-12T14:30:15')).toBe(true)
    expect(iso).toMatch(/[+-]\d{2}:\d{2}$/)
    // 偏移量必须与运行环境一致，否则跨时区排查会对不上
    const offsetMin = -LOCAL_TIME.getTimezoneOffset()
    const sign = offsetMin >= 0 ? '+' : '-'
    const abs = Math.abs(offsetMin)
    const expectOffset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    expect(iso.slice(-6)).toBe(expectOffset)
  })

  it('序号从 2 开始；seq < 2 时就是基础版本号', () => {
    const base = formatVersionTag(LOCAL_TIME, HASH)
    expect(withSequence(base, 0)).toBe(base)
    expect(withSequence(base, 1)).toBe(base)
    expect(withSequence(base, 2)).toBe(`${base}-2`)
    expect(withSequence(base, 12)).toBe(`${base}-12`)
    expect(withSequence(base, 12)).toMatch(VERSION_TAG_PATTERN)
  })

  it('isVersionTag 只认合法形态', () => {
    expect(isVersionTag('20250612-143015_a1b2c3d')).toBe(true)
    expect(isVersionTag('20250612-143015_a1b2c3d-2')).toBe(true)
    expect(isVersionTag('20250612-143015_a1b2c3')).toBe(false)
    expect(isVersionTag('2025-06-12_abcdefg')).toBe(false)
    expect(isVersionTag(undefined)).toBe(false)
  })
})

describe('同秒冲突（T09.2 / T09.5）', () => {
  it('连续 5 次归档互不重复（把已用掉的记下来再问一次）', async () => {
    const taken = new Set<string>()
    const tags: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = await resolveVersionTagDetailed({
        rootHash: HASH,
        now: LOCAL_TIME,
        exists: async (tag) => taken.has(tag)
      })
      taken.add(r.versionTag)
      tags.push(r.versionTag)
    }
    expect(new Set(tags).size).toBe(5)
    expect(tags[0]).toBe(formatVersionTag(LOCAL_TIME, HASH))
    expect(tags.slice(1)).toEqual([2, 3, 4, 5].map((n) => `${tags[0]}-${n}`))
  })

  it('前两次冲突时给出 -3，并回报试了几次', async () => {
    const taken = new Set([
      formatVersionTag(LOCAL_TIME, HASH),
      `${formatVersionTag(LOCAL_TIME, HASH)}-2`
    ])
    const r = await resolveVersionTagDetailed({
      rootHash: HASH,
      now: LOCAL_TIME,
      exists: async (tag) => taken.has(tag)
    })
    expect(r.versionTag.endsWith('-3')).toBe(true)
    expect(r.attempts).toBe(3)
  })

  it(`连续 ${MAX_VERSION_TAG_ATTEMPTS} 次都冲突时明确报错（不静默覆盖）`, async () => {
    await expect(
      resolveVersionTag({
        rootHash: HASH,
        now: LOCAL_TIME,
        // 任何候选都已存在 —— 等价于"同一秒已经归档了 5 次以上"
        exists: async () => true
      })
    ).rejects.toMatchObject({ code: 'E_VERSION_TAG_CONFLICT' })
  })

  it('冲突上限可调，且至少尝试一次', async () => {
    let calls = 0
    await expect(
      resolveVersionTag({
        rootHash: HASH,
        now: LOCAL_TIME,
        maxAttempts: 2,
        exists: async () => {
          calls++
          return true
        }
      })
    ).rejects.toMatchObject({ code: 'E_VERSION_TAG_CONFLICT' })
    expect(calls).toBe(2)

    calls = 0
    const tag = await resolveVersionTag({
      rootHash: HASH,
      now: LOCAL_TIME,
      maxAttempts: 0, // 非法值 → 至少试一次
      exists: async () => {
        calls++
        return false
      }
    })
    expect(tag).toBe(formatVersionTag(LOCAL_TIME, HASH))
    expect(calls).toBe(1)
  })
})
