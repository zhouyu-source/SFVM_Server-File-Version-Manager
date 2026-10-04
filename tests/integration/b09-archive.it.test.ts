/**
 * B09 集成测试：在**真实服务器**上跑通「归档 → 列举 → 校验 → 按策略清理」闭环
 * （这是本批次 DoD 的原文要求）。
 *
 * 为什么必须真机跑（单测已覆盖内存远端）：
 * 1. **manifest 是经 SFTP 写流写出去的**。单测证明的是"分块喂进去能拼回合法 JSON"，
 *    证明不了 ssh2 的 `createWriteStream` 在"边写边 flush + 结束"时的真实行为
 *    （B07 就是在这一层踩到"正常结束却报中断"的坑）。
 * 2. **归档靠 `rename` 把目标整个搬走**，这条路径在真机上才验证得了：
 *    同文件系统、跨目录、目录型目标的递归移动。
 * 3. **校验走 `sha256sum -c` 命令分支**（远端有 coreutils 时会选它）。
 *    远端命令的退出码语义、输出格式只有真机才能验；单测里我把能力探测设成
 *    "没有哈希工具"，走的其实是降级分支。
 * 4. **保留策略要真的删掉服务器上的目录**（`rmrf` 三层防护 + 幂等），
 *    删错东西是不可逆的，必须在真机上确认"只删了该删的那个版本"。
 *
 * 安全边界：所有写操作都在 `/tmp/sfvm-b09/<随机>` 下，测试结束一律清理，
 * 并在跑完后用 `.tools/verify/check-residue.cjs` 复核 `/tmp` 零残留。
 * 默认**跳过**：需要显式提供凭据才执行。运行方式见文件末尾。
 */
import { existsSync, readFileSync as readKey } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { SshConnectionPool } from '@main/services/ssh-client'
import { createRemoteFs, type SftpLike } from '@main/services/remote-fs'
import { createSftpHashPort, type HashSftpLike } from '@main/services/hash'
import {
  createArchiveService,
  createSftpArchivePort,
  type ArchivePorts,
  type ArchiveSftpLike
} from '@main/services/archive'
import { MANIFEST_FILE_NAME, MANIFEST_TMP_NAME, parseManifestText } from '@main/infra/manifest-io'
import type { Repositories } from '@main/db/repositories'
import { makeTestDb, type TestDb } from '../helpers/db'

const HOST = process.env['SFVM_IT_HOST']
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER']
const KEY_PATH = process.env['SFVM_IT_KEY']

const enabled = Boolean(HOST && USER && KEY_PATH && existsSync(KEY_PATH ?? ''))
const describeIf = enabled ? describe : describe.skip

describeIf('B09 归档真机集成（DoD 闭环）', () => {
  const CONNECTION_ID = 'it-b09'
  const PARENT_DIR = '/tmp/sfvm-b09'
  const tmpRoot = `${PARENT_DIR}/${Math.random().toString(36).slice(2, 10)}`

  let t: TestDb
  let repo: Repositories
  let pool: SshConnectionPool
  let sftp: SFTPWrapper
  let remoteFs: ReturnType<typeof createRemoteFs>
  let ports: ArchivePorts
  let archive: ReturnType<typeof createArchiveService>
  let targetId: string
  let appDir: string
  let archiveDir: string
  /** 第一次归档的记录 id（后面用它来确认"被清理的正是最旧的那个"） */
  let firstArchiveId: string | null = null

  /** 由测试控制的时钟：让多次归档得到不同的版本号（版本号含到秒的时间） */
  let clock: Date
  const advance = (seconds = 1): void => {
    clock = new Date(clock.getTime() + seconds * 1000)
  }

  beforeAll(async () => {
    t = makeTestDb()
    repo = t.repo
    clock = new Date()

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

    const capability = pool.capabilityOf(CONNECTION_ID)
    expect(capability, '未能取得能力探测结果').toBeTruthy()
    const tmpDir = `${(capability!.homeDir || '/tmp').replace(/\/+$/, '')}/.sfvm-tmp`

    ports = {
      fs: createSftpArchivePort(sftp as unknown as ArchiveSftpLike),
      hash: createSftpHashPort({
        sftp: sftp as unknown as HashSftpLike,
        exec: (cmd) => pool.exec(CONNECTION_ID, cmd),
        capability: capability!,
        tmpDir
      })
    }

    // 目标目录（目录型）：多一层子目录，验证 relPath 的前缀规则
    appDir = `${tmpRoot}/app`
    archiveDir = `${appDir}.versions`

    const conn = repo.connections.create({
      name: '集成测试机',
      host: HOST as string,
      port: PORT,
      username: USER as string,
      authType: 'privateKey'
    })
    const env = repo.environments.create({
      name: `B09 集成-${Math.random().toString(36).slice(2, 8)}`,
      envType: 'test',
      connectionId: conn.id
    })
    targetId = repo.targets.create({
      environmentId: env.id,
      name: '集成目标',
      kind: 'dir',
      remotePath: appDir
    }).id

    archive = createArchiveService({ repo, now: () => clock })
    console.info(
      `[B09 集成] 服务器=${HOST} 平台=${capability!.platform} ` +
        `sha256sum=${capability!.hasSha256sum} shasum=${capability!.hasShasum}`
    )
    console.info(`[B09 集成] 临时根=${tmpRoot}`)
  }, 90000)

  afterAll(async () => {
    try {
      if (remoteFs) {
        await remoteFs.rmrf(tmpRoot)
        // 父目录可能被别的残留占着，删不掉也无所谓 —— 残留由 check-residue 复核
        await new Promise<void>((resolve) => {
          sftp.rmdir(PARENT_DIR, () => resolve())
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
    t?.cleanup()
  })

  /** 通过 SFTP 落一个文件（远端 shell 里没有 `cat`/`tee`，只能走 SFTP）。 */
  async function putFile(path: string, content: string): Promise<void> {
    const idx = path.lastIndexOf('/')
    if (idx > 0) await remoteFs.mkdirp(path.slice(0, idx))
    const ws = sftp.createWriteStream(path)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`写 ${path} 超时`)), 20000)
      ws.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.on('error', (e: Error) => {
        clearTimeout(timer)
        reject(e)
      })
      ws.end(content)
    })
  }

  /** 造一份"版本内容"：目标路径 = 待归档的现网内容 */
  async function seedVersion(tag: string): Promise<void> {
    await putFile(`${appDir}/app.txt`, `hello-${tag}\n`)
    await putFile(`${appDir}/assets/app.js`, `console.log('${tag}')\n`)
    await putFile(`${appDir}/assets/nested/data.json`, `{"tag":"${tag}"}\n`)
  }

  async function readText(path: string): Promise<string> {
    const chunks: Buffer[] = []
    const rs = sftp.createReadStream(path)
    await new Promise<void>((resolve, reject) => {
      rs.on('data', (d: Buffer) => chunks.push(d))
      rs.on('end', () => resolve())
      rs.on('error', reject)
    })
    return Buffer.concat(chunks).toString('utf8')
  }

  /* ------------------------------------------------------- 1) 归档 */

  it('归档：目标路径被搬空，归档目录里内容完整、manifest 可解析（T09.3 / T09.4）', async () => {
    await seedVersion('v1')

    const r = await archive.archiveVersion({ targetId, ports })
    expect(r.archive.kind).toBe('dir')
    expect(r.hashedRemotely, '未传已知清单时应现场算指纹').toBe(true)
    expect(r.archive.storagePath.startsWith(`${archiveDir}/`)).toBe(true)
    expect(r.archive.payloadPath).toBe(`${r.archive.storagePath}/payload`)

    // 目标路径已被清空
    expect(await remoteFs.exists(appDir), '归档后目标路径应当为空').toBe(false)

    // 归档目录里内容完整：payload/app/<原有结构>
    const payloadFiles = (await remoteFs.listAllFiles(r.archive.payloadPath))
      .map((f) => f.relPath)
      .sort()
    expect(payloadFiles).toEqual(['app/app.txt', 'app/assets/app.js', 'app/assets/nested/data.json'])

    // manifest 可解析、自洽，且**没有半成品**
    expect(await remoteFs.exists(`${r.archive.storagePath}/${MANIFEST_TMP_NAME}`)).toBe(false)
    const text = await readText(`${r.archive.storagePath}/${MANIFEST_FILE_NAME}`)
    const { manifest, warnings } = parseManifestText(text)
    expect(warnings, `manifest 告警：${warnings.join('；')}`).toEqual([])
    expect(manifest.kind).toBe('dir')
    expect(manifest.originalPath).toBe(appDir)
    expect(manifest.targetName).toBe('集成目标')
    expect(manifest.fileCount).toBe(3)
    // relPath 相对 payload ⇒ 目录型目标带一层 <basename>/ 前缀
    expect(manifest.files.map((f) => f.relPath)).toEqual([
      'app/app.txt',
      'app/assets/app.js',
      'app/assets/nested/data.json'
    ])
    // manifest 与台账必须指向同一个指纹（否则校验会永远失败）
    expect(manifest.rootHash).toBe(r.archive.rootHash)
    // §5.4：manifest 的时间带本地时区偏移
    expect(manifest.archivedAt).toMatch(/[+-]\d{2}:\d{2}$/)
    // 明细里的哈希都要是 64 位小写十六进制
    for (const f of manifest.files) expect(f.hash).toMatch(/^[0-9a-f]{64}$/)

    firstArchiveId = r.archive.id
    console.info(
      `[B09 集成] 归档 ${r.archive.versionTag}：${manifest.fileCount} 个文件 / ` +
        `${manifest.totalBytes} 字节，root=${r.archive.shortHash}`
    )
  }, 180000)

  /* ------------------------------------------------------- 2) 列举 */

  it('列举：按归档时间倒序，字段完整（T09.6）', async () => {
    const list = archive.list(targetId)
    expect(list.length).toBeGreaterThanOrEqual(1)
    const v = list[0]!
    expect(v.status).toBe('valid')
    expect(v.shortHash).toHaveLength(8)
    expect(v.versionTag).toMatch(/^\d{8}-\d{6}_[0-9a-f]{7}(-\d+)?$/)
    expect(v.storagePath).toBe(`${archiveDir}/${v.versionTag}`)
    expect(v.payloadPath).toBe(`${v.storagePath}/payload`)
    expect(await remoteFs.exists(v.storagePath)).toBe(true)
    expect(repo.archives.countByTarget(targetId)).toBe(list.length)
  })

  /* ------------------------------------------------------- 3) 校验 */

  it('校验通过：内容与 manifest 一致，走远端哈希命令分支（T09.7）', async () => {
    const v = archive.list(targetId)[0]!
    const result = await archive.verifyArchive({ archiveId: v.id, ports })

    expect(result.ok, `校验失败：${result.message}`).toBe(true)
    expect(result.status).toBe('valid')
    expect(result.diff.matchedCount).toBe(3)
    expect(['sha256sum', 'shasum']).toContain(result.mode)
    expect(repo.archives.get(v.id)!.status).toBe('valid')

    console.info(`[B09 集成] 校验通过（方式 ${result.mode}，${result.durationMs}ms）`)
  }, 120000)

  it('篡改归档内容后校验报 corrupt，并指出是哪个文件', async () => {
    const v = archive.list(targetId)[0]!
    const victim = `${v.payloadPath}/app/app.txt`
    const original = await readText(victim)

    await putFile(victim, 'tampered!\n')
    const bad = await archive.verifyArchive({ archiveId: v.id, ports })
    expect(bad.ok).toBe(false)
    expect(bad.status).toBe('corrupt')
    expect(bad.diff.mismatch.map((m) => m.relPath)).toContain('app/app.txt')
    expect(repo.archives.get(v.id)!.status).toBe('corrupt')

    // 复位，避免影响后面的用例
    await putFile(victim, original)
    const good = await archive.verifyArchive({ archiveId: v.id, ports })
    expect(good.ok, `复位后仍未通过：${good.message}`).toBe(true)
    expect(repo.archives.get(v.id)!.status).toBe('valid')

    console.info(`[B09 集成] 篡改检出：${bad.diff.mismatch.map((m) => m.relPath).join('、')}`)
  }, 120000)

  /* --------------------------------------------------- 4) 保留策略清理 */

  it('保留策略 count=2：删掉最旧的版本（真的删掉远端目录），保留其余（T09.8）', async () => {
    // 再归档两次，凑满 3 个版本
    await seedVersion('v2')
    advance()
    const second = await archive.archiveVersion({ targetId, ports })
    await seedVersion('v3')
    advance()
    const third = await archive.archiveVersion({ targetId, ports })

    const before = archive.list(targetId)
    expect(before.map((a) => a.id)).toHaveLength(3)
    const oldest = before[before.length - 1]!
    // 三个版本里最旧的必须是第一个用例归档的那个（不靠"列表最后一项"这种间接推断）
    expect(firstArchiveId, '第一个用例未记录归档 id').toBeTruthy()
    expect(oldest.id).toBe(firstArchiveId)
    expect(oldest.id).not.toBe(second.archive.id)
    expect(oldest.id).not.toBe(third.archive.id)

    repo.targets.update(targetId, { retainPolicy: JSON.stringify({ mode: 'count', value: 2 }) })
    const result = await archive.applyRetention({ targetId, fs: ports.fs })

    expect(result.failed).toEqual([])
    expect(result.removed.map((r) => r.id)).toEqual([oldest.id])
    // 只删了该删的那个：远端目录消失，其余两个版本与它们的内容都还在
    expect(await remoteFs.exists(oldest.storagePath), '被清理的版本目录应当已删除').toBe(false)
    for (const keep of [second.archive, third.archive]) {
      expect(await remoteFs.exists(keep.storagePath)).toBe(true)
      expect(await remoteFs.exists(`${keep.payloadPath}/app/app.txt`)).toBe(true)
    }
    const after = archive.list(targetId)
    expect(after.map((a) => a.id)).toEqual([third.archive.id, second.archive.id])
    expect(repo.archives.countByTarget(targetId)).toBe(2)

    console.info(
      `[B09 集成] 保留策略：${result.policyText}；删除 ${result.removed
        .map((r) => r.versionTag)
        .join('、')}`
    )
  }, 240000)

  it('清理后的保留版本仍可校验通过（清理没有破坏留下里的内容）', async () => {
    for (const v of archive.list(targetId)) {
      const r = await archive.verifyArchive({ archiveId: v.id, ports })
      expect(r.ok, `${v.versionTag} 校验失败：${r.message}`).toBe(true)
    }
  }, 180000)

  it('目标路径上没有任何残留的暂存/半成品（归档是原子 rename）', async () => {
    // 归档后目标路径应为空（本用例里后续版本又归档走了，所以仍然不存在）
    expect(await remoteFs.exists(appDir)).toBe(false)
    // 归档目录下只应有版本目录，没有 .tmp / .part 之类
    const entries = await remoteFs.readdir(archiveDir)
    for (const e of entries) {
      expect(e.name, `归档目录里出现了意外的条目`).toMatch(/^\d{8}-\d{6}_[0-9a-f]{7}(-\d+)?$/)
      expect(e.isDirectory, `${e.name} 不是目录`).toBe(true)
    }
    expect(entries.length).toBe(2)
  })
})

/**
 * 运行方式（凭据通过环境变量传入，不写死在代码里）：
 *
 *   SFVM_IT_HOST=192.0.2.10 SFVM_IT_PORT=22 SFVM_IT_USER=root \
 *   SFVM_IT_KEY="/path/to/your-key.pem" \
 *   npx vitest run tests/integration/b09-archive.it.test.ts
 *
 * 不提供这些变量时整个文件会被跳过（describe.skip），因此可以安全地留在仓库里。
 * 跑完请用 `node .tools/verify/check-residue.cjs` 复核服务器 /tmp 零残留。
 */
