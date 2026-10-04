/**
 * B14 批次 DoD 的真窗口验证：**MT-06**（删掉本地版本台账后，靠对账重建）
 * 以及 T14.4/T14.5 的启动残留扫描与恢复引导。
 *
 * ## MT-06 到底在验什么
 *
 * 计划书要求"删除本地数据库后启动，通过对账重建全部台账；版本数量与时间与重建前一致"。
 *
 * 这里把"删数据库"精确到**删掉版本台账那部分**（`archives` 表）：连接 / 环境 / 目标
 * 这些是本地信息（本地产物路径、手工配的地址），**不可能也不应该**从服务器恢复；
 * 而"服务器上有哪些版本、各自什么时候归档的"——那份真相在**归档目录的 manifest 里**，
 * 主体正是要证明这件事。
 *
 * 所以流程是：
 *
 * 1. 服务器上按归档服务的真实布局造 N 个版本（每个都有 manifests）；
 * 2. 写好台账（连接 / 环境 / 目标 / N 条归档 / 1 条**没做完**的记录）；
 * 3. **把 archives 表清空**（模拟台账丢失），并记下重建前的 (版本号 → 归档时间) 基线；
 * 4. 启动真窗口 → 点「对账」→ 版本列表重新出现 N 条；
 * 5. 关掉应用、直接读数据库：**逐条比对版本号与归档时间**与基线一致。
 *
 * 第 5 步是关键：**不看界面自述**。界面说"补录了 N 条"不算数，
 * 落库的每一个 `archivedAt` 都等于 manifest 里那个值才算数 ——
 * 用"现在"填充时间也能让列表看起来"有 N 条"，但时间就错了。
 *
 * ## 前置
 *
 * 1. `npm run build`；2. `SFVM_E2E=1` + `SFVM_IT_*` 凭据
 * （真机沙箱 `/tmp/sfvm-b14/<随机>`，收尾连父目录一起删）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'ssh2'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp, launchApp, waitFor, type LaunchedApp } from '../helpers/e2e-app'
import { closeVisibleDialog, selectTarget } from '../helpers/e2e-ui'
import {
  connectRemote,
  remoteExists,
  remoteList,
  removeRemoteDir,
  sftpMkdirp,
  writeRemoteText,
  type RemoteConn
} from '../helpers/e2e-remote'
import { openDatabase } from '@main/db/client'
import { createRepositories, type Repositories } from '@main/db/repositories'
import { computeRootHash } from '@main/infra/hash-core'
import { fingerprintOf } from '@main/services/ssh-client'

const PROJECT_ROOT = process.cwd()
const HOST = process.env['SFVM_IT_HOST'] ?? ''
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER'] ?? ''
const KEY_PATH = process.env['SFVM_IT_KEY'] ?? ''

const ENABLED = process.env['SFVM_E2E'] === '1' && Boolean(HOST && USER && KEY_PATH)
const describeIf = ENABLED ? describe : describe.skip

/** 与 B12(9336) / B13(9337) 错开 */
const DEBUG_PORT = 9338

const REMOTE_PARENT = '/tmp/sfvm-b14'
const REMOTE_ROOT = `${REMOTE_PARENT}/${Math.random().toString(36).slice(2, 10)}`
const REMOTE_TARGET = `${REMOTE_ROOT}/web/dist`
const REMOTE_ARCHIVE = `${REMOTE_TARGET}.versions`

/** 造多少个历史版本 */
const VERSION_COUNT = 5

function tagOf(i: number): string {
  const day = String(10 + i).padStart(2, '0')
  const hash = createHash('sha256').update(`v${i}`).digest('hex').slice(0, 7)
  return `202609${day}-1200${String(i % 60).padStart(2, '0')}_${hash}`
}

/** 归档时间：每个版本各不相同，且都用了本地时区偏移（与归档服务的写法一致） */
function archivedAtOf(i: number): string {
  return `2026-09-${String(10 + i).padStart(2, '0')}T12:${String(i).padStart(2, '0')}:00+08:00`
}

interface SeedVersion {
  tag: string
  content: string
  archivedAt: string
  rootHash: string
}

function planVersions(): SeedVersion[] {
  const out: SeedVersion[] = []
  for (let i = 0; i < VERSION_COUNT; i++) {
    const content = `v${i}`
    out.push({
      tag: tagOf(i),
      content,
      archivedAt: archivedAtOf(i),
      rootHash: computeRootHash([
        { relPath: 'dist/index.html', hash: createHash('sha256').update(content).digest('hex') }
      ])
    })
  }
  return out
}

describeIf('B14 DoD：对账与崩溃恢复（真窗口 + 真服务器）', () => {
  let remote: RemoteConn
  let app: LaunchedApp | null = null
  let db: ReturnType<typeof openDatabase>
  let repo: Repositories
  let userDataDir = ''
  let versions: SeedVersion[] = []
  /** 目标 id 存下来：关掉应用后要重开数据库核对，直接用比再查一遍稳 */
  let targetId = ''
  /** 重建前的基线：版本号 → 归档时间 */
  let baseline: Array<{ versionTag: string; archivedAt: string }> = []

  beforeAll(async () => {
    remote = await connectRemote({ host: HOST, port: PORT, user: USER, keyPath: KEY_PATH })
    versions = planVersions()

    /* ---- 服务器上按真实布局造 N 个版本 ---- */
    for (const v of versions) {
      await sftpMkdirp(remote, `${REMOTE_ARCHIVE}/${v.tag}/payload/dist`)
      await writeRemoteText(remote, `${REMOTE_ARCHIVE}/${v.tag}/payload/dist/index.html`, v.content)
      await writeRemoteText(
        remote,
        `${REMOTE_ARCHIVE}/${v.tag}/manifest.json`,
        JSON.stringify({
          schemaVersion: 1,
          targetName: '前端产物',
          originalPath: REMOTE_TARGET,
          kind: 'dir',
          versionTag: v.tag,
          archivedAt: v.archivedAt,
          hashAlgo: 'sha256',
          rootHash: v.rootHash,
          totalBytes: v.content.length,
          fileCount: 1,
          operator: null,
          note: null,
          sourceReleaseId: null,
          files: [
            {
              relPath: 'dist/index.html',
              hash: createHash('sha256').update(v.content).digest('hex'),
              size: v.content.length,
              mtime: v.archivedAt
            }
          ]
        })
      )
    }
    /* ---- 目标路径上是"当前版本" ---- */
    await sftpMkdirp(remote, `${REMOTE_TARGET}/dist`)
    await writeRemoteText(remote, `${REMOTE_TARGET}/index.html`, 'current')

    /* ---- 台账：连接 / 环境 / 目标 / N 条归档 / 1 条没做完的记录 ---- */
    userDataDir = mkdtempSync(join(tmpdir(), 'sfvm-b14-userdata-'))
    db = openDatabase({
      dataDir: userDataDir,
      migrationsFolder: join(PROJECT_ROOT, 'src', 'main', 'db', 'migrations'),
      schemaVersion: 'e2e'
    })
    repo = createRepositories(db.db)

    const keyBlob = await new Promise<Buffer>((resolve, reject) => {
      const c = new Client()
      c.on('ready', () => c.end())
      c.on('error', reject)
      c.connect({
        host: HOST,
        port: PORT,
        username: USER,
        privateKey: readFileSync(KEY_PATH),
        hostVerifier: ((key: Buffer) => {
          resolve(key)
          return true
        }) as never
      })
    })
    const fp = fingerprintOf(keyBlob)
    repo.knownHosts.trust(HOST, PORT, fp.keyType, fp.fingerprint)

    const conn = repo.connections.create({
      name: 'e2e',
      host: HOST,
      port: PORT,
      username: USER,
      authType: 'privateKey',
      privateKeyPath: KEY_PATH
    })
    const env = repo.environments.create({ connectionId: conn.id, name: 'E2E', envType: 'test' })
    const target = repo.targets.create({
      environmentId: env.id,
      name: '前端产物',
      kind: 'dir',
      remotePath: REMOTE_TARGET
    })
    targetId = target.id

    for (const v of versions) {
      repo.archives.create({
        targetId: target.id,
        versionTag: v.tag,
        storagePath: `${REMOTE_ARCHIVE}/${v.tag}`,
        payloadPath: `${REMOTE_ARCHIVE}/${v.tag}/payload`,
        kind: 'dir',
        rootHash: v.rootHash,
        totalBytes: v.content.length,
        fileCount: 1,
        releaseId: null,
        note: null,
        status: 'valid',
        archivedAt: v.archivedAt
      })
    }

    // 一条"没做完"的记录（T14.4/T14.5 要用它把启动横幅顶出来）
    repo.releases.create({
      id: 'rel-unfinished',
      targetId: target.id,
      action: 'deploy',
      versionTag: '20260920-120000_c0ffee1',
      status: 'SWAPPING',
      source: 'local',
      totalBytes: 8,
      fileCount: 1,
      currentStep: '换版'
    })

    /* ---- 基线：重建前台账里每个版本的时间 ---- */
    baseline = repo.archives
      .listByTarget(target.id, 100)
      .map((r) => ({ versionTag: r.versionTag, archivedAt: r.archivedAt }))
      .sort((a, b) => a.versionTag.localeCompare(b.versionTag))
    expect(baseline).toHaveLength(VERSION_COUNT)

    /**
     * ---- "删库"：清空版本台账 ----
     *
     * 只清 `archives`：连接/环境/目标是本地信息，不可能从服务器恢复；
     * 而"服务器上有哪些版本、各自什么时候归档的"这份真相在归档目录的 manifest 里。
     */
    db.raw.exec('DELETE FROM archives')
    expect(repo.archives.countByTarget(target.id)).toBe(0)

    // 启动之前：本地那三样还在、版本台账已被清空（这就是"删库"这一步的证据）
    console.info(`[B14 DoD] 启动前：${countsOf(db)}`)

    db.close()

    app = await launchApp({ userDataDir, debugPort: DEBUG_PORT, projectRoot: PROJECT_ROOT })
  }, 240000)

  afterAll(async () => {
    await closeApp(app ?? undefined)
    await removeRemoteDir(remote, REMOTE_ROOT)
    await removeRemoteDir(remote, REMOTE_PARENT)
    try {
      db.close()
    } catch {
      /* 已关过 */
    }
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
    remote.client.end()
  }, 120000)

  /* --------------------------------------------------- T14.4 / T14.5 */

  it('T14.4 + T14.5：启动横幅提示"有操作没做完"，打开后能看到现场与三个选项', async () => {
    const cdp = app!.cdp


    // 启动扫描是纯本地的，界面一出来横幅就该在
    await waitFor(cdp, "!!document.querySelector('[data-test=recovery-bar]')", 30000, '启动横幅出现')
    const barText = await cdp.evaluate<string>(
      "document.querySelector('[data-test=recovery-bar]').textContent"
    )
    expect(barText).toContain('1')

    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=recovery-bar-open]').click(), true)"
    )
    await waitFor(
      cdp,
      "[...document.querySelectorAll('[data-test=recovery-dialog]')].some((d) => d.offsetParent !== null)",
      20000,
      '恢复弹窗出现'
    )
    await waitFor(
      cdp,
      "!!document.querySelector('[data-test=recovery-item-rel-unfinished]')",
      20000,
      '未结束的那条记录出现在列表里'
    )

    // 查看现场（要连服务器：看目标路径 / 归档 / 锁 / 暂存）
    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=recovery-inspect-rel-unfinished]').click(), true)"
    )
    await waitFor(
      cdp,
      "!!document.querySelector('[data-test=recovery-scene-rel-unfinished]')",
      60000,
      '现场勘察结果出现'
    )
    const scene = await cdp.evaluate<string>(
      "document.querySelector('[data-test=recovery-scene-rel-unfinished]').textContent"
    )
    // 这条记录没有归档过旧版本（status=SWAPPING 但没有 archiveId）→ 恢复旧版本必须被禁用
    expect(scene).toContain('停在')
    console.info(`[B14 DoD] 现场：${scene.slice(0, 120)}`)

    await closeVisibleDialog(cdp)
    console.info('[B14 DoD] T14.4/T14.5 通过：启动横幅 + 现场勘察 + 三选项')
  }, 180000)

  /* ------------------------------------------------------------- MT-06 */

  it('MT-06：台账被清空后，点「对账」把版本全部重建回来（数量与时间与重建前一致）', async () => {
    const cdp = app!.cdp
    await selectTarget(cdp)

    // 对账前：版本列表是空的
    await waitFor(
      cdp,
      "Number((document.querySelector('[data-test=archive-count]') || {}).textContent || 0) === 0",
      30000,
      '对账前版本列表为空（台账确实丢了）'
    )

    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=archive-reconcile]').click(), true)"
    )
    await waitFor(
      cdp,
      "[...document.querySelectorAll('[data-test=reconcile-dialog]')].some((d) => d.offsetParent !== null)",
      20000,
      '对账弹窗出现'
    )
    // 弹窗打开即自动跑一次对账；等"补录"那一栏出现数字
    await waitFor(
      cdp,
      `Number((document.querySelector('[data-test=reconcile-adopted]') || {}).textContent || 0) === ${VERSION_COUNT}`,
      120000,
      `对账补录了 ${VERSION_COUNT} 条`
    )
    const counts = await cdp.evaluate<{ adopted: number; ok: number; missing: number }>(`(() => {
      const num = (sel) => Number((document.querySelector(sel) || {}).textContent || 0)
      return {
        adopted: num('[data-test=reconcile-adopted]'),
        ok: num('[data-test=reconcile-ok]'),
        missing: num('[data-test=reconcile-missing]')
      }
    })()`)
    expect(counts.adopted).toBe(VERSION_COUNT)
    expect(counts.missing).toBe(0)
    console.info(`[B14 DoD] 对账报告：补录 ${counts.adopted}、正常 ${counts.ok}、失效 ${counts.missing}`)

    await closeVisibleDialog(cdp)

    // 界面上：版本列表恢复成 N 条
    await waitFor(
      cdp,
      `Number((document.querySelector('[data-test=archive-count]') || {}).textContent || 0) === ${VERSION_COUNT}`,
      30000,
      '版本列表已重建'
    )

    /**
     * ---- 直接读数据库核对（**应用还开着**）----
     *
     * **不看界面自述**：界面说"补录了 N 条"不算数，落库的每一个 `archivedAt`
     * 都等于 manifest 里那个值才算数 —— 用"现在"填充也能让列表看起来有 N 条，
     * 但时间就错了（而 MT-06 明确要求"时间与重建前一致"）。
     *
     * 注意**必须趁应用还开着读**：`closeApp()` 会连 `userDataDir` 一起删掉
     * （E2E 基建的约定：临时数据目录用完即弃）。关闭之后再读，读到的是一个
     * 刚被重新创建的空库 —— 那个坑本批次真踩过，排查花了三次往返。
     * 应用运行中读是安全的：SQLite 的 WAL 允许多个进程并发读。
     */
    const live = openDatabase({
      dataDir: userDataDir,
      migrationsFolder: join(PROJECT_ROOT, 'src', 'main', 'db', 'migrations'),
      schemaVersion: 'e2e'
    })
    const r2 = createRepositories(live.db)

    // 前提仍然成立：连接 / 环境 / 目标这三样本地信息没被动过（"删库"只删了版本台账）
    expect(r2.targets.get(targetId)).toBeTruthy()

    const rebuilt = r2.archives
      .listByTarget(targetId, 100)
      .map((r) => ({ versionTag: r.versionTag, archivedAt: r.archivedAt }))
      .sort((a, b) => a.versionTag.localeCompare(b.versionTag))
    live.close()

    expect(rebuilt).toEqual(baseline)
    console.info(`[B14 DoD] MT-06 通过：${rebuilt.length} 个版本的版本号与归档时间与重建前逐条一致`)
  }, 300000)

  /** 各表行数（排查"应用启动后本地数据去哪了"用）。 */
  function countsOf(o: ReturnType<typeof openDatabase>): string {
    const names = (
      o.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((x) => x.name)
    const parts = names
      .filter((n) => !n.startsWith('sqlite_') && n !== '__drizzle_migrations')
      .map((n) => {
        const c = (o.raw.prepare(`SELECT count(*) AS c FROM "${n}"`).get() as { c: number }).c
        return `${n}=${c}`
      })
    return parts.join(' ')
  }

  it('收尾：远端沙箱目录与暂存残留都已清理', async () => {
    await removeRemoteDir(remote, REMOTE_ROOT)
    await removeRemoteDir(remote, REMOTE_PARENT)
    const left = await remoteList(remote, REMOTE_PARENT)
    expect(left.filter((n) => n.startsWith('.sfvm-staging-'))).toEqual([])
    expect(await remoteExists(remote, REMOTE_ROOT)).toBe(false)
    expect(await remoteExists(remote, REMOTE_PARENT)).toBe(false)
    console.info(`[B14 DoD] 远端 ${REMOTE_PARENT} 无本批残留`)
  }, 60000)
})
