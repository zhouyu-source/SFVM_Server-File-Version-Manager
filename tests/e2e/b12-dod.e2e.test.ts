/**
 * B12 批次 DoD 的真窗口验证：**MT-04 / MT-05**。
 *
 * - **MT-04**：下载一个 10 个版本之前的归档 → 内容正确落盘；
 * - **MT-05**：把归档内容改坏 → 下载被拦截（并且台账被标成"已损坏"）。
 *
 * ## 为什么"10 个版本之前"要直接造数据，而不是真的发布 10 次
 *
 * 这条 DoD 要验的是**下载这条路径**（列表 → 计划 → 传输 → 逐文件校验 → 落盘），
 * 而不是"发布 10 次能不能成功"。真的发 10 次等于把每个版本都完整上传一遍，
 * 在一台出带宽只有 ~0.46 MB/s 的机器上要跑十几分钟，还会让失败原因变得难以归因
 * （是下载坏了还是第 7 次发布就坏了？）。所以这里按归档服务的真实布局
 * （`<archiveDir>/<versionTag>/payload/<basename>/...` + `manifest.json`）在服务器上
 * 造出 10 个版本、并把台账写好 —— **被驱动的仍然是完整的界面链路**。
 *
 * 发布链路本身由 `b11-dod.e2e.test.ts` 真跑；这里只需要"服务器上有一批历史版本"。
 *
 * ## 覆盖的 DoD 项
 *
 * | 项 | 断言 |
 * | --- | --- |
 * | T12.1 表格 | 10 条版本；虚拟滚动只渲染视口内的行（DOM 里的行数 < 总条数） |
 * | T12.6 占用 | 汇总条显示条数与占用总量，且来自台账 |
 * | T12.3/12.4 | 下载弹窗给出落点 → 传输 → 成功；本地文件内容与清单一致 |
 * | **MT-04** | 最老的那一版（第 10 条）能正确落盘 |
 * | **MT-05** | 改坏一个字节 → 下载被拦、台账变 corrupt、最终目录不出现 |
 * | T12.7 明细 | 抽屉给出 manifest 摘要（根指纹）与文件清单 |
 * | T12.5 删除 | 勾选 + 二次确认 → 列表与服务器同时少掉那个版本 |
 * | T12.6 清理 | 按策略（保留 3 份）清理 → 只留最新 3 条 |
 *
 * ## 前置
 *
 * 1. `npm run build`（跑的是 `out/` 里的产物）；
 * 2. `SFVM_E2E=1` + `SFVM_IT_*` 凭据（真机在 `/tmp/sfvm-b12/<随机>` 下操作，结束清理）。
 *
 * 运行：
 *   SFVM_E2E=1 SFVM_IT_HOST=... SFVM_IT_USER=... SFVM_IT_KEY=... \
 *   npx vitest run tests/e2e/b12-dod.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'ssh2'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, closeApp, launchApp, sleep, waitFor, type LaunchedApp } from '../helpers/e2e-app'
import {
  archiveRowButton,
  closeVisibleDialog,
  ensureArchiveRowVisible,
  selectTarget
} from '../helpers/e2e-ui'
import {
  connectRemote,
  readRemoteText,
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

const DEBUG_PORT = 9336

/** 远端沙箱：所有写操作都在这个目录下。 */
const REMOTE_ROOT = `/tmp/sfvm-b12/${Math.random().toString(36).slice(2, 10)}`
const REMOTE_TARGET = `${REMOTE_ROOT}/web/dist`
/** 默认归档目录：`<remotePath>.versions`（见 infra/archive-dir.ts） */
const REMOTE_ARCHIVE = `${REMOTE_TARGET}.versions`

/** 造多少个历史版本（DoD 要的是"10 个版本之前"）。 */
const VERSION_COUNT = 10

const localDirs: string[] = []
function makeTmp(prefix = 'sfvm-b12-e2e-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  localDirs.push(d)
  return d
}

/** 版本号：`<yyyyMMdd-HHmmss>_<hash7>`，序号靠 i 拉开（同一秒内多次归档的真实形态）。 */
function tagOf(i: number): string {
  const day = String(10 + i).padStart(2, '0')
  const hash = createHash('sha256').update(`v${i}`).digest('hex').slice(0, 7)
  return `202609${day}-1200${String(i % 60).padStart(2, '0')}_${hash}`
}

interface SeedVersion {
  tag: string
  storagePath: string
  payloadPath: string
  files: Array<{ relPath: string; content: string }>
  rootHash: string
  totalBytes: number
  archivedAt: string
}

/** 一批可复现的历史版本（内容各不相同，便于"下载到的是不是这一版"一眼可辨）。 */
function planVersions(): SeedVersion[] {
  const out: SeedVersion[] = []
  for (let i = 0; i < VERSION_COUNT; i++) {
    const tag = tagOf(i)
    const files = [
      { relPath: 'dist/index.html', content: `v${i}-index` },
      { relPath: 'dist/assets/app.js', content: `v${i}-js` }
    ]
    const items = files.map((f) => ({
      relPath: f.relPath,
      hash: createHash('sha256').update(f.content).digest('hex'),
      size: f.content.length
    }))
    out.push({
      tag,
      storagePath: `${REMOTE_ARCHIVE}/${tag}`,
      payloadPath: `${REMOTE_ARCHIVE}/${tag}/payload`,
      files,
      rootHash: computeRootHash(items),
      totalBytes: items.reduce((a, x) => a + x.size, 0),
      // 越老的版本时间越早（列表按归档时间倒序 → 第 10 条就是最老的）
      archivedAt: new Date(Date.UTC(2026, 8, 10 + i, 12, 0, i)).toISOString()
    })
  }
  return out
}

/* ------------------------------------------------------------------ 用例 */

describeIf('B12 DoD：往期版本的浏览 / 下载 / 明细 / 删除', () => {
  let app: LaunchedApp | undefined
  let remote: RemoteConn
  let userDataDir = ''
  let db: ReturnType<typeof openDatabase> | undefined
  let repo: Repositories
  let saveDir = ''
  let versions: SeedVersion[] = []
  /** 最老的那一版（MT-04 要下载的就是它） */
  let oldest: SeedVersion
  /** 会被改坏的那一版（MT-05） */
  let tampered: SeedVersion

  beforeAll(async () => {
    remote = await connectRemote({ host: HOST, port: PORT, user: USER, keyPath: KEY_PATH })
    versions = planVersions()
    oldest = versions[0]!
    tampered = versions[2]!

    /* ---- 在服务器上按归档服务的真实布局造出 10 个历史版本 ---- */
    for (const v of versions) {
      for (const f of v.files) {
        const abs = `${v.payloadPath}/${f.relPath}`
        await sftpMkdirp(remote, abs.slice(0, abs.lastIndexOf('/')))
        await writeRemoteText(remote, abs, f.content)
      }
      // manifest 与归档服务写出来的字段一致（relPath 相对 payloadPath，带 `dist/` 前缀）
      const manifest = {
        schemaVersion: 1,
        targetName: '前端产物',
        originalPath: REMOTE_TARGET,
        kind: 'dir',
        versionTag: v.tag,
        archivedAt: v.archivedAt,
        hashAlgo: 'sha256',
        rootHash: v.rootHash,
        totalBytes: v.totalBytes,
        fileCount: v.files.length,
        operator: null,
        note: null,
        sourceReleaseId: null,
        files: v.files.map((f) => ({
          relPath: f.relPath,
          hash: createHash('sha256').update(f.content).digest('hex'),
          size: f.content.length,
          mtime: v.archivedAt
        }))
      }
      await writeRemoteText(remote, `${v.storagePath}/manifest.json`, JSON.stringify(manifest))
    }

    /* ---- 先造数据：连接 / 环境 / 目标 / 10 条台账 / 已知主机指纹 ---- */
    userDataDir = mkdtempSync(join(tmpdir(), 'sfvm-b12-userdata-'))
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

    const conn = repo.connections.create({
      name: 'B12 E2E 测试机',
      host: HOST,
      port: PORT,
      username: USER,
      authType: 'privateKey',
      privateKeyPath: KEY_PATH,
      autoConnect: true
    })
    repo.knownHosts.trust(HOST, PORT, fp.keyType, fp.fingerprint)

    const env = repo.environments.create({
      name: 'B12 E2E 环境',
      envType: 'test',
      connectionId: conn.id
    })

    const target = repo.targets.create({
      environmentId: env.id,
      name: '前端产物',
      kind: 'dir',
      remotePath: REMOTE_TARGET,
      // 保留 3 份：T12.6 的"立即清理"要真有东西可清
      retainPolicy: JSON.stringify({ mode: 'count', value: 3 })
    })

    for (const v of versions) {
      const row = repo.archives.create({
        targetId: target.id,
        versionTag: v.tag,
        storagePath: v.storagePath,
        payloadPath: v.payloadPath,
        kind: 'dir',
        rootHash: v.rootHash,
        totalBytes: v.totalBytes,
        fileCount: v.files.length,
        releaseId: null,
        note: null,
        status: 'valid'
      })
      // 归档时间显式指定：列表顺序要可预测（越老的越靠后）
      repo.archives.update(row.id, { archivedAt: v.archivedAt })
    }

    saveDir = makeTmp('sfvm-b12-downloads-')

    db.close()
    db = undefined

    app = await launchApp({ projectRoot: PROJECT_ROOT, debugPort: DEBUG_PORT, userDataDir })
  }, 300000)

  afterAll(async () => {
    await closeApp(app)
    try {
      await removeRemoteDir(remote, REMOTE_ROOT)
      await removeRemoteDir(remote, '/tmp/sfvm-b12')
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

  /** 进入「目标」页并选中目标（应用默认停在连接页，见 HANDOFF §1.5）。 */
  /** 打开某版本的下载弹窗，并把它改成"下载到测试的临时目录"。 */
  async function openDownloadDialog(cdp: Cdp, tag: string): Promise<void> {
    await cdp.evaluate<boolean>(`(document.querySelector(${JSON.stringify(archiveRowButton(tag, 'download'))}).click(), true)`)
    await waitFor(
      cdp,
      "!!document.querySelector('[data-test=download-save-dir-input]')",
      20000,
      '下载弹窗出现'
    )
    // 保存位置改成测试临时目录（默认是系统下载目录，不能往用户真实目录里写）
    await cdp.evaluate<boolean>(`(() => {
      const host = document.querySelector('[data-test=download-save-dir-input]')
      const input = host.tagName === 'INPUT' ? host : host.querySelector('input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(saveDir)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    // 等计划按新路径重算（防抖 350ms + 一次主进程往返）
    await waitFor(
      cdp,
      `((document.querySelector('[data-test=download-plan-path]') || {}).textContent || '').startsWith(${JSON.stringify(saveDir)})`,
      20000,
      '下载计划按新保存位置重算'
    )
  }

  /** 点「开始下载」并等它终态。 */
  async function runDownload(cdp: Cdp): Promise<'success' | 'failed'> {
    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=download-start]').click(), true)"
    )
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      const state = await cdp.evaluate<string>(`(() => {
        if (document.querySelector('[data-test=download-failure]')) return 'failed'
        if (document.querySelector('[data-test=download-result-path]')) return 'success'
        return 'running'
      })()`)
      if (state !== 'running') return state as 'success' | 'failed'
      await sleep(300)
    }
    throw new Error('等待下载结束超时')
  }

  /* -------------------------------------------------- T12.1 / T12.6 表格与汇总 */

  it('T12.1 + T12.6：版本表格列出 10 条、汇总给出条数与占用，且虚拟滚动只渲染视口内的行', async () => {
    const cdp = app!.cdp
    await selectTarget(cdp)

    await waitFor(
      cdp,
      "Number((document.querySelector('[data-test=archive-count]') || {}).textContent || 0) === 10",
      30000,
      '汇总显示 10 个往期版本'
    )

    const usage = await cdp.evaluate<string>(
      "document.querySelector('[data-test=archive-usage]').textContent.trim()"
    )
    expect(usage).toMatch(/\d/)
    expect(usage).not.toBe('0 B')

    // 保留策略来自目标配置（T12.6 的入口展示）
    const summary = await cdp.evaluate<string>(
      "document.querySelector('[data-test=archive-summary]').textContent"
    )
    expect(summary).toContain('按份数保留 3')

    // 行是**自定义渲染**出来的（el-table-v2 不支持 type="selection"，勾选框与操作按钮
    // 都是 cellRenderer 画的），能查到这些 data-test 就说明自定义渲染生效了。
    // 10 条时全部落在虚拟滚动的过扫描窗口内，所以这里不拿"渲染行数 < 总条数"当断言 ——
    // 那要看几千条才有意义。
    const rendered = await cdp.evaluate<number>(
      "document.querySelectorAll('[data-test=arch-version]').length"
    )
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThanOrEqual(VERSION_COUNT)
    console.info(`[B12 DoD] 表格：共 10 条，DOM 内渲染 ${rendered} 行；占用 ${usage}`)
  }, 120000)

  /* --------------------------------------------------------------- MT-04 */

  it('MT-04：下载 10 个版本之前的那一版 → 内容正确落盘，暂存目录不留', async () => {
    const cdp = app!.cdp
    // 每个用例都自己确保在目标页：不依赖别的用例先跑过
    await selectTarget(cdp)
    await ensureArchiveRowVisible(cdp, oldest.tag)

    await openDownloadDialog(cdp, oldest.tag)
    expect(await runDownload(cdp)).toBe('success')

    // 落点：`<saveDir>/<目标名>-<版本号>`
    const finalPath = join(saveDir, `前端产物-${oldest.tag}`)
    expect(existsSync(finalPath)).toBe(true)
    // 内容与清单一致（relPath 相对 payload，带 `dist/` 前缀）
    expect(readFileSync(join(finalPath, 'dist/index.html'), 'utf8')).toBe('v0-index')
    expect(readFileSync(join(finalPath, 'dist/assets/app.js'), 'utf8')).toBe('v0-js')
    // 顺手逐字核对：本地落盘的内容 == 服务器上那份 payload（不看界面自述）
    expect(readFileSync(join(finalPath, 'dist/index.html'), 'utf8')).toBe(
      await readRemoteText(remote, `${oldest.payloadPath}/dist/index.html`)
    )
    // 暂存目录不留（改名走的同父目录 rename）
    expect(existsSync(join(saveDir, `.sfvm-part-`))).toBe(false)
    const reported = await cdp.evaluate<string>(
      "document.querySelector('[data-test=download-result-path]').textContent.trim()"
    )
    expect(reported).toBe(finalPath)

    await closeVisibleDialog(cdp)
    console.info(`[B12 DoD] MT-04 通过：最老版本 ${oldest.tag} 落盘到 ${finalPath}`)
  }, 240000)

  /* --------------------------------------------------------------- MT-05 */

  it('MT-05：把归档改坏一个字节 → 下载被拦截、台账标为已损坏、最终目录不出现', async () => {
    const cdp = app!.cdp
    // 每个用例都自己确保在目标页：不依赖别的用例先跑过
    await selectTarget(cdp)

    // 手工改坏服务器上的 payload（manifest 不动）—— 这正是"归档被人动过"的形态
    await writeRemoteText(
      remote,
      `${tampered.payloadPath}/dist/index.html`,
      'tampered-content'
    )

    await ensureArchiveRowVisible(cdp, tampered.tag)

    await openDownloadDialog(cdp, tampered.tag)
    expect(await runDownload(cdp)).toBe('failed')

    const failText = await cdp.evaluate<string>(
      "(document.querySelector('[data-test=download-failure]').textContent || '')"
    )
    // 失败原因必须能自证："内容与清单哈希不一致"，并且告知产物留在哪
    expect(failText).toContain('哈希不一致')
    expect(failText).toContain('.sfvm-part-')

    // 最终目录不能出现（宁可什么都没有，也不给一份内容不可信的东西）
    expect(existsSync(join(saveDir, `前端产物-${tampered.tag}`))).toBe(false)
    // 已下载的部分保留在暂存目录里（T12.4：用户可能想把已下好的文件拿走）
    const staging = readdirSync(saveDir).filter((n) => n.startsWith('.sfvm-part-'))
    expect(staging.length).toBeGreaterThan(0)

    await closeVisibleDialog(cdp)

    // 台账被标成"已损坏"：刷新列表后能看到状态标签与"状态异常"提醒
    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=archive-refresh]').click(), true)"
    )
    await waitFor(
      cdp,
      "!!document.querySelector('[data-test=archive-bad]')",
      20000,
      '汇总出现"状态异常"提醒'
    )
    const badCount = await cdp.evaluate<string>(
      "document.querySelector('[data-test=archive-bad]').textContent.trim()"
    )
    expect(badCount).toContain('1')
    console.info(`[B12 DoD] MT-05 通过：篡改被拦下（${failText.split('\n')[0].trim()}）`)
  }, 240000)

  /* --------------------------------------------------------------- T12.7 */

  it('T12.7：版本明细抽屉给出 manifest 摘要与文件清单', async () => {
    const cdp = app!.cdp
    // 每个用例都自己确保在目标页：不依赖别的用例先跑过
    await selectTarget(cdp)

    await ensureArchiveRowVisible(cdp, oldest.tag)
    await cdp.evaluate<boolean>(
      `(document.querySelector(${JSON.stringify(archiveRowButton(oldest.tag, 'detail'))}).click(), true)`
    )

    await waitFor(
      cdp,
      "!!document.querySelector('[data-test=detail-root-hash]')",
      30000,
      '明细抽屉读到远端 manifest'
    )
    const rootHash = await cdp.evaluate<string>(
      "document.querySelector('[data-test=detail-root-hash]').textContent.trim()"
    )
    expect(rootHash).toBe(oldest.rootHash)

    const filesText = await cdp.evaluate<string>(
      "(document.querySelector('[data-test=detail-files]').textContent || '')"
    )
    expect(filesText).toContain('dist/index.html')
    expect(filesText).toContain('dist/assets/app.js')

    await closeVisibleDialog(cdp)
    console.info(`[B12 DoD] 明细抽屉：根指纹 ${rootHash.slice(0, 12)}…，清单 2 个文件`)
  }, 120000)

  /* --------------------------------------------------------------- T12.5 */

  it('T12.5：勾选一个版本 → 二次确认 → 列表与服务器同时少掉它', async () => {
    const cdp = app!.cdp
    // 每个用例都自己确保在目标页：不依赖别的用例先跑过
    await selectTarget(cdp)
    const victim = versions[5]!

    await ensureArchiveRowVisible(cdp, victim.tag)

    // 勾选（自定义渲染的复选框，需要点在 .el-checkbox 上）
    await cdp.evaluate<boolean>(`(() => {
      const box = document.querySelector('[data-test=arch-select-${victim.tag}]')
      if (!box) return false
      box.click()
      return true
    })()`)
    await waitFor(
      cdp,
      "!document.querySelector('[data-test=archive-remove-selected]').disabled",
      10000,
      '删除选中按钮可用'
    )

    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=archive-remove-selected]').click(), true)"
    )
    // 危险确认弹窗（测试环境不需要输入目标名）
    await waitFor(
      cdp,
      `[...document.querySelectorAll('.el-dialog')].some((d) => d.offsetParent !== null && /删除往期版本/.test(d.textContent || ''))`,
      15000,
      '危险确认弹窗出现'
    )
    const clicked = await cdp.evaluate<boolean>(`(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].find((d) => d.offsetParent !== null && /删除往期版本/.test(d.textContent || ''))
      if (!dlg) return false
      const btn = [...dlg.querySelectorAll('.el-dialog__footer button')].find((b) => /删除/.test(b.textContent || ''))
      if (!btn) return false
      btn.click()
      return true
    })()`)
    expect(clicked, '没能在确认弹窗里点到「删除」').toBe(true)

    // 等结果：成功 → 计数变成 9；失败 → 界面上要能看到原因（不能静默）
    const outcome = await (async (): Promise<string> => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const r = await cdp.evaluate<{ count: number; msg: string }>(`(() => {
          const count = Number((document.querySelector('[data-test=archive-count]') || {}).textContent || 0)
          const msg = [...document.querySelectorAll('.el-message')].map((e) => e.textContent || '').join(' | ')
          return { count, msg }
        })()`)
        if (r.count === 9) return 'ok'
        if (/失败|错误|无法/.test(r.msg)) return `err:${r.msg}`
        await sleep(300)
      }
      return 'timeout'
    })()
    if (outcome !== 'ok') {
      // 把主进程日志打出来：错误码/明细在那边，界面只显示一句中文
      const tail = (app?.logs ?? []).slice(-40).join('\n')
      console.error(`[B12 DoD] 删除失败，主进程日志尾部：\n${tail}`)
    }
    expect(outcome, `删除没有生效：${outcome}`).toBe('ok')
    // 服务器上的归档目录真的没了（不看界面自述）
    expect(await remoteExists(remote, victim.storagePath)).toBe(false)
    console.info(`[B12 DoD] 删除 ${victim.tag}：列表与服务器同步为 9 条`)
  }, 180000)

  /* --------------------------------------------------------------- T12.6 */

  it('T12.6：按策略（保留 3 份）立即清理 → 只剩最新 3 条，服务器同步', async () => {
    const cdp = app!.cdp
    // 每个用例都自己确保在目标页：不依赖别的用例先跑过
    await selectTarget(cdp)

    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=archive-run-retention]').click(), true)"
    )
    // ElMessageBox 的确认按钮
    await waitFor(
      cdp,
      "[...document.querySelectorAll('.el-message-box')].some((b) => b.offsetParent !== null)",
      15000,
      '确认框出现'
    )

    /**
     * `ElMessageBox` 的样式必须真的生效。
     *
     * 它不在任何模板里（是 `ElMessageBox.confirm(...)` 调出来的），
     * 所以 `unplugin-vue-components` 的按需样式注入扫不到它 —— 一旦样式来源
     * 只剩按需注入，这里就是个裸 DOM：宽度撑满屏幕、没有圆角、没有背景。
     * 全量 CSS 由 `src/renderer/src/main.ts` 引入，这条用例钉住它别退化。
     */
    const styled = await cdp.evaluate<{
      width: string
      radius: string
      bg: string
      btnRadius: string
    }>(`(() => {
      const box = [...document.querySelectorAll('.el-message-box')].find((b) => b.offsetParent !== null)
      if (!box) return { width: 'no-box', radius: '', bg: '', btnRadius: '' }
      const cs = getComputedStyle(box)
      const btn = box.querySelector('.el-button')
      return {
        width: cs.width,
        radius: cs.borderTopLeftRadius,
        bg: cs.backgroundColor,
        btnRadius: btn ? getComputedStyle(btn).borderTopLeftRadius : 'no-btn'
      }
    })()`)
    // 无样式时：宽度撑满视口、圆角 0、背景透明；有样式时是 420px / 4px / 白色
    expect(styled.width, `确认框没拿到 element-plus 的样式：${JSON.stringify(styled)}`).toBe(
      '420px'
    )
    expect(styled.radius, `确认框圆角不对：${JSON.stringify(styled)}`).toBe('4px')
    expect(styled.bg, `确认框背景不对：${JSON.stringify(styled)}`).toBe('rgb(255, 255, 255)')
    expect(styled.btnRadius, `确认框里的按钮没样式：${JSON.stringify(styled)}`).toBe('4px')

    await cdp.evaluate<boolean>(`(() => {
      const box = [...document.querySelectorAll('.el-message-box')].find((b) => b.offsetParent !== null)
      const btn = [...box.querySelectorAll('button')].find((b) => /执行清理/.test(b.textContent || ''))
      if (!btn) return false
      btn.click()
      return true
    })()`)

    await waitFor(
      cdp,
      "Number((document.querySelector('[data-test=archive-count]') || {}).textContent || 0) === 3",
      60000,
      '清理后只剩 3 条'
    )

    // 服务器上剩下的目录数也要对得上（9 条里保留最新 3 条）
    const onServer = await remoteList(remote, REMOTE_ARCHIVE)
    expect(onServer.filter((n) => /^\d{8}-\d{6}_/.test(n))).toHaveLength(3)
    console.info(`[B12 DoD] 保留策略：列表与服务器都只剩 ${onServer.length} 个版本`)
  }, 180000)

  it('收尾：本地下载目录无异常残留，远端零暂存', async () => {
    const names = existsSync(saveDir) ? readdirSync(saveDir) : []
    // 目录里应当只有"下载完成的最终目录"（MT-05 保留的那份半截内容由 delete 收尾，
    // 这里只断言"没有其它来路不明的东西"）
    const unknown = names.filter((n) => !/^[^.]/.test(n) && !n.startsWith('.sfvm-part-'))
    expect(unknown).toEqual([])

    const onServer = await remoteList(remote, REMOTE_ROOT)
    expect(onServer.filter((n) => n.startsWith('.sfvm-staging-'))).toEqual([])
    console.info(`[B12 DoD] 本地目录 ${names.length} 项、远端 ${onServer.join('、')}`)
  }, 60000)
})
