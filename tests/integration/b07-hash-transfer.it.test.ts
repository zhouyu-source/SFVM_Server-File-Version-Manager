/**
 * B07 集成测试：在**真实服务器**上验证哈希与传输（T07.5 ~ T07.11）。
 *
 * 为什么必须真机跑：
 * - 单测用的是内存 SFTP，验证不了真实 OpenSSH 的语义差异：
 *   `sha256sum -c` 在真实 coreutils 下的退出码与行格式、
 *   SFTP 读流的分块行为、`fastPut`/`fastGet` 的实际表现
 * - 批次 DoD 明确要求"完成一次 300MB 上传并校验通过"
 *
 * 覆盖三条关键路径：
 * 1. 命令校验路径（远端有 sha256sum / shasum）
 * 2. 降级路径（**强制**声明远端无哈希工具，于是真的通过 SFTP 拉回文件算哈希）
 * 3. 300MB 大文件的流式上传 + 远端 sha256sum 校验（批次 DoD）
 *
 * 已知环境限制（实测，非产品缺陷）：该服务器**出方向**带宽约 0.46 MB/s
 * （裸 SSH `cat` 同速，故与 SFTP 实现无关），入方向约 8~13 MB/s。
 * 因此下载正确性用 40MB 验证；完整 300MB 往返请用 `SFVM_IT_BIG_DOWNLOAD=1` 打开。
 *
 * 安全边界：所有写操作都在 `<临时根>` = `/tmp/sfvm-b07/<随机>` 下，测试结束一律清理。
 * 默认**跳过**：需要显式提供凭据才执行。运行方式见文件末尾。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync as readKey,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promises as fsp } from 'node:fs'
import { SshConnectionPool } from '@main/services/ssh-client'
import { createRemoteFs, type SftpLike } from '@main/services/remote-fs'
import {
  createSftpHashPort,
  hashLocalArtifact,
  hashLocalFile,
  verifyRemote,
  type RemoteHashPort
} from '@main/services/hash'
import {
  createSftpTransferPort,
  createTransfer,
  type TransferSftpLike
} from '@main/services/transfer'
import { buildUnameCommand, buildCommandVCommand } from '@main/infra/remote-exec'
import { parsePlatform, commandExists } from '@main/infra/capability'
import type { SFTPWrapper } from 'ssh2'

const HOST = process.env['SFVM_IT_HOST']
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER']
const KEY_PATH = process.env['SFVM_IT_KEY']

const enabled = Boolean(HOST && USER && KEY_PATH && existsSync(KEY_PATH ?? ''))
const describeIf = enabled ? describe : describe.skip

/** 300MB：批次 DoD 规定的体量。 */
const BIG_BYTES = 300 * 1024 * 1024

describeIf('B07 哈希与传输真机集成', () => {
  const CONNECTION_ID = 'it-b07'

  let pool: SshConnectionPool
  let sftp: SFTPWrapper
  let remoteFs: ReturnType<typeof createRemoteFs>
  let hashPort: RemoteHashPort
  let transfer: ReturnType<typeof createTransfer>
  let localRoot: string

  const PARENT_DIR = '/tmp/sfvm-b07'
  const tmpRoot = `${PARENT_DIR}/${Math.random().toString(36).slice(2, 10)}`
  const payloadDir = `${tmpRoot}/payload`
  const remoteTmpDir = `${tmpRoot}/tmp`

  beforeAll(async () => {
    pool = new SshConnectionPool()
    await pool.connect({
      connectionId: CONNECTION_ID,
      host: HOST as string,
      port: PORT,
      username: USER as string,
      authType: 'privateKey',
      privateKey: readKey(KEY_PATH as string),
      hostKeyPolicy: 'accept-any'
    })
    sftp = await pool.sftp(CONNECTION_ID)
    remoteFs = createRemoteFs(sftp as unknown as SftpLike)

    await remoteFs.mkdirp(payloadDir)
    await remoteFs.mkdirp(remoteTmpDir)

    const capability = pool.capabilityOf(CONNECTION_ID)
    hashPort = createSftpHashPort({
      sftp,
      exec: (cmd) => pool.exec(CONNECTION_ID, cmd, 60000),
      capability: {
        hasSha256sum: capability?.hasSha256sum ?? false,
        hasShasum: capability?.hasShasum ?? false,
        platform: capability?.platform ?? 'unknown',
        homeDir: capability?.homeDir ?? ''
      },
      tmpDir: remoteTmpDir
    })
    transfer = createTransfer(createSftpTransferPort(sftp as unknown as TransferSftpLike))

    localRoot = mkdtempSync(join(tmpdir(), 'sfvm-b07-it-'))
  }, 60000)

  afterAll(async () => {
    try {
      if (remoteFs) {
        await remoteFs.rmrf(tmpRoot)
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
      pool?.disconnectAll()
    } catch {
      /* 已断开 */
    }
    try {
      rmSync(localRoot, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  })

  /* ------------------------------------------------------- 白名单命令真跑 */

  it('remote-exec 的模板在真实 shell 上可执行，能力探测结果自洽', async () => {
    const uname = await pool.exec(CONNECTION_ID, buildUnameCommand())
    expect(uname.code).toBe(0)
    const platform = parsePlatform(uname.stdout)
    expect(['linux', 'darwin', 'windows', 'unknown']).toContain(platform)

    const sha = await pool.exec(CONNECTION_ID, buildCommandVCommand('sha256sum'))
    const shasum = await pool.exec(CONNECTION_ID, buildCommandVCommand('shasum'))
    const cap = pool.capabilityOf(CONNECTION_ID)
    // 池探测出来的能力必须与现场复核一致，否则后续会走错分支
    expect(cap?.hasSha256sum).toBe(commandExists(sha.stdout) || sha.code === 0)
    expect(cap?.hasShasum).toBe(commandExists(shasum.stdout) || shasum.code === 0)
  })

  /* ---------------------------------------------------- 小目录：全链路 */

  it('本地哈希 → 上传 → 远端校验 → 篡改检出 → 降级校验也能检出', async () => {
    // 造一份含中文名与子目录的小产物
    const srcDir = join(localRoot, 'dist')
    const files: Record<string, string> = {
      'index.html': '<html>订单服务</html>',
      'assets/app.js': 'console.log("hello 世界")',
      'assets/css/app.css': 'body{margin:0}'
    }
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(srcDir, ...rel.split('/'))
      await fsp.mkdir(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }

    const local = await hashLocalArtifact({ localPath: srcDir, kind: 'dir' })
    expect(local.fileCount).toBe(3)
    expect(local.rootHash).toHaveLength(64)

    // 上传到远端 payload（目录型目标）
    const uploads = local.items.map((it) => ({
      localPath: join(srcDir, ...it.relPath.split('/')),
      remotePath: `${payloadDir}/${it.relPath}`,
      size: it.size
    }))
    const up = await transfer.upload(uploads)
    expect(up.files).toBe(3)
    expect(up.bytes).toBe(local.totalBytes)

    // 远端校验：走真实探测出来的分支
    const cap = pool.capabilityOf(CONNECTION_ID)
    const expectedMode = cap?.hasSha256sum ? 'sha256sum' : cap?.hasShasum ? 'shasum' : 'sftp-stream'
    const ok = await verifyRemote({
      port: hashPort,
      payloadDir,
      expected: local.items,
      releaseId: 'it-ok'
    })
    expect(ok.mode).toBe(expectedMode)
    expect(ok.diff.ok, `校验应通过，实际差异：${JSON.stringify(ok.diff)}`).toBe(true)
    expect(ok.diff.matchedCount).toBe(3)

    // 临时清单必须已被删除
    expect(await remoteFs.exists(`${remoteTmpDir}/sfvm-it-ok.sha256`)).toBe(false)

    // ---- 篡改一个字节：必须被检出 ----
    const victim = `${payloadDir}/assets/app.js`
    const ws = sftp.createWriteStream(victim)
    await new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve())
      ws.on('error', reject)
      ws.end('console.log("hello 世界!")') // 只多了一个字符
    })

    const bad = await verifyRemote({
      port: hashPort,
      payloadDir,
      expected: local.items,
      releaseId: 'it-bad'
    })
    expect(bad.diff.ok).toBe(false)
    const flagged = [...bad.diff.mismatch.map((m) => m.relPath), ...bad.diff.missing]
    expect(flagged).toContain('assets/app.js')

    // ---- 降级路径：强制声明远端没有哈希工具，真的通过 SFTP 读回文件算哈希 ----
    const fallbackPort: RemoteHashPort = {
      ...hashPort,
      capability: { ...hashPort.capability, hasSha256sum: false, hasShasum: false }
    }
    const viaSftp = await verifyRemote({
      port: fallbackPort,
      payloadDir,
      expected: local.items,
      releaseId: 'it-fallback'
    })
    expect(viaSftp.mode).toBe('sftp-stream')
    expect(viaSftp.diff.ok).toBe(false)
    const fbMismatch = viaSftp.diff.mismatch.find((m) => m.relPath === 'assets/app.js')
    expect(fbMismatch).toBeTruthy()
    // 降级路径能给出远端实际哈希，便于排障
    expect(fbMismatch?.actual).toBe(
      createHash('sha256').update('console.log("hello 世界!")').digest('hex')
    )

    // ---- 改回去之后应当重新通过（确认不是"永远报失败"）----
    const restore = sftp.createWriteStream(victim)
    await new Promise<void>((resolve, reject) => {
      restore.on('close', () => resolve())
      restore.on('error', reject)
      restore.end(files['assets/app.js'] as string)
    })
    const again = await verifyRemote({
      port: hashPort,
      payloadDir,
      expected: local.items,
      releaseId: 'it-again'
    })
    expect(again.diff.ok).toBe(true)
  }, 120000)

  /* ------------------------------------------- 300MB：批次 DoD 的要求 */

  it('300MB 文件：流式上传 → 远端 sha256sum 校验通过（DoD）', async () => {
    const localBig = join(localRoot, 'big.bin')
    writeFileSync(localBig, '')
    await fsp.truncate(localBig, BIG_BYTES)
    const bigHash = await hashLocalFile(localBig)

    const remoteBig = `${payloadDir}/big.bin`
    const started = Date.now()
    const summary = await transfer.upload(
      [{ localPath: localBig, remotePath: remoteBig, size: BIG_BYTES }],
      { progressIntervalMs: 200 }
    )
    const upMs = Date.now() - started
    expect(summary.bytes).toBe(BIG_BYTES)

    // 远端大小必须与本地一致（不是"传完了但实际上截断了"）
    const st = await remoteFs.stat(remoteBig)
    expect(st.size).toBe(BIG_BYTES)

    // 用真实 sha256sum 校验 300MB
    const verified = await verifyRemote({
      port: hashPort,
      payloadDir,
      expected: [{ relPath: 'big.bin', hash: bigHash, size: BIG_BYTES }],
      releaseId: 'it-big'
    })
    expect(verified.diff.ok, `300MB 校验失败：${JSON.stringify(verified.diff)}`).toBe(true)

    // 墙钟时间只做记录，不做门槛断言（链路快慢差异大）
    console.info(
      `[B07 集成] 300MB 上传 ${(upMs / 1000).toFixed(1)}s ` +
        `（${(BIG_BYTES / 1024 / 1024 / (upMs / 1000)).toFixed(1)} MB/s，校验模式 ${verified.mode}）`
    )
  }, 600000)

  it('下载走流式路径（> 32MB）：.part → 校验 → rename，字节与哈希一致', async () => {
    // 为什么不用 300MB 验下载：实测这台服务器**出方向**只有约 0.46 MB/s
    // （裸 SSH `cat` 也是这个数，说明是链路/服务器限制，与 SFTP 实现无关），
    // 下 300MB 要约 11 分钟，会把用例拖过超时。这里用 40MB（刚好越过 32MB
    // 阈值，因此上行与下行都真的走流式路径），完整 300MB 往返见下面按需开关的用例。
    const size = 40 * 1024 * 1024
    const localSrc = join(localRoot, 'mid.bin')
    writeFileSync(localSrc, '')
    await fsp.truncate(localSrc, size)
    const h = await hashLocalFile(localSrc)

    const remoteMid = `${payloadDir}/mid.bin`
    await transfer.upload([{ localPath: localSrc, remotePath: remoteMid, size }])

    const back = join(localRoot, 'mid-back.bin')
    const t0 = Date.now()
    await transfer.download([{ remotePath: remoteMid, localPath: back, expectedHash: h }])
    const ms = Date.now() - t0

    expect(statSync(back).size).toBe(size)
    expect(await hashLocalFile(back)).toBe(h)
    // .part 必须已被改名掉（不能留下半截文件）
    expect(existsSync(`${back}.part`)).toBe(false)
    console.info(
      `[B07 集成] 下载 40MB 用时 ${(ms / 1000).toFixed(1)}s ` +
        `（${(size / 1024 / 1024 / (ms / 1000)).toFixed(2)} MB/s，受出带宽限制）`
    )
  }, 300000)

  const bigDown = process.env['SFVM_IT_BIG_DOWNLOAD'] === '1'
  it.skipIf(!bigDown)(
    '（按需）300MB 完整往返：上传 → 校验 → 下载回本地比对哈希',
    async () => {
      const localBig = join(localRoot, 'rt.bin')
      writeFileSync(localBig, '')
      await fsp.truncate(localBig, BIG_BYTES)
      const h = await hashLocalFile(localBig)
      const remoteBig = `${payloadDir}/rt.bin`
      await transfer.upload([{ localPath: localBig, remotePath: remoteBig, size: BIG_BYTES }])

      const back = join(localRoot, 'rt-back.bin')
      const t0 = Date.now()
      await transfer.download([{ remotePath: remoteBig, localPath: back, expectedHash: h }])
      expect(statSync(back).size).toBe(BIG_BYTES)
      expect(await hashLocalFile(back)).toBe(h)
      expect(existsSync(`${back}.part`)).toBe(false)
      console.info(
        `[B07 集成] 300MB 下载用时 ${((Date.now() - t0) / 1000).toFixed(1)}s（出带宽约 0.46 MB/s 时约 11 分钟）`
      )
    },
    3600000
  )

  it('进度回调在真实链路上会被调用，且最后一次是"全部完成"', async () => {
    const localBig = join(localRoot, 'progress.bin')
    const size = 8 * 1024 * 1024
    writeFileSync(localBig, '')
    await fsp.truncate(localBig, size)

    const events: Array<{ transferred: number; total: number; filesDone: number }> = []
    await transfer.upload(
      [{ localPath: localBig, remotePath: `${payloadDir}/progress.bin`, size }],
      {
        progressIntervalMs: 200,
        onProgress: (p) =>
          events.push({ transferred: p.transferred, total: p.total, filesDone: p.filesDone })
      }
    )

    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last?.filesDone).toBe(1)
    expect(last?.transferred).toBe(last?.total)
    expect(last?.total).toBe(size)
  }, 120000)

  it('下载中断（取消）不会留下半截正式文件', async () => {
    const remoteBig = `${payloadDir}/progress.bin`
    const out = join(localRoot, 'cancelled.bin')
    const ac = new AbortController()
    ac.abort()

    await expect(
      transfer.download([{ remotePath: remoteBig, localPath: out }], { signal: ac.signal })
    ).rejects.toMatchObject({ code: 'E_JOB_CANCELLED' })

    expect(existsSync(out)).toBe(false)
    expect(existsSync(`${out}.part`)).toBe(false)
  }, 60000)

  it('非白名单命令在真实执行前就被拒绝', async () => {
    await expect(hashPort.runCommand('rm -rf /')).rejects.toThrow(/非白名单/)
    // 关键：服务器上的东西还在
    expect(await remoteFs.exists(payloadDir)).toBe(true)
  })
})

/**
 * 运行方式（凭据通过环境变量传入，不写死在代码里）：
 *
 *   $env:SFVM_IT_HOST='192.0.2.10'
 *   $env:SFVM_IT_USER='root'
 *   $env:SFVM_IT_KEY='C:\path\to\your-key.pem'
 *   pnpm exec vitest run tests/integration/b07-hash-transfer.it.test.ts
 *
 * 不提供这些变量时整个文件会被跳过（describe.skip），因此可以安全地留在仓库里。
 * 注意：本文件会往服务器上写 300MB 临时数据，跑之前确认 /tmp 空间充足。
 *
 * 可选开关：
 *   $env:SFVM_IT_BIG_DOWNLOAD='1'   # 额外跑 300MB 完整下载往返（该机出带宽下约需 11 分钟）
 */
