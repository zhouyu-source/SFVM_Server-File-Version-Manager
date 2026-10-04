/**
 * SSH 连接封装（T03.3 / T03.4 / T03.5 / T03.6 / T03.7）。
 *
 * 这一层是"远端交互的唯一入口"（方案书 §2.3 可维护性要求），职责：
 * - 把 ssh2 的事件式 API 包成 Promise，并统一错误码
 * - 主机指纹 TOFU 校验（T03.4）
 * - keepalive 与自动重连退避（T03.5），**发布中禁止重连**（T03.6）
 * - 建连后做一次能力探测并缓存（T03.7）
 *
 * 设计要点：这里**不碰数据库**。指纹的信任与否由上层 ConnectionService
 * 依据 known_hosts 判定后传入；这样本层可独立测试，也避免循环依赖。
 */
import { createHash } from 'node:crypto'
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { guardSftp } from '../infra/sftp-guard'
import { backoffDelay, shouldReconnect, MAX_RETRIES } from '../infra/backoff'
import { assertCommandAllowed, buildWriteProbeCommand } from '../infra/remote-exec'
import { normalizeFingerprint } from '../../shared/host-key'
import {
  parsePlatform,
  commandExists,
  type ConnectionCapability,
  type RemotePlatform
} from '../infra/capability'
import type { ConnectionState, ConnectionStatus } from '../../shared/contracts/connection-state'

/** 建连所需的全部信息（含已解密的凭据，故只在本层内部流转）。 */
export interface SshConnectOptions {
  connectionId: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  /** 已解密的密码（password 认证）或私钥口令（privateKey + passphrase） */
  secret?: string
  /** 私钥内容（调用方读盘后传入；本层不读文件） */
  privateKey?: Buffer | string
  keepaliveMs?: number
  /**
   * 主机密钥校验策略：
   * - 'accept-any'：只采集指纹，不做判定（TOFU 的采集阶段 /
   *   或上层已确认指纹一致）。判定由上层用 shared/host-key 的纯逻辑完成。
   * - 'strict'：只接受 expectedFingerprint，否则拒绝。
   */
  hostKeyPolicy: 'accept-any' | 'strict'
  expectedFingerprint?: string
  /** 探测时用到的额外路径（判断父目录可写性时需要） */
  probePaths?: string[]
}

export interface ConnectResult {
  capability: ConnectionCapability
  hostKeyFingerprint: string
  hostKeyType: string
  /** 服务器标识串，排障用 */
  banner?: string
}

export type StateListener = (state: ConnectionState) => void

interface Pooled {
  client: Client
  options: SshConnectOptions
  capability: ConnectionCapability
  hostKeyFingerprint: string
  hostKeyType: string
  /** 该连接上是否有进行中的发布/回滚任务（T03.6） */
  busy: boolean
  /** 用户主动断开，不触发重连 */
  userInitiated: boolean
  retryAttempt: number
  reconnectTimer?: NodeJS.Timeout
}

/**
 * 连接池（T03.6）：以 connectionId 为键。
 *
 * 注意：同一连接上的 SFTP 通道是**独立创建**的（见 sftp()），互不阻塞，
 * 所以池里存的是 ssh2 Client，而不是 SFTP 句柄。
 */
export class SshConnectionPool {
  private pool = new Map<string, Pooled>()
  private listeners = new Set<StateListener>()

  /** 订阅状态变化（T03.3 的状态广播）。返回取消订阅函数。 */
  onState(fn: StateListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(state: ConnectionState): void {
    for (const fn of this.listeners) {
      try {
        fn(state)
      } catch (err) {
        logger.warn(`state listener failed: ${(err as Error).message}`)
      }
    }
  }

  private setState(
    id: string,
    status: ConnectionStatus,
    extra: Partial<ConnectionState> = {}
  ): void {
    this.emit({ connectionId: id, status, ...extra })
  }

  /** 当前状态快照（UI 打开时初始化用）。 */
  getState(connectionId: string): ConnectionState {
    const p = this.pool.get(connectionId)
    if (!p) return { connectionId, status: 'idle' }
    const status: ConnectionStatus = p.busy ? 'online' : 'online'
    return {
      connectionId,
      status,
      lastConnectedAt: undefined,
      retryAttempt: p.retryAttempt,
      hostKeyFingerprint: p.hostKeyFingerprint
    }
  }

  isOnline(connectionId: string): boolean {
    return this.pool.has(connectionId)
  }

  capabilityOf(connectionId: string): ConnectionCapability | undefined {
    return this.pool.get(connectionId)?.capability
  }

  /** 标记该连接上有发布任务在执行（T03.6：期间禁止自动重连）。 */
  setBusy(connectionId: string, busy: boolean): void {
    const p = this.pool.get(connectionId)
    if (p) p.busy = busy
  }

  isBusy(connectionId: string): boolean {
    return this.pool.get(connectionId)?.busy ?? false
  }

  /**
   * 建连（T03.3）。成功后做能力探测（T03.7）并缓存。
   */
  async connect(opts: SshConnectOptions): Promise<ConnectResult> {
    const id = opts.connectionId
    // 已在线则直接复用（会话复用，方案书 §6.2）
    const existing = this.pool.get(id)
    if (existing) {
      return {
        capability: existing.capability,
        hostKeyFingerprint: existing.hostKeyFingerprint,
        hostKeyType: existing.hostKeyType
      }
    }

    this.setState(id, 'connecting')

    const client = new Client()
    let capturedFingerprint = ''
    let capturedKeyType = ''

    const connectConfig: ConnectConfig = {
      host: opts.host,
      port: opts.port,
      username: opts.username,
      keepaliveInterval: opts.keepaliveMs ?? 15000,
      // 方案书 §6.2：keepaliveCountMax = 3
      keepaliveCountMax: 3,
      readyTimeout: 20000,
      // T03.4：在回调里采集指纹并按策略判定
      hostVerifier: (key: Buffer | string, verify: (ok: boolean) => void) => {
        try {
          const info = fingerprintOf(key)
          capturedFingerprint = info.fingerprint
          capturedKeyType = info.keyType

          if (opts.hostKeyPolicy === 'strict' && opts.expectedFingerprint) {
            const ok =
              normalizeFingerprint(capturedFingerprint) ===
              normalizeFingerprint(opts.expectedFingerprint)
            if (!ok) {
              logger.warn(`host key mismatch for ${opts.host} (${capturedKeyType})`)
            }
            verify(ok)
            return
          }
          // accept-any：先放行以便拿到指纹，由上层决定是否信任
          verify(true)
        } catch (err) {
          logger.warn(`hostVerifier failed: ${(err as Error).message}`)
          verify(false)
        }
      }
    }

    // 认证方式
    if (opts.authType === 'password') {
      if (!opts.secret) throw new AppError(ErrorCode.E_CONN_AUTH, { reason: 'password-required' })
      connectConfig.password = opts.secret
    } else if (opts.authType === 'privateKey') {
      if (!opts.privateKey)
        throw new AppError(ErrorCode.E_CONN_AUTH, { reason: 'privateKey-required' })
      connectConfig.privateKey = opts.privateKey
      if (opts.secret) connectConfig.passphrase = opts.secret
    } else {
      // agent 认证：交给 ssh2 从 SSH_AUTH_SOCK / Pageant 取
      connectConfig.agent = process.env['SSH_AUTH_SOCK']
      if (!connectConfig.agent && process.platform !== 'win32') {
        throw new AppError(ErrorCode.E_CONN_AUTH, { reason: 'agent-unavailable' })
      }
      connectConfig.agentForward = false
    }

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        cleanup()
        resolve()
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(mapConnectError(err))
      }
      const onClose = (): void => {
        cleanup()
        reject(new AppError(ErrorCode.E_CONN_LOST, { reason: 'closed-before-ready' }))
      }
      const cleanup = (): void => {
        client.removeListener('ready', onReady)
        client.removeListener('error', onError)
        client.removeListener('close', onClose)
      }
      client.once('ready', onReady)
      client.once('error', onError)
      client.once('close', onClose)
      client.connect(connectConfig)
    })

    const banner = (client as unknown as { _sock?: { remoteVer?: string } })._sock?.remoteVer

    // T03.7 能力探测
    const capability = await this.detectCapability(client, opts.probePaths ?? [])

    const pooled: Pooled = {
      client,
      options: opts,
      capability,
      hostKeyFingerprint: capturedFingerprint,
      hostKeyType: capturedKeyType,
      busy: false,
      userInitiated: false,
      retryAttempt: 0
    }
    this.pool.set(id, pooled)

    // 断线处理：按退避重连（T03.5 / T03.6）
    client.on('close', () => {
      if (!this.pool.has(id)) return
      this.handleDisconnect(id)
    })
    client.on('error', (err: Error) => {
      logger.warn(`ssh error on ${opts.host}: ${err.message}`)
    })

    const now = new Date().toISOString()
    this.setState(id, 'online', { lastConnectedAt: now, hostKeyFingerprint: capturedFingerprint })
    logger.info(
      `ssh connected: ${opts.username}@${opts.host}:${opts.port} ` +
        `key=${capturedKeyType} cap=[${capability.platform}]`
    )

    return {
      capability,
      hostKeyFingerprint: capturedFingerprint,
      hostKeyType: capturedKeyType,
      banner
    }
  }

  /** 主动断开（不触发重连）。 */
  disconnect(connectionId: string): void {
    const p = this.pool.get(connectionId)
    if (!p) return
    p.userInitiated = true
    if (p.reconnectTimer) clearTimeout(p.reconnectTimer)
    this.pool.delete(connectionId)
    try {
      p.client.end()
    } catch {
      /* 已断开 */
    }
    this.setState(connectionId, 'idle')
  }

  /** 全部断开（应用退出时）。 */
  disconnectAll(): void {
    for (const id of [...this.pool.keys()]) this.disconnect(id)
  }

  /** 断线后的退避重连（T03.5），受 busy 与用户主动断开约束（T03.6）。 */
  private handleDisconnect(id: string): void {
    const p = this.pool.get(id)
    if (!p) return
    this.pool.delete(id)

    const allow = shouldReconnect({
      attempt: p.retryAttempt,
      busy: p.busy,
      userInitiated: p.userInitiated
    })

    const readyToReconnect = allow && p.retryAttempt < MAX_RETRIES

    if (!readyToReconnect) {
      const reason = p.busy
        ? '发布任务执行期间连接断开，为避免状态不一致，不会自动重连'
        : p.userInitiated
          ? '已手动断开'
          : `已重试 ${p.retryAttempt} 次仍未成功，请检查网络或服务器状态`
      this.setState(id, 'offline', {
        reason,
        code: p.busy ? ErrorCode.E_CONN_LOST : undefined,
        retryAttempt: p.retryAttempt
      })
      logger.warn(`ssh disconnected, no reconnect: ${reason}`)
      return
    }

    const delay = backoffDelay(p.retryAttempt)
    this.setState(id, 'reconnecting', {
      retryAttempt: p.retryAttempt + 1,
      reason: `连接已断开，${Math.round(delay / 1000)} 秒后重试（第 ${p.retryAttempt + 1} 次）`
    })

    p.reconnectTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.connect({ ...p.options, connectionId: id })
        } catch (err) {
          const next = p.retryAttempt + 1
          const again = this.pool.get(id)
          if (again) again.retryAttempt = next
          // 递归继续退避：把累计次数带回去
          const carry: Pooled = { ...p, retryAttempt: next }
          this.pool.set(id, carry)
          this.pool.delete(id)
          this.handleDisconnect(id)
          logger.warn(`reconnect attempt ${next} failed: ${(err as Error).message}`)
        }
      })()
    }, delay)
  }

  /**
   * 取 SFTP 通道（每次独立创建，互不阻塞）。
   *
   * 返回值外面套了 `guardSftp`：ssh2 的通道在连接断掉之后**所有方法都不再回调**
   * （真机实测见 `infra/sftp-guard.ts` 文件头），不包这一层的话"网线一拔，
   * 发布任务永远停在 50%"—— 既不失败也不结束。包装对上层完全透明。
   */
  async sftp(connectionId: string): Promise<SFTPWrapper> {
    const p = this.pool.get(connectionId)
    if (!p) throw new AppError(ErrorCode.E_CONN_LOST, { connectionId })
    const raw = await new Promise<SFTPWrapper>((resolve, reject) => {
      p.client.sftp((err, sftp) => {
        if (err) reject(new AppError(ErrorCode.E_SFTP_CHANNEL, { original: err.message }))
        else resolve(sftp)
      })
    })
    return guardSftp(raw, {
      label: `${p.options.username}@${p.options.host}:${p.options.port}`
    })
  }

  /**
   * 执行一条命令并收集输出。
   *
   * **所有命令都必须过白名单自检**（T08.1 的"收口"）：命令由 `infra/remote-exec`
   * 的模板生成，这里是最后一道闸。放在连接池而不是各调用点，
   * 是为了让"绕过模板直接拼字符串"不可能溜到线上去 —— 无论谁调用都会先炸。
   */
  async exec(
    connectionId: string,
    command: string,
    timeoutMs = 15000
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const p = this.pool.get(connectionId)
    if (!p) throw new AppError(ErrorCode.E_CONN_LOST, { connectionId })
    assertCommandAllowed(command)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AppError(ErrorCode.E_CONN_TIMEOUT, { command })),
        timeoutMs
      )
      p.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          reject(new AppError(ErrorCode.E_CONN_LOST, { original: err.message }))
          return
        }
        let stdout = ''
        let stderr = ''
        let code: number | null = null
        stream.on('data', (d: Buffer) => {
          stdout += d.toString('utf8')
        })
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8')
        })
        stream.on('exit', (c: number | null) => {
          code = c
        })
        stream.on('close', () => {
          clearTimeout(timer)
          resolve({ stdout, stderr, code })
        })
      })
    })
  }

  /**
   * 能力探测（T03.7）。
   * 一次多命令合并执行，减少往返；解析交给 infra/capability 的纯函数。
   *
   * 公开为方法：T05.7 的「环境体检」需要对一条连接做一次只读探测，
   * 而不必把它加进池里（体检是只读的，探测完即可断开）。
   */
  async detectCapability(client: Client, probePaths: string[] = []): Promise<ConnectionCapability> {
    const run = (cmd: string): Promise<{ stdout: string; code: number | null }> =>
      new Promise((resolve) => {
        // 探针命令同样必须过白名单 —— 这一层以前是手拼字符串的
        try {
          assertCommandAllowed(cmd)
        } catch (err) {
          logger.warn(`capability probe rejected by whitelist: ${(err as Error).message}`)
          resolve({ stdout: '', code: null })
          return
        }
        const timer = setTimeout(() => resolve({ stdout: '', code: null }), 8000)
        try {
          client.exec(cmd, (err, stream) => {
            if (err) {
              clearTimeout(timer)
              resolve({ stdout: '', code: null })
              return
            }
            let out = ''
            let code: number | null = null
            stream.on('data', (d: Buffer) => {
              out += d.toString('utf8')
            })
            stream.stderr.on('data', () => {
              /* 忽略 */
            })
            stream.on('exit', (c: number | null) => {
              code = c
            })
            stream.on('close', () => {
              clearTimeout(timer)
              resolve({ stdout: out, code })
            })
          })
        } catch {
          clearTimeout(timer)
          resolve({ stdout: '', code: null })
        }
      })

    const [unameR, shaR, shasumR, dfR, homeR] = await Promise.all([
      run('uname -s'),
      run('command -v sha256sum'),
      run('command -v shasum'),
      run('command -v df'),
      run('printf %s "$HOME"')
    ])

    let platform: RemotePlatform = parsePlatform(unameR.stdout)
    if (platform === 'unknown' && unameR.code !== 0) {
      // uname 不存在 → 很可能是 Windows
      platform = 'windows'
    }

    // 写权限探测：对每个待检路径判断父目录是否可写
    //
    // 走 `buildWriteProbeCommand`（`test -w <路径>`）而不是手拼字符串：
    // 旧实现自己做了 `'` → `'\''` 的转义，但**没有**先过 `assertSafeRemotePath`，
    // 于是带换行的路径可以逃逸出引号（换行能截断单引号参数）。
    // 现在路径先过 `assertSafeRemotePath` 再过 `quoteShellArg`，并且用退出码而非
    // `echo yes/no` 表达结果 —— 白名单里因此不需要多一个 `echo`。
    if (probePaths.length > 0 && platform !== 'windows') {
      for (const p of probePaths.slice(0, 5)) {
        let cmd: string
        try {
          cmd = buildWriteProbeCommand(p)
        } catch (err) {
          logger.warn(`write-probe skipped (unsafe path ${JSON.stringify(p)}): ${(err as Error).message}`)
          continue
        }
        const r = await run(cmd)
        logger.debug(`write-probe ${p}: writable=${r.code === 0}`)
      }
    }

    const capability: ConnectionCapability = {
      hasSha256sum: commandExists(shaR.stdout) || shaR.code === 0,
      hasShasum: commandExists(shasumR.stdout) || shasumR.code === 0,
      hasDf: commandExists(dfR.stdout) || dfR.code === 0,
      platform,
      homeDir: homeR.stdout.trim()
    }
    logger.info(`capability probe: ${JSON.stringify(capability)}`)
    return capability
  }
}

/**
 * 由 ssh2 给的密钥计算指纹。
 *
 * ssh2 的 hostVerifier 第一个参数是**整个公钥 blob**（不是裸摘要），
 * 所以指纹要自己对它算 SHA-256，不能直接当摘要用。
 * 算法名从 blob 开头解析（RFC 4253：4 字节长度 + 算法名）。
 */
export function fingerprintOf(keyBlob: Buffer | string): { fingerprint: string; keyType: string } {
  const buf = Buffer.isBuffer(keyBlob) ? keyBlob : Buffer.from(keyBlob, 'binary')

  // 解析算法名：前 4 字节是长度
  let keyType = 'unknown'
  try {
    if (buf.length > 4) {
      const len = buf.readUInt32BE(0)
      if (len > 0 && len <= buf.length - 4) keyType = buf.subarray(4, 4 + len).toString('ascii')
    }
  } catch {
    /* 解析失败就保持 unknown */
  }

  const digest = createHash('sha256').update(buf).digest()
  // 与 OpenSSH 的 SHA256 指纹一致：base64 去掉末尾的 '='
  const fingerprint = digest.toString('base64').replace(/=+$/, '')
  return { fingerprint, keyType }
}

/** 把 ssh2 的错误转成带中文文案的 AppError。 */
export function mapConnectError(err: Error & { level?: string; code?: string }): AppError {
  const msg = err.message ?? ''
  const level = err.level ?? ''

  if (
    /authentication|All configured authentication methods failed/i.test(msg) ||
    level === 'client-authentication'
  ) {
    return new AppError(ErrorCode.E_CONN_AUTH, { original: msg })
  }
  if (/timed out|ETIMEDOUT|timeout/i.test(msg)) {
    return new AppError(ErrorCode.E_CONN_TIMEOUT, { original: msg })
  }
  if (/ECONNREFUSED|refused/i.test(msg)) {
    return new AppError(ErrorCode.E_CONN_REFUSED, { original: msg })
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return new AppError(ErrorCode.E_CONN_REFUSED, { original: msg, reason: 'dns' })
  }
  if (/Host key verification failed|handshake/i.test(msg)) {
    return new AppError(ErrorCode.E_HOST_KEY_CHANGED, { original: msg })
  }
  return new AppError(ErrorCode.E_CONN_LOST, { original: msg })
}
