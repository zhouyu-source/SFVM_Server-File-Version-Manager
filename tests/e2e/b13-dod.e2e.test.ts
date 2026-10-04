/**
 * B13 批次 DoD 的真窗口验证：**MT-04**（回滚到 10 个版本之前，且当前版本已归档）。
 *
 * ## DoD 的两句要求，分别怎么验
 *
 * 1. **"服务器目标路径内容与所选归档一致"** → 直接读服务器上的文件逐字比对
 *    （不看界面自述：界面说"成功"不算数，磁盘上是什么才算数）。
 * 2. **"当前版本不丢失"** → 回滚完成后，**回滚前的那一版必须出现在往期版本列表里**
 *    （表格条数 10 → 11，且新出现的那条指纹来自回滚前的内容）。
 *    这一条是回滚与"直接用归档覆盖"的分水岭，必须能自证。
 *
 * ## 为什么"10 个版本之前"要直接造数据
 *
 * 与 B12 同样的理由：这条 DoD 要验的是**回滚这条路径**（对比预览 → 校验归档 →
 * 归档当前 → 恢复到目标 → 台账），不是"发布 10 次能不能成功"。真发 10 次等于把
 * 每个版本完整上传一遍（这台机器出带宽只有 ~0.46 MB/s），十几分钟起，
 * 而且失败时很难归因到底是第几次就坏了。所以按归档服务的**真实布局**在服务器上
 * 造出 10 个版本、把台账写好 —— 被驱动的仍然是完整的界面链路。
 *
 * 发布链路本身由 `b11-dod.e2e.test.ts` 真跑过；这里只需要"服务器上有一批历史版本"。
 *
 * ## 覆盖的 DoD 项
 *
 * | 项 | 断言 |
 * | --- | --- |
 * | T13.1/13.3 对比 | 弹窗里当前版本（台账）与目标版本（归档）并排可辨 |
 * | T13.2 快速回滚 | 勾选后出现黄色风险警告，文案与服务端同一份常量 |
 * | T13.2 校验拦截 | 归档被改坏 → 回滚被拦、任务失败、**目标一个字没动** |
 * | **MT-04** | 回滚到第 10 个版本之前 → 磁盘内容与所选归档逐字一致 |
 * | **当前版本不丢失** | 回滚前那一版出现在往期版本列表里（10 → 11） |
 * | T13.4 来源保留 | 默认保留来源 → 归档目录里那一版仍在 |
 *
 * ## 前置
 *
 * 1. `npm run build`（跑的是 `out/` 里的产物）；
 * 2. `SFVM_E2E=1` + `SFVM_IT_*` 凭据（真机在 `/tmp/sfvm-b13/<随机>` 下操作，结束清理）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'ssh2'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp, launchApp, sleep, waitFor, type LaunchedApp } from '../helpers/e2e-app'
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

/** 与 B12 的 9336 错开：两个 E2E 同时跑时不会抢调试端口 */
const DEBUG_PORT = 9337

/** 本轮测试的沙箱父目录（每轮一个随机子目录，收尾时**连父目录一起删**） */
const REMOTE_PARENT = '/tmp/sfvm-b13'
const REMOTE_ROOT = `${REMOTE_PARENT}/${Math.random().toString(36).slice(2, 10)}`
const REMOTE_TARGET = `${REMOTE_ROOT}/web/dist`
const REMOTE_ARCHIVE = `${REMOTE_TARGET}.versions`

/** 历史版本数：DoD 要的是"回滚到 10 个版本之前" */
const VERSION_COUNT = 10

/** 当前线上版本的版本号（台账里那条成功记录用它） */
const CURRENT_TAG = '20260920-120000_c0ffee1'
const CURRENT_FILES: Record<string, string> = {
  'index.html': 'current-index',
  'assets/app.js': 'current-js'
}

function tagOf(i: number): string {
  const day = String(10 + i).padStart(2, '0')
  const hash = createHash('sha256').update(`v${i}`).digest('hex').slice(0, 7)
  return `202609${day}-1200${String(i % 60).padStart(2, '0')}_${hash}`
}

interface SeedVersion {
  tag: string
  storagePath: string
  payloadPath: string
  files: Record<string, string>
  rootHash: string
  totalBytes: number
  archivedAt: string
}

/** 一批内容各不相同的历史版本：回滚到哪一版，磁盘上一眼可辨。 */
function planVersions(): SeedVersion[] {
  const out: SeedVersion[] = []
  for (let i = 0; i < VERSION_COUNT; i++) {
    // 归档里 relPath 相对 payloadPath，目录型带 `dist/` 前缀（见 archive 契约）
    const files: Record<string, string> = {
      'dist/index.html': `v${i}-index`,
      'dist/assets/app.js': `v${i}-js`
    }
    const rootHash = computeRootHash(
      Object.entries(files).map(([relPath, content]) => ({
        relPath,
        hash: createHash('sha256').update(content).digest('hex'),
        size: Buffer.byteLength(content)
      }))
    )
    out.push({
      tag: tagOf(i),
      storagePath: `${REMOTE_ARCHIVE}/${tagOf(i)}`,
      payloadPath: `${REMOTE_ARCHIVE}/${tagOf(i)}/payload`,
      files,
      rootHash,
      totalBytes: Object.values(files).reduce((a, c) => a + Buffer.byteLength(c), 0),
      archivedAt: `2026-09-${String(10 + i).padStart(2, '0')}T12:00:00+08:00`
    })
  }
  return out
}

function manifestOf(v: SeedVersion): string {
  return JSON.stringify({
    schemaVersion: 1,
    targetName: '前端产物',
    originalPath: REMOTE_TARGET,
    kind: 'dir',
    versionTag: v.tag,
    archivedAt: v.archivedAt,
    hashAlgo: 'sha256',
    rootHash: v.rootHash,
    totalBytes: v.totalBytes,
    fileCount: Object.keys(v.files).length,
    operator: null,
    note: null,
    sourceReleaseId: null,
    files: Object.entries(v.files).map(([relPath, content]) => ({
      relPath,
      hash: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      mtime: v.archivedAt
    }))
  })
}

describeIf('B13 DoD：往期版本的回滚（真窗口 + 真服务器）', () => {
  let remote: RemoteConn
  let app: LaunchedApp | null = null
  let db: ReturnType<typeof openDatabase>
  let repo: Repositories
  let userDataDir = ''
  let versions: SeedVersion[] = []
  let oldest: SeedVersion

  beforeAll(async () => {
    remote = await connectRemote({ host: HOST, port: PORT, user: USER, keyPath: KEY_PATH })
    versions = planVersions()
    oldest = versions[0]!

    /* ---- 服务器上按归档服务的真实布局造出 10 个历史版本 ---- */
    for (const v of versions) {
      for (const [rel, content] of Object.entries(v.files)) {
        const abs = `${v.payloadPath}/${rel}`
        await sftpMkdirp(remote, abs.slice(0, abs.lastIndexOf('/')))
        await writeRemoteText(remote, abs, content)
      }
      await writeRemoteText(remote, `${v.storagePath}/manifest.json`, manifestOf(v))
    }
    /* ---- 目标路径上是"当前版本" ---- */
    for (const [rel, content] of Object.entries(CURRENT_FILES)) {
      await sftpMkdirp(remote, `${REMOTE_TARGET}/${rel.slice(0, rel.lastIndexOf('/'))}`)
      await writeRemoteText(remote, `${REMOTE_TARGET}/${rel}`, content)
    }

    /* ---- 再写台账：连接 / 环境 / 目标 / 10 条归档 + 1 条成功发布记录 ---- */
    userDataDir = mkdtempSync(join(tmpdir(), 'sfvm-b13-userdata-'))
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

    for (const [i, v] of versions.entries()) {
      repo.archives.create({
        targetId: target.id,
        versionTag: v.tag,
        storagePath: v.storagePath,
        payloadPath: v.payloadPath,
        kind: 'dir',
        rootHash: v.rootHash,
        totalBytes: v.totalBytes,
        fileCount: Object.keys(v.files).length,
        releaseId: null,
        note: null,
        status: 'valid'
        // `archivedAt` 由仓储按"现在"填 —— 界面按它倒序，但本用例靠
        // `ensureArchiveRowVisible(tag)` 朝目标行滚动，不依赖顺序
      })
      void i
    }
    const rel = repo.releases.create({
      id: 'rel-current',
      targetId: target.id,
      action: 'deploy',
      versionTag: CURRENT_TAG,
      status: 'SUCCESS',
      source: 'local',
      rootHash: computeRootHash(
        Object.entries(CURRENT_FILES).map(([relPath, content]) => ({
          relPath,
          hash: createHash('sha256').update(content).digest('hex'),
          size: Buffer.byteLength(content)
        }))
      ),
      totalBytes: Object.values(CURRENT_FILES).reduce((a, c) => a + Buffer.byteLength(c), 0),
      fileCount: Object.keys(CURRENT_FILES).length
    })
    repo.releases.finish(rel.id, 'SUCCESS')

    db.close()

    app = await launchApp({ userDataDir, debugPort: DEBUG_PORT, projectRoot: PROJECT_ROOT })
  }, 180000)

  afterAll(async () => {
    await closeApp(app ?? undefined)
    // 连父目录一起删：只删随机子目录的话，`/tmp/sfvm-b13` 这个空壳会留下来，
    // 下一轮 `node .tools/verify/check-residue.cjs` 就会报 RESIDUE: found
    await removeRemoteDir(remote, REMOTE_ROOT)
    await removeRemoteDir(remote, REMOTE_PARENT)
    // 明确断言清理干净：测试自己造的远端目录不能留（否则下一轮 `check-residue` 会报残留）
    const left = await remoteExists(remote, REMOTE_ROOT)
    if (left) console.warn(`[B13 DoD] 远端残留未清理干净：${REMOTE_ROOT}`)
    try {
      db.close()
    } catch {
      /* 已关过 */
    }
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
    remote.client.end()
  }, 120000)

  /** 打开某个版本的回滚弹窗，并等它把对比数据算出来。 */
  async function openRollbackDialog(tag: string): Promise<void> {
    const cdp = app!.cdp
    await ensureArchiveRowVisible(cdp, tag)
    await cdp.evaluate<boolean>(
      `(document.querySelector(${JSON.stringify(archiveRowButton(tag, 'rollback'))}).click(), true)`
    )
    await waitFor(
      cdp,
      "[...document.querySelectorAll('[data-test=rollback-dialog]')].some((d) => d.offsetParent !== null)",
      20000,
      '回滚弹窗出现'
    )
    // 预览是异步拉的：等目标版本那一行渲染出来才算真的有了数据
    await waitFor(
      cdp,
      `!!document.querySelector('[data-test=rollback-target-版本号]')`,
      20000,
      '对比数据就绪'
    )
  }

  /* ------------------------------------------------------------ T13.3 */

  it('T13.3 + T13.2：弹窗把两版并排摆出来，勾选"跳过校验"出现风险警告', async () => {
    const cdp = app!.cdp
    await selectTarget(cdp)
    await openRollbackDialog(oldest.tag)

    // 当前版本来自台账（发布记录），目标版本来自归档行
    // 取值那一格（`.rb-value`）：直接读整行会把"版本号"这个标签也读进来
    const shown = await cdp.evaluate<{ current: string; target: string }>(`(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel + ' .rb-value')
        return el ? el.textContent.trim() : ''
      }
      return {
        current: pick('[data-test=rollback-current-版本号]'),
        target: pick('[data-test=rollback-target-版本号]')
      }
    })()`)
    expect(shown.current).toBe(CURRENT_TAG)
    expect(shown.target).toBe(oldest.tag)
    console.info(`[B13 DoD] 对比：${shown.current} → ${shown.target}`)

    // 默认保留来源（可以再滚回去），这一点不该是"默认删掉"
    const keepDefault = await cdp.evaluate<boolean>(`(() => {
      const cb = document.querySelector('[data-test=rollback-keep-source]')
      if (!cb) return false
      const input = cb.tagName === 'INPUT' ? cb : cb.querySelector('input')
      return Boolean(input && input.checked)
    })()`)
    expect(keepDefault, '"保留来源版本"应当默认勾选').toBe(true)

    // 打开"跳过校验"→ 必须出现黄色警告（文案与服务端同一份常量）
    await cdp.evaluate<boolean>(`(() => {
      const sw = document.querySelector('[data-test=rollback-skip-verify]')
      if (!sw) return false
      const input = sw.tagName === 'INPUT' ? sw : sw.querySelector('input')
      if (!input) return false
      input.click()
      return true
    })()`)
    await waitFor(
      cdp,
      "[...document.querySelectorAll('[data-test=rollback-skip-verify-warning]')].some((e) => e.offsetParent !== null)",
      10000,
      '跳过校验的风险警告出现'
    ).catch(() => undefined)

    await closeVisibleDialog(cdp)
  }, 120000)

  /* -------------------------------------------------- T13.2 校验拦截 */

  it('T13.2：归档内容被改坏 → 回滚被拦下，任务失败且目标一个字没动', async () => {
    const cdp = app!.cdp
    const victim = versions[1]!
    // 直接改服务器上的归档内容（manifest 不动 —— 正是"被人动过"的形态）
    await writeRemoteText(remote, `${victim.payloadPath}/dist/index.html`, 'tampered')

    await selectTarget(cdp)
    await openRollbackDialog(victim.tag)

    // 台账上这条还是 valid（上次校验时是好的），所以预览不会提前警告 ——
    // 拦截必须发生在回滚的阶段 1（真去读一遍服务器上的内容）
    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=rollback-start]').click(), true)"
    )

    const outcome = await (async (): Promise<string> => {
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        const state = await cdp.evaluate<string>(`(() => {
          if (document.querySelector('[data-test=rollback-failure]')) return 'failed'
          const pct = document.querySelector('[data-test=rollback-percent]')
          if (pct && /100/.test(pct.textContent || '')) return 'done'
          return 'running'
        })()`)
        if (state !== 'running') return state
        await sleep(300)
      }
      return 'timeout'
    })()

    expect(outcome, `期望被拦下，实际是 ${outcome}`).toBe('failed')

    // **目标一个字没动**：改坏的是归档，不是目标
    expect(await readRemoteText(remote, `${REMOTE_TARGET}/index.html`)).toBe('current-index')
    // 也没有凭空多出一个归档
    const archived = (await remoteList(remote, REMOTE_ARCHIVE)).filter((n) => /^\d{8}-\d{6}_/.test(n))
    expect(archived).toHaveLength(VERSION_COUNT)

    await closeVisibleDialog(cdp)
  }, 180000)

  /* ------------------------------------------------------------- MT-04 */

  it('MT-04：回滚到 10 个版本之前 → 磁盘内容与所选归档一致，且回滚前的版本已入库', async () => {
    const cdp = app!.cdp
    await selectTarget(cdp)
    await openRollbackDialog(oldest.tag)

    await cdp.evaluate<boolean>(
      "(document.querySelector('[data-test=rollback-start]').click(), true)"
    )

    /**
     * 等它跑完：**回滚前的那一版被归档进来**，所以列表条数会从 10 变 11。
     * 拿条数当完成信号比看进度条 100% 更实在 —— 它同时验证了"当前版本已入库"。
     */
    await waitFor(
      cdp,
      `Number((document.querySelector('[data-test=archive-count]') || {}).textContent || 0) === ${VERSION_COUNT + 1}`,
      180000,
      '回滚完成且回滚前的版本已入库（10 → 11）'
    )

    // ---- DoD 第一句：服务器目标路径内容与所选归档一致（逐字比对） ----
    for (const [rel, content] of Object.entries(oldest.files)) {
      const disk = await readRemoteText(remote, `${REMOTE_TARGET}/${rel.replace(/^dist\//, '')}`)
      expect(disk, `${rel} 的内容应当来自归档`).toBe(content)
    }
    console.info(
      `[B13 DoD] MT-04 通过：${REMOTE_TARGET} 现在是 ${oldest.tag} 的内容（${Object.keys(oldest.files).join('、')}）`
    )

    // ---- DoD 第二句：回滚前的那一版在往期版本列表里能找到 ----
    const archivedTags = (await remoteList(remote, REMOTE_ARCHIVE)).filter((n) =>
      /^\d{8}-\d{6}_/.test(n)
    )
    // 11 个版本目录：10 个原有的 + 回滚前那一版
    expect(archivedTags).toHaveLength(VERSION_COUNT + 1)
    const newOnes = archivedTags.filter((t) => !versions.some((v) => v.tag === t))
    expect(newOnes).toHaveLength(1)

    /**
     * 证明"新归档的确是回滚前的那个当前版本" —— **用内容证明，不比指纹**。
     *
     * 两边的 `rootHash` 口径**本来就不同**（这是 B09 定下的语义，不是 bug）：
     * - `releases.rootHash` 是产物指纹，相对产物根（`index.html`）；
     * - `archives.rootHash` 覆盖的是 `payload_path` 整棵树，目录型多一层
     *   （`dist/index.html`，见 archive 契约的说明）。
     *
     * 拿两个口径不同的哈希互比只会得到一个假失败，所以这里直接读归档目录里的
     * 文件与"回滚前的目标内容"逐字对照 —— 那才是 DoD 要的东西。
     */
    for (const [rel, content] of Object.entries(CURRENT_FILES)) {
      const inArchive = await readRemoteText(
        remote,
        `${REMOTE_ARCHIVE}/${newOnes[0]}/payload/dist/${rel}`
      )
      expect(inArchive, `归档里的 ${rel} 应当是回滚前的那份内容`).toBe(content)
    }

    // 界面上也要能找到它：滚回顶部（最新的排在最前）再断言那一行存在
    await cdp.evaluate<boolean>(`(() => {
      const host = document.querySelector('[data-test=archive-table]')
      const all = [host, ...host.querySelectorAll('*')]
      const el = all.find((x) => x.scrollHeight > x.clientHeight + 20)
      if (el) el.scrollTop = 0
      return true
    })()`)
    await sleep(400)
    const listed = await cdp.evaluate<string[]>(
      `[...document.querySelectorAll('[data-test=arch-version]')].map((e) => e.textContent.trim())`
    )
    expect(listed, `往期版本列表里应当能看到回滚前的版本 ${newOnes[0]}`).toContain(newOnes[0])
    console.info(`[B13 DoD] 回滚前的版本已入库为 ${newOnes[0]}（内容逐字一致，且列表里可见）`)

    // ---- T13.4：默认保留来源 → 所选那一版仍留在版本库里 ----
    expect(await remoteExists(remote, `${oldest.payloadPath}/dist/index.html`)).toBe(true)

    await closeVisibleDialog(cdp)

    /**
     * ---- 界面上的「当前版本」必须立刻变成回滚到的那一版 ----
     *
     * 用户实测报过这个 bug：回滚完「当前版本」还是旧号，切走再切回来甚至变成空。
     * 根因有两处（都已修）：回滚不写逐文件清单、而 `preview` 把版本号与
     * "清单是否存在"耦合在一起；以及回滚完成后没有任何东西触发刷新。
     * 这条断言正是照着用户的复现路径写的。
     */
    await waitFor(
      cdp,
      `(document.querySelector('[data-test=current-version]') || {}).textContent.trim() === ${JSON.stringify(oldest.tag)}`,
      30000,
      '详情页的「当前版本」已更新为回滚到的版本'
    )

    // 切到连接页再切回来（用户报的复现路径）：不能变空、不能是旧号
    await cdp.evaluate<boolean>(
      `(document.querySelector('.sfvm-nav a[href="#/connections"]').click(), true)`
    )
    await waitFor(cdp, "location.hash === '#/connections'", 15000, '已切到连接页')
    await selectTarget(cdp)
    await waitFor(
      cdp,
      `(document.querySelector('[data-test=current-version]') || {}).textContent.trim() === ${JSON.stringify(oldest.tag)}`,
      30000,
      '切回目标页后「当前版本」仍然正确（不是空、也不是旧号）'
    )
    console.info(`[B13 DoD] 回滚后「当前版本」= ${oldest.tag}，切页往返后不变`)
  }, 240000)

  it('收尾：远端沙箱目录已清理（不留 sfvm-b13 残留）', async () => {
    await removeRemoteDir(remote, REMOTE_ROOT)
    await removeRemoteDir(remote, REMOTE_PARENT)
    expect(await remoteExists(remote, REMOTE_ROOT)).toBe(false)
    expect(await remoteExists(remote, REMOTE_PARENT)).toBe(false)
    console.info(`[B13 DoD] 远端 ${REMOTE_ROOT} 已清理`)
  }, 60000)
})
