/**
 * T01.3 验收点：错误码齐全且每个都有中文文案；异常归一不泄露英文原文。
 */
import { describe, expect, it } from 'vitest'
import { ErrorCode, ERROR_TEXT, describeError } from '@shared/errors'
import { AppError, appError, toAppError } from '@main/infra/errors'

describe('错误码表完整性', () => {
  it('码值数量满足 T01.3 要求（≥25）', () => {
    expect(Object.keys(ErrorCode).length).toBeGreaterThanOrEqual(25)
  })

  it('每个码都有中文文案，没有漏项', () => {
    for (const code of Object.values(ErrorCode)) {
      const desc = ERROR_TEXT[code]
      expect(desc, `缺少文案: ${code}`).toBeDefined()
      expect(desc.message.length, `文案为空: ${code}`).toBeGreaterThan(0)
    }
  })

  it('文案是中文，不出现英文裸报错', () => {
    for (const code of Object.values(ErrorCode)) {
      const { message, hint } = ERROR_TEXT[code]
      // 至少含一个中文字符
      expect(/[\u4e00-\u9fa5]/.test(message), `非中文文案: ${code} -> ${message}`).toBe(true)
      if (hint) expect(/[\u4e00-\u9fa5]/.test(hint), `非中文建议: ${code}`).toBe(true)
    }
  })

  it('码值形如 E_ 前缀的大写常量', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(code).toMatch(/^E_[A-Z0-9_]+$/)
    }
  })

  it('覆盖《方案书》§11 的关键场景', () => {
    // 抽查几个必须在场的码，防止后续被误删
    for (const c of [
      ErrorCode.E_CONN_TIMEOUT,
      ErrorCode.E_CONN_AUTH,
      ErrorCode.E_HOST_KEY_CHANGED,
      ErrorCode.E_TARGET_MISSING,
      ErrorCode.E_PARENT_NOT_WRITABLE,
      ErrorCode.E_DISK_SPACE,
      ErrorCode.E_CROSS_DEVICE,
      ErrorCode.E_TARGET_BUSY_MOUNT,
      ErrorCode.E_UPLOAD_INTERRUPTED,
      ErrorCode.E_VERIFY_MISMATCH,
      ErrorCode.E_ARCHIVE_CONFLICT,
      ErrorCode.E_TARGET_BUSY,
      ErrorCode.E_NO_REMOTE_HASH_TOOL,
      ErrorCode.E_ARCHIVE_CORRUPT,
      ErrorCode.E_DB_CORRUPT,
      ErrorCode.E_ARTIFACT_TOO_MANY_FILES
    ]) {
      expect(ERROR_TEXT[c]).toBeDefined()
    }
  })
})

describe('describeError', () => {
  it('未知码退化为通用文案而不是抛错', () => {
    expect(describeError('E_NOT_A_REAL_CODE').message).toBe(ERROR_TEXT.E_UNKNOWN.message)
  })
})

describe('AppError', () => {
  it('自动带上对应码的中文说明与建议', () => {
    const e = new AppError(ErrorCode.E_CONN_AUTH)
    expect(e.code).toBe('E_CONN_AUTH')
    expect(e.message).toBe(ERROR_TEXT.E_CONN_AUTH.message)
    expect(e.hint).toBe(ERROR_TEXT.E_CONN_AUTH.hint)
    expect(e.toUserText()).toContain(ERROR_TEXT.E_CONN_AUTH.hint as string)
  })

  it('允许覆写文案但保留码', () => {
    const e = appError(ErrorCode.E_PARAM, { issues: [] }, { message: '路径不合法' })
    expect(e.message).toBe('路径不合法')
    expect(e.code).toBe('E_PARAM')
    expect(e.detail).toEqual({ issues: [] })
  })

  it('没有建议时 toUserText 只返回说明', () => {
    const e = new AppError(ErrorCode.E_NOT_IMPLEMENTED)
    expect(e.toUserText()).toBe(ERROR_TEXT.E_NOT_IMPLEMENTED.message)
  })
})

describe('toAppError', () => {
  it('AppError 原样返回，不重复包装', () => {
    const orig = new AppError(ErrorCode.E_DISK_SPACE)
    expect(toAppError(orig)).toBe(orig)
  })

  it('普通 Error 归一到 E_UNKNOWN，且英文原文只进 detail', () => {
    const e = toAppError(new Error('ECONNREFUSED 10.0.0.1:22'))
    expect(e.code).toBe('E_UNKNOWN')
    // 面向用户的 message 必须是中文
    expect(/[\u4e00-\u9fa5]/.test(e.message)).toBe(true)
    expect(e.message).not.toContain('ECONNREFUSED')
    // 原文保留在 detail 供排障
    expect(JSON.stringify(e.detail)).toContain('ECONNREFUSED')
  })

  it('非 Error 值也能归一', () => {
    const e = toAppError('something odd')
    expect(e.code).toBe('E_UNKNOWN')
    expect(JSON.stringify(e.detail)).toContain('something odd')
  })
})
