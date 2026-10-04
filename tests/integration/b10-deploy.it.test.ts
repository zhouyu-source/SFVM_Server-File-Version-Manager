/**
 * B10 集成测试：在**真实服务器**上跑通发布主流程（T10.13），
 * 以及本批次的 DoD —— **断网注入（MT-02）**（T10.14）。
 *
 * ## 为什么这两件事必须真机跑
 *
 * 单测（`tests/unit/b10-deploy.test.ts`）用一个内存远端把七个阶段、全部补偿分支都跑遍了，
 * 但它证明不了下面这些**只在真链路上才成立**的事：
 *
 * 1. **换版是一次真的 `rename`**。同文件系统、跨目录、目录型/文件型两种目标 ——
 *    SFTP 的 rename 语义（目标已存在会失败、目录递归搬走）只有真机才验得了。
 *    原子换版是整个方案的地基（"目标路径为空的窗口"之所以能只有毫秒级，全靠它）。
 * 2. **归档的目录结构**必须与《方案书》附录 C 逐字一致 ——
 *    它是 B12（往期版本）与 B13（回滚）的共同契约，摆错一层以后就全对不上。
 * 3. **阶段 3 的远端校验走 `sha256sum -c` 命令分支**（真机有 coreutils），
 *    它要求把一个校验清单经 SFTP 写到 `$HOME/.sfvm-tmp` 再跑命令 ——
 *    这条路径上有没有目录、退出码怎么解析，单测里都是替身说了算。
 * 4. **MT-02 断网**：只有把 TCP 连接真的掐断，才能看见"发布任务失败之后
 *    服务器上到底还剩什么"。这是本批次唯一不可用替身糊弄过去的验收点 ——
 *    补不上这一段，"发布中断网不会把线上弄坏"就只是一句推测。
 *
 * ## 断网怎么造
 *
 * 起一个**本地 TCP 代理**，把 ssh2 连到 `127.0.0.1:<proxyPort>`；拔网线 =
 * 把代理两端 socket 一起 `destroy()`。这比 `pool.disconnect()` 更接近真实：
 * 后者是优雅关闭（`client.end()` 会把会话正常收掉），而拔网线是连接**突然消失** ——
 * 正是 MT-02 要模拟的形态（远端收不到任何"我要走了"的信号，
 * 半截的暂存目录原样留在地上）。
 *
 * 这个测试第一次跑出来的**不是断言失败，而是任务挂死 30 秒** ——
 * 因为 ssh2 的通道在连接断掉之后所有方法都不再回调（真机探针实测，详见
 * `src/main/infra/sftp-guard.ts`）。那条"挂死"是本批次最有价值的发现：
 * 对一个部署工具来说，"卡在 50% 不动"比"报错"糟得多 —— 用户既不知道发生了什么，
 * 也没法重试（任务不结束、本地互斥不放），而服务器上还留着半截暂存目录。
 * 修完之后这里断言的 30 秒上限就成了一根"别再退回去"的钉子。
 *
 * 安全边界：所有写操作都在 `/tmp/sfvm-b10/<随机>` 下，`afterAll` 一律清理，
 * 跑完用 `.tools/verify/check-residue.cjs` 复核 `/tmp` 零残留。
 * 默认**跳过**（`describe.skip`），需要显式提供凭据才执行 —— 运行方式见文件末尾。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync as readKey,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { connect as tcpConnect, createServer, type Server, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { SshConnectionPool } from '@main/services/ssh-client'
import { createRemoteFs, type SftpLike } from '@main/services/remote-fs'
import { createArchiveService } from '@main/services/archive'
import {
  createDeployService,
  createSftpDeployPorts,
  type DeployContext,
  type DeployPorts,
  type DeployProgressInput,
  type DeploySftpLike
} from '@main/services/deploy'
import { classifyResidue, isAutoCleanable, lockPathOf, stagingRootOf } from '@main/infra/deploy-plan'
import { MANIFEST_FILE_NAME, MANIFEST_TMP_NAME, parseManifestText } from '@main/infra/manifest-io'
import { LOCK_FILE_NAME, STAGING_PREFIX } from '@shared/contracts/deploy'
import { ErrorCode } from '@shared/errors'
import type { Repositories } from '@main/db/repositories'
import { makeTestDb, type TestDb } from '../helpers/db'

const HOST = process.env['SFVM_IT_HOST']
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER']
const KEY_PATH = process.env['SFVM_IT_KEY']

const enabled = Boolean(HOST && USER && KEY_PATH && existsSync(KEY_PATH ?? ''))
const describeIf = enabled ? describe : describe.skip

/** 所有测试数据的公共父目录（每个分组用完尝试删掉） */
const PARENT_DIR = '/tmp/sfvm-b10'
const rand = (): string => Math.random().toString(36).slice(2, 10)

type RemoteFs = ReturnType<typeof createRemoteFs>
type FileSnapshot = Array<{ relPath: string; size: number }>

/* ------------------------------------------------------------ 通用小工具 */

interface LogLine {
  text: string
  level?: string
}

interface TestCtx {
  ctx: DeployContext
  logs: LogLine[]
  progress: DeployProgressInput[]
  text: () => string
  /** 在"上传到一半"这类时刻做别的事（MT-02 用它拔网线） */
  onProgress: (fn: (p: DeployProgressInput) => void) => void
}

function makeCtx(): TestCtx {
  const logs: LogLine[] = []
  const progress: DeployProgressInput[] = []
  const hooks: Array<(p: DeployProgressInput) => void> = []
  const ac = new AbortController()
  return {
    logs,
    progress,
    text: () => logs.map((l) => `${l.level ?? 'info'}\t${l.text}`).join('\n'),
    onProgress: (fn) => hooks.push(fn),
    ctx: {
      signal: ac.signal,
      progress: (p) => {
        progress.push(p)
        for (const h of hooks) h(p)
      },
      log: (text, level) => logs.push({ text, ...(level ? { level } : {}) })
    }
  }
}

/** 造一个本地目录产物，返回该目录（同时登记到 `tempDirs` 里以便收尾清理）。 */
function makeLocalDir(files: Record<string, string>, tempDirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'sfvm-b10-local-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  return root
}

/** 造一个本地单文件产物，返回文件路径。 */
function makeLocalFile(name: string, content: string, tempDirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'sfvm-b10-file-'))
  tempDirs.push(root)
  const p = join(root, name)
  writeFileSync(p, content)
  return p
}

/**
 * 建发布的全部远端端口。
 *
 * 与 `src/main/ipc/deploy.ts` 的 `openPorts` 保持一致 —— 包括先把
 * `$HOME/.sfvm-tmp` 建出来（阶段 3 要把校验清单写到那儿）。
 */
async function buildPorts(pool: SshConnectionPool, connectionId: string): Promise<DeployPorts> {
  const capability = pool.capabilityOf(connectionId)
  if (!capability) throw new Error(`连接 ${connectionId} 未就绪：拿不到能力探测结果`)
  const sftp = (await pool.sftp(connectionId)) as unknown as DeploySftpLike
  const tmpDir = `${(capability.homeDir || '/tmp').replace(/\/+$/, '')}/.sfvm-tmp`
  const ports = createSftpDeployPorts({
    sftp,
    capability,
    tmpDir,
    exec: (cmd) => pool.exec(connectionId, cmd),
    hostname: 'sfvm-b10-it'
  })
  await ports.fs.mkdirp(tmpDir)
  return ports
}

/** 远端读一个文本文件（远端 shell 没有可靠的 `cat`，一律走 SFTP）。 */
async function readText(sftp: SFTPWrapper, path: string): Promise<string> {
  const chunks: Buffer[] = []
  const rs = sftp.createReadStream(path)
  await new Promise<void>((resolve, reject) => {
    rs.on('data', (d: Buffer) => chunks.push(d))
    rs.on('end', () => resolve())
    rs.on('error', reject)
  })
  return Buffer.concat(chunks).toString('utf8')
}

async function readdirNames(
  fs: RemoteFs,
  dir: string
): Promise<Array<{ name: string; isDirectory: boolean; size: number }>> {
  const list = await fs.readdir(dir)
  return list.map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: e.size }))
}

/** 目标当前内容快照（relPath → size）：用来判断"有没有半新半旧"。 */
async function snapshot(fs: RemoteFs, target: string, kind: 'dir' | 'file'): Promise<FileSnapshot> {
  const files =
    kind === 'dir'
      ? await fs.listAllFiles(target)
      : [
          {
            relPath: target.slice(target.lastIndexOf('/') + 1),
            size: (await fs.stat(target)).size
          }
        ]
  return files
    .map((f) => ({ relPath: f.relPath, size: f.size }))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
}

/* ==========================================================================
 * 一、T10.13：目录型 + 文件型各跑一次完整发布
 * ========================================================================== */

describeIf('B10 发布真机集成：完整发布闭环（T10.13）', () => {
  const CONNECTION_ID = 'it-b10'
  const tmpRoot = `${PARENT_DIR}/${rand()}`

  let t: TestDb
  let repo: Repositories
  let pool: SshConnectionPool
  let sftp: SFTPWrapper
  let remoteFs: RemoteFs
  let ports: DeployPorts
  let service: ReturnType<typeof createDeployService>

  let dirTargetId: string
  let fileTargetId: string

  const tempDirs: string[] = []
  const dirApp = `${tmpRoot}/web/dist`
  const dirArchive = `${dirApp}.versions`
  const fileApp = `${tmpRoot}/svc/order.jar`
  const fileArchive = `${fileApp}.versions`

  /** 目录型目标的一版内容（层级关系要能验出来，所以带两层子目录） */
  const localFilesV = (v: string): Record<string, string> => ({
    'index.html': `index-${v}`,
    'assets/app.js': `js-${v}`,
    'assets/nested/data.json': `{"v":"${v}"}`
  })

  beforeAll(async () => {
    t = makeTestDb()
    repo = t.repo

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
    ports = await buildPorts(pool, CONNECTION_ID)

    const conn = repo.connections.create({
      name: 'B10 集成测试机',
      host: HOST as string,
      port: PORT,
      username: USER as string,
      authType: 'privateKey'
    })
    const env = repo.environments.create({
      name: `B10 集成-${rand()}`,
      envType: 'test',
      connectionId: conn.id
    })

    dirTargetId = repo.targets.create({
      environmentId: env.id,
      name: '前端产物',
      kind: 'dir',
      remotePath: dirApp,
      localPath: makeLocalDir(localFilesV('v1'), tempDirs)
    }).id

    fileTargetId = repo.targets.create({
      environmentId: env.id,
      name: '后端 jar',
      kind: 'file',
      remotePath: fileApp,
      localPath: makeLocalFile('order.jar', 'jar-v1', tempDirs)
    }).id

    service = createDeployService({ repo, archive: createArchiveService({ repo }) })

    const cap = pool.capabilityOf(CONNECTION_ID)!
    console.info(
      `[B10 集成] 服务器=${HOST} 平台=${cap.platform} ` +
        `sha256sum=${cap.hasSha256sum} shasum=${cap.hasShasum}`
    )
    console.info(`[B10 集成] 临时根=${tmpRoot}`)
  }, 90000)

  afterAll(async () => {
    for (const d of tempDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* 尽力而为 */
      }
    }
    try {
      if (remoteFs) {
        await remoteFs.rmrf(tmpRoot)
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
  }, 60000)

  /* ------------------------------------------- 1) 首次发布（目标路径还不存在） */

  let firstDirVersionTag = ''

  it('目录型【首次发布】：目标路径不存在时跳过归档、直接换版建出目标', async () => {
    // 目标路径刻意不预先创建 —— 这正是"新机器上第一次发布"的形态，
    // 也是阶段 4（归档当前版本）无内容可归档的那条分支。
    expect(await remoteFs.exists(dirApp), '前置条件：目标路径还不该存在').toBe(false)

    const c = makeCtx()
    const out = await service.run({ targetId: dirTargetId, ports, ctx: c.ctx })
    expect(out.ok, `发布失败：${out.failure?.code} ${out.failure?.message}`).toBe(true)
    expect(out.versionTag).toMatch(/^\d{8}-\d{6}_[0-9a-f]{7}(-\d+)?$/)
    // 没有"当前版本"可归档，就不该凭空造一个往期版本
    expect(t.repo.archives.countByTarget(dirTargetId)).toBe(0)
    expect(out.archivedVersionTag).toBeUndefined()
    expect(c.text()).toContain('首次发布')

    // 目标被建出来，内容就是本地产物
    expect(await readText(sftp, `${dirApp}/index.html`)).toBe('index-v1')
    expect(await readText(sftp, `${dirApp}/assets/nested/data.json`)).toBe('{"v":"v1"}')

    // 暂存与锁都清干净
    expect(await remoteFs.exists(stagingRootOf(dirApp, out.releaseId))).toBe(false)
    expect(await remoteFs.exists(lockPathOf(dirApp))).toBe(false)

    // 进度条要走完全程（T10.12：UI 能收到进度）。
    // 注意 progress 事件是**两类**：阶段消息带 `stage`+`percent`，
    // 上传的字节进度只带 `bytes`/`totalBytes`（`JobService.applyProgress`
    // 逐字段合并，所以两者不会互相覆盖）—— 别指望同一个事件两样都有。
    const percents = c.progress.map((p) => p.percent ?? -1)
    expect(Math.max(...percents)).toBe(100)
    expect(c.progress.some((p) => p.stage === '上传到暂存目录')).toBe(true)
    expect(c.progress.some((p) => (p.bytes ?? 0) > 0)).toBe(true)

    firstDirVersionTag = out.versionTag
    console.info(
      `[B10 集成] 首次发布完成：${out.fileCount} 个文件 / ${out.totalBytes} 字节 ` +
        `tag=${out.versionTag} 耗时 ${out.durationMs}ms（releaseId=${out.releaseId}）`
    )
  }, 180000)

  /* --------------------------------------------------- 2) 第二次发布 + 归档 */

  it('目录型【第二次发布】：旧版本进归档，目录结构与《方案书》附录 C 一致', async () => {
    repo.targets.update(dirTargetId, { localPath: makeLocalDir(localFilesV('v2'), tempDirs) })

    const c = makeCtx()
    const out = await service.run({ targetId: dirTargetId, ports, ctx: c.ctx })
    expect(out.ok, `发布失败：${out.failure?.code} ${out.failure?.message}`).toBe(true)

    // 目标上是新版本，**只有**新版本（三个文件，没有多也没有少）
    expect(await snapshot(remoteFs, dirApp, 'dir')).toEqual([
      { relPath: 'assets/app.js', size: 'js-v2'.length },
      { relPath: 'assets/nested/data.json', size: '{"v":"v2"}'.length },
      { relPath: 'index.html', size: 'index-v2'.length }
    ])

    /* ---- 附录 C：<archive_dir>/<版本号>/{payload/<basename>/…, manifest.json} ---- */
    const rows = t.repo.archives.listByTarget(dirTargetId, 10)
    expect(rows).toHaveLength(1)
    const a = rows[0]!
    expect(a.storagePath.startsWith(`${dirArchive}/`)).toBe(true)
    expect(a.payloadPath).toBe(`${a.storagePath}/payload`)
    expect(a.kind).toBe('dir')

    // 归档目录下只有版本目录，没有任何临时物
    const versionDirs = await readdirNames(remoteFs, dirArchive)
    expect(versionDirs.map((e) => e.name)).toEqual([a.versionTag])
    expect(versionDirs[0]!.isDirectory).toBe(true)

    // payload/ 下的相对路径带一层 <basename>/ 前缀（目录型目标的约定）
    const payloadFiles = (await remoteFs.listAllFiles(a.payloadPath))
      .map((f) => f.relPath)
      .sort()
    expect(payloadFiles).toEqual([
      'dist/assets/app.js',
      'dist/assets/nested/data.json',
      'dist/index.html'
    ])
    // 归档的**内容**确实是上一版（不是刚发上去的那一版）
    expect(await readText(sftp, `${a.payloadPath}/dist/index.html`)).toBe('index-v1')

    // manifest：可解析、无告警、无半成品、与台账同指纹
    expect(await remoteFs.exists(`${a.storagePath}/${MANIFEST_TMP_NAME}`)).toBe(false)
    const { manifest, warnings } = parseManifestText(
      await readText(sftp, `${a.storagePath}/${MANIFEST_FILE_NAME}`)
    )
    expect(warnings, `manifest 告警：${warnings.join('；')}`).toEqual([])
    expect(manifest.kind).toBe('dir')
    expect(manifest.originalPath).toBe(dirApp)
    expect(manifest.targetName).toBe('前端产物')
    expect(manifest.fileCount).toBe(3)
    expect(manifest.rootHash).toBe(a.rootHash)
    expect(manifest.files.map((f) => f.relPath).sort()).toEqual(payloadFiles)
    for (const f of manifest.files) expect(f.hash).toMatch(/^[0-9a-f]{64}$/)

    // 版本号与内容同源：被归档的是 v1，用的就该是 v1 那次发布的版本号
    expect(a.versionTag).toBe(firstDirVersionTag)
    expect(out.archivedVersionTag).toBe(firstDirVersionTag)

    // 收尾：暂存与锁都不留，父目录里只有目标与归档目录
    expect(await remoteFs.exists(stagingRootOf(dirApp, out.releaseId))).toBe(false)
    expect(await remoteFs.exists(lockPathOf(dirApp))).toBe(false)
    expect((await readdirNames(remoteFs, `${tmpRoot}/web`)).map((e) => e.name).sort()).toEqual([
      'dist',
      'dist.versions'
    ])
  }, 180000)

  it('目录型【第三次发布】：往期版本累积，两次归档的版本号互不相同', async () => {
    repo.targets.update(dirTargetId, { localPath: makeLocalDir(localFilesV('v3'), tempDirs) })

    const out = await service.run({ targetId: dirTargetId, ports, ctx: makeCtx().ctx })
    expect(out.ok, `发布失败：${out.failure?.code} ${out.failure?.message}`).toBe(true)
    expect(await readText(sftp, `${dirApp}/index.html`)).toBe('index-v3')

    const list = t.repo.archives.listByTarget(dirTargetId, 10)
    expect(list).toHaveLength(2)
    expect(new Set(list.map((a) => a.versionTag)).size).toBe(2)
    for (const a of list) expect(await remoteFs.exists(`${a.payloadPath}/dist/index.html`)).toBe(true)

    console.info(`[B10 集成] 往期版本：${list.map((a) => a.versionTag).join('、')}`)
  }, 180000)

  /* --------------------------------------------------------- 3) 文件型目标 */

  it('文件型【首次发布 + 归档】：payload/order.jar 与目录型共用同一套路径', async () => {
    // 父目录 /tmp/sfvm-b10/<x>/svc 还不存在 —— 阶段 0 会自己建出来
    expect(await remoteFs.exists(fileApp)).toBe(false)

    const first = await service.run({ targetId: fileTargetId, ports, ctx: makeCtx().ctx })
    expect(first.ok, `文件型首次发布失败：${first.failure?.code} ${first.failure?.message}`).toBe(
      true
    )
    expect(await readText(sftp, fileApp)).toBe('jar-v1')
    expect(t.repo.archives.countByTarget(fileTargetId)).toBe(0)

    // 换一版再发：上一版进归档
    repo.targets.update(fileTargetId, { localPath: makeLocalFile('order.jar', 'jar-v2', tempDirs) })
    const second = await service.run({ targetId: fileTargetId, ports, ctx: makeCtx().ctx })
    expect(
      second.ok,
      `文件型第二次发布失败：${second.failure?.code} ${second.failure?.message}`
    ).toBe(true)
    expect(await readText(sftp, fileApp)).toBe('jar-v2')

    const rows = t.repo.archives.listByTarget(fileTargetId, 10)
    expect(rows).toHaveLength(1)
    const a = rows[0]!
    expect(a.kind).toBe('file')
    expect(a.storagePath.startsWith(`${fileArchive}/`)).toBe(true)
    // 附录 C 的文件型布局：payload/order.jar（**不**多包一层目录）
    expect((await remoteFs.listAllFiles(a.payloadPath)).map((f) => f.relPath)).toEqual(['order.jar'])
    expect(await readText(sftp, `${a.payloadPath}/order.jar`)).toBe('jar-v1')

    const { manifest, warnings } = parseManifestText(
      await readText(sftp, `${a.storagePath}/${MANIFEST_FILE_NAME}`)
    )
    expect(warnings).toEqual([])
    expect(manifest.kind).toBe('file')
    expect(manifest.fileCount).toBe(1)
    expect(manifest.files.map((f) => f.relPath)).toEqual(['order.jar'])
    expect(manifest.rootHash).toBe(a.rootHash)
    // 号与内容同源：用的还是 v1 那次发布的版本号
    expect(a.versionTag).toBe(first.versionTag)

    expect((await readdirNames(remoteFs, `${tmpRoot}/svc`)).map((e) => e.name).sort()).toEqual([
      'order.jar',
      'order.jar.versions'
    ])
  }, 180000)

  /* ------------------------------------------------------------- 4) 收尾核对 */

  it('全程零残留：父目录里只有目标与归档目录，台账全是 SUCCESS', async () => {
    for (const [parent, target] of [
      [`${tmpRoot}/web`, dirApp],
      [`${tmpRoot}/svc`, fileApp]
    ] as const) {
      const names = (await readdirNames(remoteFs, parent)).map((e) => e.name)
      for (const n of names) {
        expect(n.startsWith(STAGING_PREFIX), `${parent} 里留下了暂存目录 ${n}`).toBe(false)
        expect(n.endsWith('.part'), `${parent} 里留下了半成品 ${n}`).toBe(false)
      }
      expect(names).not.toContain(LOCK_FILE_NAME)
      expect(await remoteFs.exists(lockPathOf(target))).toBe(false)
    }
    const rows = t.repo.releases.listByTarget(dirTargetId, 20)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.status === 'SUCCESS')).toBe(true)
    console.info(`[B10 集成] 零残留核对通过；目录型发布记录 ${rows.length} 条`)
  }, 60000)
})

/* ==========================================================================
 * 二、T10.14：断网注入（MT-02）
 * ========================================================================== */

describeIf('B10 断网注入（MT-02）：发布中拔网线', () => {
  const CONNECTION_ID = 'it-b10-mt02'
  const OP_CONNECTION_ID = 'it-b10-mt02-op'
  const tmpRoot = `${PARENT_DIR}/${rand()}`

  const app = `${tmpRoot}/web/dist`
  const parent = `${tmpRoot}/web`

  let t: TestDb
  let repo: Repositories
  /** 会被拔网线的连接：走本地 TCP 代理 */
  let pool: SshConnectionPool
  let proxy: Server
  let proxySockets: Set<Socket>
  let proxyPort = 0
  let service: ReturnType<typeof createDeployService>
  /** 「运维连接」：直连，用来在事故之后上去看现场 */
  let opPool: SshConnectionPool
  let opSftp: SFTPWrapper
  let opFs: RemoteFs
  let opPorts: DeployPorts

  let targetId: string
  const tempDirs: string[] = []
  let localDir = ''
  let v1Snapshot: FileSnapshot = []
  let firstTag = ''
  let killedReleaseId = ''

  beforeAll(async () => {
    t = makeTestDb()
    repo = t.repo

    /* ---- 本地 TCP 代理：拔网线就是把这些 socket 一起 destroy ---- */
    proxySockets = new Set<Socket>()
    proxy = createServer((down) => {
      const up = tcpConnect(PORT, HOST as string)
      proxySockets.add(down)
      proxySockets.add(up)
      const drop = (): void => {
        proxySockets.delete(down)
        proxySockets.delete(up)
        down.destroy()
        up.destroy()
      }
      down.on('error', drop)
      up.on('error', drop)
      down.on('close', () => {
        proxySockets.delete(down)
        up.destroy()
      })
      up.on('close', () => {
        proxySockets.delete(up)
        down.destroy()
      })
      down.pipe(up)
      up.pipe(down)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()))
    proxyPort = (proxy.address() as { port: number }).port

    pool = new SshConnectionPool()
    await pool.connect({
      connectionId: CONNECTION_ID,
      host: '127.0.0.1',
      port: proxyPort,
      username: USER as string,
      authType: 'privateKey',
      privateKey: readKey(KEY_PATH as string),
      hostKeyPolicy: 'accept-any'
    })

    /* ---- 运维连接（直连）：事故之后由它上去核对现场 ---- */
    opPool = new SshConnectionPool()
    await opPool.connect({
      connectionId: OP_CONNECTION_ID,
      host: HOST as string,
      port: PORT,
      username: USER as string,
      authType: 'privateKey',
      privateKey: readKey(KEY_PATH as string),
      hostKeyPolicy: 'accept-any'
    })
    opSftp = await opPool.sftp(OP_CONNECTION_ID)
    opFs = createRemoteFs(opSftp as unknown as SftpLike)
    opPorts = await buildPorts(opPool, OP_CONNECTION_ID)

    const conn = repo.connections.create({
      name: 'B10 MT-02 测试机',
      host: HOST as string,
      port: PORT,
      username: USER as string,
      authType: 'privateKey'
    })
    const env = repo.environments.create({
      name: `B10 MT-02-${rand()}`,
      envType: 'test',
      connectionId: conn.id
    })

    /**
     * 8 MB 的"胖"文件：传得够久，才有"传到一半"这个时刻可以拔网线。
     * 8 MB ≤ `SMALL_FILE_THRESHOLD`(32MB)，走的是 ssh2 的 `fastPut` 快通道 ——
     * 也就是生产路径本身。
     */
    localDir = makeLocalDir(
      {
        'blob.bin': '', // 占位，下面单独写大文件
        'index.html': 'index-v1',
        'assets/app.js': 'js-v1'
      },
      tempDirs
    )
    writeFileSync(join(localDir, 'blob.bin'), Buffer.alloc(8 * 1024 * 1024, 0x41))

    targetId = repo.targets.create({
      environmentId: env.id,
      name: 'MT-02 目标',
      kind: 'dir',
      remotePath: app,
      localPath: localDir
    }).id

    service = createDeployService({
      repo,
      archive: createArchiveService({ repo }),
      // 重试退避在生产是 1s→2s→5s；这里只关心"断网之后剩什么"，
      // 没必要为此多等 8 秒（退避本身在单测里已经跑过）
      transferRetryDelay: () => 200
    })

    console.info(`[B10 MT-02] 代理端口=${proxyPort} 临时根=${tmpRoot}`)
  }, 120000)

  afterAll(async () => {
    for (const d of tempDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* 尽力而为 */
      }
    }
    try {
      await new Promise<void>((resolve) => proxy?.close(() => resolve()))
    } catch {
      /* 已关闭 */
    }
    for (const s of proxySockets ?? []) {
      try {
        s.destroy()
      } catch {
        /* 已销毁 */
      }
    }
    try {
      if (opFs) {
        await opFs.rmrf(tmpRoot)
        await new Promise<void>((resolve) => {
          opSftp.rmdir(PARENT_DIR, () => resolve())
        })
      }
    } catch (e) {
      console.warn(`清理 ${tmpRoot} 失败（需手工检查）：${(e as Error).message}`)
    }
    try {
      pool?.disconnectAll()
      opPool?.disconnectAll()
    } catch {
      /* 已断开 */
    }
    t?.cleanup()
  }, 60000)

  /** 拔网线：把代理两端 socket 无条件毁掉（远端收不到任何"我要走了"的信号）。 */
  function pullTheCable(): number {
    const n = proxySockets.size
    for (const s of [...proxySockets]) {
      proxySockets.delete(s)
      s.destroy()
    }
    return n
  }

  /** 发布期间禁止自动重连（T03.6）—— 与 IPC 层一样把连接标记成 busy。 */
  async function runOnFlakyLink(c: TestCtx): Promise<Awaited<ReturnType<typeof service.run>>> {
    pool.setBusy(CONNECTION_ID, true)
    try {
      const ports = await buildPorts(pool, CONNECTION_ID)
      return await service.run({ targetId, ports, ctx: c.ctx })
    } finally {
      pool.setBusy(CONNECTION_ID, false)
    }
  }

  it('先发布一版稳定内容，作为"旧版本"的基线', async () => {
    const c = makeCtx()
    const out = await runOnFlakyLink(c)
    expect(out.ok, `首次发布失败：${out.failure?.code} ${out.failure?.message}`).toBe(true)
    firstTag = out.versionTag
    v1Snapshot = await snapshot(opFs, app, 'dir')
    expect(v1Snapshot.map((f) => f.relPath)).toEqual(['assets/app.js', 'blob.bin', 'index.html'])
    console.info(
      `[B10 MT-02] 基线版本 ${out.versionTag}：${out.fileCount} 个文件 / ` +
        `${(out.totalBytes / 1024 / 1024).toFixed(1)} MB`
    )
  }, 180000)

  it('发布中断网：任务失败（不挂死），服务器仍是旧版本、没有半新半旧（MT-02 核心）', async () => {
    // 改内容（大文件保持同尺寸，避免"尺寸变了"被当成别的失败原因）
    writeFileSync(join(localDir, 'index.html'), 'index-v2-KILLED')
    writeFileSync(join(localDir, 'assets', 'app.js'), 'js-v2-KILLED')

    const c = makeCtx()
    let cablePulled = false
    c.onProgress((p) => {
      // 上传真的开始了（已经有字节在飞）才拔 —— 否则可能拔在阶段 0/1，
      // 那样测出来的只是"连接断了"，而不是"上传到一半断了"
      if (!cablePulled && (p.bytes ?? 0) > 0) {
        cablePulled = true
        const n = pullTheCable()
        console.info(`[B10 MT-02] 上传中途拔网线：销毁 ${n} 个 socket`)
      }
    })

    const started = Date.now()
    let timer: NodeJS.Timeout | undefined
    const out = await Promise.race([
      runOnFlakyLink(c),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('断网后 30 秒内发布任务仍未结束 —— MT-02 要求"任务失败"，挂死不算通过')
            ),
          30_000
        )
      })
    ])
    if (timer) clearTimeout(timer)

    expect(cablePulled, '整个发布过程里都没看到上传字节 —— 拔网线没拔在点上').toBe(true)
    console.info(
      `[B10 MT-02] 断网后任务在 ${Date.now() - started}ms 结束：` +
        `stage=${out.failure?.stage} code=${out.failure?.code}`
    )

    // 1) 任务是**失败**，不是挂死、也不是"成功"
    expect(out.ok).toBe(false)
    expect(out.failure).toBeTruthy()
    expect(['E_UPLOAD_INTERRUPTED', 'E_CONN_LOST', 'E_SFTP_CHANNEL']).toContain(out.failure!.code)
    killedReleaseId = out.releaseId

    // 2) 台账里留下一条 FAILED（发布历史里看得见这次事故）
    const rel = repo.releases.get(killedReleaseId)!
    expect(rel.status).toBe('FAILED')
    expect(rel.errorMessage ?? '').toContain(out.failure!.code)

    // 3) 服务器上**仍是旧版本**，逐文件核对，且没有半新半旧
    const after = await snapshot(opFs, app, 'dir')
    expect(after, '目标路径的内容集合变了（半新半旧）').toEqual(v1Snapshot)
    expect(await readText(opSftp, `${app}/index.html`)).toBe('index-v1')
    expect(await readText(opSftp, `${app}/assets/app.js`)).toBe('js-v1')
    // 目标路径仍然存在；归档目录没有被这次发布动过（阶段 4 根本没走到）
    expect(await opFs.exists(app)).toBe(true)
    expect(t.repo.archives.countByTarget(targetId)).toBe(0)

    // 4) 现场留下两样东西：半截的暂存目录 + 远端锁。
    //    暂存目录是"断网时物理上删不掉"的必然结果（连都连不上了），
    //    工具的责任是**能识别、能清理**（下两个用例验这件事）；
    //    锁留着是 §6.8/§630 的刻意设计（锁不自动删，只由人确认）。
    expect(
      await opFs.exists(stagingRootOf(app, killedReleaseId)),
      '断网后应当留下暂存目录（这正是要能识别的那类残留）'
    ).toBe(true)
    expect(await opFs.exists(lockPathOf(app))).toBe(true)
  }, 120000)

  it('断网后的残留可被识别并清理（只有 .sfvm-staging-* 属于可自动清理）', async () => {
    const staging = stagingRootOf(app, killedReleaseId)

    // 识别：父目录里那一项必须被认成 staging
    const found = classifyResidue({
      parentDir: parent,
      targetBase: 'dist',
      entries: await readdirNames(opFs, parent)
    })
    expect(found.map((r) => r.name)).toContain(`${STAGING_PREFIX}${killedReleaseId}`)
    expect(found.every((r) => isAutoCleanable(r))).toBe(true)

    // 通过**正式入口**（IPC 暴露的那个）清理，而不是自己 rmrf
    const cleaned = await service.cleanResidue({ targetId, paths: [staging], fs: opPorts.fs })
    expect(cleaned.failed).toEqual([])
    expect(cleaned.removed).toEqual([staging])
    expect(await opFs.exists(staging)).toBe(false)

    // 清完之后父目录里再没有可自动清理的残留
    const again = classifyResidue({
      parentDir: parent,
      targetBase: 'dist',
      entries: await readdirNames(opFs, parent)
    })
    expect(again).toEqual([])
    console.info('[B10 MT-02] 残留已被识别并清理')
  }, 90000)

  it('残留清掉后，运维手工清锁即可重新发布成功（并归档旧版本）', async () => {
    // 锁还在：下一次发布会因为"远端锁被占用"被拒 —— 这是设计行为
    // （锁里写的是上次发布自己的 releaseId，且不满 30 分钟 ⇒ 不算陈旧，不能自动清）。
    const blocked = makeCtx()
    const blockedOut = await service.run({
      targetId,
      ports: opPorts,
      ctx: blocked.ctx,
      cleanStaleLock: true
    })
    expect(blockedOut.ok).toBe(false)
    expect(blockedOut.failure?.code).toBe(ErrorCode.E_TARGET_BUSY)
    // 被拒的这次不能留下任何东西（连暂存目录都不该建：取锁在 mkdirp 之前）
    expect(await opFs.exists(stagingRootOf(app, blockedOut.releaseId))).toBe(false)
    expect(await readText(opSftp, `${app}/index.html`)).toBe('index-v1')

    // §630：锁"提示用户手动清理而非自动删除"。B11/B14 的「对账」会把这步做成按钮，
    // 这里按同样的语义把锁手工删掉。
    await opPorts.fs.removeFile(lockPathOf(app))
    expect(await opFs.exists(lockPathOf(app))).toBe(false)

    // 重新发布：本地内容换成正常的一版
    writeFileSync(join(localDir, 'index.html'), 'index-v3')
    writeFileSync(join(localDir, 'assets', 'app.js'), 'js-v3')
    const out = await service.run({ targetId, ports: opPorts, ctx: makeCtx().ctx })
    expect(out.ok, `恢复后发布失败：${out.failure?.code} ${out.failure?.message}`).toBe(true)
    expect(await readText(opSftp, `${app}/index.html`)).toBe('index-v3')

    // 上一版（v1）进了归档，用的还是 v1 那次发布的版本号
    const rows = t.repo.archives.listByTarget(targetId, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.versionTag).toBe(firstTag)
    expect(await readText(opSftp, `${rows[0]!.payloadPath}/dist/index.html`)).toBe('index-v1')

    // 最终状态干净：没有任何暂存/锁/半成品
    expect(await opFs.exists(stagingRootOf(app, killedReleaseId))).toBe(false)
    expect(await opFs.exists(lockPathOf(app))).toBe(false)
    expect((await readdirNames(opFs, parent)).map((e) => e.name).sort()).toEqual([
      'dist',
      'dist.versions'
    ])
    console.info(`[B10 MT-02] 恢复后发布成功，归档 = ${rows[0]!.versionTag}`)
  }, 300000)
})

/**
 * 运行方式（凭据通过环境变量传入，不写死在代码里）：
 *
 *   SFVM_IT_HOST=192.0.2.10 SFVM_IT_PORT=22 SFVM_IT_USER=root \
 *   SFVM_IT_KEY="/path/to/your-key.pem" \
 *   npx vitest run tests/integration/b10-deploy.it.test.ts
 *
 * 不提供这些变量时整个文件会被跳过（describe.skip），因此可以安全地留在仓库里。
 * 跑完请用 `node .tools/verify/check-residue.cjs` 复核服务器 /tmp 零残留。
 */
