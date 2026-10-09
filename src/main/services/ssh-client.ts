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
import { StringDecoder } from 'node:string_decoder'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { guardSftp } from '../infra/sftp-guard'
import { backoffDelay, shouldReconnect, MAX_RETRIES } from '../infra/backoff'
import { assertCommandAllowed } from '../infra/remote-exec'
import { STEP_LOG_MAX_BYTES } from '../../shared/contracts/script'
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
}

export interface ConnectResult {
  capability: ConnectionCapability
  hostKeyFingerprint: string
  hostKeyType: string
  /** 服务器标识串，排障用 */
  banner?: string
}

export type StateListener = (state: ConnectionState) => void

export interface SshConnectionPoolOptions {
  /**
   * 「允许执行自定义脚本」总闸（**现取**，所以注入的是函数不是值）。
   *
   * 连接池比设置服务先构造（池在 `main/index.ts` 里更早），所以接线层传进来的
   * 是一个可后置赋值的读函数；默认不传 = 恒为 `false` = 拒绝。
   * 这个默认值的取向很重要：**万一接线漏了，行为是"功能不可用"，而不是"悄悄放开"**。
   *
   * 关于它守的是什么，见 `execRaw()` 的注释。
   */
  allowRawExec?: () => boolean
}

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
  /** 最近一次连接成功时间（ISO）—— 供 UI 打开时初始化状态快照（原来恒为 undefined）。 */
  lastConnectedAt?: string
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
  private options: SshConnectionPoolOptions
  /**
   * 用户**主动断开**过的 id（M9）。
   *
   * `disconnect()` 以前依赖 `pool.get()`，而 connecting / reconnecting 期间池里
   * 根本没有条目 —— 于是断开请求被静默丢弃，几秒后连接又自己回来了。这个集合把
   * "用户不想要这条连接"这件事从"池里有没有"里解耦出来：
   * - `connectOnce()` 在 `pool.set` 之前自查 —— 建连期间被断开的那条会话必须
   *   `end()` 掉而不是上线（否则它成了一条谁也管不到的孤儿会话）；
   * - `handleDisconnect()`/重连定时器自查 —— 等待窗口里被断开的连接不再退避重连。
   *
   * 标记的**消费**有两处：`connect()`（用户显式建连 = 他改主意了，直接清掉，
   * 否则一次普通断开会把后续所有连接都挡掉）与 `consumeUserClosed()`（重连链）。
   */
  private userClosed = new Set<string>()
  /**
   * 每 id 正在进行的建连 Promise（M10：并发去重）。
   *
   * `connect()` 里"查池"与"写池"之间隔着建连 + 最长 8 秒的能力探测 —— 双击「连接」、
   * 自动登录与手动连接撞车、或 job 的 `openPorts` 与重连窗口撞上时，两次都会完整
   * 建出一条 SSH 会话。留在池外的那条**永远不会被 `end()`**（`disconnectAll`
   * 遍历不到它），并且它注册的 `close` 会在将来把池里那条**正常**连接删掉、
   * 触发一次无中生有的「断线」。这里让同 id 的并发请求共用同一个 Promise。
   */
  private inflight = new Map<string, Promise<ConnectResult>>()
  /**
   * 每条连接当前打开的 SFTP 通道（S2）。
   *
   * `pool.sftp()` 每次都新开一条 SFTP 子系统通道，而 sshd 默认 `MaxSessions=10`
   * —— 以前这些通道**从不 `end()`**，累计到上限后 `client.sftp()` 收
   * `CHANNEL_OPEN_FAILURE`，被上层归一成「SSH 连接已断开」，排障方向彻底被带偏。
   * 正常路径由 `withSftp()` 的 `finally` 保证释放；这份记账是给 `disconnect()`
   * 用的：断开时先把通道收掉、再断传输，服务端的 sftp-server 才不会挂到 TCP 断开。
   */
  private channels = new Map<string, Set<SFTPWrapper>>()

  constructor(options: SshConnectionPoolOptions = {}) {
    this.options = options
  }

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
    /**
     * 状态维度里**没有** busy 这一档：`p.busy` 只是"这条连接上正跑着发布/回滚"，
     * 底层连接依旧是可用的 online（这也正是原来 `p.busy ? 'online' : 'online'`
     * 那个恒等三元想表达的意思 —— 只是写成了一个让人怀疑写错的谜语）。
     */
    return {
      connectionId,
      status: 'online',
      lastConnectedAt: p.lastConnectedAt,
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
   *
   * `fromReconnect` 只给内部的退避重连用（见 `handleDisconnect`）：重连**不**清
   * "用户主动断开"的标记，否则"在等待窗口里点了断开"会被重连无视。对外的调用
   * （连接页、自动登录、job 的 `openPorts`）都用默认值。
   */
  async connect(opts: SshConnectOptions, fromReconnect = false): Promise<ConnectResult> {
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

    /**
     * M9：显式建连 = 用户此刻确实想连上，清掉上一轮"主动断开"留下的标记。
     * 不在这里清的话，一次普通的"连上→断开"之后，所有后续连接都会被那条陈旧标记
     * 挡掉。重连（`fromReconnect`）**不**清 —— 它必须能被一次断开终止。
     */
    if (!fromReconnect) this.userClosed.delete(id)

    // M10：同 id 的并发请求共用同一条建连（见 `inflight` 字段注释）
    const pending = this.inflight.get(id)
    if (pending) return pending

    const task = this.connectOnce(opts)
    this.inflight.set(id, task)
    try {
      return await task
    } finally {
      this.inflight.delete(id)
    }
  }

  private async connectOnce(opts: SshConnectOptions): Promise<ConnectResult> {
    const id = opts.connectionId

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

          /**
           * L1：`strict` 但**没给指纹**时也要否掉。
           *
           * 旧判据是 `strict && expectedFingerprint` —— 少了后半个条件就落进下面的
           * accept-any 放行，等于"策略写着 strict，实际谁都能连"。两个条件只能取
           * **更严**的那侧：连不上是用户看得见的，静默接受一条陌生主机密钥是看不见的。
           */
          if (opts.hostKeyPolicy === 'strict') {
            if (!opts.expectedFingerprint) {
              logger.warn(`host key policy is strict but no expected fingerprint for ${opts.host}`)
              verify(false)
              return
            }
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
      // agent 认证：交给 ssh2 从 SSH_AUTH_SOCK / Pageant 取。
      //
      // Windows 上通常**没有** SSH_AUTH_SOCK（那是 OpenSSH for Windows / Cygwin 的机制），
      // 想用 agent 就得走 Pageant。而 ssh2 只在 `agent` 恰为字符串 `'pageant'` 时才会
      // 构造 `PageantAgent`（见 ssh2/lib/agent.js `createAgent`）；其余情况下
      // `cfg.agent` 是 undefined 就被直接置空 → 用户选了 agent 认证却表现为"认证失败"，
      // 且错误里看不出是这里没接上。
      const agentSock = process.env['SSH_AUTH_SOCK']
      if (agentSock) {
        connectConfig.agent = agentSock
      } else if (process.platform === 'win32') {
        connectConfig.agent = 'pageant'
      } else {
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

    /**
     * M9：这条建连**进行中**时用户点了断开（`disconnect()` 会往 `userClosed` 里记）。
     *
     * 先 `end()` 掉再抛错 —— 不 end 的话它就是一条谁也不认领的孤儿会话，会一直挂在
     * 服务端直到进程退出（`disconnectAll` 遍历的是池，找不到它）。标记**不在这里清**：
     * 留给重连链（`handleDisconnect` / 定时器）消费，那两处据此彻底停手。
     */
    if (this.userClosed.has(id)) {
      try {
        client.end()
      } catch {
        /* 已经断了 */
      }
      throw new AppError(ErrorCode.E_CONN_LOST, { connectionId: id, reason: 'closed-by-user' })
    }

    /**
     * M10 的第二道（第一道是 `inflight` 去重）：走到这里若池里已经有了一条
     * （别的路径刚完成建连），就把这条刚建好的 `end()` 掉并复用既有的 —— 否则
     * 留在池外的那条会成为孤儿会话，而它注册的 `close` 会在将来把池里那条正常
     * 连接删掉、触发一次无中生有的「断线」。
     *
     * 放在能力探测**之前**：探测最坏要跑 8 秒，为一条注定要丢掉的会话白等没有意义。
     */
    const raced = this.pool.get(id)
    if (raced) {
      try {
        client.end()
      } catch {
        /* 已经断了 */
      }
      logger.warn(`ssh connect raced for ${id}：复用已有会话，丢弃刚建好的那条`)
      return {
        capability: raced.capability,
        hostKeyFingerprint: raced.hostKeyFingerprint,
        hostKeyType: raced.hostKeyType
      }
    }

    const banner = (client as unknown as { _sock?: { remoteVer?: string } })._sock?.remoteVer

    // T03.7 能力探测
    const capability = await this.detectCapability(client)

    // 探测这 8 秒里用户也可能点了断开 —— 同一道闸补在 `pool.set` 正前方
    if (this.userClosed.has(id)) {
      try {
        client.end()
      } catch {
        /* 已经断了 */
      }
      throw new AppError(ErrorCode.E_CONN_LOST, { connectionId: id, reason: 'closed-by-user' })
    }

    const pooled: Pooled = {
      client,
      options: opts,
      capability,
      hostKeyFingerprint: capturedFingerprint,
      hostKeyType: capturedKeyType,
      busy: false,
      userInitiated: false,
      retryAttempt: 0,
      lastConnectedAt: new Date().toISOString()
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

    const now = pooled.lastConnectedAt ?? new Date().toISOString()
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

  /**
   * 主动断开（不触发重连）。
   *
   * M9：**不依赖 `pool.get`**。connecting / reconnecting 期间池里没有条目，旧写法
   * 会在 `if (!p) return` 处静默丢弃这次请求，几秒后连接又自己回来；应用退出的
   * 清理路径（`disconnectAll`）同样漏。现在改成：先把 id 记进 `userClosed`，
   * 在途的建连与待定的重连都会各自看到它并停手。
   */
  disconnect(connectionId: string): void {
    this.userClosed.add(connectionId)

    // S2：先把这条连接上的 SFTP 通道收掉，再断传输。只靠 `client.end()` 的话，
    // 服务端的 sftp-server 子进程要挂到整条 TCP 被拉掉才退。
    for (const s of [...(this.channels.get(connectionId) ?? [])]) {
      try {
        s.end()
      } catch (err) {
        logger.debug(`关闭 SFTP 通道失败（${connectionId}）：${(err as Error).message}`)
      }
    }
    this.channels.delete(connectionId)

    const p = this.pool.get(connectionId)
    if (p) {
      p.userInitiated = true
      if (p.reconnectTimer) clearTimeout(p.reconnectTimer)
      this.pool.delete(connectionId)
      try {
        p.client.end()
      } catch {
        /* 已断开 */
      }
    }
    // 池里没有它时也要广播：用户点的这次"断开"必须让界面从 connecting 回到 idle
    this.setState(connectionId, 'idle')
  }

  /** 全部断开（应用退出时）。 */
  disconnectAll(): void {
    /**
     * M9：不能只遍历池 —— connecting / reconnecting 期间池里没有条目，
     * 那些会话同样要被收掉（`disconnect()` 现在会在 `userClosed` 上做记号，
     * 让在途的建连自己 abort）。`inflight` 的键就是"正在建连的连接"。
     */
    const ids = new Set([...this.pool.keys(), ...this.inflight.keys()])
    for (const id of ids) this.disconnect(id)
  }

  /**
   * 若该 id 处在"用户已主动断开"状态，就把标记消费掉、状态归位，返回 `true`。
   *
   * 只在**重连链**里调用（`handleDisconnect` 首行与重连定时器）。显式建连那条路
   * 走 `connect()` 里的 `userClosed.delete()` —— 用户点了"连接"就是改主意了。
   */
  private consumeUserClosed(id: string): boolean {
    if (!this.userClosed.has(id)) return false
    this.userClosed.delete(id)
    this.pool.delete(id)
    this.setState(id, 'idle')
    return true
  }

  /** 断线后的退避重连（T03.5），受 busy 与用户主动断开约束（T03.6）。 */
  private handleDisconnect(id: string): void {
    // M9：等待窗口里用户点过断开 → 到此为止，别再退避重连。
    // 标记在这里消费掉，而不是在 `disconnect()` 里删：断开时"还没有 in-flight 建连"
    // 的普通情形也要能被接住。
    if (this.consumeUserClosed(id)) {
      logger.info(`ssh reconnect cancelled by user: ${id}`)
      return
    }

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
      // M9：等待窗口里用户点了断开 → 到点直接放弃，不再建连、不再退避。
      // （`disconnect()` 拿不到这个定时器的句柄 —— 它在 `handleDisconnect` 里
      // `pool.delete` 之后才被挂到一个已被移出池的对象上，所以只能到点自查。）
      if (this.consumeUserClosed(id)) {
        logger.info(`ssh reconnect cancelled by user: ${id}`)
        return
      }
      void (async () => {
        try {
          // `fromReconnect = true`：重连不清 `userClosed`（它必须还能被一次断开终止）
          await this.connect({ ...p.options, connectionId: id }, true)
        } catch (err) {
          const next = p.retryAttempt + 1
          // 把累计次数带回去，再交给 handleDisconnect 判断"继续退避还是放弃"。
          // P1-5：这里**不能**先 pool.delete —— handleDisconnect 首行 `if (!p) return`，
          // 先删等于让重连链在第一次失败后就断掉，状态永远停在 reconnecting。
          // 删除动作由 handleDisconnect 自己做（它读完 p 就会删）。
          const carry: Pooled = { ...p, retryAttempt: next }
          this.pool.set(id, carry)
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
   *
   * **优先用 `withSftp()` / `openChannel()` 而不是直接用它**（S2）：通道是有限的
   * 系统资源（sshd 默认 `MaxSessions=10`），谁拿到谁负责释放。直接调用只留给
   * 集成测试那种"取一条句柄全用例复用"的场景。
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
    const guarded = guardSftp(raw, {
      label: `${p.options.username}@${p.options.host}:${p.options.port}`
    })

    // S2 记账：`disconnect()` 要能把这条连接上仍开着的通道一并关掉。
    // 通道自己关闭（`withSftp` 的 finally / 通道出错）时摘掉这一笔。
    const set = this.channels.get(connectionId) ?? new Set<SFTPWrapper>()
    set.add(guarded)
    this.channels.set(connectionId, set)
    guarded.on('close', () => this.dropChannel(connectionId, guarded))

    return guarded
  }

  /**
   * 开一条 SFTP 通道，并带回一个**幂等的释放函数**（S2）。
   *
   * 与 `withSftp` 的分工（两者共用同一份释放逻辑）：
   *
   * - 作用域在本函数内部的（一次服务调用内用完即弃）→ **`withSftp`**，不可能忘；
   * - 作用域**跨函数**的 → `openChannel` + 调用方在自己那一层 `finally` 里
   *   `release()`。发布/回滚/下载的端口对象就是这种：它要在 job 里活到操作结束，
   *   中途补偿还要在同一条通道上再删一次；而且这些端口是**注入**的
   *   （单测换成假端口，见 `ipc/deploy.ts` 的 `openPorts`），
   *   所以"这次操作何时结束"只有接线层知道，释放也只能放在那里。
   *
   * `release` 幂等：重复调用不会二次 `end()`。`end()` 本身对已关闭的通道不抛，
   * 但重复走一遍记账会把 `channels` 弄乱，所以这里用 `released` 兜住。
   */
  async openChannel(connectionId: string): Promise<{ sftp: SFTPWrapper; release: () => void }> {
    const sftp = await this.sftp(connectionId)
    let released = false
    return {
      sftp,
      release: (): void => {
        if (released) return
        released = true
        this.dropChannel(connectionId, sftp)
        try {
          sftp.end()
        } catch (err) {
          logger.debug(`关闭 SFTP 通道失败（${connectionId}）：${(err as Error).message}`)
        }
      }
    }
  }

  /**
   * 在一条 SFTP 通道的**作用域**内做事，出作用域一定 `end()`（S2）。
   *
   * 这是"通道不会泄漏"的**结构性**保证 —— 以前各 IPC handler 各自 `pool.sftp()`
   * 然后一路用到函数结束，**全仓没有一处 `end()`**：同一条池内连接累计打开 10 条
   * 子系统通道就撞上 sshd 的 `MaxSessions`，报出来却是「SSH 连接已断开」，
   * 排障方向被彻底带偏。
   *
   * `finally` 里对 `end()` 做了兜底：通道若已因断线而死，`guardSftp` 会在
   * 这个方法上抛（有回调就回调、没回调就抛）—— 那不是我们该关心的错误。
   */
  async withSftp<T>(connectionId: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const { sftp, release } = await this.openChannel(connectionId)
    try {
      return await fn(sftp)
    } finally {
      release()
    }
  }

  /** 摘掉一条通道的记账（幂等）。 */
  private dropChannel(connectionId: string, sftp: SFTPWrapper): void {
    const set = this.channels.get(connectionId)
    if (!set) return
    set.delete(sftp)
    if (set.size === 0) this.channels.delete(connectionId)
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
      let settled = false
      let timedOut = false
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      let stream: ClientChannel | null = null
      let timer: NodeJS.Timeout | null = null
      let forceTimer: NodeJS.Timeout | null = null

      function cleanup(): void {
        if (timer) clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
      }
      function settle(fn: () => void): void {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }
      /**
       * 与 `execRaw` 同款：先 TERM 再关通道 —— 只 `close()` 的话通道断了、
       * 远端进程可能还在跑。
       */
      function killRemote(): void {
        if (!stream) return
        try {
          stream.signal('TERM')
        } catch (err) {
          logger.debug(`exec: signal TERM failed: ${(err as Error).message}`)
        }
        try {
          stream.close()
        } catch (err) {
          logger.debug(`exec: close failed: ${(err as Error).message}`)
        }
      }

      timer = setTimeout(() => {
        // P1-6：超时**不能只 reject** —— 通道与监听器都得收掉，否则远端命令
        // 继续跑、stdout 闭包继续增长，连续超时会累积（出带宽差的机器上做
        // 大目录哈希正是最常超时的场景）。先 TERM 再关通道，给 close 一点时间
        // 交回已收到的输出（超时那一刻的输出正是排障线索）；远端不理会 TERM
        // 则 3 秒兜底强制结束。
        timedOut = true
        killRemote()
        forceTimer = setTimeout(() => {
          killRemote()
          // 不把 `command` 塞进 detail：它会被 `job.ts:toErrorInfo()` 原样带进任务
          // 失败详情交给渲染层展示，而这条通道的命令虽由模板生成、眼下不含凭据，
          // 但没有必要在 UI 里出现 —— 排查靠日志（logger 已记命令，且过脱敏）。
          // 只留 `timeoutMs` 这类非敏感上下文。
          settle(() => reject(new AppError(ErrorCode.E_CONN_TIMEOUT, { timeoutMs })))
        }, 3000)
      }, timeoutMs)

      p.client.exec(command, (err, ch) => {
        if (err) {
          settle(() => reject(new AppError(ErrorCode.E_CONN_LOST, { original: err.message })))
          return
        }
        if (settled) {
          // 兜底：超时兜底已把 Promise 结了，但通道刚建出来 —— 关掉它
          try {
            ch.close()
          } catch {
            /* 已经断了就算了 */
          }
          return
        }
        stream = ch
        ch.on('data', (d: Buffer) => {
          stdout += d.toString('utf8')
        })
        ch.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8')
        })
        ch.on('exit', (c: number | null) => {
          code = c
        })
        ch.on('close', () => {
          if (timedOut) {
            // 同上：不把命令内容放进 detail（会进任务失败详情）
            settle(() => reject(new AppError(ErrorCode.E_CONN_TIMEOUT, { timeoutMs })))
            return
          }
          settle(() => resolve({ stdout, stderr, code }))
        })
      })
    })
  }

  /**
   * 执行**用户填写的**脚本（B20）。
   *
   * ## 它和 `exec()` 是两条截然不同的路
   *
   * `exec()` 走的是"命令由模板生成、调用方永远不能提供命令字符串"那套
   * （`infra/remote-exec.ts` 的 `assertCommandAllowed()` 是出口自检）。
   * 用户脚本**本质就是一段任意命令**，不可能塞进那个白名单 —— 所以这里是
   * 一条**并列**的通道，不做白名单自检，代之以三道别的闸：
   *
   * 1. `allowRawExec()` 总闸（设置项 `allowUserScripts`，**默认关**）；
   * 2. 调用前的危险确认由**服务层**做：目前唯一的入口是流水线，它会在
   *    `runJob` / `stepRunJob` 里对生产环境目标校验 `assertProdConfirmed`
   *    （逐字输入目标名）。单条脚本那条 IPC 通道已按 M15 删除 —— 原来的注释
   *    宣称这里守着"首次执行 / 生产环境输目标名"两道，但单条通道上其实一道都没有，
   *    正是那次删除要解决的"注释与实现不一致"。
   * 3. 输出全量过 `scrubText` 脱敏后才进日志与留档。
   *
   * 关键是**不动 `exec()` 一个字符**：内部命令"不可能注入"的性质完整保住，
   * 而这里放开的是"用户明确要求的能力"，责任边界清楚。
   *
   * ## 与 `exec()` 的三处行为差异（都是有意为之）
   *
   * - **流式**：`onStdout`/`onStderr` 每收到一块就回调 —— 一次 `mvn package`
   *   要跑几分钟，攒到最后再返回等于没有进度。
   * - **可取消**：`opts.signal` 触发时先给远端进程发 `TERM` **再**关通道。
   *   只 `close()` 的话通道断了、远端进程还在跑（"取消了，但服务器上还在编译"）。
   * - **超时**：默认 5 分钟。超时同样先 `TERM`，并把 `timedOut` 交回调用方 ——
   *   超时与"进程自己以非零码退出"是两件不同的事，不能混成一个报错。
   */
  async execRaw(
    connectionId: string,
    command: string,
    opts: {
      timeoutMs?: number
      signal?: AbortSignal
      onStdout?: (chunk: Buffer) => void
      onStderr?: (chunk: Buffer) => void
    } = {}
  ): Promise<{
    stdout: string
    stderr: string
    code: number | null
    timedOut: boolean
    /** stdout 或 stderr 因为超过 `STEP_LOG_MAX_BYTES` 被截断（L4） */
    truncated: boolean
  }> {
    if (this.options.allowRawExec?.() !== true) {
      // 二道闸：即便将来有人绕过服务层直接调它，也会在这里被拦下。
      throw new AppError(ErrorCode.E_SCRIPT_DISABLED, { connectionId })
    }
    const p = this.pool.get(connectionId)
    if (!p) throw new AppError(ErrorCode.E_CONN_LOST, { connectionId })
    if (typeof command !== 'string' || !command.trim()) {
      throw new AppError(ErrorCode.E_PARAM, { reason: 'empty-command' })
    }

    const timeoutMs = Math.max(1000, opts.timeoutMs ?? 300_000)

    return new Promise((resolve, reject) => {
      let settled = false
      let timedOut = false
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      /**
       * L4：这两个计数器是给"顺带攒一份的字符串"设的上限。
       *
       * 流式那条路（`onStdout`/`onStderr`）没有这个问题 —— 调用方是流式消费的。
       * 但这里还把每个块拼进 `stdout`/`stderr`：用户脚本打印几个 G 就是主进程
       * 内存涨几个 G，而这份字符串**当前根本没人用**（唯一的消费者走流式路）。
       * 上限复用了留档那条同款口径（单步 8 MB），超了就停攒并标记。
       */
      let outBytes = 0
      let errBytes = 0
      let outTrunc = false
      let errTrunc = false
      let stream: ClientChannel | null = null
      let timer: NodeJS.Timeout | null = null
      let forceTimer: NodeJS.Timeout | null = null

      /**
       * stdout / stderr **各一个**增量解码器。
       *
       * 不能直接 `d.toString('utf8')`：SSH 通道的分块边界与字符边界无关，
       * 一个中文字被切在两块之间就会"偶尔乱一下"（同 `infra/local-exec.ts`
       * 的 `createChunkDecoder`）。这里两个流各自独立分块，所以不能共用一个。
       *
       * 注意调用方（`services/script-runner.ts`）走的是 `opts.onStdout/onStderr`
       * 那条流式路，传的是**原始 Buffer**，由它自己解码 —— 此处这两个字符串
       * 只是"顺带攒一份"，但也得攒对，否则将来有人用它就会踩到同一个坑。
       */
      const outDecoder = new StringDecoder('utf8')
      const errDecoder = new StringDecoder('utf8')

      /** 先 SIGTERM 再关通道：见方法注释里"可取消"那一段。 */
      function killRemote(): void {
        if (!stream) return
        try {
          stream.signal('TERM')
        } catch (err) {
          logger.debug(`execRaw: signal TERM failed: ${(err as Error).message}`)
        }
        try {
          stream.close()
        } catch (err) {
          logger.debug(`execRaw: close failed: ${(err as Error).message}`)
        }
      }

      function cleanup(): void {
        if (timer) clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
        opts.signal?.removeEventListener('abort', onAbort)
      }

      function settle(err: Error | null): void {
        if (settled) return
        settled = true
        cleanup()
        if (err) reject(err)
        else resolve({ stdout, stderr, code, timedOut, truncated: outTrunc || errTrunc })
      }

      function onAbort(): void {
        killRemote()
        settle(new AppError(ErrorCode.E_JOB_CANCELLED, { connectionId }))
      }

      timer = setTimeout(() => {
        timedOut = true
        killRemote()
        // 不立刻 settle：给 `close` 一点时间把已经收到的输出交回来 ——
        // 超时那一刻的输出往往正是"卡在哪一步"的唯一线索。
        // 但也不能无限等（远端可能不理会 TERM），3 秒兜底强制结束。
        forceTimer = setTimeout(() => {
          killRemote()
          // M7：**这里绝不能带 `command`** —— 这条通道跑的是用户自己填的脚本，
          // 脚本里可能内嵌 `export TOKEN=...`、`mysql -p...` 之类凭据；而
          // `job.ts:toErrorInfo()` 会把 detail 原样随任务失败详情送到渲染层展示。
          // 单靠 `redact()` 兜不住：它只按"敏感键名"替换，`command` 不是敏感键，
          // 自由文本里的裸凭据更不在 `scrubText()` 的识别范围内。
          // 排查用的命令原文另有去处：脚本审计记录（`script-audit`，已过 `scrubText`）。
          settle(new AppError(ErrorCode.E_SCRIPT_TIMEOUT, { connectionId }))
        }, 3000)
      }, timeoutMs)

      if (opts.signal?.aborted) {
        onAbort()
        return
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })

      p.client.exec(command, (err, ch) => {
        if (err) {
          settle(new AppError(ErrorCode.E_CONN_LOST, { original: err.message }))
          return
        }
        if (settled) {
          // 兜底：超时/取消已经把 Promise 结了，但通道刚建出来 —— 关掉它
          try {
            ch.close()
          } catch {
            /* 已经断了就算了 */
          }
          return
        }
        stream = ch
        ch.on('data', (d: Buffer) => {
          outBytes += d.length
          if (outBytes <= STEP_LOG_MAX_BYTES) stdout += outDecoder.write(d)
          else outTrunc = true
          opts.onStdout?.(d)
        })
        ch.stderr.on('data', (d: Buffer) => {
          errBytes += d.length
          if (errBytes <= STEP_LOG_MAX_BYTES) stderr += errDecoder.write(d)
          else errTrunc = true
          opts.onStderr?.(d)
        })
        ch.on('exit', (c: number | null) => {
          code = c
        })
        ch.on('close', () => {
          // 通道结束：把解码器里压着的尾巴交出来（也可能是最后半个字符）
          if (!outTrunc) stdout += outDecoder.end()
          if (!errTrunc) stderr += errDecoder.end()
          if (timedOut) {
            settle(new AppError(ErrorCode.E_SCRIPT_TIMEOUT, { connectionId, exitCode: code }))
            return
          }
          settle(null)
        })
        ch.on('error', (e: Error) => {
          settle(new AppError(ErrorCode.E_CONN_LOST, { original: e.message }))
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
  async detectCapability(client: Client): Promise<ConnectionCapability> {
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
        /**
         * L6：探针超时后**必须把通道收掉**。
         *
         * 旧写法是 `setTimeout(() => resolve(...))` —— 流句柄根本没保存，超时那一刻
         * 既不发 `TERM` 也不 `close()`：远端命令继续跑，通道一直挂着。五条探针各来
         * 一次，加上 `MaxSessions=10`，一次"服务器很慢"的建连就能把会话额度吃掉一半。
         * 与 `exec()` / `execRaw()` 同款：先 `TERM`（让远端进程自己收尾）再关通道。
         */
        let probe: { signal(name: string): void; close(): void } | null = null
        const killProbe = (): void => {
          if (!probe) return
          try {
            probe.signal('TERM')
          } catch (err) {
            logger.debug(`capability probe TERM failed: ${(err as Error).message}`)
          }
          try {
            probe.close()
          } catch (err) {
            logger.debug(`capability probe close failed: ${(err as Error).message}`)
          }
        }
        const timer = setTimeout(() => {
          killProbe()
          resolve({ stdout: '', code: null })
        }, 8000)
        try {
          client.exec(cmd, (err, stream) => {
            if (err) {
              clearTimeout(timer)
              resolve({ stdout: '', code: null })
              return
            }
            probe = stream
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

    /**
     * L5：这里原来有一段"连接期写权限探测"，但它**从来没有真正跑过** ——
     * 待检路径来自 `SshConnectOptions.probePaths`，而那个字段全仓没有一个赋值方
     * （恒为空数组），探测结果也只是进 `logger.debug`，`ConnectionCapability`
     * 里根本没有承载它的字段。死代码 + 一个"看起来在探测、实际没有"的假象。
     *
     * 删掉而不是接上：**按目标的写权限校验已经在发布前置校验里做**，而且用的是
     * 真实的目标父目录（`deploy.ts` 的 `parent-writable` 项，走同一条
     * `buildWriteProbeCommand`）。连接期不知道目标路径，猜着探几个路径没有意义。
     */

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
