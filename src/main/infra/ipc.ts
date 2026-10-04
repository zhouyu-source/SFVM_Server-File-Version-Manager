/**
 * 统一 IPC handler 注册框架（T01.4 校验中间件 + T01.5 注册器）。
 *
 * 设计要点：
 * 1. **入参一律 Zod 校验**，失败返回 `{ok:false, code:'E_PARAM'}` 并带字段级明细；
 * 2. **异常一律转信封**：业务抛 AppError 用它的码与中文文案，其余归一到 E_UNKNOWN，
 *    绝不让渲染进程收到英文堆栈（T15.4 的前置要求）；
 * 3. 通道名统一登记在 `shared/channels.ts`，避免两端字符串不一致；
 * 4. 重复注册直接报错，防止热重载时静默覆盖。
 *
 * 纯逻辑在 `ipc-core.ts`，便于单测；这里只做 electron 侧的接线。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ZodType } from 'zod'
import { AppError, ErrorCode } from './errors'
import { errorEnvelope, paramError, validateInput } from './ipc-core'
import { ipcOk, type IpcResult } from '../../shared/ipc'
import { logger } from './logger'

/** 已注册通道，用于防重复注册与自检。 */
const registered = new Set<string>()

export interface HandlerContext {
  event: IpcMainInvokeEvent
}

export type HandlerFn<TIn, TOut> = (input: TIn, ctx: HandlerContext) => TOut | Promise<TOut>

export function registerHandler<TOut>(
  channel: string,
  schema: null,
  fn: HandlerFn<void, TOut>
): void
export function registerHandler<TIn, TOut>(
  channel: string,
  schema: ZodType<TIn>,
  fn: HandlerFn<TIn, TOut>
): void
export function registerHandler<TIn, TOut>(
  channel: string,
  schema: ZodType<TIn> | null,
  fn: HandlerFn<TIn, TOut>
): void {
  if (registered.has(channel)) {
    throw new Error(`IPC channel already registered: ${channel}`)
  }
  registered.add(channel)

  ipcMain.handle(channel, async (event, rawInput: unknown): Promise<IpcResult<TOut>> => {
    // ---- 入参校验 ----
    const checked = validateInput(schema, rawInput)
    if (!checked.ok) {
      logger.warn(`IPC ${channel} param invalid: ${JSON.stringify(checked.issues)}`)
      return paramError(checked.issues)
    }

    // ---- 执行 + 异常归一 ----
    try {
      const data = await fn(checked.data as TIn, { event })
      return ipcOk(data)
    } catch (err) {
      const envelope = errorEnvelope(err)
      const code = envelope.ok ? ErrorCode.E_UNKNOWN : envelope.code
      const logFn = code === ErrorCode.E_UNKNOWN ? logger.error : logger.warn
      const detail = err instanceof AppError && err.detail ? JSON.stringify(err.detail) : ''
      logFn(`IPC ${channel} failed: code=${code} ${detail}`)
      if (err instanceof Error && err.stack) logger.debug(`IPC ${channel} stack: ${err.stack}`)
      return envelope as IpcResult<TOut>
    }
  })
}

/** 便于测试与退出清理。 */
export function unregisterAllHandlers(): void {
  for (const channel of registered) ipcMain.removeHandler(channel)
  registered.clear()
}

/** 已注册通道快照（自检 / 生成文档用）。 */
export function registeredChannels(): string[] {
  return [...registered].sort()
}
