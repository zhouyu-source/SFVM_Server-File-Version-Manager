/**
 * B11 批次 DoD 的真窗口验证：**从界面完成一次真实发布，全程无命令行介入**。
 *
 * ## 为什么必须真窗口 + 真服务器
 *
 * 单测把 T11.1~T11.7 的每个零件都覆盖了（路径选择、过期规则、差异计算、IPC 边界），
 * 但它们都在**替身**上跑：`electron` 是内存 stub、SSH 是内存远端。
 * 而被替掉的恰好是本批次最需要验证的那一层：
 * preload 的 `contextBridge` 暴露、`ipcRenderer.invoke` 的跨进程调用、
 * Pinia store 与组件之间的响应式更新、**以及"任务事件流真的推到了这个窗口"**。
 * 这些环节在替身下"永远是绿的"，上线后才发现在真机上根本没串起来。
 *
 * 所以这里真的起应用、真的连服务器、真的点按钮 —— 用 CDP（Chrome DevTools Protocol）
 * 从外部驱动，不做任何测试专用后门（`contextIsolation` 下主世界的 `evaluate`
 * 也拿不到 `window.sfvm`，这本身就保证了下不了后门）。
 *
 * ## 覆盖的 DoD 项
 *
 * | 项 | 断言 |
 * | --- | --- |
 * | T11.1 本地产物 | 详情页显示文件数/体积；改配置后重探测能读到 |
 * | T11.2 过期徽标 | 把产物 mtime 改成 5 天前 → 徽标出现（只提示、不阻止） |
 * | T11.3 确认弹窗 | 差异摘要与备注输入；首次发布 vs 二次发布的文案不同 |
 * | T11.4 进度 | 采样面板百分比：出现**多个中间值**（不是 0 直接跳 100） |
 * | T11.5 失败视图 | 制造一次真实失败 → 阶段 / 错误码 / 补偿动作 / 复制诊断按钮都在 |
 * | T11.6 自动刷新 | 发布成功后**当前版本**与**往期版本列表**自动更新（无需手动刷新） |
 * | DoD | 全程只用界面；**服务器上的内容真的换了**（用一条独立的 SFTP 连接核实） |
 *
 * ## 前置
 *
 * 1. `npm run build`（跑的是 `out/` 里的产物）；
 * 2. `SFVM_E2E=1` + `SFVM_IT_*` 凭据（真机在 `/tmp/sfvm-b11/<随机>` 下操作，结束清理）。
 *
 * 运行：
 *   SFVM_E2E=1 SFVM_IT_HOST=... SFVM_IT_USER=... SFVM_IT_KEY=... \
 *   npx vitest run tests/e2e/b11-dod.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'ssh2'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, closeApp, launchApp, sleep, waitFor, type LaunchedApp } from '../helpers/e2e-app'
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

const DEBUG_PORT = 9334

/** 远端沙箱：所有写操作都在这个目录下。 */
const REMOTE_ROOT = `/tmp/sfvm-b11/${Math.random().toString(36).slice(2, 10)}`
const REMOTE_TARGET = `${REMOTE_ROOT}/web/dist`

const localDirs: string[] = []

function makeLocalArtifact(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sfvm-b11-e2e-'))
  localDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    const idx = rel.lastIndexOf('/')
    if (idx > 0) mkdirSync(join(root, rel.slice(0, idx)), { recursive: true })
    writeFileSync(p, content)
  }
  return root
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

function remoteExists(conn: RemoteConn, path: string): Promise<boolean> {
  return new Promise((resolve) => conn.sftp.stat(path, (e) => resolve(!e)))
}

function remoteList(conn: RemoteConn, dir: string): Promise<string[]> {
  return new Promise((resolve) => {
    conn.sftp.readdir(dir, (e, list) => resolve(e ? [] : list.map((i) => i.filename).sort()))
  })
}

function removeRemoteDir(conn: RemoteConn, dir: string): Promise<void> {
  return new Promise((resolve) => {
    conn.sftp.readdir(dir, (e, list) => {
      if (e) return resolve()
      let pending = list.length
      if (pending === 0) {
        return conn.sftp.rmdir(dir, () => resolve())
      }
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

/* ------------------------------------------------------------------ 用例 */

describeIf('B11 DoD：真窗口完成一次真实发布', () => {
  let app: LaunchedApp | undefined
  let remote: RemoteConn
  let userDataDir = ''
  let db: ReturnType<typeof openDatabase> | undefined
  let repo: Repositories
  let localDir = ''

  beforeAll(async () => {
    remote = await connectRemote()

    /* ---- 先造数据：连接（私钥）/ 环境 / 目标 / 已知主机指纹 ---- */
    userDataDir = mkdtempSync(join(tmpdir(), 'sfvm-b11-userdata-'))
    db = openDatabase({
      dataDir: userDataDir,
      migrationsFolder: join(PROJECT_ROOT, 'src', 'main', 'db', 'migrations'),
      schemaVersion: 'e2e'
    })
    repo = createRepositories(db.db)

    // 主机指纹：用一次独立连接抓握手证书，交给应用的 TOFU 表，
    // 这样窗口起来时不必再弹"信任指纹"对话框（那条路径由 B04 的用例覆盖）。
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
      name: 'B11 E2E 测试机',
      host: HOST,
      port: PORT,
      username: USER,
      authType: 'privateKey',
      privateKeyPath: KEY_PATH,
      // 启动即连上：省掉"先去连接页点连接"的一大段与发布无关的操作
      autoConnect: true
    })
    repo.knownHosts.trust(HOST, PORT, fp.keyType, fp.fingerprint)

    const env = repo.environments.create({
      name: 'B11 E2E 环境',
      envType: 'test',
      connectionId: conn.id
    })

    localDir = makeLocalArtifact({
      'index.html': 'v1-index',
      'assets/app.js': 'v1-js'
    })
    repo.targets.create({
      environmentId: env.id,
      name: '前端产物',
      kind: 'dir',
      remotePath: REMOTE_TARGET,
      localPath: localDir
    })

    // 关掉再启动应用：SQLite 的 WAL 锁不允许两个进程同时写
    db.close()
    db = undefined

    app = await launchApp({ projectRoot: PROJECT_ROOT, debugPort: DEBUG_PORT, userDataDir })
  }, 180000)

  afterAll(async () => {
    await closeApp(app)
    try {
      await removeRemoteDir(remote, REMOTE_ROOT)
      await removeRemoteDir(remote, '/tmp/sfvm-b11')
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

  /** 进入「目标」页并选中目标（等价于用户的点击）。 */
  async function selectTarget(cdp: Cdp): Promise<void> {
    /**
     * 先切到「目标」页。
     *
     * 应用默认停在「连接」页，而**左侧环境树是全局的**（连接页也会显示），
     * 所以"在树里点了目标"并不等于"右侧是目标详情" —— 不切路由就会出现
     * "点了目标但右侧还是连接页"（B08 的 E2E 只测底部任务条，没暴露这一点）。
     */
    await waitFor(
      cdp,
      `!!document.querySelector('.sfvm-nav a[href="#/targets"]')`,
      30000,
      '顶部导航就绪'
    )
    await cdp.evaluate<boolean>(
      `(document.querySelector('.sfvm-nav a[href="#/targets"]').click(), true)`
    )
    await waitFor(cdp, "location.hash === '#/targets'", 15000, '已切到目标页')

    await waitFor(cdp, "!!document.querySelector('.tree .env-list li.env')", 30000, '环境树出现')
    // 目标列表可能默认展开；没展开就点一下箭头
    const hasTarget = await cdp.evaluate<boolean>(
      "!!document.querySelector('.target-list li.target')"
    )
    if (!hasTarget) {
      await cdp.evaluate<boolean>("(document.querySelector('.env-row .caret').click(), true)")
    }
    await waitFor(cdp, "!!document.querySelector('.target-list li.target')", 15000, '目标节点出现')
    await cdp.evaluate<boolean>("(document.querySelector('.target-list li.target').click(), true)")
    await waitFor(cdp, "!!document.querySelector('[data-test=publish-btn]')", 20000, '发布面板出现')
  }

  /** 打开确认弹窗（点「发布」→ 等 precheck 与差异预览都回来）。 */
  async function openConfirmDialog(cdp: Cdp): Promise<void> {
    await cdp.evaluate<boolean>("(document.querySelector('[data-test=publish-btn]').click(), true)")
    await waitFor(
      cdp,
      "!!document.querySelector('[data-test=confirm-publish]') && " +
        "(!document.querySelector('.preparing') && (!!document.querySelector('[data-test=preview-diff]') || !!document.querySelector('.el-alert--error')))",
      60000,
      '确认弹窗就绪（前置校验 + 差异预览）'
    )
  }

  /** 在弹窗里填备注并确认发布。 */
  async function confirmPublish(cdp: Cdp, note: string): Promise<void> {
    await cdp.evaluate<boolean>(`(() => {
      const ta = document.querySelector('[data-test=publish-note] textarea')
      if (!ta) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(note)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=confirm-publish]').click(), true)"
    )
  }

  /** 等这次发布跑完（面板出现成功或失败提示）。 */
  async function waitPublishDone(cdp: Cdp): Promise<'success' | 'failed'> {
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      const state = await cdp.evaluate<string>(`(() => {
        if (document.querySelector('[data-test=publish-failure]')) return 'failed'
        if (document.querySelector('[data-test=publish-success]')) return 'success'
        return 'running'
      })()`)
      if (state !== 'running') return state as 'success' | 'failed'
      await sleep(300)
    }
    throw new Error('等待发布结束超时')
  }

  /* ------------------------------------------------------ T11.1 ~ T11.3 */

  it('详情页：本地产物被自动探测（文件数/体积），确认弹窗给出首次发布的差异', async () => {
    const cdp = app!.cdp
    await selectTarget(cdp)

    // T11.1：本地产物卡片自动探测（不需要点任何按钮）
    await waitFor(
      cdp,
      "[...document.querySelectorAll('.artifact')].some((e) => (e.textContent || '').includes('2 个文件'))",
      20000,
      '本地产物显示 2 个文件'
    )

    await openConfirmDialog(cdp)

    // T11.3：首次发布 → 新增 2、且给出"首次发布"文案
    const added = await cdp.evaluate<string>(
      "(document.querySelector('[data-test=diff-added]') || {}).textContent.trim()"
    )
    expect(added).toBe('2')
    const dialogText = await cdp.evaluate<string>(
      "(document.querySelector('[data-test=preview-diff]').textContent || '')"
    )
    expect(dialogText).toContain('首次发布')
    // 本地产物指纹前 16 位一定在弹窗里（用户要能拿它跟别处对）
    const hashText = await cdp.evaluate<string>(
      "(document.querySelector('[data-test=preview-roothash]') || {}).textContent.trim()"
    )
    expect(hashText).toMatch(/^[0-9a-f]{16}$/)
    console.info(`[B11 DoD] 确认弹窗：新增 ${added} 个文件，本地指纹 ${hashText}…`)
  }, 120000)

  it('T11.4 + DoD：点确认后跑完发布，服务器上的内容真的换了', async () => {
    const cdp = app!.cdp

    // 采样百分比：装个采样器，避免"轮询恰好错过中间态"
    await cdp.evaluate(`(() => {
      window.__pct = []
      window.__timer = setInterval(() => {
        const e = document.querySelector('[data-test=publish-percent]')
        if (e) window.__pct.push(e.textContent.trim())
      }, 40)
      return true
    })()`)

    await confirmPublish(cdp, 'B11 E2E 首次发布')

    // 弹窗应关闭。注意 el-dialog 关闭后**节点仍在 DOM 里**（Element Plus 只是隐藏它），
    // 所以判"可不可见"，不能判"存不存在" —— 后者永远为真，是个假的绿灯。
    await waitFor(
      cdp,
      `(() => {
        const o = document.querySelector('.el-overlay')
        return !o || getComputedStyle(o).display === 'none'
      })()`,
      20000,
      '确认弹窗已关闭'
    )

    const result = await waitPublishDone(cdp)
    expect(result, '发布没有成功').toBe('success')

    const samples = await cdp.evaluate<string[]>(
      '(window.__timer, clearInterval(window.__timer), window.__pct)'
    )
    const percents = samples
      .map((s) => Number.parseInt(s.replace('%', ''), 10))
      .filter((n) => Number.isFinite(n))
    expect(percents.length, `进度采样为空：${JSON.stringify(samples)}`).toBeGreaterThan(0)
    expect(
      percents.some((n) => n > 0 && n < 100),
      `没有中间百分比，进度条形同虚设：${JSON.stringify([...new Set(percents)])}`
    ).toBe(true)

    // DoD 的硬证据：**服务器上真的换了**（用独立的 SFTP 连接核实，不看界面自述）
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/index.html`)).toBe('v1-index')
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/assets/app.js`)).toBe('v1-js')
    // 暂存与锁都已清理
    expect(await remoteList(remote, `${REMOTE_ROOT}/web`)).toEqual(['dist'])
    console.info(`[B11 DoD] 首次发布成功；进度采样 ${[...new Set(percents)].join('/')}%`)
  }, 240000)

  it('T11.6：发布成功后当前版本与往期版本自动更新（无需手动刷新）', async () => {
    const cdp = app!.cdp
    // 当前版本号：发布完成后自动取到（preview 的 lastVersionTag）
    await waitFor(
      cdp,
      "!!(document.querySelector('[data-test=current-version]') || {}).textContent",
      30000,
      '当前版本号出现'
    )
    const current = await cdp.evaluate<string>(
      "document.querySelector('[data-test=current-version]').textContent.trim()"
    )
    expect(current).toMatch(/^\d{8}-\d{6}_[0-9a-f]{7}(-\d+)?$/)
    // 最近发布时间也不再是"从未发布"
    const lastDeploy = await cdp.evaluate<string>(
      "document.querySelector('[data-test=last-deploy]').textContent.trim()"
    )
    expect(lastDeploy).not.toBe('从未发布')
    console.info(`[B11 DoD] 界面自动刷新：当前版本 ${current}，最近发布 ${lastDeploy}`)
  }, 60000)

  /* ------------------------------------------------------------ T11.2 */

  it('T11.2：把产物改成 5 天前 → 过期徽标出现（只是提示，不阻止发布）', async () => {
    const cdp = app!.cdp
    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    // 目录本身与文件都回拨：真实的"5 天前构建"就是那时创建了目录与文件
    for (const rel of ['index.html', 'assets/app.js']) utimesSync(join(localDir, rel), old, old)
    utimesSync(localDir, old, old)
    utimesSync(join(localDir, 'assets'), old, old)
    expect(statSync(join(localDir, 'index.html')).mtimeMs).toBeLessThan(
      Date.now() - 24 * 60 * 60 * 1000
    )

    // 点「重新探测」（不刷新页面，验证的是探测本身）
    await cdp.evaluate<boolean>(`(() => {
      const btn = [...document.querySelectorAll('.artifact button')]
        .find((b) => (b.textContent || '').includes('重新探测'))
      if (!btn) return false
      btn.click()
      return true
    })()`)

    await waitFor(
      cdp,
      "[...document.querySelectorAll('.artifact .el-tag')].some((e) => (e.textContent || '').includes('可能过期'))",
      20000,
      '过期徽标出现'
    )
    const badge = await cdp.evaluate<string>(`(() => {
      const t = [...document.querySelectorAll('.artifact .el-tag')]
        .find((e) => (e.textContent || '').includes('可能过期'))
      return t ? t.textContent.trim() : ''
    })()`)
    expect(badge).toContain('5 天前')

    // 关键：只是提示 —— 发布按钮仍然可用
    const disabled = await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=publish-btn]') || {}).disabled === true"
    )
    expect(disabled, '产物过期只是警告，不该禁用发布').toBe(false)
    console.info(`[B11 DoD] 过期徽标：${badge}`)
  }, 60000)

  /* ------------------------------------------- 第二次发布 + 差异对比 */

  it('T11.3 + T11.6：第二次发布给出新增/修改/删除，并把上一版归档进列表', async () => {
    const cdp = app!.cdp

    // 改一版内容：改 index.html、删 assets/app.js、加 new.css
    writeFileSync(join(localDir, 'index.html'), 'v2-index')
    rmSync(join(localDir, 'assets', 'app.js'))
    writeFileSync(join(localDir, 'new.css'), 'v2-css')
    const now = new Date()
    utimesSync(join(localDir, 'index.html'), now, now)
    utimesSync(join(localDir, 'new.css'), now, now)

    await cdp.evaluate<boolean>(`(() => {
      const btn = [...document.querySelectorAll('.artifact button')]
        .find((b) => (b.textContent || '').includes('重新探测'))
      if (btn) btn.click()
      return true
    })()`)
    await sleep(300)

    await openConfirmDialog(cdp)
    const counts = await cdp.evaluate<{ added: string; modified: string; deleted: string }>(`({
      added: (document.querySelector('[data-test=diff-added]') || {}).textContent.trim(),
      modified: (document.querySelector('[data-test=diff-modified]') || {}).textContent.trim(),
      deleted: (document.querySelector('[data-test=diff-deleted]') || {}).textContent.trim()
    })`)
    expect(counts).toEqual({ added: '1', modified: '1', deleted: '1' })

    await confirmPublish(cdp, 'B11 E2E 第二次发布')
    expect(await waitPublishDone(cdp)).toBe('success')

    // 服务器上是新内容，且旧文件不见了（"删除"真的删了）
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/index.html`)).toBe('v2-index')
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/new.css`)).toBe('v2-css')
    expect(await remoteExists(remote, `${REMOTE_TARGET}/assets/app.js`)).toBe(false)

    // T11.6：往期版本列表自动多了一条（上一版进了归档）
    await waitFor(
      cdp,
      "Number((document.querySelector('[data-test=archive-count]') || {}).textContent || 0) >= 1",
      30000,
      '往期版本列表出现 1 条'
    )
    const archCount = await cdp.evaluate<string>(
      "document.querySelector('[data-test=archive-count]').textContent.trim()"
    )
    expect(archCount).toBe('1')
    // 归档目录确实在服务器上
    expect(await remoteExists(remote, `${REMOTE_ROOT}/web/dist.versions`)).toBe(true)
    console.info(`[B11 DoD] 第二次发布：新增/修改/删除 = 1/1/1，往期版本 ${archCount} 条`)
  }, 240000)

  /* ------------------------------------------------------------ T11.5 */

  it('T11.5：一次真实失败 → 失败视图给出阶段/错误码/补偿动作与复制诊断', async () => {
    const cdp = app!.cdp

    // 制造一次真实失败：打开确认弹窗后**删掉本地产物**，
    // 于是任务在阶段 0（本地产物校验）失败 —— 远端毫发无损。
    await openConfirmDialog(cdp)
    rmSync(localDir, { recursive: true, force: true })
    await confirmPublish(cdp, 'B11 E2E 故意失败')

    expect(await waitPublishDone(cdp)).toBe('failed')

    const text = await cdp.evaluate<string>(
      "(document.querySelector('[data-test=publish-failure]').textContent || '')"
    )
    expect(text).toContain('E_LOCAL_PATH_MISSING')
    expect(text).toContain('已执行的收尾动作')
    expect(text).toContain('未做任何改动') // 阶段 0 失败 → 补偿项如实说"远端未做任何改动"

    // 复制诊断：点了必须**有可见结果**（成功或失败都算，静默才算 bug）
    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=copy-diagnostics]').click(), true)"
    )
    await waitFor(
      cdp,
      "[...document.querySelectorAll('.el-message')].some((e) => /诊断信息|复制/.test(e.textContent || ''))",
      10000,
      '复制诊断有可见反馈'
    )

    // 服务器上仍是第二次发布的内容（失败没有破坏现状）
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/index.html`)).toBe('v2-index')
    console.info('[B11 DoD] 失败视图：E_LOCAL_PATH_MISSING + 补偿明细 + 复制诊断都有反馈')
  }, 180000)

  it('收尾：远端零残留（暂存目录与锁都清掉了）', async () => {
    const cdp = app!.cdp
    void cdp
    const names = await remoteList(remote, `${REMOTE_ROOT}/web`)
    expect(names.filter((n) => n.startsWith('.sfvm-staging-'))).toEqual([])
    expect(names).not.toContain('.sfvm.lock')
    console.info(`[B11 DoD] 远端目录：${names.join('、')}`)
  }, 60000)
})
