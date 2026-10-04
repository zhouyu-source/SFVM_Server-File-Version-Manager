/**
 * B16 / T16.4 的真窗口验证：**发布 → 往期版本出现新条目 → 回滚 → 当前版本切换**。
 *
 * ## 与 B11 DoD 的分工（不重复）
 *
 * B11 的 E2E 已经验过"从界面完成一次发布，服务器上的内容真的换了"。
 * 这个文件**不再重复那一段**，它要锁住的是**第二次之后的语义**：
 *
 * | 步骤 | 断言 |
 * | --- | --- |
 * | 发布 v1 | 往期版本库**还是空的**（首次发布没有可归档的内容，阶段 4 跳过） |
 * | 发布 v2 | 归档里出现一条 **v1 的内容**；当前版本变成 v2 的版本号 |
 * | 回滚 | 回滚到那条归档 → 当前版本**变成归档的版本号**（不是 v2） |
 * | 回滚的副作用 | v2 被归档进来（往期版本 +1）；台账里 v2 那条被标 `ROLLED_BACK` |
 * | 硬证据 | 服务器上的文件**逐字**回到 v1；两处版本号互相印得上 |
 *
 * 最后一条（`ROLLED_BACK`）界面里没有展示位 —— 它是状态机的内部推进，
 * 只影响下一次 `prevRelease()` 的挑选。所以这里**趁应用还开着**直接读库核对
 * （SQLite 的 WAL 允许多进程读，读到的就是应用刚写下的那份）。
 *
 * ## 前置
 *
 * 1. `npm run build`；
 * 2. `npm run test:e2e -t b16-publish-rollback`（凭据来自 `.env.it`）。
 *
 * 远端只写 `/tmp/sfvm-b16-rollback/<随机>/`，`afterAll` 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'ssh2'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeApp,
  launchApp,
  sleep,
  waitFor,
  type Cdp,
  type LaunchedApp
} from '../helpers/e2e-app'
import {
  archiveCount,
  archiveTags,
  confirmPublish,
  currentVersion,
  dumpUi,
  installUiProbe,
  isVisible,
  openPublishDialog,
  readUiProbe,
  selectTarget,
  waitPublishDone
} from '../helpers/e2e-ui'
import { openDatabase } from '@main/db/client'
import { createRepositories, type Repositories } from '@main/db/repositories'
import { fingerprintOf } from '@main/services/ssh-client'

const PROJECT_ROOT = process.cwd()
const HOST = process.env['SFVM_IT_HOST'] ?? ''
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER'] ?? ''
const KEY_PATH = process.env['SFVM_IT_KEY'] ?? ''

const ENABLED = process.env['SFVM_E2E'] === '1' && Boolean(HOST && USER && KEY_PATH)
const describeIf = ENABLED ? describe : describe.skip

const DEBUG_PORT = 9341

const REMOTE_ROOT = `/tmp/sfvm-b16-rollback/${Math.random().toString(36).slice(2, 10)}`
const REMOTE_TARGET = `${REMOTE_ROOT}/web/dist`

const VERSION_TAG_RE = /^\d{8}-\d{6}_[0-9a-f]{7}(-\d+)?$/

const localDirs: string[] = []

function makeLocalArtifact(): string {
  const root = mkdtempSync(join(tmpdir(), 'sfvm-b16-rollback-'))
  localDirs.push(root)
  return root
}

/** 覆盖写本地产物（第二次发布用）。 */
function writeArtifact(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    const idx = rel.lastIndexOf('/')
    if (idx > 0) mkdirSync(join(root, rel.slice(0, idx)), { recursive: true })
    writeFileSync(p, content)
  }
}

/* --------------------------------------------------------- 远端访问（独立连接） */

interface RemoteConn {
  client: Client
  sftp: import('ssh2').SFTPWrapper
}

async function connectRemote(): Promise<RemoteConn> {
  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.on('ready', resolve).on('error', reject)
    client.connect({ host: HOST, port: PORT, username: USER, privateKey: readFileSync(KEY_PATH) })
  })
  const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) =>
    client.sftp((e, s) => (e ? reject(e) : resolve(s)))
  )
  return { client, sftp }
}

function readRemoteText(conn: RemoteConn, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.sftp.readFile(path, (e, data) => (e ? reject(e) : resolve(data.toString('utf8'))))
  })
}

function removeRemoteDir(conn: RemoteConn, dir: string): Promise<void> {
  return new Promise((resolve) => {
    conn.sftp.readdir(dir, (e, list) => {
      if (e) return resolve()
      let pending = list.length
      if (pending === 0) return conn.sftp.rmdir(dir, () => resolve())
      for (const it of list) {
        const p = `${dir}/${it.filename}`
        const done = (): void => {
          if (--pending === 0) conn.sftp.rmdir(dir, () => resolve())
        }
        if (it.attrs.isDirectory()) void removeRemoteDir(conn, p).then(done)
        else conn.sftp.unlink(p, () => done())
      }
    })
  })
}

/* ------------------------------------------------------------------- 用例 */

describeIf('B16 / T16.4：发布两次 → 回滚 → 当前版本与往期版本同步变化', () => {
  let app: LaunchedApp | undefined
  let remote: RemoteConn
  let userDataDir = ''
  let repo: Repositories
  let localDir = ''

  /** 第一次发布后的版本号（v1），第二次发布后记为 v2。 */
  let tagV1 = ''
  let tagV2 = ''
  /** 归档库里那条「v1 的内容」的版本号 —— 回滚的目标。 */
  let tagArchived = ''

  beforeAll(async () => {
    remote = await connectRemote()

    userDataDir = mkdtempSync(join(tmpdir(), 'sfvm-b16-rollback-userdata-'))
    const db = openDatabase({
      dataDir: userDataDir,
      migrationsFolder: join(PROJECT_ROOT, 'src', 'main', 'db', 'migrations'),
      schemaVersion: 'e2e'
    })
    repo = createRepositories(db.db)

    // 主机指纹：用一次独立连接抓握手证书，交给应用的 TOFU 表，
    // 免得窗口起来时还要弹一次"信任指纹"（那条路径由 T16.3 覆盖）
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

    const conn = repo.connections.create({
      name: 'B16 回滚测试机',
      host: HOST,
      port: PORT,
      username: USER,
      authType: 'privateKey',
      privateKeyPath: KEY_PATH,
      autoConnect: true
    })
    repo.knownHosts.trust(HOST, PORT, fp.keyType, fp.fingerprint)

    const env = repo.environments.create({
      name: 'B16 回滚环境',
      envType: 'test',
      connectionId: conn.id
    })

    localDir = makeLocalArtifact()
    writeArtifact(localDir, { 'index.html': 'v1-index', 'assets/app.js': 'v1-js' })
    repo.targets.create({
      environmentId: env.id,
      name: '回滚用前端产物',
      kind: 'dir',
      remotePath: REMOTE_TARGET,
      localPath: localDir
    })

    // SQLite 的 WAL 锁不允许两个进程同时写 → 先关掉再起窗口
    db.close()
    app = await launchApp({ projectRoot: PROJECT_ROOT, debugPort: DEBUG_PORT, userDataDir })
    // 探针从一开始就装着：`ElMessage` 只活 3 秒，出问题时再装就晚了
    await installUiProbe(app.cdp)
  }, 180000)

  afterAll(async () => {
    await closeApp(app)
    try {
      await removeRemoteDir(remote, REMOTE_ROOT)
      await removeRemoteDir(remote, '/tmp/sfvm-b16-rollback')
      remote.client.end()
    } catch (e) {
      console.warn(`清理远端失败（需手工检查）：${(e as Error).message}`)
    }
    for (const d of localDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* 尽力而为 */
      }
    }
    if (userDataDir) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        /* 尽力而为 */
      }
    }
  }, 90000)

  /** 重新进入目标页并选中目标（换本地内容之后要重挂载，才会重新探测产物）。 */
  async function reselectTarget(cdp: Cdp): Promise<void> {
    await cdp.evaluate<boolean>(`(location.hash = '#/connections', true)`)
    await sleep(300)
    await selectTarget(cdp)
  }

  it('发布 v1：首次发布不入归档（阶段 4 没有可归档的内容）', async () => {
    const cdp = app!.cdp
    await selectTarget(cdp)
    await waitFor(
      cdp,
      "[...document.querySelectorAll('.artifact')].some((e) => (e.textContent || '').includes('2 个文件'))",
      30000,
      '本地产物被探测到（2 个文件）'
    )

    await openPublishDialog(cdp)
    const diffText = await cdp.evaluate<string>(
      "(document.querySelector('[data-test=preview-diff]') || {}).textContent || ''"
    )
    expect(diffText).toContain('首次发布')

    await confirmPublish(cdp, 'B16 T16.4 第一次发布')
    expect(await waitPublishDone(cdp)).toBe('success')

    await waitFor(cdp, `!!(document.querySelector('[data-test=current-version]') || {}).textContent`, 30000, '当前版本出现')
    tagV1 = await currentVersion(cdp)
    expect(tagV1).toMatch(VERSION_TAG_RE)

    // 首次发布：目标路径原本不存在 → 阶段 4 跳过归档 → 版本库是空的
    await waitFor(cdp, `document.querySelector('[data-test=archive-count]') !== null`, 30000, '往期版本工具栏出现')
    expect(await archiveCount(cdp)).toBe(0)

    // 服务器上确实是 v1
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/index.html`)).toBe('v1-index')
    console.info(`[B16/T16.4] v1 发布完成：当前版本 ${tagV1}，往期版本 0 条`)
  }, 240000)

  it('发布 v2：v1 的内容被归档进版本库，当前版本切到 v2', async () => {
    const cdp = app!.cdp
    writeArtifact(localDir, { 'index.html': 'v2-index', 'assets/app.js': 'v2-js' })
    await reselectTarget(cdp)

    await openPublishDialog(cdp)
    await confirmPublish(cdp, 'B16 T16.4 第二次发布')
    expect(await waitPublishDone(cdp)).toBe('success')

    await waitFor(cdp, `(function(){ const t = ${JSON.stringify(tagV1)}; const e = document.querySelector('[data-test=current-version]'); return !!e && e.textContent.trim() !== t })()`, 30000, '当前版本离开 v1')
    tagV2 = await currentVersion(cdp)
    expect(tagV2).toMatch(VERSION_TAG_RE)
    expect(tagV2).not.toBe(tagV1)

    // 归档里出现了「v1 的内容」——它的版本号是归档时**按内容重算**的，与 v1 发布时的
    // 版本号不是同一个（时间戳不同），所以两个都要记下来分别断言
    await waitFor(cdp, `document.querySelector('[data-test=archive-count]').textContent.trim() === '1'`, 30000, '往期版本出现 1 条')
    const tags = await archiveTags(cdp)
    expect(tags).toHaveLength(1)
    tagArchived = tags[0]
    expect(tagArchived).toMatch(VERSION_TAG_RE)
    expect(tagArchived).not.toBe(tagV2)

    expect(await readRemoteText(remote, `${REMOTE_TARGET}/index.html`)).toBe('v2-index')
    console.info(`[B16/T16.4] v2 发布完成：当前版本 ${tagV2}；归档中 v1 内容记为 ${tagArchived}`)
  }, 240000)

  it('回滚到归档版本：当前版本切回去、v2 被归档进来、远端内容逐字还原', async () => {
    const cdp = app!.cdp

    // 回滚按钮**始终在 DOM 里**（只是 busy 时 disabled），所以要等它可用而不是等它出现：
    // 发布刚结束的那一瞬间归档区还在刷新，这时点一个 disabled 按钮什么都不会发生、
    // 也不报错（B15 踩过同类静默失败）。
    const rbSel = `[data-test=arch-rollback-${tagArchived}]`
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(rbSel)})`, 30000, '归档行的回滚按钮')
    await waitFor(
      cdp,
      `!document.querySelector(${JSON.stringify(rbSel)}).disabled`,
      30000,
      '回滚按钮可用（归档区刷新完）'
    )
    await cdp.evaluate<boolean>(`(document.querySelector(${JSON.stringify(rbSel)}).click(), true)`)

    // 弹窗节点从组件挂载起就一直在 DOM 里（Element Plus 只是隐藏它）→ 必须判**可见**，
    // 判"存在"永远为真，会掩盖"根本没打开"这种情况（本次就先踩了一次）。
    try {
      await waitFor(cdp, isVisible('rollback-dialog'), 20000, '回滚弹窗打开')
    } catch (e) {
      const probe = await readUiProbe(cdp)
      throw new Error(
        `${(e as Error).message}\n出现过的提示条：${JSON.stringify(probe.msgs)}\n${await dumpUi(cdp, app!.logs)}`,
        { cause: e }
      )
    }

    // 弹窗要先加载两栏对比（当前版 ↔ 目标版），加载完之前「确认回滚」是禁用的。
    // **就绪判据就用那个按钮的可用性**，不要另外挑某个元素当路标：
    // 一开始写成等 `rollback-target-status`，而那个标签只在"归档损坏 / 目录缺失"时
    // 才渲染（正常版本永远是 valid）→ 白等 60 秒才超时。
    // 加载失败走的是另一个分支（`rollback-preview-error`），把它的文案带出来
    // —— 否则只能得到一个"预览超时"，等于没说。
    try {
      await waitFor(
        cdp,
        `(() => {
          const b = document.querySelector('[data-test=rollback-start]')
          return !!b && !b.disabled
        })()`,
        60000,
        '回滚预览就绪（「确认回滚」变为可用）'
      )
    } catch (e) {
      const detail = await cdp.evaluate<string>(`(() => {
        const err = document.querySelector('[data-test=rollback-preview-error]')
        const dlg = document.querySelector('[data-test=rollback-dialog]')
        return [
          '预览错误: ' + (err ? err.textContent.replace(/\\s+/g, ' ').trim() : '(无)'),
          '弹窗正文: ' + (dlg ? dlg.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400) : '(无)'),
        ].join('\\n')
      })()`)
      throw new Error(`${(e as Error).message}\n${detail}\n${await dumpUi(cdp, app!.logs)}`, { cause: e })
    }
    const sideText = await cdp.evaluate<string>(
      `document.querySelector('[data-test="rollback-side-current"]').textContent.replace(/\\s+/g, ' ').trim()`
    )
    expect(sideText).toContain(tagV2)

    await cdp.evaluate<boolean>(`(document.querySelector('[data-test=rollback-start]').click(), true)`)
    await waitFor(
      cdp,
      `!!document.querySelector('[data-test=rollback-close]') || !!document.querySelector('[data-test=rollback-failure]')`,
      240000,
      '回滚结束'
    )
    const failed = await cdp.evaluate<string>(
      `(() => {
        const f = document.querySelector('[data-test=rollback-failure]')
        return f ? f.textContent.replace(/\\s+/g, ' ').trim() : ''
      })()`
    )
    expect(failed, `回滚失败：${failed}`).toBe('')
    await cdp.evaluate<boolean>(`(document.querySelector('[data-test=rollback-close]').click(), true)`)
    await sleep(500)

    // ① 当前版本变成**归档那条**的版本号（不是 v2）
    await waitFor(
      cdp,
      `(function(){ const e = document.querySelector('[data-test=current-version]'); return !!e && e.textContent.trim() === ${JSON.stringify(tagArchived)} })()`,
      60000,
      '当前版本切到归档版本'
    )

    // ② 往期版本 +1：被取代的 v2 被自动归档进来了（回滚是「两处同时改动」的操作）
    await waitFor(cdp, `document.querySelector('[data-test=archive-count]').textContent.trim() === '2'`, 60000, '往期版本变成 2 条')
    const tagsAfter = await archiveTags(cdp)
    expect(tagsAfter).toContain(tagArchived)

    // ③ 硬证据：服务器上的内容逐字回到 v1
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/index.html`)).toBe('v1-index')
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/assets/app.js`)).toBe('v1-js')

    // ④ 台账核对（趁应用还开着读：WAL 允许多进程读，读到的就是它刚写下的那份）
    const db = new Database(join(userDataDir, 'sfvm.db'), { readonly: true })
    try {
      const rows = db
        .prepare('SELECT action, version_tag, status, source FROM releases ORDER BY rowid')
        .all() as Array<{ action: string; version_tag: string; status: string; source: string }>
      const rollbackRow = rows.find((r) => r.action === 'rollback')
      expect(rollbackRow, `台账里没有 rollback 记录：${JSON.stringify(rows)}`).toBeTruthy()
      expect(rollbackRow!.version_tag).toBe(tagArchived)
      expect(rollbackRow!.status).toBe('SUCCESS')
      expect(rollbackRow!.source).toBe('archive')
      // 被这次回滚取代的那条（v2）必须转成 ROLLED_BACK —— 它会影响下次 prevRelease() 的挑选
      expect(
        rows.find((r) => r.version_tag === tagV2)?.status,
        `v2 没有被标记 ROLLED_BACK：${JSON.stringify(rows)}`
      ).toBe('ROLLED_BACK')
      console.info(`[B16/T16.4] 台账：${rows.map((r) => `${r.version_tag}=${r.status}`).join(' / ')}`)
    } finally {
      db.close()
    }

    console.info(`[B16/T16.4] 回滚完成：当前版本 ${tagArchived}；往期版本 2 条`)
  }, 300000)
})
