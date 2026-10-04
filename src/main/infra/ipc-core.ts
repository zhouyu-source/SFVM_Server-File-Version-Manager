/**
 * IPC 入参与异常处理的**纯逻辑**（T01.4）。
 *
 * 刻意与 electron 解耦，这样可以在 Vitest 里直接单测
 * （registerHandler 需要 electron 运行时，无法在单测环境加载）。
 * `infra/ipc.ts` 引用这里的实现，保证"测的就是跑的"。
 */
import type { ZodType } from 'zod'
import { AppError, ErrorCode, ERROR_TEXT, toAppError } from './errors'
import { ipcErr, type IpcResult } from '../../shared/ipc'

export interface ParamIssue {
  path: string
  message: string
}

export type ValidateResult<T> = { ok: true; data: T } | { ok: false; issues: ParamIssue[] }

/** 校验入参。schema 为 null 表示该通道无入参。 */
export function validateInput<T>(schema: ZodType<T> | null, raw: unknown): ValidateResult<T> {
  if (!schema) return { ok: true, data: undefined as T }

  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, data: parsed.data }

  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message
    }))
  }
}

/** 校验失败的标准信封（T01.4 验收点：必须返回 code = 'E_PARAM'）。 */
export function paramError(issues: ParamIssue[]): IpcResult<never> {
  return ipcErr(ErrorCode.E_PARAM, ERROR_TEXT.E_PARAM.message, ERROR_TEXT.E_PARAM.hint, { issues })
}

/**
 * 把任意异常转成标准错误信封。
 * 业务抛 AppError 用它的码；其余归一到 E_UNKNOWN（原文只进 detail 供排障）。
 */
export function errorEnvelope(err: unknown): IpcResult<never> {
  const appErr = err instanceof AppError ? err : toAppError(err)
  return ipcErr(appErr.code, appErr.message, appErr.hint, appErr.detail)
}
