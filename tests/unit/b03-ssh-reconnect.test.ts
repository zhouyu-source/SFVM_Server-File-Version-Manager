/**
 * P1-5 回归测试：SSH 自动重连必须按退避序列持续重试，MAX_RETRIES 次后转 offline。
 *
 * 缺陷回顾：重连失败的 catch 分支里 `pool.set(id, carry)` 之后紧跟
 * `pool.delete(id)`，而 `handleDisconnect` 首行 `if (!p) return` ——
 * 重连链第一次失败就断掉，状态永远停在 `reconnecting`。
 *
 * 测试方式：mock ssh2 的 Client（事件式 API 的最小实现），用假定时器驱动退避链。
 * 连接成功后把"后续 connect 全部失败"打开，断言状态最终走到 `offline`
 * （修复前会永远停在 `reconnecting`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshConnectionPool, fingerprintOf } from '@main/services/ssh-client'
import { ErrorCode } from '@main/infra/errors'
import { STEP_LOG_MAX_BYTES } from '@shared/contracts/script'
import type { ConnectionState } from '@shared/contracts/connection-state'

const h = vi.hoisted(() => {
  const state = {
    /** 之后的所有 connect 是否一律失败（测试里用来模拟"服务器一直起不来"） */
    failConnects: false,
    clients: [] as unknown[],
    /** 置 true 后 exec 的通道永远不产生输出/退出（模拟远端命令挂起） */
    hangExec: false,
    /** 每次 exec 创建的流记录（断言 close/signal 是否被调用） */
    streams: [] as Array<{ closeCalled: boolean; signalled: string[] }>,
    /** 被 `end()` 过的 client（M9：孤儿会话必须被收掉） */
    ended: [] as unknown[],
    /** 被 `end()` 过的 SFTP 通道（S2：通道不能泄漏） */
    channelsEnded: [] as unknown[],
    /** `hostVerifier` 给出的判定结果（L1：strict 无指纹必须否掉） */
    hostKeyVerdicts: [] as boolean[],
    /** 非挂起模式下 `exec` 的流要吐的内容；null = 按探针命令作答 */
    rawOutput: null as string | null
  }
  return state
})

vi.mock('ssh2', () => {
  /** 极简事件源（避免在 mock 工厂里做动态 import） */
  class Emitter {
    private ls = new Map<string, Array<(...a: unknown[]) => void>>()
    on(ev: string, fn: (...a: unknown[]) => void): this {
      const arr = this.ls.get(ev) ?? []
      arr.push(fn)
      this.ls.set(ev, arr)
      return this
    }
    once(ev: string, fn: (...a: unknown[]) => void): this {
      const wrap = (...a: unknown[]): void => {
        this.removeListener(ev, wrap)
        fn(...a)
      }
      return this.on(ev, wrap)
    }
    removeListener(ev: string, fn: (...a: unknown[]) => void): this {
      const arr = this.ls.get(ev) ?? []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
      return this
    }
    emit(ev: string, ...args: unknown[]): boolean {
      for (const fn of [...(this.ls.get(ev) ?? [])]) fn(...args)
      return true
    }
  }

  /** 探针命令 → 输出（与 capability 探测一一对应） */
  function probeAnswer(cmd: string): { out: string; code: number } {
    if (cmd.startsWith('uname -s')) return { out: 'Linux\n', code: 0 }
    if (cmd.includes('sha256sum')) return { out: '/usr/bin/sha256sum\n', code: 0 }
    if (cmd.includes('shasum')) return { out: '', code: 1 }
    if (cmd.includes('df')) return { out: '/usr/bin/df\n', code: 0 }
    if (cmd.startsWith('printf %s "$HOME"')) return { out: '/root', code: 0 }
    return { out: '', code: 0 }
  }

  function makeStream(record?: { closeCalled: boolean; signalled: string[] }): unknown {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
    const stream: Record<string, unknown> = {
      stderr: {
        on: (ev: string, fn: (...a: unknown[]) => void) => {
          const arr = listeners.get(`stderr:${ev}`) ?? []
          arr.push(fn)
          listeners.set(`stderr:${ev}`, arr)
        }
      },
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        const arr = listeners.get(ev) ?? []
        arr.push(fn)
        listeners.set(ev, arr)
      },
      signal(name: string): void {
        record?.signalled.push(name)
      },
      close(): void {
        if (record) record.closeCalled = true
      }
    }
    ;(stream as unknown as { emit: (ev: string, ...a: unknown[]) => void }).emit = (
      ev: string,
      ...a: unknown[]
    ): void => {
      for (const fn of [...(listeners.get(ev) ?? [])]) fn(...a)
    }
    return stream
  }

  class FakeClient extends Emitter {
    connect(cfg: { hostVerifier?: (k: Buffer, v: (ok: boolean) => void) => void }): void {
      h.clients.push(this)
      let verdict: boolean | null = null
      cfg.hostVerifier?.(Buffer.from('fake-host-key'), (ok: boolean) => {
        verdict = ok
        h.hostKeyVerdicts.push(ok)
      })
      queueMicrotask(() => {
        // 与真实 ssh2 一致：指纹判定为否 → 握手直接失败
        if (verdict === false) {
          this.emit('error', new Error('Host key verification failed'))
          return
        }
        if (h.failConnects) this.emit('error', new Error('connect ECONNREFUSED'))
        else this.emit('ready')
      })
    }
    exec(cmd: string, cb: (err: Error | null, stream: unknown) => void): void {
      // P1-6：模拟远端命令挂起 —— 通道给出来，但永远不输出也不退出
      if (h.hangExec) {
        const record = { closeCalled: false, signalled: [] as string[] }
        h.streams.push(record)
        const stream = makeStream(record)
        queueMicrotask(() => cb(null, stream))
        return
      }
      const answer = h.rawOutput !== null ? { out: h.rawOutput, code: 0 } : probeAnswer(cmd)
      const stream = makeStream()
      queueMicrotask(() => {
        cb(null, stream)
        queueMicrotask(() => {
          ;(stream as unknown as { emit: (ev: string, ...a: unknown[]) => void }).emit(
            'data',
            Buffer.from(answer.out)
          )
          ;(stream as unknown as { emit: (ev: string, ...a: unknown[]) => void }).emit(
            'exit',
            answer.code
          )
          ;(stream as unknown as { emit: (ev: string, ...a: unknown[]) => void }).emit('close')
        })
      })
    }
    end(): void {
      // 主动断开：记录一下，供 M9 断言"孤儿会话确实被收掉"
      h.ended.push(this)
    }
    /**
     * 假 SFTP 通道（S2）。
     *
     * 只做两件事：能被 `guardSftp` 包（所以要有 EventEmitter 的 `on`），
     * 以及 `end()` 时记一笔 —— 单测要看的就是"这条通道有没有被还回去"。
     */
    sftp(cb: (err: Error | null, sftp: unknown) => void): void {
      const channel = new Emitter() as Emitter & { end: () => void }
      channel.end = (): void => {
        h.channelsEnded.push(channel)
      }
      queueMicrotask(() => cb(null, channel))
    }
  }

  return { Client: FakeClient }
})

describe('SSH 连接池（P1-5 / P1-6 回归）', () => {
  let states: ConnectionState[] = []
  let pool: SshConnectionPool

  beforeEach(() => {
    vi.useFakeTimers()
    h.failConnects = false
    h.hangExec = false
    h.clients.length = 0
    h.streams.length = 0
    h.ended.length = 0
    h.channelsEnded.length = 0
    h.hostKeyVerdicts.length = 0
    h.rawOutput = null
    states = []
    pool = new SshConnectionPool()
    pool.onState((s) => states.push(s))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function connect(): Promise<void> {
    await pool.connect({
      connectionId: 'c1',
      host: '10.0.0.1',
      port: 22,
      username: 'deploy',
      authType: 'password',
      secret: 'secret',
      hostKeyPolicy: 'accept-any'
    })
  }

  it('断线后按退避序列持续重试，MAX_RETRIES 次后转 offline（不再卡 reconnecting）', async () => {
    await connect()
    expect(states.at(-1)?.status).toBe('online')

    // 之后所有重连一律失败（服务器起不来的最常见场景）
    h.failConnects = true
    ;(h.clients[0] as { emit: (ev: string) => boolean }).emit('close')

    // 退避序列 1s → 2s → 5s → 10s → 10s，共 5 次重试
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
    }

    const last = states.at(-1)
    expect(last?.status).toBe('offline')
    expect(last?.reason).toContain('已重试 5 次')

    // 中途经历过 5 次 reconnecting（每次 attempt 递增）
    const reconnecting = states.filter((s) => s.status === 'reconnecting')
    expect(reconnecting.length).toBe(5)
  })

  it('getState 快照带上连接时间（原来恒为 undefined）（P2-7）', async () => {
    await connect()
    const snap = pool.getState('c1')
    expect(snap.status).toBe('online')
    expect(typeof snap.lastConnectedAt).toBe('string')
    expect(Number.isNaN(Date.parse(snap.lastConnectedAt!))).toBe(false)
  })

  it('重连成功：第一次失败、第二次成功 → 回到 online', async () => {
    await connect()
    h.failConnects = true
    ;(h.clients[0] as { emit: (ev: string) => boolean }).emit('close')

    // 第一次重连失败
    await vi.advanceTimersByTimeAsync(1000)
    // 恢复网络
    h.failConnects = false
    // 第二次重连（退避 2s）
    await vi.advanceTimersByTimeAsync(2000)

    expect(states.at(-1)?.status).toBe('online')
  })

  /**
   * P1-6 回归：exec 超时不能只 reject —— 远端命令要被 TERM、通道要被关闭、
   * 监听器要被清理，否则每次超时都在服务器上留一个继续跑的进程，
   * stdout 闭包继续增长（大目录哈希正是最常超时的场景）。
   */
  it('exec 超时会先 TERM 再关闭远端通道，后续命令不受影响', async () => {
    await connect()

    // 远端命令挂起：通道给了，但永远不输出也不退出
    h.hangExec = true
    const pending = pool.exec('c1', 'uname -s', 1000)
    // 兜底 settle 发生在 advanceTimers 期间 —— 拒绝处理器必须**现在**就挂上，
    // 等断言时再挂会被 vitest 记成 unhandledRejection
    void pending.catch(() => undefined)
    const rejection = expect(pending).rejects.toMatchObject({ code: ErrorCode.E_CONN_TIMEOUT })

    // 超时触发：先 TERM 再 close，3 秒兜底强制结束
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.streams[0]?.signalled).toContain('TERM')
    expect(h.streams[0]?.closeCalled).toBe(true)

    await vi.advanceTimersByTimeAsync(3000)
    await rejection

    // 通道收干净了：后续命令照常执行（监听器/闭包没有泄漏）
    h.hangExec = false
    const ok = await pool.exec('c1', 'uname -s', 1000)
    expect(ok.stdout).toBe('Linux\n')
    expect(ok.code).toBe(0)
  })

  /**
   * M10 回归：同一 id 并发建连只能建出一条会话。
   *
   * 缺陷回顾：`connect()` 里"查池"与"写池"之间隔着建连 + 能力探测两次 await。
   * 双击「连接」/ 自动登录与手动连接撞车时两次都会完整建会话：留在池外的那条
   * **永远不会被 `end()`**，而它注册的 `close` 会在将来把池里那条正常连接删掉。
   */
  it('并发两次 connect(sameId) → 只建一条会话，第二条复用同一条（M10）', async () => {
    const opts = {
      connectionId: 'c1',
      host: '10.0.0.1',
      port: 22,
      username: 'deploy',
      authType: 'password' as const,
      secret: 'secret',
      hostKeyPolicy: 'accept-any' as const
    }

    const [a, b] = await Promise.all([pool.connect(opts), pool.connect(opts)])

    expect(h.clients.length, '并发建连应只产生一条 SSH 会话').toBe(1)
    expect(pool.isOnline('c1')).toBe(true)
    // 第二条拿到的是同一条会话的探测结果
    expect(b.hostKeyFingerprint).toBe(a.hostKeyFingerprint)
    expect(b.capability.platform).toBe('linux')
  })

  /**
   * M9 回归之一：**建连期间**点断开 → 那条会话必须被收掉，不能悄悄上线。
   *
   * 缺陷回顾：`disconnect()` 依赖 `pool.get`，而 connecting 期间池里没有条目，
   * 直接 `return`；随后 `pool.set` 照常执行 —— 一条用户已经"断开"过的 client
   * 正式上线（且库里 `lastConnectedAt` 并没有更新）。
   */
  it('connecting 期间 disconnect() → 会话被 end() 且不入池（M9）', async () => {
    const p = connect()
    // 立刻点断开（此时 connect 还在 await 建连）
    pool.disconnect('c1')

    await expect(p).rejects.toMatchObject({ code: ErrorCode.E_CONN_LOST })
    expect(pool.isOnline('c1'), '用户已断开的连接不该进池').toBe(false)
    expect(h.ended.length, '孤儿会话必须被 end() 掉').toBeGreaterThan(0)
    expect(states.at(-1)?.status).toBe('idle')
  })

  /**
   * M9 回归之二：**重连等待窗口**里点断开 → 到点不再重连。
   *
   * 缺陷回顾：`handleDisconnect` 把 `p` 从池里删掉之后才挂 `reconnectTimer`，
   * 断开请求拿不到那个句柄（且 `pool.get` 已为空）→ 定时器照常触发、连接自己回来。
   */
  it('重连等待窗口里 disconnect() → 定时器到点也不重连（M9）', async () => {
    await connect()
    expect(h.clients.length).toBe(1)

    h.failConnects = true
    ;(h.clients[0] as { emit: (ev: string) => boolean }).emit('close')
    expect(states.at(-1)?.status).toBe('reconnecting')

    // 窗口内点断开
    pool.disconnect('c1')

    // 跑完整个退避序列：不应再建任何会话
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
    }

    expect(h.clients.length, '断开之后不该再有新建连').toBe(1)
    expect(pool.isOnline('c1')).toBe(false)
    expect(states.at(-1)?.status).toBe('idle')
  })

  /** M9 回归之三：退出清理要走 `disconnectAll()`，而它以前只遍历池 —— 建连中的漏了。 */
  it('disconnectAll() 覆盖"正在建连"的连接（不在池里也不会被漏掉）（M9）', async () => {
    const p = connect()
    // 建连中调用退出清理
    pool.disconnectAll()

    await expect(p).rejects.toMatchObject({ code: ErrorCode.E_CONN_LOST })
    expect(pool.isOnline('c1')).toBe(false)
    expect(h.ended.length).toBeGreaterThan(0)
  })

  /**
   * S2 回归之一：`withSftp` 的作用域一出去就必须关通道。
   *
   * 缺陷回顾：全仓没有任何一处 `end()` 过 `pool.sftp()` 的返回值 ——
   * 同一条池内连接累计开 10 条子系统通道就撞上 sshd 的 `MaxSessions`，
   * 而报出来的却是「SSH 连接已断开」（底层 TCP 完全正常），排障方向被带偏。
   */
  it('withSftp：正常返回后通道被 end()（S2）', async () => {
    await connect()
    const result = await pool.withSftp('c1', async () => 42)
    expect(result).toBe(42)
    expect(h.channelsEnded.length, '出作用域必须关掉通道').toBe(1)
  })

  /** S2 回归之二：回调里抛错时通道同样要被关（否则失败路径每次泄漏一条）。 */
  it('withSftp：回调抛错也关通道（S2）', async () => {
    await connect()
    await expect(
      pool.withSftp('c1', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(h.channelsEnded.length).toBe(1)
  })

  /**
   * S2 回归之三：`openChannel` 的 `release` 幂等。
   *
   * 长作用域的端口（发布/回滚/下载）自己调 `release()`，而 `disconnect()`
   * 也可能同时把通道关掉 —— 两条路都走一遍时不能二次 `end()`。
   */
  it('openChannel：release 幂等，重复调用只 end() 一次（S2）', async () => {
    await connect()
    const { release } = await pool.openChannel('c1')
    release()
    release()
    expect(h.channelsEnded.length).toBe(1)
  })

  /** S2 回归之四：`disconnect()` 要把池内连接上仍开着的通道一并收掉（S2 × M9）。 */
  it('disconnect() 会关掉该连接上仍开着的 SFTP 通道（S2）', async () => {
    await connect()
    // 开一条长作用域的通道（模拟发布/下载拿到手还没还）
    await pool.openChannel('c1')
    expect(h.channelsEnded.length, '此时还没释放').toBe(0)

    pool.disconnect('c1')
    expect(h.channelsEnded.length, '断开必须把在途通道一起收掉').toBe(1)
  })

  /* ---------------------------------------------------------------- L1 */

  /**
   * L1：`strict` 但**没给指纹**时必须直接否掉。
   *
   * 旧判据是 `hostKeyPolicy === 'strict' && expectedFingerprint` —— 少了后半个
   * 条件就落进 accept-any 放行：策略写着 strict，实际谁都能连（当前调用点都会
   * 同时给指纹，所以是**潜伏**缺陷，一旦哪天忘了传就静默打开）。
   */
  it('L1：strict 但没给指纹 → 直接否掉，不许落进 accept-any 放行', async () => {
    const p = pool.connect({
      connectionId: 'c1',
      host: '10.0.0.1',
      port: 22,
      username: 'deploy',
      authType: 'password',
      secret: 'secret',
      hostKeyPolicy: 'strict'
      // 故意不给 expectedFingerprint
    })

    await expect(p).rejects.toBeTruthy()
    expect(h.hostKeyVerdicts, '必须判定为否').toEqual([false])
    expect(pool.isOnline('c1')).toBe(false)
  })

  it('L1：strict + 指纹一致 → 放行；strict + 指纹不符 → 否掉', async () => {
    const good = fingerprintOf(Buffer.from('fake-host-key')).fingerprint
    await pool.connect({
      connectionId: 'c1',
      host: '10.0.0.1',
      port: 22,
      username: 'deploy',
      authType: 'password',
      secret: 'secret',
      hostKeyPolicy: 'strict',
      expectedFingerprint: good
    })
    expect(h.hostKeyVerdicts).toEqual([true])

    h.hostKeyVerdicts.length = 0
    const bad = pool.connect({
      connectionId: 'c2',
      host: '10.0.0.2',
      port: 22,
      username: 'deploy',
      authType: 'password',
      secret: 'secret',
      hostKeyPolicy: 'strict',
      expectedFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    })
    await expect(bad).rejects.toBeTruthy()
    expect(h.hostKeyVerdicts).toEqual([false])
  })

  /* ---------------------------------------------------------------- L6 */

  /**
   * L6：能力探针超时后必须把通道收掉。
   *
   * 旧写法 `setTimeout(() => resolve(...))` 连流句柄都没保存：超时那一刻既不
   * `TERM` 也不 `close()`，远端命令继续跑、通道继续挂着。五条探针各来一次，
   * 叠上 sshd 的 `MaxSessions=10`，"服务器很慢"的一次建连就能吃掉一半会话额度。
   */
  it('L6：探针超时 → 对每条通道发 TERM 并关闭（不是丢下不管）', async () => {
    await connect()
    h.hangExec = true
    h.streams.length = 0

    const pending = pool.detectCapability(h.clients[0] as never)
    await vi.advanceTimersByTimeAsync(8000)
    const cap = await pending

    // 五条探针全部没拿到结果（`code === null` ⇒ 按既有口径当成"没有 uname"）
    expect(cap.platform).toBe('windows')
    expect(cap.hasSha256sum).toBe(false)
    expect(h.streams.length).toBe(5)
    expect(h.streams.every((s) => s.closeCalled)).toBe(true)
    expect(h.streams.every((s) => s.signalled.includes('TERM'))).toBe(true)
  })

  /* ---------------------------------------------------------------- L4 */

  /**
   * L4：`execRaw` 里"顺带攒一份"的 stdout/stderr 也要有上限。
   *
   * 用户脚本可能打印几个 G —— 无上限就是主进程内存无上限。流式那条路
   * （`onStdout`/`onStderr`）不受影响，只有这份没人消费的字符串被截断。
   */
  it('L4：execRaw 的超大输出被截断并标记 truncated', async () => {
    const rawPool = new SshConnectionPool({ allowRawExec: () => true })
    await rawPool.connect({
      connectionId: 'c1',
      host: '10.0.0.1',
      port: 22,
      username: 'deploy',
      authType: 'password',
      secret: 'secret',
      hostKeyPolicy: 'accept-any'
    })
    let streamed = 0
    h.rawOutput = 'x'.repeat(STEP_LOG_MAX_BYTES + 1024)

    const r = await rawPool.execRaw('c1', 'echo hi', {
      onStdout: (c) => {
        streamed += c.length
      }
    })

    expect(r.truncated).toBe(true)
    expect(r.stdout.length).toBeLessThan(STEP_LOG_MAX_BYTES + 1024)
    // 流式那条路拿到的是**全部**字节，不受这份字符串的上限影响
    expect(streamed).toBe(STEP_LOG_MAX_BYTES + 1024)
  })
})
