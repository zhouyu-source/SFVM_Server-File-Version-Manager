/**
 * T01.4 验收点：校验失败返回 code='E_PARAM'；异常转信封保留错误码。
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { validateInput, paramError, errorEnvelope } from '@main/infra/ipc-core'
import { AppError } from '@main/infra/errors'
import { ErrorCode } from '@shared/errors'

const schema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535)
})

describe('validateInput', () => {
  it('合法入参通过并返回解析后的数据', () => {
    const r = validateInput(schema, { host: '10.0.0.1', port: 22 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ host: '10.0.0.1', port: 22 })
  })

  it('schema 为 null 时视为无入参', () => {
    const r = validateInput(null, undefined)
    expect(r.ok).toBe(true)
  })

  it('缺字段时给出字段路径与原因', () => {
    const r = validateInput(schema, { port: 22 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === 'host')).toBe(true)
    }
  })

  it('类型错误被拦下', () => {
    const r = validateInput(schema, { host: 'x', port: '22' })
    expect(r.ok).toBe(false)
  })

  it('越界值被拦下', () => {
    const r = validateInput(schema, { host: 'x', port: 70000 })
    expect(r.ok).toBe(false)
  })

  it('完全不传入参时被拦下（不是静默通过）', () => {
    const r = validateInput(schema, undefined)
    expect(r.ok).toBe(false)
  })
})

describe('paramError', () => {
  it('返回 ok:false 且 code 为 E_PARAM', () => {
    const env = paramError([{ path: 'host', message: '必填' }])
    expect(env.ok).toBe(false)
    if (!env.ok) {
      expect(env.code).toBe('E_PARAM')
      expect(/[\u4e00-\u9fa5]/.test(env.message)).toBe(true)
      expect(env.detail).toEqual({ issues: [{ path: 'host', message: '必填' }] })
    }
  })
})

describe('errorEnvelope', () => {
  it('AppError 保留自己的错误码与中文文案', () => {
    const env = errorEnvelope(new AppError(ErrorCode.E_DISK_SPACE, { need: 1024 }))
    expect(env.ok).toBe(false)
    if (!env.ok) {
      expect(env.code).toBe('E_DISK_SPACE')
      expect(env.detail).toEqual({ need: 1024 })
    }
  })

  it('普通 Error 归一到 E_UNKNOWN 且不把英文原文放进 message', () => {
    const env = errorEnvelope(new Error('EPERM: operation not permitted'))
    expect(env.ok).toBe(false)
    if (!env.ok) {
      expect(env.code).toBe('E_UNKNOWN')
      expect(env.message).not.toContain('EPERM')
    }
  })
})
