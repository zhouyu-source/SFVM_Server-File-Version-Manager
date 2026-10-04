/**
 * 主进程侧错误工具（T01.3）。
 *
 * 码值与中文文案在 `src/shared/errors.ts`（三端共用），这里只放主进程专有的：
 * AppError 类与异常归一化。渲染进程不需要、也不应加载这个文件。
 */
import {
  ErrorCode,
  ERROR_TEXT,
  type ErrorCodeValue,
  type ErrorDescriptor
} from '../../shared/errors'

export { ErrorCode, ERROR_TEXT }
export type { ErrorCodeValue, ErrorDescriptor }

/** 业务异常：携带稳定错误码，经 IPC 序列化后由渲染进程还原为中文提示。 */
export class AppError extends Error {
  readonly code: ErrorCodeValue
  readonly detail?: unknown
  readonly hint?: string
  /** 便于排查的附加信息，不进 UI */
  readonly context?: Record<string, unknown>

  constructor(
    code: ErrorCodeValue,
    detail?: unknown,
    overrides?: { message?: string; hint?: string; context?: Record<string, unknown> }
  ) {
    const desc = ERROR_TEXT[code]
    super(overrides?.message ?? desc.message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
    this.hint = overrides?.hint ?? desc.hint
    this.context = overrides?.context
  }

  /** 面向用户的完整提示（说明 + 建议）。 */
  toUserText(): string {
    return this.hint ? `${this.message}\n${this.hint}` : this.message
  }
}

/** 便捷构造。 */
export function appError(
  code: ErrorCodeValue,
  detail?: unknown,
  overrides?: { message?: string; hint?: string; context?: Record<string, unknown> }
): AppError {
  return new AppError(code, detail, overrides)
}

/**
 * 把任意异常规整成 AppError。
 * 用于 IPC 边界：绝不把原始英文异常直接丢给用户（T15.4 的前置要求）。
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err
  const original = err instanceof Error ? err.message : String(err)
  const wrapped = new AppError(ErrorCode.E_UNKNOWN, { original })
  if (err instanceof Error && err.stack) wrapped.stack = err.stack
  return wrapped
}
