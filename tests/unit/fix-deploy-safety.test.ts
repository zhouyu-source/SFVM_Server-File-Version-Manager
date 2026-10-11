// Four production fault reproductions, now asserted against the repaired behavior.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { lockPathOf } from '@main/infra/deploy-plan'
import { dirname } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { makeTestDb, seedBasic } from '../helpers/db'
import { FakeRemote, CLOCK, makeCtx, makeLocalFile, deferred } from '../helpers/fake-remote'
import { createArchiveService } from '@main/services/archive'
import { createDeployService } from '@main/services/deploy'
import { createReconcileService } from '@main/services/reconcile'
import { createPipelineDeployPort } from '@main/ipc/pipeline'
import { verifyCopiedArtifact } from '@main/services/hash'
import { sha256 } from '../helpers/fake-remote'
import { createJobService } from '@main/services/job'
import { registerReconcileHandlers } from '@main/ipc/reconcile'
import { unregisterAllHandlers } from '@main/infra/ipc'
import { __invokeIpc, __resetIpcHandlers } from '../stubs/electron'
import { IPC_CHANNELS } from '@shared/channels'
import type { ConnectionService } from '@main/services/connection'
import type { SshConnectionPool } from '@main/services/ssh-client'

let db: ReturnType<typeof makeTestDb>
let fake: FakeRemote
let archive: ReturnType<typeof createArchiveService>
let deploy: ReturnType<typeof createDeployService>
let target: ReturnType<typeof seedBasic>['target']
let local: string
beforeEach(() => {
  db = makeTestDb()
  target = seedBasic(db.repo).target
  local = makeLocalFile('order.jar', 'new-v2')
  db.repo.targets.update(target.id, { localPath: local })
  fake = new FakeRemote()
  fake.putFile(target.remotePath, 'old-v1')
  archive = createArchiveService({ repo: db.repo, now: () => CLOCK })
  deploy = createDeployService({
    repo: db.repo,
    archive,
    now: () => CLOCK,
    transferRetryDelay: () => 1
  })
})
afterEach(async () => {
  unregisterAllHandlers()
  __resetIpcHandlers()
  await deploy.whenIdle()
  vi.restoreAllMocks()
  db.cleanup()
  rmSync(dirname(local), { recursive: true, force: true })
})

it.each(['archive-create', 'archive-audit', 'release-link'])(
  'archive stage DB failure (%s) preserves or commits target content',
  async (point) => {
    if (point === 'archive-create')
      vi.spyOn(db.repo.archives, 'create').mockImplementation(() => {
        throw new Error('simulated disk full')
      })
    if (point === 'archive-audit') {
      const write = db.repo.audit.write.bind(db.repo.audit)
      vi.spyOn(db.repo.audit, 'write').mockImplementation((entry) => {
        if (entry.scope === 'archive') throw new Error('simulated disk full')
        return write(entry)
      })
    }
    if (point === 'release-link') {
      const update = db.repo.releases.update.bind(db.repo.releases)
      vi.spyOn(db.repo.releases, 'update').mockImplementation((id, patch) => {
        if (patch.archiveId) throw new Error('simulated disk full')
        return update(id, patch)
      })
    }
    const result = await deploy.run({
      targetId: target.id,
      ports: fake.ports(),
      ctx: makeCtx().ctx
    })
    expect(result.ok).toBe(point === 'archive-audit')
    expect(fake.text(target.remotePath)).toBe(point === 'archive-audit' ? 'new-v2' : 'old-v1')
    expect(db.repo.releases.get(result.releaseId)?.status).toBe(
      point === 'archive-audit' ? 'SUCCESS' : 'FAILED'
    )
    if (point !== 'archive-audit') expect(db.repo.archives.listByTarget(target.id)).toHaveLength(0)
  }
)

it('pipeline keeps the channel and lock until retention finishes', async () => {
  const first = await deploy.run({ targetId: target.id, ports: fake.ports(), ctx: makeCtx().ctx })
  expect(first.ok).toBe(true)
  await deploy.whenIdle()
  db.repo.targets.update(target.id, { retainPolicy: JSON.stringify({ mode: 'count', value: 1 }) })
  writeFileSync(local, 'new-v3')
  const gate = deferred()
  const entered = deferred()
  const originalRetention = archive.applyRetention.bind(archive)
  let retentionResult: Awaited<ReturnType<typeof archive.applyRetention>> | undefined
  vi.spyOn(archive, 'applyRetention').mockImplementation(async (input) => {
    entered.resolve()
    await gate.promise
    retentionResult = await originalRetention(input)
    return retentionResult
  })
  let closed = false
  const ports = fake.ports()
  const originalRmrf = ports.archiveFs.rmrf
  ports.archiveFs.rmrf = async (path) => {
    if (closed) throw new Error('SFTP channel closed')
    return originalRmrf(path)
  }
  const port = createPipelineDeployPort({
    repo: db.repo,
    deploy,
    pool: {
      setBusy: () => undefined
    } as unknown as import('@main/services/ssh-client').SshConnectionPool,
    openPorts: async () => ({
      ports,
      connectionId: 'probe',
      release: () => {
        closed = true
      }
    })
  })
  const running = port.run({
    targetId: target.id,
    ctx: { ...makeCtx().ctx, jobId: 'probe-retention' },
    releaseId: 'probe-retention'
  })
  await entered.promise
  expect(closed).toBe(false)
  expect(fake.has(lockPathOf(target.remotePath))).toBe(true)
  gate.resolve()
  const result = await running
  expect(result.ok).toBe(true)
  expect(closed).toBe(true)
  expect(retentionResult?.failed).toHaveLength(0)
  expect(db.repo.archives.listByTarget(target.id)).toHaveLength(1)
})

it('recovery rejects a successful release without modifying content', async () => {
  const result = await deploy.run({ targetId: target.id, ports: fake.ports(), ctx: makeCtx().ctx })
  await deploy.whenIdle()
  expect(result.ok).toBe(true)
  const reconcile = createReconcileService({ repo: db.repo, archive, now: () => CLOCK })
  const ports = fake.ports()
  const input = { targetId: target.id, releaseId: result.releaseId, ports }
  await expect(reconcile.diagnose(input)).rejects.toMatchObject({ code: 'E_DEPLOY_BLOCKED' })
  await expect(reconcile.recover({ ...input, mode: 'restore-old' })).rejects.toMatchObject({
    code: 'E_DEPLOY_BLOCKED'
  })
  expect(fake.text(target.remotePath)).toBe('new-v2')
  expect(db.repo.releases.get(result.releaseId)?.status).toBe('SUCCESS')
})

it('copy swap rejects same-size corruption and restores the old content', async () => {
  db.repo.targets.update(target.id, { deployStrategy: 'copy' })
  const ports = fake.ports()
  const copy = ports.fs.copyFile
  ports.fs.copyFile = async (src, dst) => {
    await copy(src, dst)
    if (dst === target.remotePath) fake.putFile(dst, 'BAD-v2')
  }
  const result = await deploy.run({ targetId: target.id, ports, ctx: makeCtx().ctx })
  expect(result.ok).toBe(false)
  expect(result.failure?.stage).toBe(5)
  expect(fake.text(target.remotePath)).toBe('old-v1')
})

it('abandoning one crashed release preserves other targets staging', async () => {
  const result = await deploy.run({ targetId: target.id, ports: fake.ports(), ctx: makeCtx().ctx })
  await deploy.whenIdle()
  db.repo.releases.update(result.releaseId, { status: 'SWAPPING' })
  const other = db.repo.targets.create({
    environmentId: target.environmentId,
    name: 'Another target',
    kind: 'file',
    remotePath: '/opt/svc/other.jar'
  })
  db.repo.releases.create({
    id: 'other-active-release',
    targetId: other.id,
    versionTag: 'other',
    status: 'UPLOADING',
    action: 'deploy',
    source: 'local',
    localPath: local
  })
  const otherStaging = '/opt/svc/.sfvm-staging-other-active-release/payload/other.jar'
  fake.putFile(otherStaging, 'uploading')
  const reconcile = createReconcileService({ repo: db.repo, archive, now: () => CLOCK })
  await reconcile.recover({
    targetId: target.id,
    releaseId: result.releaseId,
    ports: fake.ports(),
    mode: 'abandon'
  })
  expect(db.repo.releases.get('other-active-release')?.status).toBe('UPLOADING')
  expect(fake.has(otherStaging)).toBe(true)
})

async function interrupted(id = 'interrupted') {
  db.repo.releases.create({
    id,
    targetId: target.id,
    action: 'deploy',
    versionTag: id,
    status: 'ARCHIVING'
  })
  const saved = await archive.archiveVersion({
    targetId: target.id,
    ports: fake.archivePorts(),
    releaseId: id
  })
  db.repo.releases.update(id, { status: 'SWAPPING' })
  return {
    id,
    saved,
    reconcile: createReconcileService({ repo: db.repo, archive, now: () => CLOCK })
  }
}

it('refuses occupied-target restoration even for an interrupted release', async () => {
  const c = await interrupted()
  fake.putFile(target.remotePath, 'someone-else')
  await expect(
    c.reconcile.recover({
      targetId: target.id,
      releaseId: c.id,
      mode: 'restore-old',
      ports: fake.ports()
    })
  ).rejects.toMatchObject({ code: 'E_DEPLOY_BLOCKED' })
  expect(fake.text(target.remotePath)).toBe('someone-else')
  expect(fake.text(c.saved.recovery.artifactPath)).toBe('old-v1')
  expect(fake.has(lockPathOf(target.remotePath))).toBe(false)
})

it('rejects a release belonging to another target before acquiring a lock', async () => {
  const c = await interrupted()
  const other = db.repo.targets.create({
    environmentId: target.environmentId,
    name: 'other',
    kind: 'file',
    remotePath: '/opt/svc/other.jar'
  })
  await expect(
    c.reconcile.recover({
      targetId: other.id,
      releaseId: c.id,
      mode: 'abandon',
      ports: fake.ports()
    })
  ).rejects.toMatchObject({ code: 'E_DEPLOY_BLOCKED' })
  expect(fake.has(c.saved.recovery.artifactPath)).toBe(true)
  expect(db.repo.releases.get(c.id)?.status).toBe('SWAPPING')
})

it('preserves an unreadable lock and all recovery content', async () => {
  const c = await interrupted()
  fake.putFile(lockPathOf(target.remotePath), 'unknown owner')
  await expect(
    c.reconcile.recover({
      targetId: target.id,
      releaseId: c.id,
      mode: 'restore-old',
      ports: fake.ports()
    })
  ).rejects.toMatchObject({ code: 'E_TARGET_BUSY' })
  expect(fake.text(lockPathOf(target.remotePath))).toBe('unknown owner')
  expect(fake.has(c.saved.recovery.artifactPath)).toBe(true)
})

it('reports failed bookkeeping as partial and keeps the record discoverable', async () => {
  const c = await interrupted()
  vi.spyOn(db.repo.releases, 'finish').mockImplementation(() => {
    throw new Error('disk full')
  })
  const result = await c.reconcile.recover({
    targetId: target.id,
    releaseId: c.id,
    mode: 'restore-old',
    ports: fake.ports()
  })
  expect(result.status).toBe('partial')
  expect(result.manualCleanup.join()).toContain('disk full')
  expect(fake.text(target.remotePath)).toBe('old-v1')
  expect(c.reconcile.startupScan().unfinished.map((r) => r.releaseId)).toContain(c.id)
})

it('completed recovery is idempotent', async () => {
  const c = await interrupted()
  const input = {
    targetId: target.id,
    releaseId: c.id,
    mode: 'restore-old' as const,
    ports: fake.ports()
  }
  expect((await c.reconcile.recover(input)).status).toBe('success')
  expect((await c.reconcile.recover(input)).status).toBe('success')
  expect(fake.text(target.remotePath)).toBe('old-v1')
  expect(c.reconcile.startupScan().unfinished).toHaveLength(0)
})

it('pending recovery archive cannot be deleted by retention, manual deletion or dedupe', async () => {
  const c = await interrupted()
  db.repo.targets.update(target.id, { retainPolicy: JSON.stringify({ mode: 'count', value: 1 }) })
  fake.putFile(target.remotePath, 'second')
  await archive.archiveVersion({ targetId: target.id, ports: fake.archivePorts() })
  const retained = await archive.applyRetention({ targetId: target.id, fs: fake.asArchiveFsPort() })
  expect(retained.removed).toHaveLength(0)
  expect(retained.failed.some((r) => r.id === c.saved.archive.id)).toBe(true)
  const removed = await archive.removeVersions({
    archiveIds: [c.saved.archive.id],
    fs: fake.asArchiveFsPort()
  })
  expect(removed.removed).toHaveLength(0)
  expect(fake.text(c.saved.recovery.artifactPath)).toBe('old-v1')
  fake.putFile(target.remotePath, 'old-v1')
  const same = await archive.archiveVersion({ targetId: target.id, ports: fake.archivePorts() })
  const deduped = await archive.discardDuplicateArchive({
    archiveId: c.saved.archive.id,
    keepArchiveId: same.archive.id,
    fs: fake.asArchiveFsPort()
  })
  expect(deduped.discarded).toBe(false)
  expect(fake.text(c.saved.recovery.artifactPath)).toBe('old-v1')
})

it('failed archive insertion plus failed compensation survives as a recoverable FAILED release', async () => {
  fake.renameFailures.set(target.remotePath, { err: new Error('restore denied'), remaining: 2 })
  const fault = vi.spyOn(db.repo.archives, 'create').mockImplementation(() => {
    throw new Error('disk full')
  })
  const result = await deploy.run({ targetId: target.id, ports: fake.ports(), ctx: makeCtx().ctx })
  expect(result.ok).toBe(false)
  expect(fake.has(target.remotePath)).toBe(false)
  expect(db.repo.releases.get(result.releaseId)?.recoveryRequired).toBe(true)
  const reconcile = createReconcileService({ repo: db.repo, archive, now: () => CLOCK })
  expect(reconcile.startupScan().unfinished.map((r) => r.releaseId)).toContain(result.releaseId)
  fault.mockRestore()
  fake.renameFailures.delete(target.remotePath)
  await reconcile.reconcile({ targetId: target.id, ports: fake.ports() })
  const restored = await reconcile.recover({
    targetId: target.id,
    releaseId: result.releaseId,
    mode: 'restore-old',
    ports: fake.ports()
  })
  expect(restored.status).toBe('success')
  expect(fake.text(target.remotePath)).toBe('old-v1')
  expect(reconcile.startupScan().unfinished).toHaveLength(0)
})

it('archive copy corruption never deletes the original', async () => {
  const ports = fake.archivePorts()
  const copy = ports.fs.copyFile
  ports.fs.copyFile = async (src, dst) => {
    await copy(src, dst)
    fake.putFile(dst, 'BAD-v1')
  }
  await expect(
    archive.archiveVersion({ targetId: target.id, ports, moveMode: 'copy' })
  ).rejects.toMatchObject({ code: 'E_ARCHIVE_FAILED' })
  expect(fake.text(target.remotePath)).toBe('old-v1')
  expect(db.repo.archives.listByTarget(target.id)).toHaveLength(0)
})

it('swap copy fallback retains the original archive rename mode for compensation', async () => {
  const ports = fake.ports()
  ports.fs.rename = async () => {
    const err = Object.assign(new Error('cross device'), { code: 'EXDEV' })
    throw err
  }
  const copy = ports.fs.copyFile
  ports.fs.copyFile = async (src, dst) => {
    await copy(src, dst)
    fake.putFile(dst, 'BAD-v2')
  }
  const result = await deploy.run({ targetId: target.id, ports, ctx: makeCtx().ctx })
  expect(result.ok).toBe(false)
  expect(result.failure?.compensations.some((c) => c.action === '归档复位' && c.ok)).toBe(true)
  expect(fake.text(target.remotePath)).toBe('old-v1')
})

it('disabling optional remote verification cannot bypass final copy verification', async () => {
  db.repo.targets.update(target.id, { deployStrategy: 'copy', verifyRemote: false })
  const ports = fake.ports()
  const copy = ports.fs.copyFile
  ports.fs.copyFile = async (src, dst) => {
    await copy(src, dst)
    fake.putFile(dst, 'BAD-v2')
  }
  const result = await deploy.run({ targetId: target.id, ports, ctx: makeCtx().ctx })
  expect(result.ok).toBe(false)
  expect(fake.text(target.remotePath)).toBe('old-v1')
})

it('copy is rejected before original deletion when required hash capability is unavailable', async () => {
  const strict = createArchiveService({ repo: db.repo, now: () => CLOCK, hashCompat: () => false })
  await expect(
    strict.archiveVersion({ targetId: target.id, ports: fake.archivePorts(), moveMode: 'copy' })
  ).rejects.toMatchObject({ code: 'E_NO_REMOTE_HASH_TOOL' })
  expect(fake.text(target.remotePath)).toBe('old-v1')
})

it('copy restoration refuses unavailable verification before writing the target', async () => {
  const saved = await archive.archiveVersion({
    targetId: target.id,
    ports: fake.archivePorts(),
    moveMode: 'copy'
  })
  const strict = createArchiveService({ repo: db.repo, hashCompat: () => false })
  await expect(
    strict.restoreRecovery({ recovery: saved.recovery, ports: fake.archivePorts() })
  ).rejects.toMatchObject({ code: 'E_NO_REMOTE_HASH_TOOL' })
  expect(fake.has(target.remotePath)).toBe(false)
  expect(fake.text(saved.recovery.artifactPath)).toBe('old-v1')
})

it('file copy verification ignores unrelated siblings', async () => {
  fake.putFile('/opt/svc/unrelated.jar', 'unrelated')
  await verifyCopiedArtifact({
    port: fake.ports().hash,
    remotePath: target.remotePath,
    kind: 'file',
    expected: [{ relPath: 'local-name.jar', hash: sha256('old-v1'), size: 6, mtime: null }],
    operationId: 'file-check'
  })
})

it('empty directory copy rejects unexpected final files', async () => {
  fake.putFile('/opt/empty/extra', 'unexpected')
  await expect(
    verifyCopiedArtifact({
      port: fake.ports().hash,
      remotePath: '/opt/empty',
      kind: 'dir',
      expected: [],
      operationId: 'empty-check'
    })
  ).rejects.toMatchObject({ code: 'E_VERIFY_MISMATCH' })
})

it('runAndWait returns structured data after the job reaches its terminal state', async () => {
  const jobs = createJobService()
  const data = { actions: [{ ok: true }] }
  expect(
    await jobs.runAndWait({
      type: 'reconcile',
      title: 'recover',
      targetId: target.id,
      run: async () => data
    })
  ).toEqual(data)
  expect(jobs.activeForTarget(target.id)).toHaveLength(0)
  expect(jobs.list()[0].status).toBe('succeeded')
})

it('runAndWait propagates failures after required cleanup finishes', async () => {
  const jobs = createJobService()
  const entered = deferred()
  const gate = deferred()
  let settled = false
  const work = jobs.runAndWait({
    type: 'reconcile',
    title: 'recover',
    targetId: target.id,
    run: async () => {
      throw new Error('recover failed')
    },
    cleanup: async () => {
      entered.resolve()
      await gate.promise
    }
  })
  const checked = expect(work)
    .rejects.toThrow('recover failed')
    .then(() => {
      settled = true
    })
  await entered.promise
  expect(settled).toBe(false)
  expect(jobs.hasActiveForTarget(target.id)).toBe(true)
  gate.resolve()
  await checked
  expect(jobs.hasActiveForTarget(target.id)).toBe(false)
})

it('recovery IPC rejects a busy target before opening a channel', async () => {
  const c = await interrupted()
  const jobs = createJobService()
  const gate = deferred()
  const busy = jobs.runAndWait({
    type: 'deploy',
    title: 'deploy',
    targetId: target.id,
    run: async () => {
      await gate.promise
    }
  })
  const openPorts = vi.fn(async () => ({ ports: fake.ports() }))
  registerReconcileHandlers({
    repo: db.repo,
    reconcile: c.reconcile,
    jobs,
    connections: {} as ConnectionService,
    pool: {} as SshConnectionPool,
    openPorts
  })
  const result = await __invokeIpc(IPC_CHANNELS.RECONCILE_RECOVER, {
    targetId: target.id,
    releaseId: c.id,
    mode: 'restore-old'
  })
  expect(result).toMatchObject({ ok: false, code: 'E_TARGET_BUSY' })
  expect(openPorts).not.toHaveBeenCalled()
  gate.resolve()
  await busy
})

it('recovery IPC holds the channel and lane through restoration', async () => {
  const c = await interrupted()
  const jobs = createJobService()
  const entered = deferred()
  const gate = deferred()
  const ports = fake.ports()
  const rename = ports.fs.rename
  ports.fs.rename = async (src, dst) => {
    if (dst === target.remotePath) {
      entered.resolve()
      await gate.promise
    }
    await rename(src, dst)
  }
  let closed = false
  registerReconcileHandlers({
    repo: db.repo,
    reconcile: c.reconcile,
    jobs,
    connections: {} as ConnectionService,
    pool: {} as SshConnectionPool,
    openPorts: async () => ({
      ports,
      release: () => {
        closed = true
      }
    })
  })
  const work = __invokeIpc(IPC_CHANNELS.RECONCILE_RECOVER, {
    targetId: target.id,
    releaseId: c.id,
    mode: 'restore-old'
  })
  await entered.promise
  expect(closed).toBe(false)
  expect(jobs.hasActiveForTarget(target.id)).toBe(true)
  gate.resolve()
  expect(await work).toMatchObject({ ok: true, data: { status: 'success' } })
  expect(closed).toBe(true)
  expect(jobs.hasActiveForTarget(target.id)).toBe(false)
})

it('commit receipts work with standard SFTP rename that cannot overwrite files', async () => {
  const ports = fake.ports()
  const rename = ports.archiveFs.rename
  ports.archiveFs.rename = async (src, dst) => {
    if (fake.has(dst)) throw new Error('SFTP cannot overwrite destination')
    await rename(src, dst)
  }
  expect((await deploy.run({ targetId: target.id, ports, ctx: makeCtx().ctx })).ok).toBe(true)
  expect((await deploy.precheck({ targetId: target.id, ports })).ok).toBe(true)
  writeFileSync(local, 'new-v3')
  expect((await deploy.run({ targetId: target.id, ports, ctx: makeCtx().ctx })).ok).toBe(true)
  expect(fake.text(target.remotePath)).toBe('new-v3')
})

it('closed receipt repairs SQLite after a successful commit with failed bookkeeping', async () => {
  const ports = fake.ports()
  const realUpdate = db.repo.releases.update.bind(db.repo.releases)
  vi.spyOn(db.repo.releases, 'update').mockImplementation((id, patch) => {
    if (patch.recoveryInfo === null || patch.status === 'SUCCESS')
      throw new Error('SQLite unavailable')
    return realUpdate(id, patch)
  })
  vi.spyOn(db.repo.releases, 'finish').mockImplementation(() => {
    throw new Error('SQLite unavailable')
  })
  const result = await deploy.run({ targetId: target.id, ports, ctx: makeCtx().ctx })
  expect(result.ok).toBe(true)
  expect(fake.text(target.remotePath)).toBe('new-v2')
  vi.restoreAllMocks()
  const reconcile = createReconcileService({ repo: db.repo, archive, now: () => CLOCK })
  expect(reconcile.startupScan().unfinished.map((r) => r.releaseId)).toContain(result.releaseId)
  await reconcile.reconcile({ targetId: target.id, ports })
  expect(db.repo.releases.get(result.releaseId)?.status).toBe('SUCCESS')
  expect(reconcile.startupScan().unfinished).toHaveLength(0)
  expect(fake.text(target.remotePath)).toBe('new-v2')
})

it('partial original deletion during copy archive restores verified content', async () => {
  const ports = fake.archivePorts()
  const remove = ports.fs.rmrf
  let injected = false
  ports.fs.rmrf = async (path) => {
    await remove(path)
    if (path === target.remotePath && !injected) {
      injected = true
      throw new Error('delete interrupted')
    }
  }
  await expect(
    archive.archiveVersion({ targetId: target.id, ports, moveMode: 'copy' })
  ).rejects.toMatchObject({ code: 'E_ARCHIVE_FAILED' })
  expect(fake.text(target.remotePath)).toBe('old-v1')
  expect(db.repo.archives.listByTarget(target.id)).toHaveLength(0)
})

it('rollback recovery restores pre-rollback content and preserves its source archiveId', async () => {
  const source = await archive.archiveVersion({ targetId: target.id, ports: fake.archivePorts() })
  fake.putFile(target.remotePath, 'current')
  db.repo.releases.create({
    id: 'rollback-crashed',
    targetId: target.id,
    action: 'rollback',
    versionTag: source.archive.versionTag,
    archiveId: source.archive.id,
    status: 'ARCHIVING'
  })
  await archive.archiveVersion({
    targetId: target.id,
    ports: fake.archivePorts(),
    releaseId: 'rollback-crashed'
  })
  db.repo.releases.update('rollback-crashed', { status: 'SWAPPING' })
  const reconcile = createReconcileService({ repo: db.repo, archive, now: () => CLOCK })
  expect(
    (
      await reconcile.recover({
        targetId: target.id,
        releaseId: 'rollback-crashed',
        mode: 'restore-old',
        ports: fake.ports()
      })
    ).status
  ).toBe('success')
  expect(fake.text(target.remotePath)).toBe('current')
  expect(db.repo.releases.get('rollback-crashed')?.archiveId).toBe(source.archive.id)
  expect(fake.text(source.recovery.artifactPath)).toBe('old-v1')
})

it('retention stops between victims when cancellation is requested', async () => {
  for (const value of ['one', 'two', 'three']) {
    fake.putFile(target.remotePath, value)
    await archive.archiveVersion({ targetId: target.id, ports: fake.archivePorts() })
  }
  db.repo.targets.update(target.id, { retainPolicy: JSON.stringify({ mode: 'count', value: 1 }) })
  const controller = new AbortController()
  const fs = fake.asArchiveFsPort()
  const remove = fs.rmrf
  fs.rmrf = async (path) => {
    await remove(path)
    controller.abort()
  }
  const result = await archive.applyRetention({
    targetId: target.id,
    fs,
    signal: controller.signal
  })
  expect(result.removed).toHaveLength(1)
  expect(db.repo.archives.listByTarget(target.id)).toHaveLength(2)
})

it('failed staging cleanup keeps a cancelled release in the startup recovery scan', async () => {
  const ports = fake.ports()
  const remove = ports.fs.rmrf
  ports.fs.rmrf = async (path) => {
    if (path.includes('.sfvm-staging-')) throw new Error('cleanup denied')
    await remove(path)
  }
  const controller = new AbortController()
  const context = makeCtx().ctx
  const result = await deploy.run({
    targetId: target.id,
    ports,
    ctx: {
      ...context,
      signal: controller.signal,
      progress: (progress) => {
        if ((progress.percent ?? 0) >= 20) controller.abort()
      }
    }
  })
  expect(result.ok).toBe(false)
  expect(db.repo.releases.get(result.releaseId)?.recoveryRequired).toBe(true)
  const reconcile = createReconcileService({ repo: db.repo, archive, now: () => CLOCK })
  expect(reconcile.startupScan().unfinished.map((r) => r.releaseId)).toContain(result.releaseId)
  expect(fake.text(target.remotePath)).toBe('old-v1')
})
