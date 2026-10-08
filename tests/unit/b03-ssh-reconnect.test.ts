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
import { SshConnectionPool } from '@main/services/ssh-client'
import { ErrorCode } from '@main/infra/errors'
import type { ConnectionState } from '@shared/contracts/connection-state'

const h = vi.hoisted(() => {
  const state = {
    /** 之后的所有 connect 是否一律失败（测试里用来模拟"服务器一直起不来"） */
    failConnects: false,
    clients: [] as unknown[],
    /** 置 true 后 exec 的通道永远不产生输出/退出（模拟远端命令挂起） */
    hangExec: false,
    /** 每次 exec 创建的流记录（断言 close/signal 是否被调用） */
    streams: [] as Array<{ closeCalled: boolean; signalled: string[] }>
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
      cfg.hostVerifier?.(Buffer.from('fake-host-key'), () => {})
      queueMicrotask(() => {
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
      const answer = probeAnswer(cmd)
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
      /* 主动断开：测试里不需要副作用 */
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
})
