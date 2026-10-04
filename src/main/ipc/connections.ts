/**
 * 连接相关 IPC 通道（T03.9）。
 *
 * 两条不可逾越的规则：
 * 1. **入参**：只接受用户输入的明文密码/口令（主进程内立即加密），
 *    不接受任何"已加密"字段 —— 渲染进程不该有密文的概念。
 * 2. **出参**：一律走 ConnectionService 的脱敏视图，只暴露 `hasSecret: boolean`。
 *
 * `connections:state` 是事件推送（不是 invoke），由 main/index.ts 在池上订阅后转发。
 */
import { z } from 'zod'
import { registerHandler } from '../infra/ipc'
import { IPC_CHANNELS } from '../../shared/channels'
import { AppError, ErrorCode } from '../infra/errors'
import { connectionInputSchema, connectionPatchSchema } from '../../shared/contracts/connection'
import type { ConnectionService } from '../services/connection'

const idSchema = z.object({ id: z.string().min(1) })

export function registerConnectionHandlers(svc: ConnectionService): void {
  registerHandler(IPC_CHANNELS.CONNECTIONS_LIST, null, () => svc.list())

  registerHandler(IPC_CHANNELS.CONNECTIONS_GET, idSchema, ({ id }) => svc.get(id))

  registerHandler(IPC_CHANNELS.CONNECTIONS_CREATE, connectionInputSchema, (input) =>
    svc.create(input)
  )

  registerHandler(
    IPC_CHANNELS.CONNECTIONS_UPDATE,
    idSchema.extend({ patch: connectionPatchSchema }),
    ({ id, patch }) => svc.update(id, patch)
  )

  registerHandler(IPC_CHANNELS.CONNECTIONS_REMOVE, idSchema, ({ id }) => {
    svc.remove(id)
    return { removed: true }
  })

  // 连接测试：既可测已保存的连接（id），也可测表单里尚未保存的参数（input）
  registerHandler(
    IPC_CHANNELS.CONNECTIONS_TEST,
    z
      .object({
        id: z.string().optional(),
        input: connectionInputSchema.optional()
      })
      .refine((v) => Boolean(v.id) || Boolean(v.input), { message: 'id 与 input 至少要有一个' }),
    (params) => svc.test(params)
  )

  registerHandler(IPC_CHANNELS.CONNECTIONS_CONNECT, idSchema, async ({ id }) => svc.connect(id))

  registerHandler(IPC_CHANNELS.CONNECTIONS_DISCONNECT, idSchema, ({ id }) => {
    svc.disconnect(id)
    return { disconnected: true }
  })

  registerHandler(IPC_CHANNELS.CONNECTIONS_STATE, idSchema, ({ id }) => svc.state(id))

  /** 首次连接后确认信任指纹（TOFU 落库） */
  registerHandler(
    IPC_CHANNELS.CONNECTIONS_TRUST_KEY,
    z.object({
      id: z.string().min(1),
      keyType: z.string().min(1),
      fingerprint: z.string().min(1)
    }),
    ({ id, keyType, fingerprint }) => {
      svc.trustHostKey(id, keyType, fingerprint)
      return { trusted: true }
    }
  )

  /** 本机能否安全保存密码（T03.2）—— UI 据此决定是否禁用"保存密码" */
  registerHandler(IPC_CHANNELS.CONNECTIONS_CREDENTIAL_STATUS, null, () => svc.credentialStatus())

  /**
   * 刻意保留的"禁止通道"：任何试图取出明文凭据的调用都必须失败。
   * 它不是功能，而是把"明文不出主进程"这条约束变成可被测试与审查的东西。
   */
  registerHandler(IPC_CHANNELS.CONNECTIONS_REVEAL_SECRET, idSchema, () => {
    throw new AppError(ErrorCode.E_NOT_IMPLEMENTED, {
      reason: '出于安全设计，明文凭据不允许经由 IPC 传递'
    })
  })
}
