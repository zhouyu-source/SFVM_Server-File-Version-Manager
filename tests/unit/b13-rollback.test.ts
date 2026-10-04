/**
 * T13.1 ~ T13.5 单测：回滚的六阶段、失败补偿、来源去留、台账。
 *
 * ## 为什么用内存远端把整条链路真跑一遍
 *
 * 回滚是本项目**唯一会同时改动两处**的操作（服务器的目标路径 + 版本库），
 * 而它最要紧的性质全是"过程"里的：阶段 3 失败时当前版本有没有被搬回来、
 * 归档目录有没有被搬空却仍留着台账行、跳过校验到底跳过了什么。
 * 用 `vi.fn()` 断言"调用了 undoArchive"证明不了这些 ——
 * 所以这里断言的是**最后服务器上剩了什么**（`fake.ls()` / `fake.text()`）。
 *
 * 内存远端与夹具来自 `tests/helpers/fake-remote.ts`（与 B10 发布单测同一套）——
 * 两边用同一份替身，才不会漏掉"发布做得到、回滚做不到"这类不对称 bug。
 *
 * ## 用例的组织方式
 *
 * `setupArchived()` 造出一个**真实局面**：服务器上先有 v1 → 把 v1 归档进版本库
 * （走的是与发布阶段 4 完全相同的 `archiveVersion`）→ 再手工放上 v2 并补一条
 * 成功台账。于是"当前版本 = v2、往期版本 = v1"不是伪造的数据结构，
 * 而是真跑出来的状态 —— 归档目录里有真的 manifest，校验也校验得了。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { createArchiveService } from '@main/services/archive'
import { createDeployService } from '@main/services/deploy'
import { createRollbackService } from '@main/services/rollback'
import { manifestToArtifactItems } from '@main/infra/manifest-io'
import { AppError, ErrorCode } from '@main/infra/errors'
import { lockPathOf } from '@main/infra/deploy-plan'
import { buildLockPayload } from '@main/infra/deploy-plan'
import { CLOCK, FakeRemote, makeCtx, makeLocalDir } from '../helpers/fake-remote'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

const REMOTE = '/opt/app/dist'

describe('RollbackService（B13 回滚）', () => {
  let t: TestDb
  let fake: FakeRemote
  let archive: ReturnType<typeof createArchiveService>
  let service: ReturnType<typeof createRollbackService>
  let targetId: string
  const tempDirs: string[] = []

  beforeEach(() => {
    t = makeTestDb()
    fake = new FakeRemote()
    archive = createArchiveService({ repo: t.repo, now: () => CLOCK })
    // 时钟可注入：锁的陈旧判据（LOCK_STALE_MS）依赖时间，写死真实时间的话
    // "被占用的锁"会被判成陈旧，E_TARGET_BUSY 那条分支就永远测不到
    service = createRollbackService({ repo: t.repo, archive, now: () => CLOCK })
    const base = seedBasic(t.repo).target
    // 目录型目标 `/opt/app/dist`（与 B10 单测同一形态）
    const localDir = makeLocalDir({ 'index.html': 'local' })
    tempDirs.push(localDir)
    targetId = t.repo.targets.create({
      environmentId: base.environmentId,
      name: '前端产物',
      kind: 'dir',
      remotePath: REMOTE,
      localPath: localDir
    }).id
  })

  afterEach(() => {
    t.cleanup()
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /**
   * 造出"当前版本 v2、版本库里有 v1"的真实局面。
   *
   * 归档那一步走的是**与发布阶段 4 相同的** `archiveVersion`，
   * 因此归档目录里有真的 `manifest.json`，阶段 1 的校验能真的跑起来。
   */
  async function setupArchived(): Promise<{ archiveId: string; versionTag: string; storagePath: string }> {
    fake.putFile(`${REMOTE}/index.html`, 'v1')
    const a = await archive.archiveVersion({
      targetId,
      ports: fake.archivePorts(),
      releaseId: 'rel-v1',
      moveMode: 'rename'
    })
    // 之后"发布了 v2"：目标重新有内容，台账里留下一条成功记录
    fake.putFile(`${REMOTE}/index.html`, 'v2')
    t.repo.releases.create({
      id: 'rel-v2',
      targetId,
      action: 'deploy',
      versionTag: '20250612-143100_aaaaaaa',
      status: 'SUCCESS',
      source: 'local',
      rootHash: 'r2',
      totalBytes: 2,
      fileCount: 1
    })
    t.repo.releases.finish('rel-v2', 'SUCCESS')
    return {
      archiveId: a.archive.id,
      versionTag: a.archive.versionTag,
      storagePath: a.archive.storagePath
    }
  }

  /**
   * 跑一次回滚。
   *
   * 注意 `run` 的失败有两种形态，测试要按实际情况断言：
   * - **参数错误**（目标 / 归档 id 根本不存在）→ 直接抛 `AppError`
   *   （连台账行都建不出来，没什么可记的）；
   * - **运行期失败**（校验不过、rename 失败…）→ 返回 `{ ok: false, failure }`，
   *   由 IPC 层转成异常抛给任务框架（与发布同一套：任务框架只认抛出来的异常）。
   */
  function run(archiveId: string, extra: Record<string, unknown> = {}) {
    const { ctx, logs, text } = makeCtx()
    return {
      text,
      logs,
      result: service.run({
        targetId,
        archiveId,
        ports: fake.rollbackPorts(),
        ctx,
        rollbackId: 'rb-1',
        ...extra
      })
    }
  }

  /* ------------------------------------------------------------ 前置校验 */

  it('阶段 0：归档记录不存在 → E_NOT_FOUND，远端零改动', async () => {
    fake.putFile(`${REMOTE}/index.html`, 'v2')
    const { result } = run('nope')
    await expect(result).rejects.toMatchObject({ code: ErrorCode.E_NOT_FOUND })
    expect(fake.text(`${REMOTE}/index.html`)).toBe('v2')
    expect(fake.execLog.filter((c) => c.startsWith('chmod'))).toEqual([])
  })

  it('阶段 0：所选版本不属于这个目标 → E_PARAM（不会把别人的内容搬过来）', async () => {
    const other = t.repo.targets.create({
      environmentId: t.repo.targets.get(targetId)!.environmentId,
      name: '另一个目标',
      kind: 'dir',
      remotePath: '/opt/other/dist'
    })
    const row = t.repo.archives.create({
      targetId: other.id,
      versionTag: '20250612-143000_bbbbbbb',
      storagePath: '/opt/other/dist.versions/20250612-143000_bbbbbbb',
      payloadPath: '/opt/other/dist.versions/20250612-143000_bbbbbbb/payload',
      kind: 'dir',
      rootHash: 'x',
      totalBytes: 1,
      fileCount: 1,
      status: 'valid'
    })
    fake.putFile(`${REMOTE}/index.html`, 'v2')
    const out = await run(row.id).result
    expect(out.ok).toBe(false)
    expect(out.failure?.code).toBe(ErrorCode.E_PARAM)
    expect(fake.text(`${REMOTE}/index.html`)).toBe('v2')
  })

  it('阶段 0：归档目录已不在 → E_ARCHIVE_MISSING，且**不会**先把当前版本归档掉', async () => {
    const a = await setupArchived()
    fake.rmrf(a.storagePath)
    const out = await run(a.archiveId).result
    expect(out.ok).toBe(false)
    expect(out.failure?.code).toBe(ErrorCode.E_ARCHIVE_MISSING)
    // 关键：当前版本必须原封不动 —— 否则就是"归档了当前版本、又拿不到旧版本"的最坏局面
    expect(fake.text(`${REMOTE}/index.html`)).toBe('v2')
    // 台账里仍只有 setup 时那一条 —— 没有因为"回滚失败"多出归档
    expect(t.repo.archives.countByTarget(targetId)).toBe(1)
  })

  it('阶段 0：远端锁被占用 → E_TARGET_BUSY，一个字都没动', async () => {
    const a = await setupArchived()
    fake.putFile(
      lockPathOf(REMOTE),
      buildLockPayload({
        releaseId: 'someone-else',
        hostname: 'other-host',
        pid: 1,
        now: new Date(CLOCK.getTime())
      })
    )
    const out = await run(a.archiveId).result
    expect(out.ok).toBe(false)
    expect(out.failure?.code).toBe(ErrorCode.E_TARGET_BUSY)
    expect(fake.text(`${REMOTE}/index.html`)).toBe('v2')
    expect(t.repo.archives.countByTarget(targetId)).toBe(1)
  })

  /* -------------------------------------------------------------- 校验 */

  it('阶段 1：归档内容被改坏 → E_ARCHIVE_CORRUPT，目标原封不动、没有产生新归档', async () => {
    const a = await setupArchived()
    fake.putFile(`${a.storagePath}/payload/dist/index.html`, 'tampered')
    const out = await run(a.archiveId).result
    expect(out.ok).toBe(false)
    expect(out.failure?.code).toBe(ErrorCode.E_ARCHIVE_CORRUPT)
    expect(fake.text(`${REMOTE}/index.html`)).toBe('v2')
    // 只应该有 setup 时那一条归档
    expect(t.repo.archives.countByTarget(targetId)).toBe(1)
  })

  it('阶段 1：跳过校验（T13.2）→ 改坏的内容照样换上线，日志里有风险提示', async () => {
    const a = await setupArchived()
    fake.putFile(`${a.storagePath}/payload/dist/index.html`, 'tampered')
    const { result, text } = run(a.archiveId, { skipVerify: true })
    const out = await result
    expect(out.ok).toBe(true)
    expect(out.verified).toBe(false)
    expect(fake.text(`${REMOTE}/index.html`)).toBe('tampered')
    expect(text()).toContain('跳过完整性校验')
  })

  /* -------------------------------------------------------------- 成功 */

  it('成功：目标内容变成所选归档，且**回滚前的版本已入库**（当前版本不丢失）', async () => {
    const a = await setupArchived()
    const out = await run(a.archiveId).result
    expect(out.ok).toBe(true)
    expect(out.versionTag).toBe(a.versionTag)
    // DoD：服务器目标路径内容与所选归档一致
    expect(fake.text(`${REMOTE}/index.html`)).toBe('v1')
    // "当前版本不丢失"：v2 现在应该躺在版本库里
    const rows = t.repo.archives.listByTarget(targetId, 10)
    expect(rows).toHaveLength(2)
    expect(rows.some((r) => r.versionTag === out.archivedVersionTag)).toBe(true)
    expect(out.archivedVersionTag).toBeTruthy()
    // 锁要放掉（否则下一次发布会被自己的残留锁挡住）
    expect(fake.has(lockPathOf(REMOTE))).toBe(false)
  })

  it('成功：保留来源（默认）→ 归档目录与台账行都还在，可以再滚回来', async () => {
    const a = await setupArchived()
    const out = await run(a.archiveId).result
    expect(out.moveMode).toBe('copy')
    const row = t.repo.archives.get(a.archiveId)
    expect(row).toBeTruthy()
    expect(fake.has(`${a.storagePath}/payload/dist/index.html`)).toBe(true)
  })

  it('成功：不保留来源 → 归档目录被删、台账行摘掉（不留对不上账的孤儿）', async () => {
    const a = await setupArchived()
    const out = await run(a.archiveId, { keepSource: false }).result
    expect(out.ok).toBe(true)
    // 内容搬走了（rename），来源那条从版本库消失
    expect(fake.has(a.storagePath)).toBe(false)
    expect(t.repo.archives.get(a.archiveId)).toBeUndefined()
    // 但回滚前的 v2 还在库里
    expect(t.repo.archives.listByTarget(targetId, 10)).toHaveLength(1)
    expect(fake.text(`${REMOTE}/index.html`)).toBe('v1')
  })

  it('台账：写 action=rollback / source=archive / archive_id，并把被取代的那版标成 ROLLED_BACK', async () => {
    const a = await setupArchived()
    await run(a.archiveId).result
    const rb = t.repo.releases.get('rb-1')!
    expect(rb.action).toBe('rollback')
    expect(rb.source).toBe('archive')
    expect(rb.archiveId).toBe(a.archiveId)
    expect(rb.versionTag).toBe(a.versionTag)
    expect(rb.status).toBe('SUCCESS')
    // 被取代的那条：它的内容已经不在线上了
    expect(t.repo.releases.get('rel-v2')!.status).toBe('ROLLED_BACK')
  })

  it('台账：把"回滚到的这一版"的逐文件清单也记下来（下次发布的差异基准）', async () => {
    const a = await setupArchived()
    await run(a.archiveId).result

    const rows = t.repo.releaseItems.listByRelease('rb-1')
    /**
     * **口径必须换过来**：归档 manifest 里的 relPath 相对 `payload_path`
     * （`dist/index.html`），而 `release_items` 存的是相对产物根（`index.html`）。
     * 直接塞进去会让下次发布的差异摘要凭空多出一层 `dist/`。
     */
    expect(rows.map((r) => r.relPath)).toEqual(['index.html'])
    expect(rows[0]!.size).toBe('v1'.length)

    // 顺带验一下"这次发布能看到正确的差异基准"
    const preview = await createDeployService({ repo: t.repo, archive }).preview({ targetId })
    expect(preview.lastVersionTag).toBe(a.versionTag)
    expect(preview.diff.previousVersionTag).toBe(a.versionTag)
  })

  it('preview：即便逐文件清单缺失，当前版本号也要给出来（B13 实测踩到的那个 bug）', async () => {
    const a = await setupArchived()
    await run(a.archiveId).result
    // 模拟"清单没落库"（文件数超过上限、或老版本留下的行）
    t.repo.releaseItems.removeByRelease('rb-1')

    const preview = await createDeployService({ repo: t.repo, archive }).preview({ targetId })
    /**
     * 版本号与"清单是否存在"**必须解耦**：
     * 清单只影响差异摘要，而"当前版本"是用户判断"线上到底是什么"的唯一依据。
     * 原来两者耦合在一起，回滚（不写清单）之后详情页的「当前版本」直接变空。
     */
    expect(preview.lastVersionTag).toBe(a.versionTag)
    // 清单没了，差异摘要确实只能退化成"无法比对" —— 这是可以接受的降级
    expect(preview.diff.previousVersionTag).toBeNull()
  })

  describe('manifestToArtifactItems（清单口径转换，纯函数）', () => {
    const manifest = {
      schemaVersion: 1,
      targetName: 'x',
      originalPath: REMOTE,
      kind: 'dir',
      versionTag: '20260910-120000_0270da4',
      archivedAt: '2026-09-10T12:00:00+08:00',
      hashAlgo: 'sha256',
      rootHash: 'r',
      totalBytes: 2,
      fileCount: 2,
      files: [
        { relPath: 'dist/index.html', hash: 'h1', size: 2, mtime: null },
        { relPath: 'dist/assets/app.js', hash: 'h2', size: 3, mtime: null }
      ]
    } as never

    it('目录型：剥掉一层 `<basename>/`', () => {
      expect(manifestToArtifactItems(manifest, { originalPath: REMOTE, kind: 'dir' })).toEqual([
        { relPath: 'index.html', hash: 'h1', size: 2, mtime: null },
        { relPath: 'assets/app.js', hash: 'h2', size: 3, mtime: null }
      ])
    })

    it('文件型：relPath 本来就一致，原样返回', () => {
      const m = {
        ...(manifest as Record<string, unknown>),
        kind: 'file',
        files: [{ relPath: 'order.jar', hash: 'h', size: 5, mtime: null }]
      }
      expect(
        manifestToArtifactItems(m as never, { originalPath: '/opt/svc/order.jar', kind: 'file' })
      ).toEqual([{ relPath: 'order.jar', hash: 'h', size: 5, mtime: null }])
    })

    it('前缀对不上 → 返回 null（宁可不写清单，也不往台账里写一份错的）', () => {
      const m = {
        ...(manifest as Record<string, unknown>),
        files: [{ relPath: 'other/index.html', hash: 'h', size: 1, mtime: null }]
      }
      expect(manifestToArtifactItems(m as never, { originalPath: REMOTE, kind: 'dir' })).toBeNull()
    })
  })

  /* -------------------------------------------- 当前线上版本（纯台账） */

  describe('currentVersion（目标详情页的「当前版本」用它）', () => {
    it('回滚后给的是**回滚到的**那一版，而不是被取代的旧号', async () => {
      const a = await setupArchived()
      // 回滚前是 rel-v2 那一版
      const svc = createDeployService({ repo: t.repo, archive })
      expect(svc.currentVersion({ targetId }).versionTag).toBe('20250612-143100_aaaaaaa')

      await run(a.archiveId).result
      const after = svc.currentVersion({ targetId })
      expect(after.versionTag).toBe(a.versionTag)
      expect(after.action).toBe('rollback')
    })

    it('目标没配本地产物路径也能回答（挂在 preview 上时这里会直接抛错）', async () => {
      t.repo.releases.create({
        id: 'rel-only',
        targetId,
        action: 'deploy',
        versionTag: '20250612-140000_ddddddd',
        status: 'SUCCESS',
        source: 'local',
        rootHash: 'x',
        totalBytes: 1,
        fileCount: 1
      })
      t.repo.releases.finish('rel-only', 'SUCCESS')
      t.repo.targets.update(targetId, { localPath: null })

      const svc = createDeployService({ repo: t.repo, archive })
      // preview 要求本地产物路径 —— 这就是"接管既有目录"的场景下
      // 「当前版本」显示"未知"的原因（明明台账里有记录）
      await expect(svc.preview({ targetId })).rejects.toMatchObject({
        code: ErrorCode.E_LOCAL_PATH_MISSING
      })
      expect(svc.currentVersion({ targetId }).versionTag).toBe('20250612-140000_ddddddd')
    })

    it('台账里没有任何成功记录 → 版本号为 null（不抛错）', () => {
      const svc = createDeployService({ repo: t.repo, archive })
      expect(svc.currentVersion({ targetId })).toMatchObject({
        versionTag: null,
        action: null,
        at: null,
        fileCount: 0
      })
    })
  })

  /* -------------------------------------------------------------- 补偿 */

  it('阶段 3 失败（复制中断）→ 先清掉半个副本、再把回滚前的版本搬回来', async () => {
    const a = await setupArchived()
    /**
     * 默认保留来源 → 阶段 3 走复制。让某一次文件复制失败，目标路径上就会留下
     * "半个新版本" —— 这正是补偿要处理的最麻烦的形态。
     */
    fake.copyFileFailures.set(`${REMOTE}/index.html`, {
      err: new Error('模拟复制中断'),
      remaining: 1
    })

    const { result, logs } = run(a.archiveId)
    const out = await result

    expect(out.ok).toBe(false)
    const comps = out.failure!.compensations
    // 顺序必须是"由外到内"：先清残留，再搬回旧版本。
    // 反过来 undoArchive 会因为"目标已有内容"拒绝覆盖，用户就卡在死局里。
    expect(comps[0]).toMatchObject({ action: '清理换版残留', ok: true })
    expect(comps[1]).toMatchObject({ action: 'undo-archive', ok: true })
    // **最关键的断言**：目标路径上是回滚前的 v2，而不是空目录或半个副本
    expect(fake.text(`${REMOTE}/index.html`)).toBe('v2')
    expect(logs.some((l) => l.text.includes('补偿成功'))).toBe(true)
    // 锁必须放掉，否则目标被自己的残留锁锁死
    expect(fake.has(lockPathOf(REMOTE))).toBe(false)
  })

  it('阶段 3 失败且补偿也失败 → 如实说明"内容还在版本库里"，不谎报已恢复', async () => {
    const a = await setupArchived()
    // 阶段 3 的复制失败；补偿要用的 rename 也失败（目标路径上搬不回去）
    fake.copyFileFailures.set(`${REMOTE}/index.html`, {
      err: new Error('模拟复制中断'),
      remaining: 1
    })
    fake.renameFailures.set(REMOTE, { err: new Error('Permission denied'), remaining: 1 })

    const out = await run(a.archiveId).result
    expect(out.ok).toBe(false)
    const comps = out.failure!.compensations
    expect(comps.find((c) => c.action === 'undo-archive')).toMatchObject({ ok: false })
    // 台账里那条归档还在 —— **内容没丢**，只是需要人工搬回去
    expect(fake.has(`${a.storagePath}/payload`)).toBe(true)
    expect(t.repo.archives.countByTarget(targetId)).toBeGreaterThanOrEqual(1)
    // 锁仍然要放掉：不放会把目标永久锁死
    expect(fake.has(lockPathOf(REMOTE))).toBe(false)
  })

  /* -------------------------------------------------------- 目标不存在 */

  it('目标不存在（没有当前版本可归档）→ 仍然成功，只是没有"回滚前版本"可保全', async () => {
    fake.putFile(`${REMOTE}/index.html`, 'v1')
    const a = await archive.archiveVersion({
      targetId,
      ports: fake.archivePorts(),
      releaseId: 'rel-v1',
      moveMode: 'rename'
    })
    // 归档已经把目标搬空，这里不再放任何东西 → 目标不存在
    expect(fake.has(REMOTE)).toBe(false)

    const out = await run(a.archive.id).result
    expect(out.ok).toBe(true)
    expect(out.archivedVersionTag).toBeUndefined()
    expect(fake.text(`${REMOTE}/index.html`)).toBe('v1')
  })

  /* -------------------------------------------------------------- 预览 */

  describe('preview（纯本地，T13.3）', () => {
    it('给出两版对比：当前版本来自台账、目标版本来自归档行', async () => {
      const a = await setupArchived()
      const p = service.preview({ targetId, archiveId: a.archiveId })
      expect(p.current?.versionTag).toBe('20250612-143100_aaaaaaa')
      expect(p.current?.origin).toBe('release')
      expect(p.target.versionTag).toBe(a.versionTag)
      expect(p.target.origin).toBe('archive')
      expect(p.target.status).toBe('valid')
      expect(p.remotePath).toBe(REMOTE)
      expect(p.warnings).toEqual([])
    })

    it('台账里没有成功记录时明确警告（不要拿"未知"冒充"当前版本"）', async () => {
      fake.putFile(`${REMOTE}/index.html`, 'v1')
      const a = await archive.archiveVersion({
        targetId,
        ports: fake.archivePorts(),
        releaseId: 'rel-1',
        moveMode: 'rename'
      })
      const p = service.preview({ targetId, archiveId: a.archive.id })
      expect(p.current).toBeNull()
      expect(p.warnings.join('；')).toContain('没有这个目标的成功记录')
    })

    it('归档状态是 corrupt 时给出警告（但不禁用操作 —— 禁不禁用由用户决定）', async () => {
      const a = await setupArchived()
      t.repo.archives.setStatus(a.archiveId, 'corrupt')
      const p = service.preview({ targetId, archiveId: a.archiveId })
      expect(p.warnings.join('；')).toContain('内容与清单不一致')
    })

    it('跨目标的归档直接报 E_PARAM', async () => {
      const other = t.repo.targets.create({
        environmentId: t.repo.targets.get(targetId)!.environmentId,
        name: 'x',
        kind: 'dir',
        remotePath: '/opt/x'
      })
      const row = t.repo.archives.create({
        targetId: other.id,
        versionTag: '20250612-143000_ccccccc',
        storagePath: '/opt/x.versions/20250612-143000_ccccccc',
        payloadPath: '/opt/x.versions/20250612-143000_ccccccc/payload',
        kind: 'dir',
        rootHash: 'x',
        totalBytes: 1,
        fileCount: 1,
        status: 'valid'
      })
      expect(() => service.preview({ targetId, archiveId: row.id })).toThrowError(AppError)
    })
  })
})
