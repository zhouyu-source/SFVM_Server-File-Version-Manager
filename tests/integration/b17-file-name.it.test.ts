/**
 * B17 真机回归：**文件型目标的本地产物名与服务器端文件名不一致时，发布必须成功，
 * 且服务器上落地的是配置里的文件名**。
 *
 * ## 为什么必须真机跑
 *
 * 单测（`tests/unit/b17-file-name-align.test.ts`）已经用内存远端把三个阶段
 * （上传落盘名字 / 远端校验期望值 / 换版 rename 的源路径）证明过了。真机要补的是
 * 替身说了不算的那几条：
 *
 * 1. **换版是一次真的 `rename`**：`payload/<服务器端文件名>` → 目标路径。
 *    内存远端里"名字对不上"是一个 Map key 的差别，真机是一条 ENOENT；
 * 2. 阶段 3 的远端校验在真机走 `sha256sum -c` **命令分支**，
 *    清单里的 `relPath` 与磁盘上的文件名对不对得上，只有真机才验得了；
 * 3. **归档立刻自校验**：往期版本的 manifest 也是按服务器端文件名写的，
 *    真机 `verifyArchive` 必须回 `valid` —— 否则"归档完了但没人敢用它回滚"。
 *
 * ## 只用几字节的文件
 *
 * 这条用例的目的是**文件名**，不是吞吐。远端出带宽只有 ~0.46 MB/s，
 * 传大文件既慢又和本用例要验的东西无关 —— 所以产物只有几个字节。
 *
 * 安全边界：所有写操作都在 `/tmp/sfvm-b17/<随机>` 下，`afterAll` 连根删掉，
 * 跑完用 `node .tools/verify/check-residue.cjs` 复核 `/tmp` 零残留。
 * 默认 **skip**，需要显式给凭据才跑（见文件末尾）。
 */
import { existsSync, mkdtempSync, readFileSync as readKey, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { SshConnectionPool } from '@main/services/ssh-client'
import { createRemoteFs, type SftpLike } from '@main/services/remote-fs'
import {
  createArchiveService,
  createSftpArchivePort,
  type ArchiveSftpLike,
  type ArchivePorts
} from '@main/services/archive'
import {
  createDeployService,
  createSftpDeployPorts,
  type DeployContext,
  type DeployPorts,
  type DeployProgressInput,
  type DeploySftpLike
} from '@main/services/deploy'
import { createSftpHashPort, type HashSftpLike } from '@main/services/hash'
import type { Repositories } from '@main/db/repositories'
import { makeTestDb, type TestDb } from '../helpers/db'

const HOST = process.env['SFVM_IT_HOST']
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER']
const KEY_PATH = process.env['SFVM_IT_KEY']
const enabled = Boolean(HOST && USER && KEY_PATH && existsSync(KEY_PATH ?? ''))
const describeIf = enabled ? describe : describe.skip

const rand = (): string => Math.random().toString(36).slice(2, 10)
/** 远端临时根：只有 2 层，收尾必须连根删（见 rmRemoteRecursive 的说明） */
const REMOTE_ROOT = `/tmp/sfvm-b17-${rand()}`

let t: TestDb
let repo: Repositories
let pool: SshConnectionPool
let connId = ''
/**
 * **复用同一条 SFTP 通道**。
 *
 * `pool.sftp()` 每次调用都会新开一条 SFTP 子系统通道（见 `ssh-client.ts` 的说明：
 * 同一连接上的通道互相独立、不缓存），而 sshd 默认 `MaxSessions=10` ——
 * 测试里十几处"随用随开"会把这个额度用光，报出来的是一句
 * `CHANNEL_OPEN_FAILURE` → "SSH 连接已断开"（第一次真跑就是这么栽的，
 * 失败点还落在与被测逻辑无关的一行上）。应用里每个操作只建一次端口，
 * 测试也照这个来。
 */
let sftpHandle: SFTPWrapper

const localDirs: string[] = []

/** 造一个**指定文件名**的本地产物（内容只有几个字节）。 */
function localFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfvm-b17-'))
  localDirs.push(dir)
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

function makeCtx(): { ctx: DeployContext; logs: string[] } {
  const logs: string[] = []
  const ac = new AbortController()
  const ctx: DeployContext = {
    signal: ac.signal,
    progress: (_p: DeployProgressInput) => undefined,
    log: (text: string, level?: string) => logs.push(`${level ?? 'info'}\t${text}`)
  }
  return { ctx, logs }
}

function deployPorts(): DeployPorts {
  const capability = pool.capabilityOf(connId)!
  return createSftpDeployPorts({
    sftp: sftpHandle as unknown as DeploySftpLike,
    capability,
    tmpDir: `${(capability.homeDir || '/tmp').replace(/\/+$/, '')}/.sfvm-tmp`,
    exec: (cmd) => pool.exec(connId, cmd),
    hostname: 'probe'
  })
}

function archivePorts(): ArchivePorts {
  const capability = pool.capabilityOf(connId)!
  return {
    fs: createSftpArchivePort(sftpHandle as unknown as ArchiveSftpLike),
    hash: createSftpHashPort({
      sftp: sftpHandle as unknown as HashSftpLike,
      exec: (cmd) => pool.exec(connId, cmd),
      capability,
      tmpDir: `${(capability.homeDir || '/tmp').replace(/\/+$/, '')}/.sfvm-tmp`
    })
  }
}

/**
 * 递归删远端目录，**绕开** `remote-fs.rmrf` 的守卫。
 *
 * 守卫要求"至少 3 层"（防误删生产路径），而测试临时根只有 2 层 ——
 * 它本来就该被删，只是不该走守卫那条路。项目约定：跑完 `/tmp` 下 `sfvm-*` 必须为零。
 */
async function rmRemoteRecursive(sftp: SFTPWrapper, path: string): Promise<void> {
  const isDir = (): Promise<boolean> =>
    new Promise((resolve) => {
      sftp.stat(path, (err, st) => resolve(!err && Boolean(st && st.isDirectory())))
    })
  const children = (): Promise<string[]> =>
    new Promise((resolve) => {
      sftp.readdir(path, (err, list) =>
        resolve(err || !list ? [] : list.map((e) => e.filename).filter((n) => n !== '.' && n !== '..'))
      )
    })
  const unlink = (p: string): Promise<void> =>
    new Promise((resolve) => sftp.unlink(p, () => resolve()))
  const rmdir = (p: string): Promise<void> => new Promise((resolve) => sftp.rmdir(p, () => resolve()))

  if (!(await isDir())) {
    await unlink(path)
    return
  }
  for (const name of await children()) {
    await rmRemoteRecursive(sftp, `${path}/${name}`)
  }
  await rmdir(path)
}

/** 读远端文本（不存在返回 null —— 用来断言"文件真的没被创建"）。 */
async function readRemote(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    sftpHandle.readFile(path, (err, data) =>
      resolve(err || !data ? null : data.toString('utf8'))
    )
  })
}

async function listDir(path: string): Promise<string[]> {
  const fs = createRemoteFs(sftpHandle as unknown as SftpLike)
  try {
    const list = await fs.readdir(path)
    return list.map((e) => `${e.name}${e.isDirectory ? '/' : ''}`).sort()
  } catch {
    return []
  }
}

beforeAll(async () => {
  t = makeTestDb()
  repo = t.repo
  pool = new SshConnectionPool()
  const conn = repo.connections.create({
    name: 'probe',
    host: HOST!,
    port: PORT,
    username: USER!,
    authType: 'privateKey',
    privateKeyPath: KEY_PATH!
  })
  connId = conn.id
  const keyBlob = readKey(KEY_PATH!)
  const { fingerprintOf } = await import('@main/services/ssh-client')
  const fp = fingerprintOf(keyBlob)
  repo.knownHosts.trust(HOST!, PORT, fp.keyType, fp.fingerprint)
  await pool.connect({
    connectionId: connId,
    host: HOST!,
    port: PORT,
    username: USER!,
    authType: 'privateKey',
    privateKey: keyBlob,
    hostKeyPolicy: 'accept-any'
  })
  sftpHandle = (await pool.sftp(connId)) as unknown as SFTPWrapper
}, 120000)

afterAll(async () => {
  try {
    await rmRemoteRecursive(sftpHandle, REMOTE_ROOT)
  } catch {
    /* 清理失败不影响测试结论，但会被 check-residue 抓到 */
  }
  pool.disconnectAll?.()
  t.cleanup()
  for (const d of localDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describeIf('文件型目标：本地产物名 ≠ 服务器端文件名', () => {
  it('两次发布都用配置的文件名落盘，归档 manifest 也按它写（verifyArchive → valid）', async () => {
    const remotePath = `${REMOTE_ROOT}/svc/order.jar`
    const parent = `${REMOTE_ROOT}/svc`

    const env = repo.environments.create({
      name: `probe-${rand()}`,
      envType: 'test',
      connectionId: connId
    })
    // 本地产物的文件名故意与配置的服务器端文件名不同（构建产物常见的带版本号命名）
    const first = localFile('order-v2.jar', 'B17-v2')
    const target = repo.targets.create({
      environmentId: env.id,
      name: 'probe-file',
      kind: 'file',
      remotePath,
      localPath: first
    })

    const archive = createArchiveService({ repo })
    const svc = createDeployService({ repo, archive })

    /* ---------------- 第一次：首次发布（目标尚不存在） ---------------- */

    const r1 = makeCtx()
    const out1 = await svc.run({
      targetId: target.id,
      ports: deployPorts(),
      ctx: r1.ctx,
      releaseId: `rel-${rand()}`,
      note: null
    })

    console.log('\n===== B17 第一次发布（首次发布 + 名字不一致）=====')
    console.log('ok =', out1.ok, '| status =', out1.status)
    console.log('日志：\n' + r1.logs.join('\n'))
    console.log('服务器目录：', JSON.stringify(await listDir(parent)))

    expect(out1.ok, `首次发布应当成功，实际：${JSON.stringify(out1.failure)}`).toBe(true)

    // 1) 服务器上落地的是**配置里的文件名**，不是本地的 order-v2.jar
    expect(await readRemote(remotePath)).toBe('B17-v2')
    const after1 = await listDir(parent)
    expect(after1).toContain('order.jar')
    expect(after1, '暂存目录不该留下').not.toContain('order-v2.jar')
    expect(after1.filter((n) => n.startsWith('.sfvm-staging-'))).toEqual([])

    // 2) 提醒确实出现在日志里
    expect(r1.logs.join('\n')).toContain('order-v2.jar')
    expect(r1.logs.join('\n')).toContain('order.jar')

    /* ---------------- 前置校验里的提醒项（真链路） ---------------- */

    const pre = await svc.precheck({ targetId: target.id, ports: deployPorts() })
    const nameItem = pre.items.find((i) => i.key === 'file-name')
    console.log('前置校验 file-name 项：', JSON.stringify(nameItem))
    expect(nameItem?.level).toBe('warn')
    expect(nameItem?.detail).toContain('order-v2.jar')
    expect(pre.ok, '名字不一致不该阻断发布').toBe(true)

    /* ---------------- 第二次：换一个本地文件名再发一次 ---------------- */

    const second = localFile('order-v3.jar', 'B17-v3')
    repo.targets.update(target.id, { localPath: second })

    const r2 = makeCtx()
    const out2 = await svc.run({
      targetId: target.id,
      ports: deployPorts(),
      ctx: r2.ctx,
      releaseId: `rel-${rand()}`,
      note: null
    })

    console.log('\n===== B17 第二次发布（本地文件名又变了）=====')
    console.log('ok =', out2.ok, '| status =', out2.status)
    console.log('日志：\n' + r2.logs.join('\n'))

    expect(out2.ok, `第二次发布应当成功，实际：${JSON.stringify(out2.failure)}`).toBe(true)
    expect(await readRemote(remotePath)).toBe('B17-v3')

    // 3) 归档里的旧版本也是配置的文件名，且**立刻能自校验通过**
    const archived = repo.archives.listByTarget(target.id)
    console.log('归档：', JSON.stringify(archived.map((a) => ({ tag: a.versionTag, payload: a.payloadPath }))))
    expect(archived).toHaveLength(1)
    expect(await readRemote(`${archived[0].payloadPath}/order.jar`)).toBe('B17-v2')
    // 归档目录按 `<目标名>.versions` 建（目录条目带 `/` 后缀，见 listDir）
    expect(await listDir(parent)).toContain('order.jar.versions/')

    const verified = await archive.verifyArchive({
      archiveId: archived[0].id,
      ports: archivePorts()
    })
    console.log('归档自校验：', verified.status, '—', verified.message)
    expect(verified.status, `归档应当自校验通过，实际：${verified.message}`).toBe('valid')

    // 4) 台账里的逐文件清单用的也是服务器端文件名（下次发布的差异基准）
    const items = repo.releaseItems.listByRelease(out2.releaseId)
    console.log('本次逐文件清单：', JSON.stringify(items.map((i) => i.relPath)))
    expect(items.map((i) => i.relPath)).toEqual(['order.jar'])

    /* ---------------- 收尾：把测试造的远端目录清干净 ---------------- */

    await rmRemoteRecursive(sftpHandle, REMOTE_ROOT)
    expect(await readRemote(remotePath)).toBeNull()
    expect(await listDir(REMOTE_ROOT)).toEqual([])
  }, 300000)
})

/**
 * 运行方式（默认跳过，必须显式给凭据）：
 *
 * ```bash
 * SFVM_IT_HOST=192.0.2.10 SFVM_IT_USER=root \
 * SFVM_IT_KEY=/path/to/your-key.pem \
 * npx vitest run tests/integration/b17-file-name.it.test.ts
 * ```
 *
 * 跑完复核 `/tmp` 无残留：`node .tools/verify/check-residue.cjs`
 */
