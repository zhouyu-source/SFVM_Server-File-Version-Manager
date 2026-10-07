/**
 * T10.1 ~ T10.12 单测：发布主流程的七阶段、失败补偿、并发控制。
 *
 * 内存远端与夹具在 `tests/helpers/fake-remote.ts`（B13 的回滚测试共用同一套 ——
 * 两边用同一份替身跑，才不会漏掉"发布做得到、回滚做不到"的不对称 bug）。
 *
 * 关键断言都围绕"目标路径为空的窗口"：阶段 4 会把目标清空、阶段 5 才就位，
 * 所以每个失败用例都必须回答"此刻失败，用户还剩什么" —— 见各用例名与断言。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDeployService } from '@main/services/deploy'
import { createArchiveService } from '@main/services/archive'
import { createRollbackService } from '@main/services/rollback'
import { hashLocalArtifact } from '@main/services/hash'
import { ErrorCode } from '@main/infra/errors'
import { lockPathOf, stagingPayloadOf, stagingRootOf, swapSourceOf } from '@main/infra/deploy-plan'
import { LOCK_STALE_MS } from '@shared/contracts/deploy'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'
import {
  CLOCK,
  FakeRemote,
  deferred,
  makeCtx,
  makeLocalDir,
  makeLocalFile,
  sha256
} from '../helpers/fake-remote'


describe('DeployService（B10 发布主流程）', () => {
  let t: TestDb
  let fake: FakeRemote
  let archive: ReturnType<typeof createArchiveService>
  let service: ReturnType<typeof createDeployService>
  let targetId: string
  let localDir: string
  let clock: Date
  const tempDirs: string[] = []

  /** 目录型目标：`/opt/app/dist`，本地产物在临时目录 */
  function seedDirTarget(files: Record<string, string> = { 'index.html': 'v1' }): string {
    localDir = makeLocalDir(files)
    tempDirs.push(localDir)
    const id = t.repo.targets.create({
      environmentId: t.repo.targets.get(targetId)!.environmentId,
      name: '前端产物',
      kind: 'dir',
      remotePath: '/opt/app/dist',
      localPath: localDir
    }).id
    return id
  }

  /**
   * 文件型目标：`/opt/svc/order.jar`。
   *
   * 直接复用 `seedBasic` 建好的那条目标（改本地路径即可）—— 同一环境里
   * `(environmentId, remotePath)` 有唯一约束，再造一条同路径的目标会撞库。
   */
  function seedFileTarget(content = 'jar-1'): { id: string; localPath: string } {
    const p = makeLocalFile('order.jar', content)
    tempDirs.push(dirname(p))
    t.repo.targets.update(targetId, { kind: 'file', localPath: p })
    return { id: targetId, localPath: p }
  }

  beforeEach(() => {
    t = makeTestDb()
    fake = new FakeRemote()
    clock = CLOCK
    archive = createArchiveService({ repo: t.repo, now: () => clock })
    service = createDeployService({
      repo: t.repo,
      archive,
      now: () => clock,
      newReleaseId: (() => {
        let n = 0
        return () => `rel-${++n}`
      })(),
      transferRetryDelay: () => 1
    })
    targetId = seedBasic(t.repo).target.id
  })

  afterEach(() => {
    t.cleanup()
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /* ============================================================ 正常路径 */

  it('目录型目标：七阶段跑通，目标换成新内容、旧版本进归档、暂存与锁都清干净', async () => {
    const id = seedDirTarget({ 'index.html': 'v2', 'assets/a.js': 'aa' })
    // 现网是 v1
    fake.putFile('/opt/app/dist/index.html', 'v1')

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx })

    expect(out.ok).toBe(true)
    expect(out.status).toBe('SUCCESS')
    expect(out.fileCount).toBe(2)

    // 1) 目标路径上是新版本
    expect(fake.text('/opt/app/dist/index.html')).toBe('v2')
    expect(fake.text('/opt/app/dist/assets/a.js')).toBe('aa')
    // 2) 旧版本进了归档目录。
    //    版本号里带的是**被归档那份内容**的指纹前 7 位（现网是 v1、这次发的是 v2，
    //    两者内容不同 ⇒ 号也不同）。这就是"版本号即内容标识"的含义。
    const archived = t.repo.archives.listByTarget(id)
    expect(archived).toHaveLength(1)
    expect(out.archivedVersionTag).toBe(archived[0].versionTag)
    expect(archived[0].versionTag).not.toBe(out.versionTag)
    expect(archived[0].versionTag.endsWith(archived[0].rootHash.slice(0, 7))).toBe(true)
    expect(fake.text(`${archived[0].payloadPath}/dist/index.html`)).toBe('v1')
    // 3) 暂存与锁都不留
    expect(fake.has(stagingRootOf('/opt/app/dist', out.releaseId))).toBe(false)
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(false)
    // 4) 台账
    const rel = t.repo.releases.listByTarget(id, 5)[0]
    expect(rel).toMatchObject({ status: 'SUCCESS', action: 'deploy', source: 'local' })
    expect(t.repo.releaseItems.listByRelease(out.releaseId)).toHaveLength(2)

    // 5) 阶段顺序：七阶段的状态迁移都应出现在日志里
    expect(text()).toContain('开始发布')
    expect(text()).toContain('发布成功')
    expect(out.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('文件型目标：本地路径只拼一次（回归：曾拼成 <file>/<file>），整条流程成功', async () => {
    const f = seedFileTarget('jar-2')
    fake.putFile('/opt/svc/order.jar', 'jar-1')

    const { ctx } = makeCtx()
    const out = await service.run({ targetId: f.id, ports: fake.ports(), ctx })

    expect(out.ok).toBe(true)
    expect(fake.text('/opt/svc/order.jar')).toBe('jar-2')
    // 暂存里的路径是 payload/order.jar —— 换版就是把这一个文件 rename 过去
    expect(stagingPayloadOf('/opt/svc/order.jar', out.releaseId)).toBe(
      `/opt/svc/.sfvm-staging-${out.releaseId}/payload`
    )
    expect(swapSourceOf('/opt/svc/order.jar', out.releaseId, 'file')).toBe(
      `/opt/svc/.sfvm-staging-${out.releaseId}/payload/order.jar`
    )
    // 旧版本归档为 order.jar.versions/<tag>/payload/order.jar
    const archived = t.repo.archives.listByTarget(f.id)
    expect(archived).toHaveLength(1)
    expect(fake.text(`${archived[0].payloadPath}/order.jar`)).toBe('jar-1')
  })

  it('首次发布（目标路径还不存在）：跳过归档直接换版，不让阶段 4 白炸一次', async () => {
    // 回归：阶段 0 对"远端目标不存在"给的是 warn（"将作为首次发布创建"），
    // 但阶段 4 曾无条件调用 archiveVersion —— 它对不存在的路径必然抛错，
    // 于是"precheck 放行、阶段 4 必失败"自相矛盾。
    const id = seedDirTarget({ 'index.html': 'v1', 'assets/a.js': 'aa' })

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx })

    expect(out.ok).toBe(true)
    // 没有"当前版本"，就不该有归档记录，也不该凭空报一个往期版本号
    expect(t.repo.archives.countByTarget(id)).toBe(0)
    expect(out.archivedVersionTag).toBeUndefined()
    expect(text()).toContain('首次发布')
    // 目标路径由换版那一步 rename 出来
    expect(fake.text('/opt/app/dist/index.html')).toBe('v1')
    expect(fake.text('/opt/app/dist/assets/a.js')).toBe('aa')
    // 暂存与锁照旧清干净
    expect(fake.has(stagingRootOf('/opt/app/dist', out.releaseId))).toBe(false)
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(false)
  })

  it('首次发布（文件型）：远端 jar 还不存在时同样能发上去', async () => {
    const f = seedFileTarget('jar-1')

    const { ctx } = makeCtx()
    const out = await service.run({ targetId: f.id, ports: fake.ports(), ctx })

    expect(out.ok).toBe(true)
    expect(fake.text('/opt/svc/order.jar')).toBe('jar-1')
    expect(t.repo.archives.countByTarget(f.id)).toBe(0)
  })

  it('id 三处一致：调用方给的 releaseId == 台账行 id == 远端暂存目录后缀', async () => {
    // 回归：`repo.releases.create` 曾经无条件自造 id，把调用方传的丢掉 ——
    // 于是"任务 id == 台账 id == `.sfvm-staging-<id>`"这条链路断在中间：
    // `out.releaseId` 与服务器上的暂存目录对不上，B14 按记录找残留就找不到。
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'v1')
    // 让收尾清理失败，好让暂存目录留在远端 —— 直接看它的名字
    fake.rmrfFailures.add('/opt/app/.sfvm-staging-job-42')

    const { ctx, text } = makeCtx()
    const out = await service.run({
      targetId: id,
      ports: fake.ports(),
      ctx,
      releaseId: 'job-42'
    })

    expect(out.ok, '收尾清理失败不该把成功的发布改成失败').toBe(true)
    expect(out.releaseId).toBe('job-42')
    expect(t.repo.releases.get('job-42')!.id).toBe('job-42')
    // 暂存目录用的就是这个 id（名字对得上才算三处一致）
    expect(fake.has('/opt/app/.sfvm-staging-job-42')).toBe(true)
    // 归档记录也记着同一个 releaseId（它由台账行 id 而来）
    expect(t.repo.archives.listByTarget(id)[0]!.releaseId).toBe('job-42')
    expect(text()).toContain('releaseId=job-42')
  })

  it('第二次发布时复用上一版清单：归档不重算现网哈希（几百 MB 产物不重算的关键）', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'v1')

    const first = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })
    expect(first.ok).toBe(true)

    // 第二次发布：本地内容换一版
    writeFileSync(join(localDir, 'index.html'), 'v3')
    fake.hashReadPaths = []
    const { ctx, text } = makeCtx()
    const second = await service.run({ targetId: id, ports: fake.ports(), ctx })

    expect(second.ok).toBe(true)
    expect(fake.text('/opt/app/dist/index.html')).toBe('v3')

    // 关键断言：归档**没有**为了算"旧版本的指纹"去读现网内容。
    // （阶段 3 的校验会读暂存目录 —— 那是必须的，所以按路径过滤而不是数次数）
    expect(fake.hashReadPaths.filter((p) => p.startsWith('/opt/app/dist/'))).toEqual([])
    expect(text()).not.toContain('指纹由远端现场计算')
    // 而且归档出来的版本号与第一次发布时的版本号一致（preferredTag 生效）
    const tags = t.repo.archives.listByTarget(id).map((a) => a.versionTag)
    expect(tags).toContain(first.versionTag)
  })

  /* ================================================ 回滚之后紧跟的发布 */

  /**
   * 造出"回滚到旧版"的真实局面：
   *
   * 现网 v1 → 按发布阶段 4 同样的方式归档进版本库（manifest 是真的，校验校验得了）
   * → 现网被换成 v2 并补一条成功台账 → **真跑一次回滚**（写清单、归档前置版本、
   * 标 ROLLED_BACK，一样不缺）。之后现网是 v1，版本库里躺着 v1（来源）与 v2
   * （回滚前置归档）—— 正是用户报"往期版本出现两份一样"的那条路径的起点。
   */
  async function setupRolledBack(keepSource: boolean): Promise<{
    targetId: string
    sourceArchiveId: string
  }> {
    const id = seedDirTarget({ 'index.html': 'v3' })
    fake.putFile('/opt/app/dist/index.html', 'v1')
    const a1 = await archive.archiveVersion({
      targetId: id,
      ports: fake.archivePorts(),
      releaseId: 'rel-seed',
      moveMode: 'rename'
    })
    fake.putFile('/opt/app/dist/index.html', 'v2')
    t.repo.releases.create({
      id: 'rel-v2',
      targetId: id,
      action: 'deploy',
      versionTag: '20250612-143100_aaaaaaa',
      status: 'SUCCESS',
      source: 'local',
      rootHash: 'r2',
      totalBytes: 2,
      fileCount: 1
    })
    t.repo.releases.finish('rel-v2', 'SUCCESS')

    const rollback = createRollbackService({ repo: t.repo, archive, now: () => clock })
    const rb = await rollback.run({
      targetId: id,
      archiveId: a1.archive.id,
      ports: fake.rollbackPorts(),
      ctx: makeCtx().ctx,
      rollbackId: 'rb-1',
      keepSource
    })
    expect(rb.ok).toBe(true)
    // 现网回到了 v1 —— 用户接下来要发新版时的起点
    expect(fake.text('/opt/app/dist/index.html')).toBe('v1')
    return { targetId: id, sourceArchiveId: a1.archive.id }
  }

  it('回滚到旧版之后再发布：内容与版本库里那份一致，不再重复归档', async () => {
    const { targetId: tid, sourceArchiveId } = await setupRolledBack(true)
    const before = t.repo.archives.listByTarget(tid).map((a) => a.id).sort()
    expect(before).toHaveLength(2)

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: tid, ports: fake.ports(), ctx })
    expect(out.ok).toBe(true)
    expect(fake.text('/opt/app/dist/index.html')).toBe('v3')

    // 关键断言：没有多出第三份归档 —— 与来源归档内容一致的那份被摘掉了
    const after = t.repo.archives.listByTarget(tid)
    expect(after.map((a) => a.id).sort()).toEqual(before)
    // 留下来的是来源那份，v1 内容仍在版本库里
    const kept = t.repo.archives.get(sourceArchiveId)!
    expect(fake.text(`${kept.payloadPath}/dist/index.html`)).toBe('v1')
    expect(text()).toContain('已去掉重复归档')
    // 给 UI 的"本次归档版本"是**保留下来的**那份，不是刚被摘掉的那个号
    expect(out.archivedVersionTag).toBe(kept.versionTag)

    // 回滚标记随这次发布整体退场（B19 标记的生命周期）
    for (const row of archive.list(tid)) {
      expect(row.rollback).toBeNull()
      expect(row.supersededByRollbackAt).toBeNull()
    }
  })

  it('回滚时选了不保留来源：现网那份在版本库里没有副本，发布时照常归档', async () => {
    const { targetId: tid, sourceArchiveId } = await setupRolledBack(false)
    // 来源归档已被回滚摘除（目录 + 台账行）
    expect(t.repo.archives.get(sourceArchiveId)).toBeUndefined()
    const before = t.repo.archives.listByTarget(tid).length

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: tid, ports: fake.ports(), ctx })
    expect(out.ok).toBe(true)

    // 这份归档是现网 v1 的**唯一**副本，必须保留 —— 不去重
    const after = t.repo.archives.listByTarget(tid)
    expect(after.length).toBe(before + 1)
    expect(text()).toContain('唯一副本')
    expect(fake.text(`${after[0]!.payloadPath}/dist/index.html`)).toBe('v1')
  })

  it('回滚之后手工改过现网（同字节数的改动）：指纹对不上，不去重、把改动完整归档保留', async () => {
    const { targetId: tid } = await setupRolledBack(true)
    // 'v1' → 'v9'：字节数没变，"路径 + 大小"核对发现不了 —— 这正是"回滚恢复后
    // 这次归档要现算指纹"的原因。指纹对不上就不许当作重复删掉。
    fake.putFile('/opt/app/dist/index.html', 'v9')
    const before = t.repo.archives.listByTarget(tid).map((a) => a.id).sort()

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: tid, ports: fake.ports(), ctx })
    expect(out.ok).toBe(true)

    const after = t.repo.archives.listByTarget(tid)
    expect(after.length).toBe(3)
    expect(text()).toContain('不一致')
    expect(text()).toContain('照常保留这次归档')
    const newArchived = after.find((a) => !before.includes(a.id))!
    // 手改的内容完整进了版本库，而不是被当作重复删掉
    expect(fake.text(`${newArchived.payloadPath}/dist/index.html`)).toBe('v9')
    expect(out.archivedVersionTag).toBe(newArchived.versionTag)
  })

  /* ==================================================== 阶段 0：前置校验 */

  it('阶段 0 失败：本地产物不存在 → 远端零改动（无锁、无暂存、目标未动）', async () => {
    const id = seedDirTarget({ 'index.html': 'v1' })
    rmSync(localDir, { recursive: true, force: true })
    fake.putFile('/opt/app/dist/index.html', 'live')

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx })

    expect(out.ok).toBe(false)
    expect(out.failure?.stage).toBe(0)
    expect(out.failure?.code).toBe(ErrorCode.E_LOCAL_PATH_MISSING)
    expect(out.failure?.compensations.some((c) => /未做任何改动/.test(c.detail ?? ''))).toBe(true)
    expect(fake.text('/opt/app/dist/index.html')).toBe('live')
    // `ls` 是递归列出的：父目录里只有目标本身及其内容，没有任何暂存/锁/归档残留
    expect(fake.ls('/opt/app')).toEqual(['dist/', 'dist/index.html'])
    expect(text()).toContain('发布失败')
  })

  it('阶段 0 失败：父目录不可写 → E_PARENT_NOT_WRITABLE，不碰服务器', async () => {
    const id = seedDirTarget()
    fake.parentWritable = false

    const out = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })

    expect(out.ok).toBe(false)
    expect(out.failure?.code).toBe(ErrorCode.E_PARENT_NOT_WRITABLE)
    expect(fake.ls('/opt/app')).toEqual([])
  })

  it('阶段 0：发现上次中断留下的暂存目录 → 默认拒绝；确认后只清"能证明来源"的那部分', async () => {
    const id = seedDirTarget()
    fake.putFile('/opt/app/dist/index.html', 'live')
    fake.putFile('/opt/app/.sfvm-staging-old1/payload/x', 'half')
    fake.putFile('/opt/app/handmade.part', 'other-tool')

    const denied = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })
    expect(denied.ok).toBe(false)
    expect(denied.failure?.code).toBe(ErrorCode.E_REMOTE_RESIDUE)
    // 拒绝了也不许动现场
    expect(fake.has('/opt/app/.sfvm-staging-old1')).toBe(true)
    expect(fake.has('/opt/app/handmade.part')).toBe(true)

    const allowed = await service.run({
      targetId: id,
      ports: fake.ports(),
      ctx: makeCtx().ctx,
      confirmCleanResidue: true
    })
    expect(allowed.ok).toBe(true)
    // 自己留下的暂存被清掉
    expect(fake.has('/opt/app/.sfvm-staging-old1')).toBe(false)
    // 别人的 `.part` **不**自动删（出现它更可能是别人/别的进程留下的）
    expect(fake.has('/opt/app/handmade.part')).toBe(true)
  })

  it('阶段 0：远端锁被占用 → E_TARGET_BUSY；陈旧锁 → E_LOCK_STALE，确认后才清', async () => {
    const id = seedDirTarget()
    fake.putFile('/opt/app/dist/index.html', 'live')
    const lockPath = lockPathOf('/opt/app/dist')

    // 新鲜锁：别人的发布正在进行
    fake.putFile(
      lockPath,
      JSON.stringify({
        releaseId: 'other',
        hostname: 'other-host',
        pid: 42,
        ts: new Date(clock.getTime() - 1000).toISOString()
      })
    )
    const busy = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })
    expect(busy.failure?.code).toBe(ErrorCode.E_TARGET_BUSY)
    expect(fake.has(lockPath)).toBe(true)

    // 陈旧锁（超过 30 分钟）：给出可操作的提示，但不自动删
    fake.putFile(
      lockPath,
      JSON.stringify({
        releaseId: 'dead',
        hostname: 'dead-host',
        pid: 7,
        ts: new Date(clock.getTime() - LOCK_STALE_MS - 60_000).toISOString()
      })
    )
    const stale = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })
    expect(stale.failure?.code).toBe(ErrorCode.E_LOCK_STALE)
    expect(fake.has(lockPath)).toBe(true)

    // 用户确认清理陈旧锁 → 发布继续
    const ok = await service.run({
      targetId: id,
      ports: fake.ports(),
      ctx: makeCtx().ctx,
      cleanStaleLock: true
    })
    expect(ok.ok).toBe(true)
    expect(fake.has(lockPath)).toBe(false)
  })

  /* ==================================================== 阶段 2：上传暂存 */

  it('阶段 2 失败：磁盘余量不足（产物 × 2.2）→ 失败且远端零改动', async () => {
    const id = seedDirTarget({ 'index.html': 'x'.repeat(1000) })
    fake.putFile('/opt/app/dist/index.html', 'live')
    fake.dfAvailableBytes = 100 // 远小于 1000 × 2.2

    const out = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })

    expect(out.ok).toBe(false)
    expect(out.failure?.code).toBe(ErrorCode.E_DISK_SPACE)
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(false)
    // `ls` 是递归列出的：父目录里只有目标本身及其内容，没有任何暂存/锁/归档残留
    expect(fake.ls('/opt/app')).toEqual(['dist/', 'dist/index.html'])
    expect(fake.text('/opt/app/dist/index.html')).toBe('live')
  })

  it('阶段 2 失败：上传中断 → 暂存清干净、锁已释放、目标一个字都没动', async () => {
    const id = seedDirTarget({ 'index.html': 'v2', 'assets/a.js': 'aa' })
    fake.putFile('/opt/app/dist/index.html', 'live')
    const releaseId = 'rel-fixed'
    fake.putFailures.add(`/opt/app/.sfvm-staging-${releaseId}/payload/index.html`)

    const out = await service.run({
      targetId: id,
      ports: fake.ports(),
      ctx: makeCtx().ctx,
      releaseId
    })

    expect(out.ok).toBe(false)
    expect(out.failure?.stage).toBe(2)
    expect(out.failure?.code).toBe(ErrorCode.E_UPLOAD_INTERRUPTED)
    expect(fake.has(stagingRootOf('/opt/app/dist', releaseId))).toBe(false)
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(false)
    expect(fake.text('/opt/app/dist/index.html')).toBe('live')
    // `ls` 是递归列出的：父目录里只有目标本身及其内容，没有任何暂存/锁/归档残留
    expect(fake.ls('/opt/app')).toEqual(['dist/', 'dist/index.html'])
    expect(out.failure?.compensations.some((c) => /清理暂存目录/.test(c.action))).toBe(true)
  })

  /* ==================================================== 阶段 3：远端校验 */

  it('阶段 3 失败：暂存里一个文件被改坏 → 报出具体路径，目标未动、暂存已清', async () => {
    const id = seedDirTarget({ 'index.html': 'v2', 'assets/a.js': 'aa' })
    fake.putFile('/opt/app/dist/index.html', 'live')
    const releaseId = 'rel-verify'

    // 上传完成后把暂存里的一个文件改掉：模拟"传到服务器上坏了"
    const payload = stagingPayloadOf('/opt/app/dist', releaseId)
    fake.afterPut = (remotePath) => {
      if (remotePath === `${payload}/assets/a.js`) fake.putFile(remotePath, 'corrupted')
    }

    const { ctx } = makeCtx()
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx, releaseId })

    expect(out.ok).toBe(false)
    expect(out.failure?.stage).toBe(3)
    expect(out.failure?.code).toBe(ErrorCode.E_VERIFY_MISMATCH)
    // 差异明细要能定位到具体文件
    const detail = JSON.stringify(out.failure) + (out.failure?.message ?? '')
    expect(detail).toContain('哈希不符 1 个')
    expect(fake.has(stagingRootOf('/opt/app/dist', releaseId))).toBe(false)
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(false)
    expect(fake.text('/opt/app/dist/index.html')).toBe('live')
  })

  it('目标关闭了发布后校验时：跳过校验但照常发布成功', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'v1')
    t.repo.targets.update(id, { verifyRemote: false })

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx })

    expect(out.ok).toBe(true)
    expect(text()).toContain('关闭了发布后远端校验')
    expect(fake.text('/opt/app/dist/index.html')).toBe('v2')
  })

  /* ==================================================== 阶段 4：归档旧版 */

  it('阶段 4 失败：归档建不出目录 → 流程终止，现网版本原封不动', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'live')
    fake.mkdirpFailures.add('/opt/app/dist.versions')

    const out = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })

    expect(out.ok).toBe(false)
    expect(out.failure?.stage).toBe(4)
    // 具体错误码取决于归档内部的哪一步先炸（建目录 / 搬迁 / 写 manifest），
    // 这里要断言的是"流程在阶段 4 终止"，而不是某一个具体码
    expect(out.failure?.code).toBeTruthy()
    // 关键：归档失败绝不允许继续换版 —— 现网必须还是旧的
    expect(fake.text('/opt/app/dist/index.html')).toBe('live')
    expect(t.repo.archives.listByTarget(id)).toHaveLength(0)
    expect(fake.has(stagingRootOf('/opt/app/dist', out.releaseId))).toBe(false)
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(false)
  })

  it('阶段 4 失败：归档 rename 失败 → 目标未被改动，也不允许跳过归档继续', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'live')
    fake.renamePrefixFailures.set('/opt/app/dist.versions', {
      err: new Error('Stale file handle'),
      remaining: 1
    })

    const out = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })

    expect(out.ok).toBe(false)
    expect(out.failure?.code).toBe(ErrorCode.E_ARCHIVE_FAILED)
    expect(fake.text('/opt/app/dist/index.html')).toBe('live')
    const rel = t.repo.releases.listByTarget(id, 5)[0]
    expect(rel.status).toBe('FAILED')
    expect(rel.errorMessage).toContain('E_ARCHIVE_FAILED')
  })

  /* ============================== 阶段 5：换版（全流程最关键的一处补偿） */

  it('阶段 5 失败：rename 报权限错误 → 旧版本被搬回目标路径，归档记录撤销', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'live')
    // 只让"换版那一次" rename 失败；之后的补偿 rename（归档复位）必须能成功
    fake.renameFailures.set('/opt/app/dist', {
      err: Object.assign(new Error('Permission denied'), { code: 3 }),
      remaining: 1
    })

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx })

    expect(out.ok).toBe(false)
    expect(out.failure?.stage).toBe(5)
    expect(out.failure?.code).toBe(ErrorCode.E_SWAP_FAILED)
    // **最重要的一条**：目标路径此刻本该是空的，补偿必须把旧版本搬回来
    expect(fake.text('/opt/app/dist/index.html')).toBe('live')
    expect(out.failure?.compensations.some((c) => /归档复位/.test(c.action) && c.ok)).toBe(true)
    // 归档记录被撤销（内容已经搬回目标，再留一条"往期版本"就是重复记账）
    expect(t.repo.archives.listByTarget(id)).toHaveLength(0)
    // 归档目录下不留半截的版本目录（`dist.versions/` 这个空壳本身是往期版本库的正常结构）
    expect(fake.ls('/opt/app/dist.versions')).toEqual([])
    // 暂存与锁都没留下
    expect(fake.ls('/opt/app').filter((x) => x.startsWith('.sfvm-staging-'))).toEqual([])
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(false)
    expect(text()).toContain('复位到目标路径')
  })

  it('阶段 5 失败（复制中断）→ 先清掉半个新版本，再把旧版本搬回目标路径', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'live')
    // 目标自己是挂载点 → 归档与换版都只能走复制（rename 必然 EXDEV）
    fake.dfOverride.set('/opt/app/dist', { filesystem: '/dev/vdb1', mountPoint: '/opt/app/dist' })
    // 只让"换版那一次"的复制失败；补偿里的复制必须能成功
    fake.copyFileFailures.set('/opt/app/dist/index.html', {
      err: new Error('模拟复制中断'),
      remaining: 1
    })

    const { ctx } = makeCtx()
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx })

    expect(out.ok).toBe(false)
    expect(out.failure?.stage).toBe(5)
    /**
     * **最重要的一条**：复制失败会在目标路径上留下"半个新版本"，
     * 而 `undoArchive` 明确拒绝往已有内容的路径上搬东西。
     * 所以补偿必须先清掉那半个副本，再复位 —— 顺序反过来就是死局。
     */
    expect(fake.text('/opt/app/dist/index.html')).toBe('live')
    const actions = out.failure?.compensations ?? []
    expect(actions.some((c) => /清理换版残留/.test(c.action) && c.ok)).toBe(true)
    expect(actions.some((c) => /归档复位/.test(c.action) && c.ok)).toBe(true)
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(false)
  })

  it('阶段 5：rename 报 EXDEV → 自动回退复制模式并发布成功，事后告知原因', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'live')
    fake.renameFailures.set('/opt/app/dist', {
      err: Object.assign(new Error('EXDEV: invalid cross-device link'), { code: 18 }),
      remaining: 1
    })

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx })

    expect(out.ok).toBe(true)
    expect(out.strategy).toBe('rename')
    expect(out.strategyFallback).toMatchObject({ from: 'rename', to: 'copy' })
    expect(out.strategyFallback?.reason).toContain('EXDEV')
    expect(fake.text('/opt/app/dist/index.html')).toBe('v2')
    expect(text()).toContain('换版改用 copy')
  })

  it('阶段 5：目标本身是挂载点 → 连 rename 都不尝试，直接用复制模式', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'v1')
    fake.dfOverride.set('/opt/app/dist', {
      filesystem: '/dev/sdb1',
      mountPoint: '/opt/app/dist'
    })

    const out = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })

    expect(out.ok).toBe(true)
    // 挂载点场景下归档也必须走 copy（归档目录在父目录，跨设备）
    expect(out.strategyFallback?.to).toBe('copy')
    expect(out.strategyFallback?.reason).toContain('挂载点')
    expect(fake.text('/opt/app/dist/index.html')).toBe('v2')
    // 没有任何一次 rename 落在目标路径上（renameLog 里只有归档/协作用的搬动）
    expect(fake.renameLog.some((r) => r.to === '/opt/app/dist')).toBe(false)
    const archived = t.repo.archives.listByTarget(id)
    expect(archived).toHaveLength(1)
    expect(fake.text(`${archived[0].payloadPath}/dist/index.html`)).toBe('v1')
  })

  it('阶段 5：目标配置成 copy 策略 → 全程复制，且不算"回退"（没有 fallback 记录）', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'v1')
    t.repo.targets.update(id, { deployStrategy: 'copy' })

    const out = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })

    expect(out.ok).toBe(true)
    expect(out.strategy).toBe('copy')
    expect(out.strategyFallback).toBeUndefined()
    expect(fake.text('/opt/app/dist/index.html')).toBe('v2')
  })

  /* ============================== 阶段 6：收尾（不允许把成功改失败） */

  it('阶段 6：清暂存失败 → 仍然报成功，但明确提示要人工清理', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'v1')
    const releaseId = 'rel-cleanfail'
    fake.rmrfFailures.add(stagingRootOf('/opt/app/dist', releaseId))

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx, releaseId })

    expect(out.ok).toBe(true)
    expect(fake.text('/opt/app/dist/index.html')).toBe('v2')
    expect(text()).toContain('未能删除')
    // 锁还是要放掉的
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(false)
  })

  it('权限/属主对齐：用阶段 0 记录的 mode 恢复到目标自身（不递归）', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'v1')

    const out = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })

    expect(out.ok).toBe(true)
    expect(out.alignment?.map((a) => a.action).sort()).toEqual(['chmod', 'chown'])
    expect(out.alignment?.every((a) => a.ok)).toBe(true)
    // 目标目录原本是 0755 → 恢复成 755；且只对目标路径自身发命令，没有 -R
    expect(fake.execLog.some((c) => c === "chmod 755 '/opt/app/dist'")).toBe(true)
    expect(fake.execLog.some((c) => c === "chown 0:0 '/opt/app/dist'")).toBe(true)
    expect(fake.execLog.some((c) => c.includes(' -R'))).toBe(false)
  })

  it('权限/属主对齐：显式关闭时一条命令都不发', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'v1')
    fake.execLog = []

    const out = await service.run({
      targetId: id,
      ports: fake.ports(),
      ctx: makeCtx().ctx,
      alignOwnership: false
    })

    expect(out.ok).toBe(true)
    expect(out.alignment).toEqual([])
    expect(fake.execLog.some((c) => c.startsWith('chmod ') || c.startsWith('chown '))).toBe(false)
  })

  it('权限/属主对齐：chmod 失败只告警，不把成功的发布改判为失败', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'v1')
    fake.chmodExitCode = 1

    const { ctx, text } = makeCtx()
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx })

    expect(out.ok).toBe(true)
    expect(out.alignment?.find((a) => a.action === 'chmod')?.ok).toBe(false)
    expect(text()).toContain('恢复权限失败（仅告警）')
  })

  /* ============================================================ 取消 */

  it('取消：上传途中取消 → FAILED + current_step=cancelled，暂存清了、锁放了、目标未动', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'live')
    const releaseId = 'rel-cancel'

    // 让第一个文件的上传卡在"闸门"上，直到测试主动放行
    const gate = deferred()
    const entered = deferred()
    fake.uploadGate = { onEnter: () => entered.resolve(), wait: gate.promise }

    const ac = new AbortController()
    const logs: string[] = []
    const pending = service.run({
      targetId: id,
      ports: fake.ports(),
      releaseId,
      ctx: {
        signal: ac.signal,
        progress: () => undefined,
        log: (text) => logs.push(text)
      }
    })

    await entered.promise
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(true) // 锁已经拿上了
    ac.abort() // 用户点了取消
    gate.resolve() // 在途的那一笔写完了

    const out = await pending

    expect(out.ok).toBe(false)
    expect(out.failure?.code).toBe(ErrorCode.E_JOB_CANCELLED)
    // 取消不算"失败"，用 current_step 区分（UI 给的建议完全不同）
    const rel = t.repo.releases.listByTarget(id, 5)[0]
    expect(rel.status).toBe('FAILED')
    expect(rel.currentStep).toBe('cancelled')
    // 三件事都要做到：暂存清了、锁放开了、现网没动
    expect(fake.has(stagingRootOf('/opt/app/dist', releaseId))).toBe(false)
    expect(fake.has(lockPathOf('/opt/app/dist'))).toBe(false)
    expect(fake.text('/opt/app/dist/index.html')).toBe('live')
    expect(logs.join('\n')).toContain('发布失败')
  })

  /* ======================================================== 并发控制 */

  it('并发控制：同一目标第二次发布被拒（E_TARGET_BUSY），台账不产生第二条记录', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'live')

    const gate = deferred()
    const entered = deferred()
    fake.uploadGate = { onEnter: () => entered.resolve(), wait: gate.promise }

    const first = service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })
    await entered.promise
    expect(service.busyTargets()).toContain(id)

    await expect(
      service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })
    ).rejects.toMatchObject({ code: ErrorCode.E_TARGET_BUSY })

    gate.resolve()
    const out = await first
    expect(out.ok).toBe(true)
    expect(service.busyTargets()).toEqual([])
    expect(t.repo.releases.listByTarget(id, 10)).toHaveLength(1)
  })

  /* ======================================================== 残留清理 */

  it('残留清理只认白名单：不在"可自动清理"清单里的路径一律拒绝', async () => {
    const id = seedDirTarget()
    fake.putFile('/opt/app/.sfvm-staging-a/payload/x', 'half')
    fake.putFile('/opt/app/notes.txt', 'hand made')

    const r = await service.cleanResidue({
      targetId: id,
      paths: ['/opt/app/.sfvm-staging-a', '/opt/app', '/opt/app/notes.txt'],
      fs: fake.ports().fs
    })

    expect(r.removed).toEqual(['/opt/app/.sfvm-staging-a'])
    expect(r.failed.map((f) => f.path)).toEqual(['/opt/app', '/opt/app/notes.txt'])
    expect(fake.has('/opt/app/notes.txt')).toBe(true)
  })

  /* ======================================================== 前置校验报告 */

  it('precheck（full）：给出本地产物摘要与磁盘余量，供确认弹窗直接展示', async () => {
    const id = seedDirTarget({ 'index.html': 'hello', 'assets/a.js': 'aa' })
    fake.putFile('/opt/app/dist/index.html', 'v1')

    const report = await service.precheck({ targetId: id, ports: fake.ports() })

    const keys = report.items.map((i) => i.key)
    expect(keys).toContain('connection')
    expect(keys).toContain('local-artifact')
    expect(keys).toContain('parent-writable')
    expect(keys).toContain('disk-space')
    expect(report.items.every((i) => i.level !== 'error')).toBe(true)
    expect(report.artifactSummary).toMatchObject({
      kind: 'dir',
      fileCount: 2,
      totalBytes: 7,
      rootHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(report.needConfirm).toBe(false)
  })

  it('precheck（full）：磁盘不足 / 远端锁 / 残留都会阻止发布并标 needConfirm', async () => {
    const id = seedDirTarget({ 'index.html': 'x'.repeat(2000) })
    fake.dfAvailableBytes = 100
    fake.putFile('/opt/app/.sfvm-staging-old/payload/x', 'half')

    const report = await service.precheck({ targetId: id, ports: fake.ports() })

    expect(report.items.find((i) => i.key === 'disk-space')?.level).toBe('error')
    expect(report.items.find((i) => i.key === 'residue')?.level).toBe('error')
    expect(report.needConfirm).toBe(true)
  })

  /* ======================================================== 台账一致性 */

  it('任意阶段失败都留下一条 FAILED 台账，error_message 带错误码', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'live')
    fake.putFile('/opt/app/dist/index.html.backup', 'x')
    // 让父目录可写探测失败，制造阶段 0 失败
    fake.parentWritable = false

    const out = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })
    expect(out.ok).toBe(false)

    const rel = t.repo.releases.listByTarget(id, 5)[0]
    expect(rel.id).toBe(out.releaseId)
    expect(rel.status).toBe('FAILED')
    expect(rel.errorMessage).toContain('E_PARENT_NOT_WRITABLE')
    expect(rel.finishedAt).toBeTruthy()
  })

  it('whenIdle：等得到发布成功后异步跑的保留策略', async () => {
    const id = seedDirTarget({ 'index.html': 'v2' })
    fake.putFile('/opt/app/dist/index.html', 'v1')
    // 保留 1 个版本：第二次发布后会真的删掉旧的归档
    t.repo.targets.update(id, { retainPolicy: JSON.stringify({ mode: 'count', value: 1 }) })

    const first = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })
    expect(first.ok).toBe(true)
    await service.whenIdle()

    writeFileSync(join(localDir, 'index.html'), 'v3')
    const second = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })
    expect(second.ok).toBe(true)
    await service.whenIdle()

    expect(t.repo.archives.listByTarget(id)).toHaveLength(1)
  })

  /* ============================================ AppError 契约快检 */

  it('hash 值稳定：同一份内容两次发布的 rootHash 一致（版本号含指纹的前提）', async () => {
    const a = makeLocalDir({ 'index.html': 'same' })
    const b = makeLocalDir({ 'index.html': 'same' })
    tempDirs.push(a, b)
    expect(a).not.toBe(b)

    const env = t.repo.targets.get(targetId)!.environmentId
    const ta = t.repo.targets.create({
      environmentId: env,
      name: 'A',
      kind: 'dir',
      remotePath: '/opt/a/dist',
      localPath: a
    })
    const tb = t.repo.targets.create({
      environmentId: env,
      name: 'B',
      kind: 'dir',
      remotePath: '/opt/b/dist',
      localPath: b
    })

    const ra = await service.run({ targetId: ta.id, ports: fake.ports(), ctx: makeCtx().ctx })
    const rb = await service.run({ targetId: tb.id, ports: fake.ports(), ctx: makeCtx().ctx })
    expect(ra.rootHash).toBe(rb.rootHash)
    expect(ra.versionTag).toBe(rb.versionTag)
  })

  it('AppError 的 hint 会带到失败结果里（UI 直接展示）', async () => {
    const id = seedDirTarget()
    rmSync(localDir, { recursive: true, force: true })
    const out = await service.run({ targetId: id, ports: fake.ports(), ctx: makeCtx().ctx })
    expect(out.ok).toBe(false)
    expect(out.failure?.hint).toBeTruthy()
    expect(out.failure?.stageText).toBeTruthy()
  })

  it('sha256 口径一致：本地文件哈希 == node crypto 的 sha256（防两端口径漂移）', async () => {
    const f = makeLocalFile('a.txt', 'hello')
    tempDirs.push(dirname(f))
    const r = await hashLocalArtifact({ localPath: f, kind: 'file' })
    expect(r.items).toEqual([
      { relPath: 'a.txt', hash: sha256('hello'), size: 5, mtime: expect.any(String) }
    ])
    expect(r.rootHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
