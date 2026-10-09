/**
 * B07 / T07.9 ~ T07.11 验收点：上传下载的进度、重试、取消，以及 `.part` 语义。
 *
 * 用手写的内存远端（`MemoryTransferPort`）而不是 vi.mock：
 * 重试与取消是**状态机行为**，需要能精确控制"第几次失败""什么时候中断"，
 * 用 mock 断言调用次数远不如用一个真实的小状态机来得可靠。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { promises as fsp } from 'node:fs'
import {
  SMALL_FILE_THRESHOLD,
  createTransfer,
  pipeWithProgress,
  replaceFile,
  type ReplaceFsLike,
  type TransferPort
} from '@main/services/transfer'
import { AppError, ErrorCode } from '@main/infra/errors'

const dirs: string[] = []
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sfvm-b07t-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true })
    } catch {
      /* Windows 偶发占用 */
    }
  }
})

/** 内存远端。刻意保留 failTimes / inflight 计数，以便断言重试与并发。 */
class MemoryTransferPort implements TransferPort {
  files = new Map<string, Buffer>()
  dirs = new Set<string>()
  /** remotePath → 前 N 次调用抛错 */
  failTimes = new Map<string, number>()
  calls = new Map<string, number>()
  inflight = 0
  maxInflight = 0
  /** 写流直接丢弃数据（大文件用例用它避免把内存吃满） */
  discardWrites = false
  createdWriteStreams: string[] = []
  /** 在写流第一次写入时触发（用于确定性地测取消） */
  onFirstWrite?: () => void

  private bump(key: string): void {
    const n = (this.calls.get(key) ?? 0) + 1
    this.calls.set(key, n)
    const fail = this.failTimes.get(key) ?? 0
    if (n <= fail) throw new Error(`simulated failure #${n} for ${key}`)
  }

  async statSize(absPath: string): Promise<number | null> {
    const b = this.files.get(absPath)
    return b ? b.length : null
  }

  async ensureDir(absPath: string): Promise<void> {
    this.dirs.add(absPath)
  }

  async fastPut(
    localPath: string,
    remotePath: string,
    onStep?: (n: number) => void
  ): Promise<void> {
    this.inflight++
    this.maxInflight = Math.max(this.maxInflight, this.inflight)
    try {
      // 让出事件循环，才能观察到并发上限
      await new Promise((r) => setTimeout(r, 5))
      this.bump(remotePath)
      const buf = readFileSync(localPath)
      if (!this.discardWrites) this.files.set(remotePath, buf)
      onStep?.(buf.length)
    } finally {
      this.inflight--
    }
  }

  async fastGet(
    remotePath: string,
    localPath: string,
    onStep?: (n: number) => void
  ): Promise<void> {
    this.bump(remotePath)
    const buf = this.files.get(remotePath)
    if (!buf) throw new Error(`no such file: ${remotePath}`)
    await fsp.writeFile(localPath, buf)
    onStep?.(buf.length)
  }

  createReadStream(absPath: string): NodeJS.ReadableStream {
    const b = this.files.get(absPath)
    if (!b) throw new Error(`no such file: ${absPath}`)
    return Readable.from([b])
  }

  createWriteStream(absPath: string, highWaterMark = 64 * 1024): NodeJS.WritableStream {
    this.createdWriteStreams.push(absPath)
    const chunks: Buffer[] = []
    let first = true
    // 按"批"计费（一次网络往返），并刻意做成与源分块大小无关：
    // 真实 ssh2 的 WriteStream 也是"串行 _write / 批量 _writev"，生产侧靠
    // "源分块 << 目标水位"来凑批。假实现若不认 highWaterMark、也没有 writev，
    // 用例耗时就会随生产侧分块数膨胀（曾因此把 5s 超时跑挂）。
    const accept = (bufs: readonly Buffer[], cb: (e?: Error | null) => void): void => {
      if (first) {
        first = false
        this.onFirstWrite?.()
      }
      // 模拟慢链路：让流式路径有可观察的时长
      setTimeout(() => {
        if (!this.discardWrites) for (const b of bufs) chunks.push(Buffer.from(b))
        cb()
      }, 2)
    }
    return new Writable({
      highWaterMark,
      write: (chunk: Buffer, _enc, cb) => accept([chunk], cb),
      writev: (list: Array<{ chunk: Buffer }>, cb) => accept(list.map((l) => l.chunk), cb),
      final: (cb) => {
        if (!this.discardWrites) this.files.set(absPath, Buffer.concat(chunks))
        cb()
      }
    })
  }

  async rename(from: string, to: string): Promise<void> {
    const b = this.files.get(from)
    if (!b) throw new Error(`no such file: ${from}`)
    this.files.delete(from)
    this.files.set(to, b)
  }

  async removeFile(absPath: string): Promise<void> {
    this.files.delete(absPath)
  }
}

const fast = { retryDelay: (): number => 1 }

describe('pipeWithProgress', () => {
  it('统计字节并把数据管到目标', async () => {
    const data = randomBytes(50000)
    const chunks: Buffer[] = []
    const dst = new Writable({
      write(c: Buffer, _e, cb) {
        chunks.push(c)
        cb()
      }
    })
    let seen = 0
    await pipeWithProgress(Readable.from([data]), dst, (n) => (seen = n))
    expect(seen).toBe(data.length)
    expect(Buffer.concat(chunks).equals(data)).toBe(true)
  })

  it('源流报错时 reject（并把目标销毁）', async () => {
    const src = new Readable({
      read() {
        this.destroy(new Error('boom'))
      }
    })
    const dst = new Writable({ write: (_c, _e, cb) => cb() })
    await expect(pipeWithProgress(src, dst, () => undefined)).rejects.toThrow('boom')
  })

  it('取消时立刻以 E_JOB_CANCELLED 结束', async () => {
    const ac = new AbortController()
    const src = new Readable({ read: () => undefined })
    const dst = new Writable({ write: (_c, _e, cb) => cb() })
    const p = pipeWithProgress(src, dst, () => undefined, ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: ErrorCode.E_JOB_CANCELLED })
  })

  it('源已读完时，目标流"先 close 再 finish"也算成功（ssh2 语义）', async () => {
    // 真机回归：ssh2 的 WriteStream._final 是"先 destroy()（→ 'close'）再调 cb()（→ 'finish'）"，
    // 因此正常结束时 'close' 也会先到。曾经的实现把这种情况判成"上传中断"，
    // 表现为"300MB 明明传完了却报失败、还白重试两次"。
    const data = randomBytes(4096)
    const dst = new Writable({
      write: (_c, _e, cb) => cb(),
      final(cb) {
        // 显式复刻 ssh2 的事件顺序：'close' 先于 'finish'
        this.emit('close')
        cb()
      }
    })
    await expect(pipeWithProgress(Readable.from([data]), dst, () => undefined)).resolves.toBeUndefined()
  })

  it('源还没读完就 close → E_UPLOAD_INTERRUPTED（真的链路断了不能放过）', async () => {
    const src = new Readable({ read: () => undefined }) // 永不结束
    const dst = new Writable({ write: (_c, _e, cb) => cb() })
    const p = pipeWithProgress(src, dst, () => undefined)
    dst.emit('close')
    await expect(p).rejects.toMatchObject({ code: ErrorCode.E_UPLOAD_INTERRUPTED })
  })
})

describe('upload（T07.9）', () => {
  it('小文件走 fastPut，内容一致，并创建远端目录', async () => {
    const root = makeTmp()
    const local = join(root, 'a.js')
    writeFileSync(local, 'content-A')
    const port = new MemoryTransferPort()
    const t = createTransfer(port, fast)

    const s = await t.upload([{ localPath: local, remotePath: '/opt/payload/a.js' }])

    expect(s.files).toBe(1)
    expect(s.bytes).toBe(9)
    expect(s.retries).toBe(0)
    expect(port.files.get('/opt/payload/a.js')?.toString()).toBe('content-A')
    expect(port.dirs.has('/opt/payload')).toBe(true)
  })

  it('多个文件并发上传，并发数不超过配置', async () => {
    const root = makeTmp()
    const files = Array.from({ length: 8 }, (_, i) => {
      const p = join(root, `f${i}.js`)
      writeFileSync(p, `content-${i}`)
      return { localPath: p, remotePath: `/opt/payload/f${i}.js` }
    })
    const port = new MemoryTransferPort()
    const t = createTransfer(port, fast)

    await t.upload(files, { concurrency: 4 })

    expect(port.maxInflight).toBe(4)
    expect(port.files.size).toBe(8)
  })

  it('大文件走流式路径（> 32MB），内容一致', async () => {
    const root = makeTmp()
    const local = join(root, 'big.bin')
    // 用 truncate 造一个稀疏大文件，避免真的写 33MB 数据
    const size = SMALL_FILE_THRESHOLD + 1024 * 1024
    writeFileSync(local, '')
    await fsp.truncate(local, size)

    const port = new MemoryTransferPort()
    port.discardWrites = true
    const t = createTransfer(port, fast)

    const s = await t.upload([{ localPath: local, remotePath: '/opt/payload/big.bin' }])

    expect(s.bytes).toBe(size)
    // 走的是 createWriteStream 而不是 fastPut
    expect(port.createdWriteStreams).toEqual(['/opt/payload/big.bin'])
    expect(port.calls.get('/opt/payload/big.bin') ?? 0).toBe(0)
  })

  it('单文件失败重试 3 次后成功，并把重试次数回报给 UI', async () => {
    const root = makeTmp()
    const local = join(root, 'a.js')
    writeFileSync(local, 'A')
    const port = new MemoryTransferPort()
    port.failTimes.set('/opt/payload/a.js', 2)
    const t = createTransfer(port, fast)

    const s = await t.upload([{ localPath: local, remotePath: '/opt/payload/a.js' }])

    expect(s.retries).toBe(2)
    expect(port.calls.get('/opt/payload/a.js')).toBe(3)
    expect(port.files.get('/opt/payload/a.js')?.toString()).toBe('A')
  })

  it('重试次数耗尽 → E_UPLOAD_INTERRUPTED', async () => {
    const root = makeTmp()
    const local = join(root, 'a.js')
    writeFileSync(local, 'A')
    const port = new MemoryTransferPort()
    port.failTimes.set('/opt/payload/a.js', 99)
    const t = createTransfer(port, fast)

    await expect(
      t.upload([{ localPath: local, remotePath: '/opt/payload/a.js' }])
    ).rejects.toMatchObject({ code: ErrorCode.E_UPLOAD_INTERRUPTED })
    expect(port.calls.get('/opt/payload/a.js')).toBe(3)
  })

  it('本地文件不存在 → E_LOCAL_PATH_MISSING（在传输前就拦住）', async () => {
    const root = makeTmp()
    const port = new MemoryTransferPort()
    const t = createTransfer(port, fast)
    await expect(
      t.upload([{ localPath: join(root, 'nope.js'), remotePath: '/opt/payload/nope.js' }])
    ).rejects.toMatchObject({ code: ErrorCode.E_LOCAL_PATH_MISSING })
  })

  it('已取消的信号 → 一个字节都不传', async () => {
    const root = makeTmp()
    const local = join(root, 'a.js')
    writeFileSync(local, 'A')
    const port = new MemoryTransferPort()
    const t = createTransfer(port, fast)
    const ac = new AbortController()
    ac.abort()

    await expect(
      t.upload([{ localPath: local, remotePath: '/opt/payload/a.js' }], { signal: ac.signal })
    ).rejects.toMatchObject({ code: ErrorCode.E_JOB_CANCELLED })
    expect(port.calls.size).toBe(0)
  })

  it('流式传输中途取消 → E_JOB_CANCELLED，且不再重试', async () => {
    const root = makeTmp()
    const local = join(root, 'big.bin')
    const size = SMALL_FILE_THRESHOLD + 1024 * 1024
    writeFileSync(local, '')
    await fsp.truncate(local, size)

    const port = new MemoryTransferPort()
    port.discardWrites = true
    const ac = new AbortController()
    // 第一次写入时就取消：结果确定，不依赖计时
    port.onFirstWrite = () => ac.abort()
    const t = createTransfer(port, fast)

    await expect(
      t.upload([{ localPath: local, remotePath: '/opt/payload/big.bin' }], { signal: ac.signal })
    ).rejects.toMatchObject({ code: ErrorCode.E_JOB_CANCELLED })
    expect(port.createdWriteStreams).toHaveLength(1)
  })

  it('进度事件被节流，且最后一次一定上报"全部完成"', async () => {
    const root = makeTmp()
    const files = Array.from({ length: 3 }, (_, i) => {
      const p = join(root, `f${i}.js`)
      writeFileSync(p, `content-${i}`)
      return { localPath: p, remotePath: `/opt/payload/f${i}.js` }
    })
    const port = new MemoryTransferPort()
    const t = createTransfer(port, fast)

    const seen: Array<{ transferred: number; filesDone: number; total: number }> = []
    await t.upload(files, {
      concurrency: 1,
      progressIntervalMs: 200,
      onProgress: (p) =>
        seen.push({ transferred: p.transferred, filesDone: p.filesDone, total: p.total })
    })

    expect(seen.length).toBeGreaterThanOrEqual(3)
    // 节流生效：远少于"每文件多次"的调用次数
    expect(seen.length).toBeLessThan(12)
    const last = seen[seen.length - 1]
    expect(last?.filesDone).toBe(3)
    expect(last?.transferred).toBe(last?.total)
    // 单调不减（重试回退除外）
    for (let i = 1; i < seen.length; i++) {
      expect((seen[i] as { transferred: number }).transferred).toBeGreaterThanOrEqual(
        (seen[i - 1] as { transferred: number }).transferred
      )
    }
  })

  it('进度不重复计数：文件完成后必须摘掉"在途"（M5 回归）', async () => {
    const root = makeTmp()
    const SIZE = 100
    const files = Array.from({ length: 3 }, (_, i) => {
      const p = join(root, `f${i}.bin`)
      writeFileSync(p, 'x'.repeat(SIZE))
      return { localPath: p, remotePath: `/opt/payload/f${i}.bin` }
    })
    const port = new MemoryTransferPort()
    const t = createTransfer(port, fast)

    const seen: Array<{ transferred: number; filesDone: number }> = []
    await t.upload(files, {
      concurrency: 1,
      // 关掉节流，才能精确看到"某个文件刚完成"的那一刻
      progressIntervalMs: 0,
      onProgress: (p) => seen.push({ transferred: p.transferred, filesDone: p.filesDone })
    })

    /**
     * 快照是 `doneBytes + Σinflight`。若完成时只加 `doneBytes` 而不把该文件
     * 从 `inflight` 里摘掉，同一个文件会被算两遍 —— 传完第 1 个文件就会报 200。
     */
    const firstDone = seen.find((s) => s.filesDone === 1)
    expect(firstDone?.transferred).toBe(SIZE)
    const secondDone = seen.find((s) => s.filesDone === 2)
    expect(secondDone?.transferred).toBe(SIZE * 2)
    expect(seen[seen.length - 1]?.transferred).toBe(SIZE * 3)
  })
})

describe('download（T07.10）', () => {
  it('小文件：写 .part → 校验 → rename，最终文件存在且 .part 消失', async () => {
    const root = makeTmp()
    const content = Buffer.from('JAR-CONTENT')
    const port = new MemoryTransferPort()
    port.files.set('/opt/archives/v1/payload/order.jar', content)
    const t = createTransfer(port, fast)
    const target = join(root, 'order.jar')

    const s = await t.download(
      [
        {
          remotePath: '/opt/archives/v1/payload/order.jar',
          localPath: target,
          expectedHash: createHash('sha256').update(content).digest('hex')
        }
      ],
      {}
    )

    expect(s.files).toBe(1)
    expect(readFileSync(target).equals(content)).toBe(true)
    expect(existsSync(`${target}.part`)).toBe(false)
  })

  it('哈希不一致 → E_VERIFY_MISMATCH，且不留下半截正式文件（核心不变量）', async () => {
    const root = makeTmp()
    const port = new MemoryTransferPort()
    port.files.set('/opt/archives/v1/payload/order.jar', Buffer.from('CORRUPTED'))
    const t = createTransfer(port, fast)
    const target = join(root, 'order.jar')

    await expect(
      t.download([
        {
          remotePath: '/opt/archives/v1/payload/order.jar',
          localPath: target,
          expectedHash: createHash('sha256').update('ORIGINAL').digest('hex')
        }
      ])
    ).rejects.toMatchObject({ code: ErrorCode.E_VERIFY_MISMATCH })

    expect(existsSync(target)).toBe(false)
    expect(existsSync(`${target}.part`)).toBe(false)
  })

  it('远端不存在 → E_ARCHIVE_MISSING（且不创建空文件）', async () => {
    const root = makeTmp()
    const port = new MemoryTransferPort()
    const t = createTransfer(port, fast)
    const target = join(root, 'ghost.jar')

    await expect(
      t.download([{ remotePath: '/opt/archives/gone.jar', localPath: target }])
    ).rejects.toMatchObject({ code: ErrorCode.E_ARCHIVE_MISSING })
    expect(existsSync(target)).toBe(false)
  })

  it('覆盖已有文件：旧的正式文件在校验通过后才被替换', async () => {
    const root = makeTmp()
    const target = join(root, 'order.jar')
    writeFileSync(target, 'OLD')
    const content = Buffer.from('NEW-CONTENT')
    const port = new MemoryTransferPort()
    port.files.set('/opt/archives/v2/payload/order.jar', content)
    const t = createTransfer(port, fast)

    await t.download([
      {
        remotePath: '/opt/archives/v2/payload/order.jar',
        localPath: target,
        expectedHash: createHash('sha256').update(content).digest('hex')
      }
    ])

    expect(readFileSync(target).toString()).toBe('NEW-CONTENT')
    expect(existsSync(`${target}.part`)).toBe(false)
  })

  it('校验失败时不覆盖已有文件', async () => {
    const root = makeTmp()
    const target = join(root, 'order.jar')
    writeFileSync(target, 'OLD-GOOD')
    const port = new MemoryTransferPort()
    port.files.set('/opt/archives/v2/payload/order.jar', Buffer.from('NEW'))
    const t = createTransfer(port, fast)

    await expect(
      t.download([
        {
          remotePath: '/opt/archives/v2/payload/order.jar',
          localPath: target,
          expectedHash: createHash('sha256').update('SOMETHING-ELSE').digest('hex')
        }
      ])
    ).rejects.toMatchObject({ code: ErrorCode.E_VERIFY_MISMATCH })

    expect(readFileSync(target).toString()).toBe('OLD-GOOD')
  })

  it('大文件走流式下载（> 32MB），内容与哈希一致', async () => {
    const root = makeTmp()
    const port = new MemoryTransferPort()
    // 大文件用稀疏数据：全零 33MB
    const size = SMALL_FILE_THRESHOLD + 1024
    port.files.set('/opt/archives/v3/payload/big.bin', Buffer.alloc(size))
    const t = createTransfer(port, fast)
    const target = join(root, 'big.bin')
    const expected = createHash('sha256').update(Buffer.alloc(size)).digest('hex')

    await t.download(
      [
        {
          remotePath: '/opt/archives/v3/payload/big.bin',
          localPath: target,
          expectedHash: expected
        }
      ],
      {}
    )

    expect(existsSync(target)).toBe(true)
    expect((await fsp.stat(target)).size).toBe(size)
    expect(createHash('sha256').update(readFileSync(target)).digest('hex')).toBe(expected)
  })

  it('下载重试：前两次失败后成功', async () => {
    const root = makeTmp()
    const port = new MemoryTransferPort()
    port.files.set('/opt/a.jar', Buffer.from('X'))
    port.failTimes.set('/opt/a.jar', 2)
    const t = createTransfer(port, fast)
    const target = join(root, 'a.jar')

    const s = await t.download([{ remotePath: '/opt/a.jar', localPath: target }], {})
    expect(s.retries).toBe(2)
    expect(readFileSync(target).toString()).toBe('X')
  })

  it('下载重试耗尽 → E_DOWNLOAD_INTERRUPTED，不留下 .part', async () => {
    const root = makeTmp()
    const port = new MemoryTransferPort()
    port.files.set('/opt/a.jar', Buffer.from('X'))
    port.failTimes.set('/opt/a.jar', 99)
    const t = createTransfer(port, fast)
    const target = join(root, 'a.jar')

    await expect(
      t.download([{ remotePath: '/opt/a.jar', localPath: target }])
    ).rejects.toMatchObject({ code: ErrorCode.E_DOWNLOAD_INTERRUPTED })
    expect(existsSync(`${target}.part`)).toBe(false)
    expect(existsSync(target)).toBe(false)
  })

  it('本地目录会被自动创建', async () => {
    const root = makeTmp()
    const port = new MemoryTransferPort()
    port.files.set('/opt/a.jar', Buffer.from('X'))
    const t = createTransfer(port, fast)
    const target = join(root, 'deep', 'nested', 'a.jar')

    await t.download([{ remotePath: '/opt/a.jar', localPath: target }])
    expect(existsSync(target)).toBe(true)
  })

  /**
   * L15：覆盖落盘失败时**保留 `.part`**。
   *
   * 这一步走到时 `.part` 已经校验通过，"换不上去"和"没下下来"是两回事：
   * 把校验通过的成果删掉、又可能连旧文件一起没了，是最亏的收场。
   */
  it('L15：覆盖落盘失败 → .part 保留（内容可用）、旧目标不被清空', async () => {
    const root = makeTmp()
    const target = join(root, 'order.jar')
    writeFileSync(target, 'OLD-GOOD')
    const content = Buffer.from('NEW-CONTENT')
    const port = new MemoryTransferPort()
    port.files.set('/opt/archives/v2/payload/order.jar', content)
    const t = createTransfer(port, {
      ...fast,
      replaceFile: () => Promise.reject(new Error('模拟换名失败'))
    })

    const err = await t
      .download([
        {
          remotePath: '/opt/archives/v2/payload/order.jar',
          localPath: target,
          expectedHash: createHash('sha256').update(content).digest('hex')
        }
      ])
      .then(() => null)
      .catch((e: AppError) => e)

    expect(err?.code).toBe(ErrorCode.E_DOWNLOAD_INTERRUPTED)
    // 失败详情带上 .part 路径 —— 用户知道去哪儿把这份内容捡回来
    expect((err?.detail as { partPath?: string })?.partPath).toBe(`${target}.part`)
    // 旧文件原样还在（真实 replaceFile 会回滚；注入的替身直接失败，正好验"我们没动它"）
    expect(readFileSync(target).toString()).toBe('OLD-GOOD')
    // .part 保留，且是**校验通过**的完整内容
    expect(existsSync(`${target}.part`)).toBe(true)
    expect(readFileSync(`${target}.part`, 'utf8')).toBe('NEW-CONTENT')
  })
})

/* ------------------------------------------------------------------- L15 */

/** `replaceFile` 用的小假 fs：只实现它要的两个动作，可按序号注入失败。 */
class FakeReplaceFs implements ReplaceFsLike {
  files = new Map<string, string>()
  /** 第 N 次 `rename`（1-based）抛这个错 */
  renameFailAt = new Map<number, Error>()
  renameCalls: Array<{ from: string; to: string }> = []

  async rename(from: string, to: string): Promise<void> {
    this.renameCalls.push({ from, to })
    const scripted = this.renameFailAt.get(this.renameCalls.length)
    if (scripted) throw scripted
    // 与 Windows 一致：目标已存在就拒绝覆盖
    if (this.files.has(to)) {
      throw Object.assign(new Error(`EEXIST: ${to}`), { code: 'EEXIST' })
    }
    const content = this.files.get(from)
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' })
    }
    this.files.delete(from)
    this.files.set(to, content)
  }

  async rm(path: string): Promise<void> {
    this.files.delete(path)
  }
}

describe('replaceFile（覆盖式落盘，L15）', () => {
  it('目标已存在：旧的先挪到 .sfvm-old，换成功后备份被删（新内容就位）', async () => {
    const fs = new FakeReplaceFs()
    fs.files.set('/d/a.jar.part', 'NEW')
    fs.files.set('/d/a.jar', 'OLD')

    await replaceFile('/d/a.jar.part', '/d/a.jar', fs)

    expect(fs.files.get('/d/a.jar')).toBe('NEW')
    expect(fs.files.has('/d/a.jar.part')).toBe(false)
    // 备份是"这次覆盖前的内容"，成功后就该清掉，别在用户目录里留垃圾
    expect(fs.files.has('/d/a.jar.sfvm-old')).toBe(false)
  })

  it('第二次 rename 失败 → 旧文件被搬回原名，.part 内容也还在（两头都不丢）', async () => {
    const fs = new FakeReplaceFs()
    fs.files.set('/d/a.jar.part', 'NEW')
    fs.files.set('/d/a.jar', 'OLD')
    fs.renameFailAt.set(3, new Error('模拟换名失败'))

    await expect(replaceFile('/d/a.jar.part', '/d/a.jar', fs)).rejects.toThrow('模拟换名失败')

    // 关键断言：目标**不是空的**，还是原来那份旧内容
    expect(fs.files.get('/d/a.jar')).toBe('OLD')
    expect(fs.files.get('/d/a.jar.part')).toBe('NEW')
    expect(fs.files.has('/d/a.jar.sfvm-old')).toBe(false)
  })

  it('非"目标已存在"类的错误 → 直接抛，不碰任何东西', async () => {
    const fs = new FakeReplaceFs()
    fs.files.set('/d/a.jar.part', 'NEW')
    fs.files.set('/d/a.jar', 'OLD')
    fs.renameFailAt.set(1, Object.assign(new Error('EIO'), { code: 'EIO' }))

    await expect(replaceFile('/d/a.jar.part', '/d/a.jar', fs)).rejects.toThrow('EIO')
    expect(fs.renameCalls).toHaveLength(1)
    expect(fs.files.get('/d/a.jar')).toBe('OLD')
    expect(fs.files.get('/d/a.jar.part')).toBe('NEW')
  })
})

describe('真实文件流的完整往返（本地 → 内存远端 → 本地）', () => {
  it('上传再下载，字节完全一致', async () => {
    const root = makeTmp()
    const src = join(root, 'src.bin')
    const payload = randomBytes(300000)
    // 用流写一次，避免直接写整块
    const ws = createWriteStream(src)
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject)
      ws.on('finish', () => resolve())
      ws.end(payload)
    })

    const port = new MemoryTransferPort()
    const t = createTransfer(port, fast)
    await t.upload([{ localPath: src, remotePath: '/opt/payload/src.bin' }])

    const out = join(root, 'out.bin')
    await t.download([{ remotePath: '/opt/payload/src.bin', localPath: out }])

    expect(readFileSync(out).equals(payload)).toBe(true)
  })
})
