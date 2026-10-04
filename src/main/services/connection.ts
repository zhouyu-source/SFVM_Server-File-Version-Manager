/**
 * 连接管理服务（T03.8）。
 *
 * 职责：把「仓储 + 凭据 + 连接池」串起来，并对渲染进程只暴露**脱敏后的**连接视图。
 *
 * 关键安全约束（方案书 §3.2 / §6.3）：
 * - `secret_cipher` 与任何解密结果**绝不进入 IPC 返回值**
 * - 渲染进程只能知道 `hasSecret: true/false`
 * - 私钥只存路径，读取发生在主进程
 */
import { readFileSync } from 'node:fs'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { verifyHostKey, type TrustedFingerprint } from '../../shared/host-key'
import type {
  AuthType,
  ConnectionInput,
  ConnectionView,
  TestResult
} from '../../shared/contracts/connection'
import type { ConnectionState } from '../../shared/contracts/connection-state'
import type { Repositories } from '../db/repositories'
import type { Connection as ConnectionRow } from '../db/schema'
import {
  canStoreSecrets,
  checkAvailability,
  decryptSecret,
  encryptSecret,
  hasStoredSecret,
  unavailableReason
} from './credential'
import { SshConnectionPool, mapConnectError, type SshConnectOptions } from './ssh-client'

/* ------------------------------------------------------------------ 输入输出 */

// 类型统一定义在 shared/contracts/connection（三端共用），这里再导出一次，
// 让调用方不必同时 import 两个位置。
export type { AuthType, ConnectionInput, ConnectionView, TestResult }

export interface ConnectionServiceDeps {
  repo: Repositories
  pool: SshConnectionPool
}

/* -------------------------------------------------------------------- 服务 */

export function createConnectionService(deps: ConnectionServiceDeps) {
  const { repo, pool } = deps

  /** 行 → 脱敏视图。这是唯一允许跨 IPC 的形态。 */
  function toView(row: ConnectionRow): ConnectionView {
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      authType: row.authType as AuthType,
      hasSecret: hasStoredSecret(row.secretCipher),
      privateKeyPath: row.privateKeyPath ?? null,
      hostKeyFingerprint: row.hostKeyFingerprint ?? null,
      keepaliveMs: row.keepaliveMs,
      autoConnect: row.autoConnect,
      lastConnectedAt: row.lastConnectedAt ?? null,
      remark: row.remark ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  /** 读取该连接的已信任指纹（同主机的所有算法）。 */
  function trustedFingerprints(host: string, port: number): TrustedFingerprint[] {
    return repo.knownHosts
      .list()
      .filter((k) => k.host === host && k.port === port)
      .map((k) => ({ keyType: k.keyType, fingerprint: k.fingerprint }))
  }

  /** 组装 ssh2 建连参数（含解密凭据）。仅在主进程内使用。 */
  function buildConnectOptions(
    row: ConnectionRow,
    policy: 'accept-any' | 'strict',
    expectedFingerprint?: string,
    overrideSecret?: string
  ): SshConnectOptions {
    let secret = overrideSecret
    if (secret === undefined && hasStoredSecret(row.secretCipher)) {
      secret = decryptSecret(row.secretCipher)
    }

    let privateKey: Buffer | string | undefined
    if (row.authType === 'privateKey') {
      if (!row.privateKeyPath) {
        throw new AppError(ErrorCode.E_CONN_AUTH, { reason: 'privateKeyPath-missing' })
      }
      try {
        privateKey = readFileSync(row.privateKeyPath)
      } catch (err) {
        throw new AppError(ErrorCode.E_LOCAL_PATH_MISSING, {
          path: row.privateKeyPath,
          original: (err as Error).message
        })
      }
    }

    return {
      connectionId: row.id,
      host: row.host,
      port: row.port,
      username: row.username,
      authType: row.authType as AuthType,
      secret,
      privateKey,
      keepaliveMs: row.keepaliveMs,
      hostKeyPolicy: policy,
      expectedFingerprint
    }
  }

  return {
    /* ----------------------------------------------------------- 可用性 */

    /** 本机能否安全保存密码（T03.2）。UI 用它决定是否禁用"保存密码"。 */
    credentialStatus(): { available: boolean; backend: string; reason?: string } {
      const a = checkAvailability()
      return a.available ? a : { ...a, reason: unavailableReason() }
    },

    /* --------------------------------------------------------------- CRUD */

    list(): ConnectionView[] {
      return repo.connections.list().map(toView)
    },

    get(id: string): ConnectionView {
      const row = repo.connections.get(id)
      if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { id })
      return toView(row)
    },

    create(input: ConnectionInput): ConnectionView {
      assertInput(input)

      // 凭据：能加密才保存，否则明确拒绝而不是写明文（T03.2）
      let secretCipher: string | null = null
      if (input.secret) {
        if (!canStoreSecrets()) throw new AppError(ErrorCode.E_NO_KEYCHAIN)
        secretCipher = encryptSecret(input.secret)
      }

      const row = repo.connections.create({
        name: input.name,
        host: input.host,
        port: input.port ?? 22,
        username: input.username,
        authType: input.authType,
        secretCipher,
        privateKeyPath: input.privateKeyPath ?? null,
        keepaliveMs: input.keepaliveMs ?? 15000,
        autoConnect: input.autoConnect ?? false,
        remark: input.remark ?? null
      })
      logger.info(`connection created: ${row.name} (${row.username}@${row.host}:${row.port})`)
      return toView(row)
    },

    update(id: string, input: Partial<ConnectionInput>): ConnectionView {
      const existing = repo.connections.get(id)
      if (!existing) throw new AppError(ErrorCode.E_NOT_FOUND, { id })

      const patch: Parameters<typeof repo.connections.update>[1] = {}
      if (input.name !== undefined) patch.name = input.name
      if (input.host !== undefined) patch.host = input.host
      if (input.port !== undefined) patch.port = input.port
      if (input.username !== undefined) patch.username = input.username
      if (input.authType !== undefined) patch.authType = input.authType
      if (input.privateKeyPath !== undefined) patch.privateKeyPath = input.privateKeyPath
      if (input.keepaliveMs !== undefined) patch.keepaliveMs = input.keepaliveMs
      if (input.autoConnect !== undefined) patch.autoConnect = input.autoConnect
      if (input.remark !== undefined) patch.remark = input.remark

      // secret 语义：undefined = 不改；'' = 清除；其他 = 重新设置
      if (input.secret !== undefined) {
        if (input.secret === '') {
          patch.secretCipher = null
        } else {
          if (!canStoreSecrets()) throw new AppError(ErrorCode.E_NO_KEYCHAIN)
          patch.secretCipher = encryptSecret(input.secret)
        }
      }

      const row = repo.connections.update(id, patch)!
      return toView(row)
    },

    remove(id: string): void {
      const count = repo.connections.countEnvironments(id)
      if (count > 0) {
        throw new AppError(ErrorCode.E_IN_USE, { environments: count })
      }
      pool.disconnect(id)
      repo.connections.remove(id)
      logger.info(`connection removed: ${id}`)
    },

    /* ------------------------------------------------------------ 连接测试 */

    /**
     * 连接测试（T03.3/T03.4/T03.7）。
     *
     * 用临时连接：探测完立即断开，不进入池，因此不会影响"在线状态"。
     * 支持两种来源：已保存的连接（传 id），或表单里还没保存的参数（传 input + secret）。
     */
    async test(params: { id?: string; input?: ConnectionInput }): Promise<TestResult> {
      const started = Date.now()

      // 刻意不给 trusted 初值：下面 if/else 每条路径都会赋值，
      // 第三条路径直接抛错。给 `= []` 反而会被 lint 判为"无用赋值"，
      // 也容易让人误以为存在"用空信任列表"的分支。
      let options: SshConnectOptions
      let host: string
      let port: number
      let trusted: TrustedFingerprint[]

      if (params.id) {
        const row = repo.connections.get(params.id)
        if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { id: params.id })
        host = row.host
        port = row.port
        trusted = trustedFingerprints(host, port)
        // 先用宽松策略拿指纹，再按 known_hosts 判定是否一致
        options = buildConnectOptions(row, 'accept-any')
      } else if (params.input) {
        const i = params.input
        host = i.host
        port = i.port ?? 22
        trusted = trustedFingerprints(host, port)
        options = {
          connectionId: `__test__${Date.now()}`,
          host,
          port,
          username: i.username,
          authType: i.authType,
          secret: i.secret,
          privateKey:
            i.authType === 'privateKey' && i.privateKeyPath
              ? readFileSync(i.privateKeyPath)
              : undefined,
          keepaliveMs: 15000,
          hostKeyPolicy: 'accept-any'
        }
      } else {
        throw new AppError(ErrorCode.E_PARAM, { reason: 'id 或 input 必填' })
      }

      try {
        const result = await pool.connect(options)

        // T03.4：用纯逻辑判定指纹（match / unknown / mismatch）
        const verdict = verifyHostKey(result.hostKeyFingerprint, trusted, result.hostKeyType)

        // 探测用的临时连接不进池、随后断开
        if (options.connectionId.startsWith('__test__')) {
          pool.disconnect(options.connectionId)
        }

        return {
          latencyMs: Date.now() - started,
          capability: result.capability,
          hostKeyFingerprint: result.hostKeyFingerprint,
          hostKeyType: result.hostKeyType,
          hostKeyStatus: verdict.status
        }
      } catch (err) {
        // 确保测试连接不留下池中残留
        if (options.connectionId.startsWith('__test__')) pool.disconnect(options.connectionId)
        throw err instanceof AppError ? err : mapConnectError(err as Error)
      }
    },

    /** 首次连接后确认信任该指纹（TOFU 的落库动作）。 */
    trustHostKey(id: string, keyType: string, fingerprint: string): void {
      const row = repo.connections.get(id)
      if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { id })
      repo.knownHosts.trust(row.host, row.port, keyType, fingerprint)
      repo.connections.update(id, { hostKeyFingerprint: fingerprint })
      logger.info(`host key trusted: ${row.host}:${row.port} ${keyType}`)
    },

    /* ------------------------------------------------------------ 建连/断连 */

    async connect(id: string): Promise<ConnectionState> {
      const row = repo.connections.get(id)
      if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { id })

      const trusted = trustedFingerprints(row.host, row.port)
      // 已有信任记录 → 严格校验；没有则宽松采集后由 UI 走确认流程
      const strict = trusted.length > 0
      const options = buildConnectOptions(
        row,
        strict ? 'strict' : 'accept-any',
        strict ? (row.hostKeyFingerprint ?? trusted[0].fingerprint) : undefined
      )

      const result = await pool.connect(options)

      // 严格模式下若指纹与记录不符，hostVerifier 已经拒绝，走不到这里
      if (strict) {
        const verdict = verifyHostKey(result.hostKeyFingerprint, trusted, result.hostKeyType)
        if (verdict.status === 'mismatch') {
          pool.disconnect(id)
          throw new AppError(ErrorCode.E_HOST_KEY_CHANGED, {
            expected: verdict.expected,
            actual: verdict.actual
          })
        }
      }

      repo.connections.markConnected(id)
      return { connectionId: id, status: 'online', hostKeyFingerprint: result.hostKeyFingerprint }
    },

    disconnect(id: string): void {
      pool.disconnect(id)
    },

    state(id: string): ConnectionState {
      return pool.getState(id)
    },

    /**
     * 自动登录（方案书 §7.3）：应用启动后为 auto_connect=1 的连接建连。
     * 并发上限 3，**失败不阻塞启动**。
     */
    async autoConnectAll(concurrency = 3): Promise<{ ok: number; failed: number }> {
      const rows = repo.connections.listAutoConnect()
      let ok = 0
      let failed = 0
      const queue = [...rows]

      const worker = async (): Promise<void> => {
        for (;;) {
          const row = queue.shift()
          if (!row) return
          try {
            await this.connect(row.id)
            ok++
          } catch (err) {
            failed++
            const e = err instanceof AppError ? err : mapConnectError(err as Error)
            logger.warn(`auto connect failed for ${row.name}: ${e.code} ${e.message}`)
            // 写审计，便于用户在界面上看到失败原因（方案书 §7.3）
            repo.audit.write({
              level: 'warn',
              scope: 'connection',
              refId: row.id,
              message: `自动登录失败：${e.message}`,
              detail: JSON.stringify({ code: e.code })
            })
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker))
      logger.info(`auto connect finished: ok=${ok} failed=${failed}`)
      return { ok, failed }
    }
  }
}

export type ConnectionService = ReturnType<typeof createConnectionService>

/* -------------------------------------------------------------------- 校验 */

function assertInput(input: ConnectionInput): void {
  const issues: string[] = []
  if (!input.name?.trim()) issues.push('name')
  if (!input.host?.trim()) issues.push('host')
  if (!input.username?.trim()) issues.push('username')
  if (!input.authType) issues.push('authType')
  if (input.port !== undefined && (input.port < 1 || input.port > 65535)) issues.push('port')
  if (input.authType === 'privateKey' && !input.privateKeyPath) issues.push('privateKeyPath')
  if (issues.length > 0) {
    throw new AppError(ErrorCode.E_PARAM, { issues })
  }
}
