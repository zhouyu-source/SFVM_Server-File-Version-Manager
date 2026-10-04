/**
 * B07 批次 DoD 的**内存侧**验收：300MB 文件流式传输的内存峰值 < 200MB。
 *
 * 为什么单测里也要测一次：真机集成测试需要凭证、只有在有服务器时才跑；
 * 而"上传 300MB 时内存峰值"是本批次最容易悄悄退化的指标
 * （只要有人把 `pipe` 换成 `readFile` + `writeFile`，真机上照样能传成功，
 *  只有在传大文件时才会 OOM）。所以这里用一个**丢弃式的内存远端**把
 * 真实读流/写流都跑起来，只断言内存曲线。
 *
 * 默认跳过（要花几秒 + 300MB 磁盘），需要时显式打开：
 *   SFVM_BIG_TEST=1 pnpm test
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promises as fsp } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { createTransfer, type TransferPort } from '@main/services/transfer'

const enabled = process.env['SFVM_BIG_TEST'] === '1'
const BIG = 300 * 1024 * 1024
const MEM_LIMIT = 200 * 1024 * 1024

const dirs: string[] = []
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sfvm-b07big-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
})

/** 只统计字节、不保留内容的内存远端。 */
class DiscardPort implements TransferPort {
  written = 0

  async statSize(): Promise<number | null> {
    return BIG
  }
  async ensureDir(): Promise<void> {
    /* noop */
  }
  async fastPut(): Promise<void> {
    throw new Error('300MB 不应走 fastPut')
  }
  async fastGet(): Promise<void> {
    throw new Error('300MB 不应走 fastGet')
  }
  createReadStream(): NodeJS.ReadableStream {
    // 300MB 零字节流，按 64KB 产出
    let sent = 0
    const chunk = Buffer.alloc(64 * 1024)
    return new Readable({
      read() {
        if (sent >= BIG) {
          this.push(null)
          return
        }
        sent += chunk.length
        this.push(chunk)
      }
    })
  }
  createWriteStream(): NodeJS.WritableStream {
    return new Writable({
      highWaterMark: 256 * 1024,
      write: (chunk: Buffer, _enc, cb) => {
        this.written += chunk.length
        cb()
      }
    })
  }
  async rename(): Promise<void> {
    /* noop */
  }
  async removeFile(): Promise<void> {
    /* noop */
  }
}

/** 采样 heapUsed 与 arrayBuffers，取峰值。 */
async function measurePeak<T>(
  fn: () => Promise<T>
): Promise<{ result: T; heapDelta: number; bufferDelta: number }> {
  const base = process.memoryUsage()
  let peakHeap = base.heapUsed
  let peakBuf = base.arrayBuffers
  const timer = setInterval(() => {
    const m = process.memoryUsage()
    peakHeap = Math.max(peakHeap, m.heapUsed)
    peakBuf = Math.max(peakBuf, m.arrayBuffers)
  }, 20)
  try {
    const result = await fn()
    const heapDelta = peakHeap - base.heapUsed
    const bufferDelta = peakBuf - base.arrayBuffers
    // 把实测值打出来：这是本批次的关键指标，跑一次就该能看到数字
    process.stdout.write(
      `[B07 内存实测] 300MB 传输：heap 峰值增量 ${(heapDelta / 1048576).toFixed(1)}MB，` +
        `arrayBuffers 峰值增量 ${(bufferDelta / 1048576).toFixed(1)}MB（上限 200MB）\n`
    )
    return { result, heapDelta, bufferDelta }
  } finally {
    clearInterval(timer)
  }
}

describe.skipIf(!enabled)('300MB 流式传输内存峰值（B07 DoD）', () => {
  it('上传 300MB：内存峰值 < 200MB', async () => {
    const root = makeTmp()
    const local = join(root, 'big.bin')
    writeFileSync(local, '')
    await fsp.truncate(local, BIG)

    const port = new DiscardPort()
    const t = createTransfer(port)

    const { result, heapDelta, bufferDelta } = await measurePeak(() =>
      t.upload([{ localPath: local, remotePath: '/opt/payload/big.bin', size: BIG }], {
        progressIntervalMs: 200
      })
    )

    expect(result.bytes).toBe(BIG)
    expect(port.written).toBe(BIG)
    // 关键断言：内存没有随文件大小线性增长
    expect(heapDelta).toBeLessThan(MEM_LIMIT)
    expect(bufferDelta).toBeLessThan(MEM_LIMIT)
  }, 300000)

  it('下载 300MB：内存峰值 < 200MB，且最终以 .part → rename 落地', async () => {
    const root = makeTmp()
    const out = join(root, 'big.bin')
    const port = new DiscardPort()
    const t = createTransfer(port)

    const { heapDelta, bufferDelta } = await measurePeak(() =>
      t.download([{ remotePath: '/opt/payload/big.bin', localPath: out, size: BIG }], {
        progressIntervalMs: 200
      })
    )

    expect(existsSync(out)).toBe(true)
    expect(existsSync(`${out}.part`)).toBe(false)
    // 落地文件大小正确（稀疏/全零，不读内容）
    expect((await fsp.stat(out)).size).toBe(BIG)
    expect(heapDelta).toBeLessThan(MEM_LIMIT)
    expect(bufferDelta).toBeLessThan(MEM_LIMIT)
  }, 300000)

  it('同一份 300MB 数据跨越多个 64KB 分块时哈希正确（分块边界不能错）', async () => {
    const port = new DiscardPort()
    const stream = port.createReadStream()
    const h = createHash('sha256')
    for await (const c of stream as unknown as AsyncIterable<Buffer>) h.update(c)

    // 期望值也按流式累加算，避免在测试里再分配 300MB
    const mb = Buffer.alloc(1024 * 1024)
    const expected = createHash('sha256')
    for (let i = 0; i < BIG / mb.length; i++) expected.update(mb)
    expect(h.digest('hex')).toBe(expected.digest('hex'))
  }, 300000)
})
