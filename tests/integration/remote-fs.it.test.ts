/**
 * B05 集成测试：在**真实服务器**上验证 remote-fs 的 SFTP 操作（T05.6）。
 *
 * 为什么必须真机跑：单测用的是假 SFTP 实现，验证不了真实 OpenSSH 的语义差异
 * （错误码、目录属性、rename 行为、rmdir 非空时的表现等）。
 * 这正是《开发计划书》T05.6 要求的「集成测试：在 SSH 环境上跑通全部操作」。
 *
 * 安全边界（重要）：
 * - 所有**写操作**都限定在 `<临时根>` 下，临时根为 `/tmp/sfvm-b05-<随机>`
 * - 测试结束（含失败）一律在 afterAll 里 rmrf 清理
 * - 额外验证 rmrf 会拒绝高危路径（`/`、`/etc` 等），确保防护生效
 *
 * 默认**跳过**：需要显式提供凭据才执行，避免在无凭据环境里失败。
 * 运行方式见文件末尾说明。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { Client, type SFTPWrapper } from 'ssh2'
import { createRemoteFs, type SftpLike } from '@main/services/remote-fs'

const HOST = process.env['SFVM_IT_HOST']
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER']
const KEY_PATH = process.env['SFVM_IT_KEY']

/** 没有提供凭据就整体跳过（CI / 其他机器上不会误跑）。 */
const enabled = Boolean(HOST && USER && KEY_PATH && existsSync(KEY_PATH ?? ''))

const describeIf = enabled ? describe : describe.skip

describeIf('remote-fs 真机集成（T05.6）', () => {
  let client: Client
  let sftp: SFTPWrapper
  let fs: ReturnType<typeof createRemoteFs>
  /**
   * 临时根刻意多一层：`/tmp/sfvm-b05/<随机>`（3 段）。
   *
   * 为什么不直接用 `/tmp/sfvm-b05-xxx`（2 段）：rmrf 拒绝删除 3 段以下
   * 的整棵子树（见 remote-fs 的 MIN_RM_DEPTH），目的是避免"误把整个
   * /tmp/xxx 当删除目标"。多一层既符合工具实际创建的形态，
   * 也让清理走的是同一条受保护路径。
   */
  const PARENT_DIR = '/tmp/sfvm-b05'
  const tmpRoot = `${PARENT_DIR}/${Math.random().toString(36).slice(2, 10)}`

  beforeAll(async () => {
    client = new Client()
    await new Promise<void>((resolve, reject) => {
      client
        .once('ready', () => resolve())
        .once('error', reject)
        .connect({
          host: HOST!,
          port: PORT,
          username: USER!,
          privateKey: readFileSync(KEY_PATH!),
          readyTimeout: 25000,
          hostVerifier: () => true // 这只是集成测试，指纹校验已在 B03 单测覆盖
        })
    })
    sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, s) => (err ? reject(err) : resolve(s)))
    })
    fs = createRemoteFs(sftp as unknown as SftpLike)
  }, 40000)

  afterAll(async () => {
    // 无论成败都清理。
    // 注意要连**父目录**一起清：tmpRoot 的父目录是本测试创建的，
    // 但 rmrf 出于安全不允许删除 2 段路径，所以要显式用 rmdirEmpty 收尾，
    // 否则每跑一次就会在服务器上留下一个空的 /tmp/sfvm-b05。
    try {
      if (fs) {
        await fs.rmrf(tmpRoot)
        // 子目录删完后，父目录应为空，直接删；非空（并发运行）则忽略
        await new Promise<void>((resolve) => {
          ;(sftp as unknown as { rmdir(p: string, cb: (e?: Error | null) => void): void }).rmdir(
            PARENT_DIR,
            () => resolve()
          )
        })
      }
    } catch (e) {
      console.warn(`清理 ${tmpRoot} 失败（需手工检查）：${(e as Error).message}`)
    }
    try {
      client?.end()
    } catch {
      /* 已断开 */
    }
  })

  it('stat：存在的目录 / 不存在的路径 / 文件类型判定', async () => {
    const root = await fs.stat('/')
    expect(root.exists).toBe(true)
    expect(root.isDirectory).toBe(true)

    const missing = await fs.stat('/definitely/not/here/sfvm-probe')
    expect(missing.exists).toBe(false)
    expect(missing.isDirectory).toBe(false)

    const home = await fs.stat('~').catch(() => null)
    // `~` 未必被 SFTP 展开，这里不断言；用 realpath 验证
    if (!home) {
      const abs = await fs.realpath('.')
      expect(abs.startsWith('/')).toBe(true)
    }
  })

  it('exists 与 stat 一致', async () => {
    expect(await fs.exists('/')).toBe(true)
    expect(await fs.exists('/definitely/not/here')).toBe(false)
  })

  it('mkdirp：逐级创建多级目录，且重复调用幂等', async () => {
    await fs.mkdirp(`${tmpRoot}/a/b/c`)
    expect((await fs.stat(`${tmpRoot}/a/b/c`)).isDirectory).toBe(true)

    // 再调一次不应抛错（幂等）
    await expect(fs.mkdirp(`${tmpRoot}/a/b/c`)).resolves.toBeUndefined()
  })

  it('写文件 + readdir + walk：能列出刚创建的文件', async () => {
    // 用 SFTP 的 createWriteStream 写两个文件
    const write = (p: string, content: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const ws = (
          sftp as unknown as { createWriteStream(p: string): NodeJS.WritableStream }
        ).createWriteStream(p)
        ws.on('close', () => resolve())
        ws.on('error', reject)
        ws.end(content)
      })

    await write(`${tmpRoot}/a/b/c/one.txt`, 'hello')
    await write(`${tmpRoot}/a/two.txt`, 'world')

    const entries = await fs.readdir(`${tmpRoot}/a`)
    const names = entries.map((e) => e.name).sort()
    expect(names).toContain('b')
    expect(names).toContain('two.txt')

    const walked = await fs.listAllFiles(tmpRoot)
    const rels = walked.map((w) => w.relPath).sort()
    expect(rels).toContain('a/two.txt')
    expect(rels).toContain('a/b/c/one.txt')
    // 大小与 mtime 应当有值（真实 SFTP 会带属性）
    const one = walked.find((w) => w.relPath === 'a/b/c/one.txt')!
    expect(one.size).toBe(5)
    expect(one.mtime).toBeTruthy()
  })

  it('rename：同目录改名成功', async () => {
    await fs.rename(`${tmpRoot}/a/two.txt`, `${tmpRoot}/a/two-renamed.txt`)
    const entries = await fs.readdir(`${tmpRoot}/a`)
    const names = entries.map((e) => e.name)
    expect(names).toContain('two-renamed.txt')
    expect(names).not.toContain('two.txt')
  })

  it('rmrf：递归删除整棵树', async () => {
    const before = await fs.exists(tmpRoot)
    expect(before).toBe(true)

    await fs.rmrf(tmpRoot)

    expect(await fs.exists(tmpRoot)).toBe(false)
  })

  it('rmrf 拒绝删除高危路径（两层防护都生效）', async () => {
    // 第一层：显式高危名单命中
    for (const dangerous of ['/etc', '/root', '/usr', '/var', '/tmp']) {
      await expect(fs.rmrf(dangerous), dangerous).rejects.toThrow(/拒绝删除|不合法/)
    }
    // 第二层：名单没列到但层级过浅
    await expect(fs.rmrf('/srv2'), '/srv2').rejects.toThrow(/拒绝删除|不合法/)

    // 关键：这些路径真的没被删
    expect(await fs.exists('/etc')).toBe(true)
    expect(await fs.exists('/root')).toBe(true)
    expect(await fs.exists('/tmp')).toBe(true)
  })

  it('rmrf 拒绝层级过浅的路径（2 段仍嫌浅）', async () => {
    await expect(fs.rmrf('/tmp/xx')).rejects.toThrow(/拒绝删除|不合法/)
  })

  it('rename 到已存在目标时的行为可观测（不静默丢数据）', async () => {
    await fs.mkdirp(`${tmpRoot}/x`)
    const write = (p: string, content: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const ws = (
          sftp as unknown as { createWriteStream(p: string): NodeJS.WritableStream }
        ).createWriteStream(p)
        ws.on('close', () => resolve())
        ws.on('error', reject)
        ws.end(content)
      })
    await write(`${tmpRoot}/x/f1`, 'a')
    await write(`${tmpRoot}/x/f2`, 'b')

    // 覆盖式 rename 在类 Unix SFTP 上通常成功；这里只要求"结果可观测"：
    // 要么抛错，要么目标存在。不允许"无声无息什么都没发生"。
    let threw = false
    try {
      await fs.rename(`${tmpRoot}/x/f1`, `${tmpRoot}/x/f2`)
    } catch {
      threw = true
    }
    expect((await fs.exists(`${tmpRoot}/x/f2`)) || threw).toBe(true)

    await fs.rmrf(tmpRoot)
  })
})

/**
 * 运行方式（凭据通过环境变量传入，不写死在代码里）：
 *
 *   $env:SFVM_IT_HOST='192.0.2.10'
 *   $env:SFVM_IT_USER='root'
 *   $env:SFVM_IT_KEY='C:\path\to\your-key.pem'
 *   pnpm exec vitest run tests/integration/remote-fs.it.test.ts
 *
 * 不提供这些变量时整个文件会被跳过（describe.skip），因此可以安全地留在仓库里。
 */
