/**
 * B15 / T15.4 错误文案的完整性（可执行的校对）。
 *
 * 计划书对这条的要求是"抽查 15 种错误场景文案可读"—— 人手抽查的问题在于
 * **它只覆盖当下这一遍**：以后新增一个错误码、或者有人复制粘贴时把 hint 忘了，
 * 没有任何机制会拦下来。所以这里把"能自动判定的部分"钉成测试：
 *
 * 1. 每个码都有 message（不能只有码没有话）；
 * 2. **除了明确"无事可做"的少数码外，都必须有 hint** —— 用户看到错误时最需要的
 *    恰恰是"我该怎么办"，而漏写 hint 是最常见的疏漏；
 * 3. 文案里不出现"英文裸报错"的味道（比如以 `Error:` 开头、或者整句没有中文），
 *    因为这类文案基本都是从底层异常直接 `String(err)` 抄来的；
 * 4. 已知的几个**具体**坑（历史上真写错过的数字与过时指引）单独钉住。
 *
 * 判不了的（语气、是否真有用）仍靠人看，但这份清单至少保证"没有空缺"。
 */
import { describe, expect, it } from 'vitest'
import { ERROR_TEXT, ErrorCode } from '@shared/errors'

/** 允许没有 hint 的码：它们要么是"就是没做"，要么是"下一步无可奉告"。 */
const HINT_OPTIONAL: readonly string[] = [
  ErrorCode.E_NOT_IMPLEMENTED,
  ErrorCode.E_UNKNOWN
]

describe('B15 / T15.4 错误文案表', () => {
  const entries = Object.entries(ERROR_TEXT)

  it('覆盖全部错误码（Record 类型已保证，这里再确认一次不是空的）', () => {
    // 目前 54 条（B20 加了 4 个 script 相关码）；数量本身不是目标，
    // 但"突然少了一半"往往意味着有人误删了整段
    expect(entries.length).toBe(Object.keys(ErrorCode).length)
    expect(entries.length).toBeGreaterThan(40)
  })

  it('每个码都有非空的 message', () => {
    for (const [code, d] of entries) {
      expect(d.message?.trim(), `${code} 缺 message`).toBeTruthy()
    }
  })

  it('除少数明确例外，每个码都要有 hint（"我该怎么办"）', () => {
    const missing = entries
      .filter(([code, d]) => !HINT_OPTIONAL.includes(code) && !d.hint?.trim())
      .map(([code]) => code)
    expect(missing, `这些错误码缺 hint：${missing.join('、')}`).toEqual([])
  })

  it('文案必须是中文说明，不能是底层异常的原文', () => {
    for (const [code, d] of entries) {
      const all = `${d.message} ${d.hint ?? ''}`
      // 有中文即可（允许夹带命令名、路径、字段名这些英文标识）
      expect(/[\u4e00-\u9fa5]/.test(all), `${code} 的文案里没有中文：${all}`).toBe(true)
      // 典型的"把异常直接贴上去"的形态
      expect(d.message.startsWith('Error:'), `${code} 的 message 像是异常原文`).toBe(false)
      expect(/undefined|null\b/.test(d.message), `${code} 的 message 里出现了空值痕迹`).toBe(false)
    }
  })

  it('文案里的数字必须与实现一致（历史上写过偏小 40 倍的阈值）', () => {
    // 真阈值：`hash.ts` 的 MAX_LOCAL_FILES = 200000、MAX_WALK_DEPTH = 64
    const d = ERROR_TEXT[ErrorCode.E_ARTIFACT_TOO_MANY_FILES]
    expect(d.hint).toContain('20 万')
    expect(d.hint).toContain('64')
    // 旧的错误说法不能残留
    expect(d.hint).not.toContain('5000')

    // 磁盘余量 2.2 倍（与 deploy 的 `ceil(bytes*22/10)` 同口径）
    expect(ERROR_TEXT[ErrorCode.E_DISK_SPACE].hint).toContain('2.2')
  })

  it('指向界面的建议必须是**现在真的存在**的入口（不是过时的手工步骤）', () => {
    // 陈旧锁：B14 之后应用里有清理入口，不该再让用户去服务器上 rm
    expect(ERROR_TEXT[ErrorCode.E_LOCK_STALE].hint).toContain('对账')

    // 无 hash 工具：这条是"校验没做成"，不能写成"慢一点"
    const noTool = ERROR_TEXT[ErrorCode.E_NO_REMOTE_HASH_TOOL]
    expect(noTool.hint).toContain('算法兼容模式')
    expect(noTool.message).not.toContain('速度较慢')
  })
})
