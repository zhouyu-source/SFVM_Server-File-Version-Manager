/**
 * 连接管理的跨进程契约（T03.9）。
 *
 * 放在 shared 而不是 main：preload、渲染进程、主进程都要用同一份形状。
 * 若放在 main，渲染进程 import 时会把主进程模块拖进 bundle。
 */
import { z } from 'zod'

export const authTypeSchema = z.enum(['password', 'privateKey', 'agent'])
export type AuthType = z.infer<typeof authTypeSchema>

/**
 * 新建/更新连接的入参。
 *
 * 关于 `secret` 的语义（三个值必须区分清楚）：
 * - **不传**：保持原凭据不变（编辑时用户没动密码框）
 * - **空字符串**：清除已保存的凭据
 * - **非空字符串**：设置为新的密码 / 私钥口令
 */
export const connectionInputSchema = z.object({
  name: z.string().min(1, '名称不能为空'),
  host: z.string().min(1, '主机不能为空'),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1, '用户名不能为空'),
  authType: authTypeSchema,
  secret: z.string().optional(),
  privateKeyPath: z.string().nullable().optional(),
  keepaliveMs: z.number().int().min(5000).max(300000).optional(),
  autoConnect: z.boolean().optional(),
  remark: z.string().optional()
})
export type ConnectionInput = z.infer<typeof connectionInputSchema>

/** 部分更新：所有字段可选（secret 语义同上）。 */
export const connectionPatchSchema = connectionInputSchema.partial()
export type ConnectionPatch = z.infer<typeof connectionPatchSchema>

/**
 * 暴露给渲染进程的连接视图。
 *
 * **不含 `secretCipher`，也不含任何能被解出明文的东西**；
 * 渲染进程只能知道 `hasSecret` 这个布尔量（方案书 §3.2）。
 */
export interface ConnectionView {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  hasSecret: boolean
  privateKeyPath: string | null
  hostKeyFingerprint: string | null
  keepaliveMs: number
  autoConnect: boolean
  lastConnectedAt: string | null
  remark: string | null
  createdAt: string
  updatedAt: string
}

/** 远端能力探测结果（跨进程展示用）。 */
export interface CapabilityView {
  hasSha256sum: boolean
  hasShasum: boolean
  hasDf: boolean
  platform: 'linux' | 'darwin' | 'windows' | 'unknown'
  homeDir: string
}

/** 连接测试结果。 */
export interface TestResult {
  latencyMs: number
  capability: CapabilityView
  hostKeyFingerprint: string
  hostKeyType: string
  /** 指纹与已记录的是否一致；首次连接为 unknown，需要用户确认（TOFU） */
  hostKeyStatus: 'match' | 'unknown' | 'mismatch'
}

/** 本机凭据加密可用性（T03.2）。 */
export interface CredentialStatus {
  available: boolean
  backend: string
  reason?: string
}
