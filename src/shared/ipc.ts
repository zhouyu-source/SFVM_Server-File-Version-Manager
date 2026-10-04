/**
 * IPC 统一信封（T01.4）。
 *
 * 所有 invoke 通道的返回值都是 `IpcResult<T>`：
 * - 成功：{ ok: true, data }
 * - 失败：{ ok: false, code, message, hint? }
 *
 * 为什么不用「抛异常跨 IPC」：Electron 会把异常压成字符串，错误码与结构化明细全丢，
 * 渲染进程只能拿到一句英文原文。用信封可以把码、中文说明、建议动作、明细一起带过去。
 */
import type { ErrorCodeValue } from './errors'

export interface IpcOk<T> {
  ok: true
  data: T
}

export interface IpcErr {
  ok: false
  code: ErrorCodeValue | string
  message: string
  hint?: string
  detail?: unknown
}

export type IpcResult<T> = IpcOk<T> | IpcErr

export function ipcOk<T>(data: T): IpcOk<T> {
  return { ok: true, data }
}

export function ipcErr(
  code: ErrorCodeValue | string,
  message: string,
  hint?: string,
  detail?: unknown
): IpcErr {
  return {
    ok: false,
    code,
    message,
    ...(hint ? { hint } : {}),
    ...(detail === undefined ? {} : { detail })
  }
}

/** 类型收窄辅助，便于渲染进程分支。 */
export function isIpcOk<T>(r: IpcResult<T>): r is IpcOk<T> {
  return r.ok === true
}
