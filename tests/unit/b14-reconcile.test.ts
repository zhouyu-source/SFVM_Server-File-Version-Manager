/**
 * T14.1 ~ T14.6 单测：对账与崩溃恢复。
 *
 * ## 这份测试要钉住的核心事实
 *
 * **远端是真相来源**。台账只是缓存 —— 所以对账的每一条断言都在问同一个问题：
 * "当两边不一致时，最后留下的那一份，是不是来自远端？"
 *
 * 特别是：
 * - 补录的 `archivedAt` 必须来自 manifest（用"现在"会让 MT-06 对不上）；
 * - **manifest 缺失 / originalPath 不匹配的目录一律不补录**（补进去就是一条
 *   既不能校验、也不能回滚的记录）；
 * - 台账与 manifest 不一致时**以 manifest 为准**（`updated`）。
 *
 * 内存远端与夹具来自 `tests/helpers/fake-remote.ts`（与发布/回滚单测同一套）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createArchiveService } from '@main/services/archive'
import { createReconcileService } from '@main/services/reconcile'
import { AppError, ErrorCode } from '@main/infra/errors'
import { buildLockPayload, lockPathOf } from '@main/infra/deploy-plan'
import { MANIFEST_FILE_NAME, PAYLOAD_DIR_NAME } from '@main/infra/manifest-io'
import { CLOCK, FakeRemote, makeLocalDir } from '../helpers/fake-remote'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

const REMOTE = '/opt/app/dist'
const ARCHIVE = `${REMOTE}.versions`

const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex')

describe('ReconcileService（B14 对账与恢复）', () => {
  let t: TestDb
  let fake: FakeRemote
  let reconcile: ReturnType<typeof createReconcileService>
  let targetId: string
  const tempDirs: string[] = []

  beforeEach(() => {
    t = makeTestDb()
    fake = new FakeRemote()
    const archive = createArchiveService({ repo: t.repo, now: () => CLOCK })
    reconcile = createReconcileService({ repo: t.repo, archive, now: () => CLOCK })

    const base = seedBasic(t.repo).target
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

  /** 在远端造一个"像归档服务写出来的"版本目录（payload + manifest）。 */
  function seedArchive(
    tag: string,
    content = 'v1',
    opts: { originalPath?: string; manifest?: boolean; payload?: boolean; archivedAt?: string } = {}
  ): void {
    const files = { 'dist/index.html': content }
    if (opts.payload !== false) {
      fake.putFile(`${ARCHIVE}/${tag}/${PAYLOAD_DIR_NAME}/dist/index.html`, content)
    }
    if (opts.manifest !== false) {
      fake.putFile(
        `${ARCHIVE}/${tag}/${MANIFEST_FILE_NAME}`,
        JSON.stringify({
          schemaVersion: 1,
          targetName: '前端产物',
          originalPath: opts.originalPath ?? REMOTE,
          kind: 'dir',
          versionTag: tag,
          archivedAt: opts.archivedAt ?? '2026-09-10T12:00:00+08:00',
          hashAlgo: 'sha256',
          rootHash: sha256(content),
          totalBytes: content.length,
          fileCount: 1,
          operator: null,
          note: null,
          sourceReleaseId: null,
          files: [
            {
              relPath: files['dist/index.html'] ? 'dist/index.html' : 'dist/index.html',
              hash: sha256(content),
              size: content.length,
              mtime: null
            }
          ]
        })
      )
    }
  }

  const run = (extra: Record<string, unknown> = {}) =>
    reconcile.reconcile({ targetId, ports: fake.rollbackPorts(), ...extra })

  /* ----------------------------------------------------------- 补录 */

  it('远端有、台账没有 → 按 manifest 补录，**归档时间也来自 manifest**', async () => {
    seedArchive('20260910-120000_0270da4', 'v1', { archivedAt: '2026-09-10T12:00:00+08:00' })
    expect(t.repo.archives.countByTarget(targetId)).toBe(0)

    const r = await run()
    expect(r.counts.adopted).toBe(1)
    expect(r.counts.ok).toBe(0)

    const rows = t.repo.archives.listByTarget(targetId, 10)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.versionTag).toBe('20260910-120000_0270da4')
    expect(row.storagePath).toBe(`${ARCHIVE}/20260910-120000_0270da4`)
    expect(row.payloadPath).toBe(`${ARCHIVE}/20260910-120000_0270da4/${PAYLOAD_DIR_NAME}`)
    expect(row.rootHash).toBe(sha256('v1'))
    expect(row.status).toBe('valid')
    /**
     * **最关键的一条**：时间来自 manifest，不是"现在"。
     * 用"现在"的话，MT-06（删库后重建）的时间对不上，往期版本列表的排序也会整体乱掉。
     */
    expect(row.archivedAt).toBe('2026-09-10T12:00:00+08:00')
    expect(r.adopted[0]).toMatchObject({ how: 'adopted' })
  })

  it('没有 manifest 的版本目录 → **不补录**，如实报告', async () => {
    seedArchive('20260910-120000_0270da4', 'v1', { manifest: false })
    const r = await run()

    expect(r.counts.adopted).toBe(0)
    expect(r.counts.withoutManifest).toBe(1)
    /**
     * 补录它只会得到一条既不能校验、也不能回滚的记录 ——
     * 没有清单就不知道这份内容是什么。
     */
    expect(t.repo.archives.countByTarget(targetId)).toBe(0)
    expect(r.items[0]!.status).toBe('no-manifest')
  })

  it('manifest 的 originalPath 不是这个目标 → **不补录**（不然回滚会把别人的内容搬过来）', async () => {
    seedArchive('20260910-120000_0270da4', 'v1', { originalPath: '/opt/other/dist' })
    const r = await run()
    expect(r.counts.adopted).toBe(0)
    expect(t.repo.archives.countByTarget(targetId)).toBe(0)
    expect(r.items[0]!.note).toContain('/opt/other/dist')
  })

  it('台账记录与 manifest 不一致 → **以 manifest 为准**修正（updated）', async () => {
    seedArchive('20260910-120000_0270da4', 'v1')
    t.repo.archives.create({
      targetId,
      versionTag: '20260910-120000_0270da4',
      storagePath: `${ARCHIVE}/20260910-120000_0270da4`,
      payloadPath: `${ARCHIVE}/20260910-120000_0270da4/${PAYLOAD_DIR_NAME}`,
      kind: 'dir',
      rootHash: 'bogus-hash',
      totalBytes: 999,
      fileCount: 42,
      status: 'valid'
    })

    const r = await run()
    const row = t.repo.archives.listByTarget(targetId, 10)[0]!
    expect(row.rootHash).toBe(sha256('v1'))
    expect(row.totalBytes).toBe('v1'.length)
    expect(row.fileCount).toBe(1)
    expect(r.adopted[0]).toMatchObject({ how: 'updated' })
  })

  it('关上补录开关 → 只诊断不修改（一个字节都不动台账）', async () => {
    seedArchive('20260910-120000_0270da4')
    const r = await run({ adopt: false })
    expect(t.repo.archives.countByTarget(targetId)).toBe(0)
    expect(r.counts.adopted).toBe(0)
    expect(r.items[0]!.note).toContain('未补录')
  })

  /* ------------------------------------------------------- 标记失效 */

  it('台账有、远端没有 → 标 missing；关上开关则只报告', async () => {
    t.repo.archives.create({
      targetId,
      versionTag: '20260901-120000_aaaaaaa',
      storagePath: `${ARCHIVE}/20260901-120000_aaaaaaa`,
      payloadPath: `${ARCHIVE}/20260901-120000_aaaaaaa/${PAYLOAD_DIR_NAME}`,
      kind: 'dir',
      rootHash: 'h',
      totalBytes: 1,
      fileCount: 1,
      status: 'valid'
    })

    const r = await run()
    expect(r.counts.markedMissing).toBe(1)
    expect(t.repo.archives.listByTarget(targetId, 10)[0]!.status).toBe('missing')

    // 重置后关掉开关再看一次
    t.repo.archives.setStatus(t.repo.archives.listByTarget(targetId, 10)[0]!.id, 'valid')
    const r2 = await run({ markMissing: false })
    expect(r2.counts.markedMissing).toBe(1)
    expect(t.repo.archives.listByTarget(targetId, 10)[0]!.status).toBe('valid')
  })

  it('版本目录在、但 payload 不存在 → 补录时直接标 missing（不是 valid）', async () => {
    seedArchive('20260910-120000_0270da4', 'v1', { payload: false })
    const r = await run()
    expect(r.counts.adopted).toBe(1)
    expect(t.repo.archives.listByTarget(targetId, 10)[0]!.status).toBe('missing')
    expect(r.items[0]!.note).toContain('归档内容目录不存在')
  })

  /* --------------------------------------------------------- 深度校验 */

  it('深度校验：内容被改过 → 标 corrupt（结构对账发现不了）', async () => {
    seedArchive('20260910-120000_0270da4', 'v1')
    // 先把台账建出来（轻量对账），再改坏内容
    await run()
    fake.putFile(`${ARCHIVE}/20260910-120000_0270da4/${PAYLOAD_DIR_NAME}/dist/index.html`, 'tampered')

    const light = await run()
    expect(light.counts.corrupt).toBe(0) // 结构对账发现不了 —— 这是刻意的

    const deep = await run({ deep: true })
    expect(deep.counts.corrupt).toBe(1)
    expect(t.repo.archives.listByTarget(targetId, 10)[0]!.status).toBe('corrupt')
  })

  /* --------------------------------------------------------- 报告细节 */

  it('归档目录下的东西认不出形态 → 列进 unrecognized，不动它', async () => {
    fake.putDir(`${ARCHIVE}/not-a-version`)
    fake.putFile(`${ARCHIVE}/readme.txt`, 'hi')
    const r = await run()
    expect(r.unrecognized.sort()).toEqual(['not-a-version', 'readme.txt'])
    expect(r.counts.adopted).toBe(0)
  })

  it('归档目录不存在不是错误（这个目标还没归档过）', async () => {
    const r = await run()
    expect(r.archiveDirExists).toBe(false)
    expect(r.counts.adopted).toBe(0)
    expect(r.items).toEqual([])
  })

  it('顺带报告远端锁与暂存残留', async () => {
    seedArchive('20260910-120000_0270da4')
    fake.putFile(
      lockPathOf(REMOTE),
      buildLockPayload({
        releaseId: 'rel-x',
        hostname: 'builder.local',
        pid: 1,
        now: new Date(CLOCK.getTime() - 40 * 60 * 1000)
      })
    )
    fake.putDir('/opt/app/.sfvm-staging-job-1')

    const r = await run()
    expect(r.lock?.releaseId).toBe('rel-x')
    expect(r.lock?.stale).toBe(true)
    expect(r.stagingResidue).toEqual(['/opt/app/.sfvm-staging-job-1'])
  })

  /* --------------------------------------------------- 启动扫描（纯本地） */

  describe('startupScan', () => {
    it('列出非终态记录，并带上目标与环境名', () => {
      t.repo.releases.create({
        id: 'rel-unfinished',
        targetId,
        action: 'deploy',
        versionTag: '20260910-120000_0270da4',
        status: 'SWAPPING',
        source: 'local',
        totalBytes: 1,
        fileCount: 1,
        currentStep: '换版'
      })
      t.repo.releases.create({
        id: 'rel-done',
        targetId,
        action: 'deploy',
        versionTag: '20260909-120000_bbbbbbb',
        status: 'SUCCESS',
        source: 'local',
        totalBytes: 1,
        fileCount: 1
      })

      const scan = reconcile.startupScan()
      expect(scan.unfinished).toHaveLength(1)
      expect(scan.unfinished[0]).toMatchObject({
        releaseId: 'rel-unfinished',
        status: 'SWAPPING',
        currentStep: '换版',
        targetName: '前端产物'
      })
    })

    it('没有未结束记录时返回空数组（而不是 null）', () => {
      expect(reconcile.startupScan().unfinished).toEqual([])
    })
  })

  /* --------------------------------------------------- 崩溃恢复（T14.5） */

  describe('diagnose / recover', () => {
    /** 造出"发布崩在换版之前"的现场：目标空、旧版本已归档。 */
    async function seedCrashed(): Promise<{ releaseId: string; archiveId: string; versionTag: string }> {
      // 先有内容 → 归档走 → 目标被搬空（模拟阶段 4 成功、阶段 5 还没跑）
      fake.putFile(`${REMOTE}/index.html`, 'live')
      const archive = createArchiveService({ repo: t.repo, now: () => CLOCK })
      const a = await archive.archiveVersion({
        targetId,
        ports: fake.archivePorts(),
        releaseId: 'rel-crashed',
        moveMode: 'rename'
      })
      t.repo.releases.create({
        id: 'rel-crashed',
        targetId,
        action: 'deploy',
        versionTag: '20260911-120000_ccccccc',
        status: 'SWAPPING',
        source: 'local',
        totalBytes: 1,
        fileCount: 1,
        archiveId: a.archive.id,
        currentStep: '换版'
      })
      return { releaseId: 'rel-crashed', archiveId: a.archive.id, versionTag: a.archive.versionTag }
    }

    it('目标为空 + 有归档 → 允许"恢复旧版本"', async () => {
      const c = await seedCrashed()
      const d = await reconcile.diagnose({
        targetId,
        releaseId: c.releaseId,
        ports: fake.rollbackPorts()
      })
      expect(d.target.exists).toBe(false)
      expect(d.archive?.versionTag).toBe(c.versionTag)
      expect(d.options.find((o) => o.mode === 'restore-old')?.enabled).toBe(true)
      expect(d.summary).toContain('为空')
    })

    it('目标上有内容 → **禁用**"恢复旧版本"，并把原因说清楚', async () => {
      const c = await seedCrashed()
      fake.putFile(`${REMOTE}/index.html`, 'something-else')
      const d = await reconcile.diagnose({
        targetId,
        releaseId: c.releaseId,
        ports: fake.rollbackPorts()
      })
      const opt = d.options.find((o) => o.mode === 'restore-old')!
      expect(opt.enabled).toBe(false)
      /**
       * 那套内容可能是这次操作换上去的半成品、也可能是别人放的 ——
       * 这种判断不该由工具替用户下。
       */
      expect(opt.reason).toContain('已有内容')
    })

    it('recover(restore-old)：把旧版本搬回目标，并把记录收尾（不再挡着下一次发布）', async () => {
      const c = await seedCrashed()
      const r = await reconcile.recover({
        targetId,
        releaseId: c.releaseId,
        mode: 'restore-old',
        cleanResidue: true,
        ports: fake.rollbackPorts()
      })

      expect(r.status).toBe('success')
      // 目标路径上恢复成了归档里的内容
      expect(fake.text(`${REMOTE}/index.html`)).toBe('live')
      // 台账收尾：这条记录不再是"未结束"
      expect(t.repo.releases.get(c.releaseId)!.status).toBe('FAILED')
      expect(reconcile.startupScan().unfinished).toEqual([])
    })

    it('recover(abandon)：不动目标路径，只清残留与收尾', async () => {
      const c = await seedCrashed()
      fake.putDir('/opt/app/.sfvm-staging-job-1')
      const r = await reconcile.recover({
        targetId,
        releaseId: c.releaseId,
        mode: 'abandon',
        cleanResidue: true,
        ports: fake.rollbackPorts()
      })

      expect(r.status).toBe('success')
      // 目标路径仍然不存在（没有"恢复"这个动作）
      expect(fake.has(REMOTE)).toBe(false)
      // 暂存清掉了
      expect(fake.has('/opt/app/.sfvm-staging-job-1')).toBe(false)
      expect(t.repo.releases.get(c.releaseId)!.status).toBe('FAILED')
    })

    it('recover(restore-old)：这次操作没有归档过 → 明确报错并给出替代方案', async () => {
      t.repo.releases.create({
        id: 'rel-no-archive',
        targetId,
        action: 'deploy',
        versionTag: '20260911-120000_ddddddd',
        status: 'UPLOADING',
        source: 'local',
        totalBytes: 1,
        fileCount: 1
      })
      await expect(
        reconcile.recover({
          targetId,
          releaseId: 'rel-no-archive',
          mode: 'restore-old',
          ports: fake.rollbackPorts()
        })
      ).rejects.toMatchObject({ code: ErrorCode.E_NOT_FOUND })
    })

    it('只清"锁里写的正是这次操作"的那把锁（别的锁可能属于另一台机器）', async () => {
      const c = await seedCrashed()
      fake.putFile(
        lockPathOf(REMOTE),
        buildLockPayload({
          releaseId: 'someone-else',
          hostname: 'other-host',
          pid: 9,
          now: new Date(CLOCK.getTime())
        })
      )
      const r = await reconcile.recover({
        targetId,
        releaseId: c.releaseId,
        mode: 'abandon',
        cleanResidue: true,
        ports: fake.rollbackPorts()
      })
      expect(fake.has(lockPathOf(REMOTE))).toBe(true)
      expect(r.actions.some((a) => (a.detail ?? '').includes('保留未动'))).toBe(true)
    })
  })

  /* -------------------------------------------------------- 远端锁（T14.6） */

  describe('远端锁', () => {
    it('读：给出是谁的锁、什么时候的、是否陈旧', async () => {
      fake.putFile(
        lockPathOf(REMOTE),
        buildLockPayload({
          releaseId: 'rel-lock',
          hostname: 'builder.local',
          pid: 77,
          now: new Date(CLOCK.getTime() - 5 * 60 * 1000)
        })
      )
      const v = await reconcile.readLock({ targetId }, fake.rollbackPorts())
      expect(v.exists).toBe(true)
      expect(v).toMatchObject({ releaseId: 'rel-lock', hostname: 'builder.local', pid: 77, stale: false })
    })

    it('没有锁时 exists=false（而不是报错）', async () => {
      const v = await reconcile.readLock({ targetId }, fake.rollbackPorts())
      expect(v.exists).toBe(false)
      expect(v.path).toBe(lockPathOf(REMOTE))
    })

    it('删：写一条审计，之后锁就没了', async () => {
      fake.putFile(
        lockPathOf(REMOTE),
        buildLockPayload({
          releaseId: 'rel-lock',
          hostname: 'builder.local',
          pid: 77,
          now: new Date(CLOCK.getTime())
        })
      )
      const r = await reconcile.removeLock(
        { targetId, confirmed: true },
        fake.rollbackPorts()
      )
      expect(r.removed).toBe(true)
      expect(fake.has(lockPathOf(REMOTE))).toBe(false)
    })

    it('契约要求 confirmed:true —— 不确认就调不动这个入口', async () => {
      const { removeRemoteLockInputSchema } = await import('@shared/contracts/reconcile')
      expect(removeRemoteLockInputSchema.safeParse({ targetId }).success).toBe(false)
      expect(
        removeRemoteLockInputSchema.safeParse({ targetId, confirmed: false }).success
      ).toBe(false)
      expect(removeRemoteLockInputSchema.safeParse({ targetId, confirmed: true }).success).toBe(true)
    })

    it('目标不存在时抛 E_NOT_FOUND（不静默成功）', async () => {
      await expect(reconcile.readLock({ targetId: 'nope' }, fake.rollbackPorts())).rejects.toBeInstanceOf(
        AppError
      )
    })
  })
})
