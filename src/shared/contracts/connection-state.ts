/**
 * 连接状态的跨进程契约。
 *
 * 主进程通过 `connections:state` 事件推送，渲染进程据此更新顶部状态条与徽标。
 * 与 `main/infra/connection-state.ts` 的区别：那份含主进程侧的辅助函数，
 * 这份只保留三端共用的**数据形状**。
 */

export type ConnectionStatus =
  /** 从未连接过 */
  | 'idle'
  /** 正在建连（含首次与手动重连） */
  | 'connecting'
  /** 已连接可用 */
  | 'online'
  /** 断线后自动重连中 */
  | 'reconnecting'
  /** 不可用（附原因） */
  | 'offline'

export interface ConnectionState {
  connectionId: string
  status: ConnectionStatus
  /** 面向用户的中文原因说明；online / idle 时通常没有 */
  reason?: string
  /** 错误码，便于 UI 分支处理 */
  code?: string
  /** 最近一次连接成功时间（ISO） */
  lastConnectedAt?: string
  /** 已重试次数 */
  retryAttempt?: number
  /** 主机指纹（首次连接后可得，供 TOFU 确认） */
  hostKeyFingerprint?: string
  /** 主机密钥类型 */
  hostKeyType?: string
}

/** 状态是否允许发起发布/回滚等写操作。 */
export function isOperable(status: ConnectionStatus): boolean {
  return status === 'online'
}

/** UI 徽标文案。 */
export function describeStatus(s: ConnectionStatus): string {
  switch (s) {
    case 'online':
      return '在线'
    case 'connecting':
      return '连接中'
    case 'reconnecting':
      return '重连中'
    case 'offline':
      return '离线'
    default:
      return '未连接'
  }
}
