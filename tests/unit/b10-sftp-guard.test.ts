/**
 * `guardSftp` 的单测（B10 的 MT-02 真机跑出来的东西）。
 *
 * 真机事实（探针实测，见 `src/main/infra/sftp-guard.ts` 文件头）：
 * 连接断掉之后，ssh2 的 SFTP 通道**所有方法都不再回调** —— 于是"发布任务挂死"。
 * 这里用一个 `EventEmitter` 替身把那个行为精确地复现出来：
 * 替身的方法是"登记了回调但永远不调用"，只有我们主动 `emit('close')` 之后
 * 才看出守卫有没有把请求失败掉。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { guardSftp } from '@main/infra/sftp-guard'
import { ErrorCode } from '@shared/errors'

/** 流替身：`destroy(err)` 会按 node 的语义 emit 'error' 再 emit 'close'。 */
type StreamStub = EventEmitter & { destroyed?: Error; destroy?: (err?: Error) => void }

/**
 * 一个"像 ssh2 那样"的替身：
 * - 方法是回调式的，**默认永不回调**（模拟死通道）；
 * - `replyNext` 可以让下一次调用正常回调（模拟活通道）；
 * - `emit('close')` 就是"网线被拔"。
 */
class FakeSftp extends EventEmitter {
  /** 被调用过的方法名（按顺序） */
  calls: string[] = []
  /** 为 true 时方法会异步正常回调 */
  alive = true
  /** 造出来的流 */
  streams: Array<{ destroyed?: Error; destroy?: (err?: Error) => void }> = []
  statResult: unknown = { size: 1 }
  /** 最近一次收到的回调（`alive = false` 时用它手动模拟"迟到的回调"） */
  lastCb: ((err: Error | null, v?: unknown) => void) | null = null

  private reply(args: unknown[], value?: unknown): void {
    const cb = [...args].reverse().find((a) => typeof a === 'function') as
      | ((err: Error | null, v?: unknown) => void)
      | undefined
    if (!cb) return
    this.lastCb = cb
    if (this.alive) queueMicrotask(() => cb(null, value))
    // alive = false：登记了但永不回调 —— 这正是真机上死通道的行为
  }

  stat(path: string, cb: (e: Error | null, s?: unknown) => void): void {
    this.calls.push('stat')
    this.reply([path, cb], this.statResult)
  }

  mkdir(path: string, cb: (e?: Error | null) => void): void {
    this.calls.push('mkdir')
    this.reply([path, cb])
  }

  unlink(path: string, cb: (e?: Error | null) => void): void {
    this.calls.push('unlink')
    this.reply([path, cb])
  }

  fastPut(
    localPath: string,
    remotePath: string,
    opts: Record<string, unknown>,
    cb: (e?: Error | null) => void
  ): void {
    this.calls.push('fastPut')
    this.reply([localPath, remotePath, opts, cb])
  }

  createWriteStream(_path: string): StreamStub {
    this.calls.push('createWriteStream')
    return this.makeStream()
  }

  createReadStream(_path: string): StreamStub {
    this.calls.push('createReadStream')
    return this.makeStream()
  }

  /** 一个"像 node 流那样"的替身：`destroy(err)` 会 emit 'error' 再 emit 'close'。 */
  private makeStream(): StreamStub {
    const s = new EventEmitter() as StreamStub
    s.destroy = (err?: Error): void => {
      s.destroyed = err
      queueMicrotask(() => {
        if (err) s.emit('error', err)
        s.emit('close')
      })
    }
    this.streams.push(s)
    return s
  }

  /** 无回调、无返回值的方法（`SFTPWrapper` 上确实有这种，如 `end`）。 */
  end(): void {
    this.calls.push('end')
  }
}

/** 把"回调式"调用包成 Promise，便于断言它到底 settle 了没有。 */
/**
 * 把"回调式"调用包成 Promise，便于断言它到底 settle 了没有。
 *
 * `value` 刻意用 `unknown` 而不是泛型：替身各方法的回调第二参类型不同
 * （`stat` 给 `Stats`、其余没有），泛型会让"传进去的回调"与"方法声明的回调"
 * 互相不可赋值 —— 而这里只关心"有没有回调"，值本身用 `toEqual` 断言即可。
 */
function settle(
  fn: (cb: (err?: Error | null, value?: unknown) => void) => void
): Promise<{ err: Error | null; value?: unknown }> {
  return new Promise((resolve) => {
    // 回调的两个参数都可能是 undefined（ssh2 的语义），统一成 err: Error | null
    fn((err, value) => resolve({ err: err ?? null, value }))
  })
}

/** 等一个微任务队列清空（守卫的失败是异步回调的）。 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('guardSftp（SFTP 通道存活守卫）', () => {
  it('通道活着时完全透传：参数、返回值、回调都照旧', async () => {
    const raw = new FakeSftp()
    const s = guardSftp(raw, { label: 'root@test:22' })

    const r = await settle((cb) => s.stat('/opt/app', cb))
    expect(r.err).toBeNull()
    expect(r.value).toEqual({ size: 1 })
    expect(raw.calls).toEqual(['stat'])

    // fastPut 的 options 与最后一个回调都要原样传下去
    const args: unknown[] = []
    const rawFastPut = raw.fastPut.bind(raw)
    raw.fastPut = (a, b, c, cb): void => {
      args.push(a, b, c)
      rawFastPut(a, b, c, cb)
    }
    const put = await settle((cb) => s.fastPut('/local/a', '/remote/a', { concurrency: 4 }, cb))
    expect(put.err).toBeNull()
    expect(args).toEqual(['/local/a', '/remote/a', { concurrency: 4 }])
  })

  it('通道关闭后：**新**请求立即失败，不再去碰那个死通道', async () => {
    const raw = new FakeSftp()
    const s = guardSftp(raw, { label: 'root@test:22' })

    raw.emit('close')
    await tick()
    const before = raw.calls.length

    const r = await settle((cb) => s.mkdir('/opt/app/x', cb))
    expect(r.err).toBeInstanceOf(Error)
    expect((r.err as { code?: string }).code).toBe(ErrorCode.E_CONN_LOST)
    expect((r.err as Error).message).toContain('root@test:22')
    // 关键：底层方法**一次都没被调用**（死通道上调用它只会挂住）
    expect(raw.calls.length).toBe(before)

    const r2 = await settle((cb) => s.stat('/opt/app', cb))
    expect((r2.err as { code?: string }).code).toBe(ErrorCode.E_CONN_LOST)
    expect(raw.calls.length).toBe(before)
  })

  it('通道关闭时：**在途**请求被失败掉（这是"发布不停在 50%"的关键）', async () => {
    const raw = new FakeSftp()
    raw.alive = false // 方法登记回调但永不回调 —— 真机上死通道的行为
    const s = guardSftp(raw, { label: 'root@test:22' })

    // 三个在途请求（正是 MT-02 那一刻的样子：上传/建目录/删文件都在飞）
    const inflight = [
      settle((cb) => s.fastPut('/l', '/r', {}, cb)),
      settle((cb) => s.mkdir('/opt/app/x', cb)),
      settle((cb) => s.unlink('/opt/app/x/y', cb))
    ]
    expect(raw.calls).toEqual(['fastPut', 'mkdir', 'unlink'])

    // 拔网线
    raw.emit('close')

    const results = await Promise.all(inflight)
    for (const r of results) {
      expect((r.err as { code?: string }).code).toBe(ErrorCode.E_CONN_LOST)
    }
  })

  it('通道出错（error 事件）与 close 等价', async () => {
    const raw = new FakeSftp()
    raw.alive = false
    const s = guardSftp(raw, { label: 'root@test:22' })

    const p = settle((cb) => s.stat('/opt/app', cb))
    raw.emit('error', new Error('read ECONNRESET'))
    const r = await p
    expect((r.err as { code?: string }).code).toBe(ErrorCode.E_CONN_LOST)
    expect((r.err as Error).message).toContain('ECONNRESET')
  })

  it('回调只被调用一次：die() 失败过之后，迟到的底层回调不再调用它', async () => {
    const raw = new FakeSftp()
    raw.alive = false // 在途、不回调
    const s = guardSftp(raw, { label: 'root@test:22' })

    let calls = 0
    s.stat('/opt/app', () => {
      calls++
    })
    // 此刻请求在途
    expect(raw.lastCb).toBeTruthy()

    raw.emit('close')
    await tick()
    expect(calls).toBe(1)

    // 模拟"我们以为死了、其实底层后来还是回调了"（网络抖动了一下又回来）。
    // 再调一次会让调用方二次 settle —— 那会引发难以复现的状态错乱。
    raw.lastCb!(null, { size: 99 })
    await tick()
    expect(calls, '迟到的回调让调用方二次 settle 会引发难以复现的状态错乱').toBe(1)
  })

  it('通道死时销毁它上面的流（读流不 destroy，读方同样会挂住）', async () => {
    const raw = new FakeSftp()
    const s = guardSftp(raw, { label: 'root@test:22' })

    const stream = s.createReadStream('/opt/app/big.bin')
    expect(raw.streams).toHaveLength(1)
    raw.emit('close')

    expect(raw.streams[0]!.destroyed, '流没有被销毁').toBeInstanceOf(Error)
    // 读方的 'error' 处理器能收到同一个错误（不会变成未捕获异常）
    const seen: Error[] = []
    stream.on('error', (e: Error) => seen.push(e))
    await tick()
    expect(seen).toHaveLength(1)
  })

  it('通道已死时仍能拿到流（已出错），而不是 undefined 崩在 .on 上', async () => {
    const raw = new FakeSftp()
    const s = guardSftp(raw, { label: 'root@test:22' })
    raw.emit('close')

    const stream = s.createWriteStream('/opt/app/x')
    expect(stream).toBeTruthy()
    expect(raw.streams[0]!.destroyed).toBeInstanceOf(Error)
  })

  it('EventEmitter 的方法原样透传：data 监听器不会被当成"请求回调"喂 Error', async () => {
    const raw = new FakeSftp()
    const s = guardSftp(raw, { label: 'root@test:22' })

    const got: unknown[] = []
    s.on('data' as never, ((d: unknown) => got.push(d)) as never)
    // 死之前先注册、死之后 emit：正常数据事件必须原样到监听器手里
    raw.emit('data', Buffer.from('ok'))
    expect(got).toHaveLength(1)

    raw.emit('close')
    await tick()
    // 关键：die() 不能把 'data' 监听器当成在途请求去调用（那会让它收到一个 AppError）
    expect(got).toHaveLength(1)
    expect(Buffer.isBuffer(got[0])).toBe(true)
  })

  it('无回调的方法（如 open 之外的同步返回）在通道已死时抛出而不是静默返回', () => {
    const raw = new FakeSftp()
    const s = guardSftp(raw, { label: 'root@test:22' })
    raw.emit('close')
    expect(() => (s as unknown as { end: () => void }).end()).toThrowError(
      /SFTP 通道已断开/
    )
  })

  it('warning 只打一次（重复 close/error 不会刷爆日志）', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const raw = new FakeSftp()
    guardSftp(raw, { label: 'root@test:22' })
    raw.emit('close')
    raw.emit('close')
    raw.emit('error', new Error('x'))
    await tick()
    spy.mockRestore()
    // logger 走 electron-log，在测试里落到 console.warn —— 只该有一条
    const lines = spy.mock.calls.filter((c) => String(c[0] ?? '').includes('channel dead'))
    expect(lines.length).toBeLessThanOrEqual(1)
  })
})
