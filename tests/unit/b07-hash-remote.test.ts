/**
 * B07 / T07.5 ~ T07.8 验收点：远端校验的能力分支、降级路径、清单上传与篡改检出。
 *
 * 用**内存远端**而不是 mock：
 * - `runCommand` 忠实复现 `sha256sum -c` 的行格式与退出码语义（含 `FAILED open or read`）
 * - 因此"篡改一个字节"这类关键用例可以在单测里真实地跑完，不必依赖真机
 *
 * 真机集成测试（tests/integration）只用来验证 ssh2 的语义差异。
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  createSftpHashPort,
  listRemoteFiles,
  verifyRemote,
  type HashSftpLike,
  type RemoteHashPort
} from '@main/services/hash'
import { buildSha256SumFile } from '@main/infra/hash-core'
import { pickVerifyMode, type ConnectionCapability } from '@main/infra/capability'
import { ErrorCode } from '@main/infra/errors'
import type { ReleaseItem } from '@shared/contracts/hash'

const sha256 = (b: Buffer | string): string =>
  createHash('sha256')
    .update(typeof b === 'string' ? Buffer.from(b, 'utf8') : b)
    .digest('hex')

/* ------------------------------------------------------------ 内存远端 */

interface Cap {
  hasSha256sum: boolean
  hasShasum: boolean
}

class MemoryRemote implements RemoteHashPort {
  files = new Map<string, Buffer>()
  removed: string[] = []
  commands: string[] = []
  manifestContent: string | null = null
  tmpDir = '/home/u/.sfvm-tmp'
  cap: Cap

  constructor(cap: Cap) {
    this.cap = cap
  }

  get capability(): RemoteHashPort['capability'] {
    return {
      hasSha256sum: this.cap.hasSha256sum,
      hasShasum: this.cap.hasShasum,
      platform: 'linux',
      homeDir: '/home/u'
    }
  }

  put(absPath: string, content: string | Buffer): void {
    this.files.set(absPath, typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
  }

  /** 归档文件型目标时要读它（`hashLocalArtifact` 侧的对称接口）。 */
  async statSize(remoteAbsPath: string): Promise<number | null> {
    const b = this.files.get(remoteAbsPath)
    return b ? b.length : null
  }

  async writeTextFile(absPath: string, content: string): Promise<void> {
    this.manifestContent = content
    this.files.set(absPath, Buffer.from(content, 'utf8'))
  }

  async removeFile(absPath: string): Promise<void> {
    this.removed.push(absPath)
    this.files.delete(absPath)
  }

  readStream(absPath: string): NodeJS.ReadableStream {
    const b = this.files.get(absPath)
    if (!b) throw new Error(`no such file: ${absPath}`)
    return Readable.from([b])
  }

  async listFiles(root: string): Promise<Array<{ relPath: string; size: number }>> {
    const prefix = `${root.replace(/\/+$/, '')}/`
    const out: Array<{ relPath: string; size: number }> = []
    for (const [abs, buf] of this.files) {
      if (abs.startsWith(prefix)) out.push({ relPath: abs.slice(prefix.length), size: buf.length })
    }
    return out
  }

  /**
   * 复现 coreutils 的 `-c` 语义：
   * - 输出 `<名字>: OK` / `<名字>: FAILED` / `<名字>: FAILED open or read`（**不回显哈希**）
   * - 全部 OK 时退出码 0，否则 1
   */
  async runCommand(cmd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    this.commands.push(cmd)
    const m = /^cd '(.+?)' && (sha256sum|shasum -a 256) -c( --status)? '(.+?)'$/.exec(cmd)
    if (!m) return { stdout: '', stderr: 'unexpected command', code: 127 }
    const cwd = m[1] as string
    const manifestPath = m[4] as string

    const manifest = this.files.get(manifestPath)
    if (!manifest) return { stdout: '', stderr: 'manifest missing', code: 1 }

    const out: string[] = []
    let failed = 0
    for (const line of manifest.toString('utf8').split('\n')) {
      if (!line) continue
      const lm = /^([0-9a-f]{64}) {2}(.*)$/.exec(line)
      if (!lm) {
        failed++
        continue
      }
      const expectedHash = lm[1] as string
      const name = lm[2] as string
      const actual = this.files.get(`${cwd}/${name}`)
      if (!actual) {
        out.push(`${name}: FAILED open or read`)
        failed++
      } else if (sha256(actual) === expectedHash) {
        out.push(`${name}: OK`)
      } else {
        out.push(`${name}: FAILED`)
        failed++
      }
    }
    return { stdout: `${out.join('\n')}\n`, stderr: '', code: failed === 0 ? 0 : 1 }
  }
}

/* ------------------------------------------------------------------ 用例 */

function itemsOf(files: Record<string, string>): ReleaseItem[] {
  return Object.entries(files).map(([relPath, content]) => ({
    relPath,
    hash: sha256(content),
    size: Buffer.byteLength(content)
  }))
}

const PAYLOAD = '/opt/app/payload'

describe('pickVerifyMode（T07.5）', () => {
  const mk = (
    hasSha256sum: boolean,
    hasShasum: boolean
  ): Pick<ConnectionCapability, 'hasSha256sum' | 'hasShasum'> => ({ hasSha256sum, hasShasum })

  it('按 sha256sum → shasum → sftp-stream 的优先级分支', () => {
    expect(pickVerifyMode(mk(true, true), true)).toBe('sha256sum')
    expect(pickVerifyMode(mk(false, true), true)).toBe('shasum')
    expect(pickVerifyMode(mk(false, false), true)).toBe('sftp-stream')
  })

  it('关闭校验时直接 disabled（生产环境不允许关闭，由上层拦截）', () => {
    expect(pickVerifyMode(mk(true, true), false)).toBe('disabled')
  })
})

describe('verifyRemote 命令分支（T07.7）', () => {
  it('全部一致 → ok，并且用的是 sha256sum -c', async () => {
    const local = { 'a.js': 'AAA', 'sub/b.js': 'BBB' }
    const expected = itemsOf(local)
    const remote = new MemoryRemote({ hasSha256sum: true, hasShasum: true })
    for (const [rel, content] of Object.entries(local)) remote.put(`${PAYLOAD}/${rel}`, content)

    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected,
      releaseId: 'rel-1'
    })

    expect(r.mode).toBe('sha256sum')
    expect(r.diff.ok).toBe(true)
    expect(r.diff.matchedCount).toBe(2)
    expect(remote.commands).toHaveLength(1)
    expect(remote.commands[0]).toContain(`sha256sum -c '/home/u/.sfvm-tmp/sfvm-rel-1.sha256'`)
    // 清单按 coreutils 格式、两空格分隔
    expect(remote.manifestContent).toBe(buildSha256SumFile(expected))
  })

  it('清单在校验完立即从远端删除（方案书 §6.6）', async () => {
    const remote = new MemoryRemote({ hasSha256sum: true, hasShasum: true })
    remote.put(`${PAYLOAD}/a.js`, 'AAA')

    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'AAA' }),
      releaseId: 'rel-2'
    })

    expect(r.diff.ok).toBe(true)
    expect(remote.removed).toEqual(['/home/u/.sfvm-tmp/sfvm-rel-2.sha256'])
    expect(remote.files.has('/home/u/.sfvm-tmp/sfvm-rel-2.sha256')).toBe(false)
  })

  it('篡改远端一个字节会被检出（T07.7 的核心验收点）', async () => {
    const local = { 'a.js': 'AAA', 'sub/b.js': 'BBB' }
    const remote = new MemoryRemote({ hasSha256sum: true, hasShasum: true })
    remote.put(`${PAYLOAD}/a.js`, 'AAA')
    // 模拟上传损坏：最后一个字节变了
    remote.put(`${PAYLOAD}/sub/b.js`, 'BBC')

    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf(local),
      releaseId: 'rel-3'
    })

    expect(r.diff.ok).toBe(false)
    expect(r.diff.matchedCount).toBe(1)
    expect(r.diff.mismatch).toEqual([
      { relPath: 'sub/b.js', expected: sha256('BBB'), actual: null }
    ])
    expect(r.rawTail).toContain('FAILED')
  })

  it('远端文件缺失 → missing', async () => {
    const remote = new MemoryRemote({ hasSha256sum: true, hasShasum: true })
    remote.put(`${PAYLOAD}/a.js`, 'AAA')

    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'AAA', 'b.js': 'BBB' }),
      releaseId: 'rel-4'
    })

    expect(r.diff.missing).toEqual(['b.js'])
    expect(r.diff.ok).toBe(false)
  })

  it('只有 shasum 时走 shasum -a 256 -c', async () => {
    const remote = new MemoryRemote({ hasSha256sum: false, hasShasum: true })
    remote.put(`${PAYLOAD}/a.js`, 'AAA')

    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'AAA' }),
      releaseId: 'rel-5'
    })

    expect(r.mode).toBe('shasum')
    expect(r.diff.ok).toBe(true)
    expect(remote.commands[0]).toContain('shasum -a 256 -c')
  })

  it('退出码非 0 但逐行结果全 OK（输出格式不符预期）时判定失败：宁可误报，也不放过损坏', async () => {
    const remote = new MemoryRemote({ hasSha256sum: true, hasShasum: true })
    remote.put(`${PAYLOAD}/a.js`, 'AAA')
    // 命令报错，但 stdout 看起来"全对"—— 说明输出不是我们预期的格式，
    // 此时不能报通过
    remote.runCommand = async () => ({
      stdout: 'a.js: OK\n',
      stderr: 'boom',
      code: 1
    })

    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'AAA' }),
      releaseId: 'rel-6'
    })

    expect(r.diff.ok).toBe(false)
    expect(r.diff.mismatch).toEqual([
      { relPath: '<unparsed>', expected: '1 个文件的清单', actual: null }
    ])
  })

  it('退出码非 0 且输出完全无法解析时，缺失清单里的全部文件', async () => {
    const remote = new MemoryRemote({ hasSha256sum: true, hasShasum: true })
    remote.put(`${PAYLOAD}/a.js`, 'AAA')
    remote.runCommand = async () => ({ stdout: '乱七八糟的输出', stderr: 'boom', code: 1 })

    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'AAA' }),
      releaseId: 'rel-6b'
    })

    expect(r.diff.ok).toBe(false)
    expect(r.diff.missing).toEqual(['a.js'])
  })

  it('清单写失败时不会静默通过（异常向上抛）', async () => {
    const remote = new MemoryRemote({ hasSha256sum: true, hasShasum: true })
    remote.writeTextFile = async () => {
      throw new Error('permission denied')
    }
    await expect(
      verifyRemote({
        port: remote,
        payloadDir: PAYLOAD,
        expected: itemsOf({ 'a.js': 'AAA' }),
        releaseId: 'rel-7'
      })
    ).rejects.toThrow('permission denied')
  })

  it('releaseId 里的路径分隔符被清洗，临时清单不会跑出临时目录', async () => {
    const remote = new MemoryRemote({ hasSha256sum: true, hasShasum: true })
    remote.put(`${PAYLOAD}/a.js`, 'AAA')
    await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'AAA' }),
      releaseId: '../../etc/evil'
    })
    expect(remote.commands[0]).toContain("'/home/u/.sfvm-tmp/sfvm-etcevil.sha256'")
  })

  it('空清单无需上传、直接通过', async () => {
    const remote = new MemoryRemote({ hasSha256sum: true, hasShasum: true })
    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: [],
      releaseId: 'rel-8'
    })
    expect(r.diff.ok).toBe(true)
    expect(remote.commands).toEqual([])
    expect(remote.manifestContent).toBeNull()
  })

  it('verify_remote 关闭时返回 disabled 且不执行任何命令', async () => {
    const remote = new MemoryRemote({ hasSha256sum: true, hasShasum: true })
    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'AAA' }),
      releaseId: 'rel-9',
      verifyRemoteEnabled: false
    })
    expect(r.mode).toBe('disabled')
    expect(r.diff.ok).toBe(true)
    expect(remote.commands).toEqual([])
  })
})

describe('verifyRemote SFTP 流式降级分支（T07.6）', () => {
  it('无哈希工具时通过 SFTP 读流计算，结果正确', async () => {
    const local = { 'a.js': 'AAA', 'sub/b.js': 'BBB' }
    const remote = new MemoryRemote({ hasSha256sum: false, hasShasum: false })
    for (const [rel, content] of Object.entries(local)) remote.put(`${PAYLOAD}/${rel}`, content)

    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf(local),
      releaseId: 'rel-10'
    })

    expect(r.mode).toBe('sftp-stream')
    expect(r.diff.ok).toBe(true)
    expect(r.diff.matchedCount).toBe(2)
    // 降级路径不跑任何命令
    expect(remote.commands).toEqual([])
  })

  it('降级路径也能检出篡改，并能给出远端实际哈希', async () => {
    const remote = new MemoryRemote({ hasSha256sum: false, hasShasum: false })
    remote.put(`${PAYLOAD}/a.js`, 'AAAB')
    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'AAA' }),
      releaseId: 'rel-11'
    })
    expect(r.diff.ok).toBe(false)
    expect(r.diff.mismatch[0]?.relPath).toBe('a.js')
    expect(r.diff.mismatch[0]?.actual).toBe(sha256('AAAB'))
  })

  it('降级路径能判出 extra（命令路径做不到，这是它的优势）', async () => {
    const remote = new MemoryRemote({ hasSha256sum: false, hasShasum: false })
    remote.put(`${PAYLOAD}/a.js`, 'AAA')
    remote.put(`${PAYLOAD}/leftover.tmp`, 'X')

    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'AAA' }),
      releaseId: 'rel-13'
    })
    expect(r.diff.extra).toEqual(['leftover.tmp'])
    expect(r.diff.ok).toBe(false)
  })

  it('降级路径能判出 missing', async () => {
    const remote = new MemoryRemote({ hasSha256sum: false, hasShasum: false })
    const r = await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'AAA' }),
      releaseId: 'rel-14'
    })
    expect(r.diff.missing).toEqual(['a.js'])
  })

  it('降级路径的进度回调按文件推进', async () => {
    const remote = new MemoryRemote({ hasSha256sum: false, hasShasum: false })
    remote.put(`${PAYLOAD}/a.js`, 'A')
    remote.put(`${PAYLOAD}/b.js`, 'B')
    const seen: number[] = []
    await verifyRemote({
      port: remote,
      payloadDir: PAYLOAD,
      expected: itemsOf({ 'a.js': 'A', 'b.js': 'B' }),
      releaseId: 'rel-15',
      onProgress: (done) => seen.push(done)
    })
    expect(seen).toEqual([1, 2])
  })

  it('取消时抛 E_JOB_CANCELLED', async () => {
    const remote = new MemoryRemote({ hasSha256sum: false, hasShasum: false })
    remote.put(`${PAYLOAD}/a.js`, 'A')
    const ac = new AbortController()
    ac.abort()
    await expect(
      verifyRemote({
        port: remote,
        payloadDir: PAYLOAD,
        expected: itemsOf({ 'a.js': 'A' }),
        releaseId: 'rel-16',
        signal: ac.signal
      })
    ).rejects.toMatchObject({ code: ErrorCode.E_JOB_CANCELLED })
  })
})

/* ------------------------------------------------------- ssh2 接线层单测 */

interface FakeAttrs {
  isDirectory(): boolean
  isFile(): boolean
  size: number
  mtime: number
}

/**
 * 用内存实现冒充 SFTPWrapper：`readdir` 只返回**直接子项**并区分目录/文件，
 * 这样 `listRemoteFiles` 的递归逻辑是被真实走到的。
 */
function makeFakeSftp(tree: Record<string, Buffer>): {
  sftp: HashSftpLike
  written: Map<string, string>
  unlinked: string[]
} {
  const written = new Map<string, string>()
  const unlinked: string[] = []

  const allFiles = (): Map<string, Buffer> =>
    new Map<string, Buffer>([
      ...Object.entries(tree),
      ...[...written.entries()].map(([k, v]) => [k, Buffer.from(v, 'utf8')] as [string, Buffer])
    ])

  const sftp: HashSftpLike = {
    stat(p, cb) {
      const f = allFiles().get(p)
      if (!f) {
        cb(new Error('no such file'), {
          isDirectory: () => false,
          isFile: () => false,
          size: 0,
          mtime: 0
        })
        return
      }
      cb(null, { isDirectory: () => false, isFile: () => true, size: f.length, mtime: 0 })
    },
    readdir(dir, cb) {
      const prefix = `${dir.replace(/\/+$/, '')}/`
      const dirs = new Set<string>()
      const files = new Map<string, Buffer>()
      for (const [k, v] of allFiles()) {
        if (!k.startsWith(prefix)) continue
        const rest = k.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) files.set(rest, v)
        else dirs.add(rest.slice(0, slash))
      }
      const list: Array<{ filename: string; attrs: FakeAttrs }> = [
        ...[...dirs].map((name) => ({
          filename: name,
          attrs: { isDirectory: () => true, isFile: () => false, size: 0, mtime: 0 }
        })),
        ...[...files].map(([name, v]) => ({
          filename: name,
          attrs: { isDirectory: () => false, isFile: () => true, size: v.length, mtime: 0 }
        }))
      ]
      cb(null, list)
    },
    createReadStream(p) {
      const f = allFiles().get(p)
      if (!f) throw new Error(`no such file: ${p}`)
      return Readable.from([f])
    },
    writeFile(p, data, _o, cb) {
      written.set(p, data.toString('utf8'))
      cb(null)
    },
    unlink(p, cb) {
      unlinked.push(p)
      cb(null)
    }
  }

  return { sftp, written, unlinked }
}

describe('createSftpHashPort / listRemoteFiles', () => {
  it('listRemoteFiles 递归产出相对路径', async () => {
    const { sftp } = makeFakeSftp({
      '/opt/payload/a.js': Buffer.from('A'),
      '/opt/payload/sub/b.js': Buffer.from('B'),
      '/opt/payload/sub/deep/c.js': Buffer.from('C')
    })
    const files = await listRemoteFiles(sftp, '/opt/payload')
    expect(files.map((f) => f.relPath)).toEqual(['a.js', 'sub/b.js', 'sub/deep/c.js'])
  })

  it('端口写清单走 SFTP 的 writeFile，路径被规范化', async () => {
    const { sftp, written } = makeFakeSftp({})
    const port = createSftpHashPort({
      sftp,
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      capability: { hasSha256sum: true, hasShasum: false, platform: 'linux', homeDir: '/home/u' },
      tmpDir: '/home/u/.sfvm-tmp/'
    })
    await port.writeTextFile('/home/u/.sfvm-tmp//x.sha256', 'abc')
    expect(written.get('/home/u/.sfvm-tmp/x.sha256')).toBe('abc')
    expect(port.tmpDir).toBe('/home/u/.sfvm-tmp')
  })

  it('runCommand 对非白名单命令直接拒绝（不落到 exec）', async () => {
    const { sftp } = makeFakeSftp({})
    let called = false
    const port = createSftpHashPort({
      sftp,
      exec: async () => {
        called = true
        return { stdout: '', stderr: '', code: 0 }
      },
      capability: { hasSha256sum: true, hasShasum: false, platform: 'linux', homeDir: '/home/u' },
      tmpDir: '/home/u/.sfvm-tmp'
    })
    await expect(port.runCommand('rm -rf /')).rejects.toMatchObject({
      code: ErrorCode.E_PATH_UNSAFE
    })
    expect(called).toBe(false)
  })
})
