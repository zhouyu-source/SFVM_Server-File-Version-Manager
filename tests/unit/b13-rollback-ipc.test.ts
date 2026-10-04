/**
 * B13 单测：回滚的 IPC 接线（T13.1 ~ T13.5）。
 *
 * ## 这一层要证明的第一件事：**失败不能被记成成功**
 *
 * `JobService.execute()` 只把"抛出来的异常"当作失败。回滚服务用返回值表达失败
 * （`{ ok: false, failure }`）—— 如果接线层忘了把它转成异常，任务会被记成
 * `succeeded`：底部任务条变绿、列表显示"已完成"，而服务器上的版本根本没换回来。
 * B11 在发布侧栽过一次（"发布失败却显示成功"），B13 的原样复制了这个坑，
 * 所以这里专门钉住它。
 *
 * ## 为什么端口是注入的
 *
 * 真连 SFTP 那一段（`openPortsDefault`）由真窗口 E2E 覆盖。这里换掉的是
 * "端口从哪来"，**不换**使用端口的逻辑：六阶段的顺序、补偿、
 * 锁的释放这些真正会写错的地方仍然被真实执行。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { __invokeIpc, __resetIpcHandlers } from '../stubs/electron'
import { IPC_CHANNELS } from '@shared/channels'
import { ErrorCode } from '@shared/errors'
import { isTerminalStatus, type JobView } from '@shared/contracts/job'
import type { IpcResult } from '@shared/ipc'
import { unregisterAllHandlers } from '@main/infra/ipc'
import { registerRollbackHandlers } from '@main/ipc/rollback'
import { createArchiveService } from '@main/services/archive'
import { createRollbackService } from '@main/services/rollback'
import { createJobService, type JobService } from '@main/services/job'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'
import { CLOCK, FakeRemote, makeLocalDir } from '../helpers/fake-remote'

const REMOTE = '/opt/app/dist'

/** 扁平信封：`{ok:true,data}` / `{ok:false,code,...}`（不是 `{ok:false,error}`）。 */
async function invokeOk<T>(channel: string, arg?: unknown): Promise<T> {
  const r = (await __invokeIpc(channel, arg)) as IpcResult<T>
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.code} ${r.message}`)
  return r.data
}

async function invokeErr(channel: string, arg?: unknown): Promise<string> {
  const r = (await __invokeIpc(channel, arg)) as IpcResult<unknown>
  if (r.ok) throw new Error('期望失败，实际成功')
  return String(r.code)
}

/** 等任务进入终态（进度事件是异步推的）。 */
async function waitTerminal(jobs: JobService, jobId: string, ms = 8000): Promise<JobView> {
  const deadline = Date.now() + ms
  for (;;) {
    const j = jobs.get(jobId)
    if (j && isTerminalStatus(j.status)) return j
    if (Date.now() > deadline) throw new Error(`任务 ${jobId} 未在 ${ms}ms 内结束`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('回滚 IPC 接线（B13）', () => {
  let t: TestDb
  let fake: FakeRemote
  let jobs: JobService
  let targetId: string
  let archiveId: string
  let versionTag: string
  const tempDirs: string[] = []

  beforeEach(async () => {
    __resetIpcHandlers()
    t = makeTestDb()
    fake = new FakeRemote()
    jobs = createJobService()
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

    const archive = createArchiveService({ repo: t.repo, now: () => CLOCK })
    // 造出"当前版本 v2 + 版本库里有 v1"的局面：归档走的是与发布阶段 4 相同的动作
    fake.putFile(`${REMOTE}/index.html`, 'v1')
    const a = await archive.archiveVersion({
      targetId,
      ports: fake.archivePorts(),
      releaseId: 'rel-v1',
      moveMode: 'rename'
    })
    archiveId = a.archive.id
    versionTag = a.archive.versionTag
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

    registerRollbackHandlers({
      rollback: createRollbackService({ repo: t.repo, archive, now: () => CLOCK }),
      jobs,
      connections: {} as never,
      // 回滚期间要把连接标 busy（T03.6：换版窗口里禁止自动重连）
      pool: { setBusy: (): void => undefined } as never,
      repo: t.repo,
      // 只换"端口从哪来"：其余逻辑（阶段顺序、补偿、抛错转换）全部真实执行
      openPorts: async () => ({
        connectionId: 'conn-1',
        ports: fake.ports(),
        rollbackPorts: fake.rollbackPorts()
      })
    })
  })

  afterEach(() => {
    unregisterAllHandlers()
    __resetIpcHandlers()
    t.cleanup()
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('rollback.preview：返回两版对比（纯本地，不碰服务器）', async () => {
    const p = await invokeOk<{ current: { versionTag: string } | null; target: { versionTag: string } }>(
      IPC_CHANNELS.ROLLBACK_PREVIEW,
      { targetId, archiveId }
    )
    expect(p.current?.versionTag).toBe('20250612-143100_aaaaaaa')
    expect(p.target.versionTag).toBe(versionTag)
  })

  it('入参校验：缺 archiveId / 空字符串都被契约挡住（E_PARAM）', async () => {
    expect(await invokeErr(IPC_CHANNELS.ROLLBACK_PREVIEW, { targetId })).toBe(ErrorCode.E_PARAM)
    expect(
      await invokeErr(IPC_CHANNELS.ROLLBACK_START, { targetId, archiveId: '' })
    ).toBe(ErrorCode.E_PARAM)
  })

  it('rollback.start：成功时任务进 succeeded，且服务器上换成了所选版本', async () => {
    const view = await invokeOk<JobView>(IPC_CHANNELS.ROLLBACK_START, {
      targetId,
      archiveId
    })
    const done = await waitTerminal(jobs, view.jobId)
    expect(done.status).toBe('succeeded')
    expect(fake.text(`${REMOTE}/index.html`)).toBe('v1')
    // 台账里有这条回滚记录（任务 id == 台账行 id）
    const row = t.repo.releases.get(view.jobId)!
    expect(row.action).toBe('rollback')
    expect(row.source).toBe('archive')
    expect(row.status).toBe('SUCCESS')
  })

  /**
   * **本文件最重要的一条**：失败必须变成任务的 failed。
   *
   * 回滚服务用返回值表达失败；接线层若忘了抛，任务会被记成 `succeeded` ——
   * 用户看到"已完成"，而服务器上什么都没变（或者更糟）。
   */
  it('rollback.start：阶段 3 失败时任务必须是 failed（不能记成成功）', async () => {
    fake.copyFileFailures.set(`${REMOTE}/index.html`, {
      err: new Error('模拟复制中断'),
      remaining: 1
    })
    // 补偿里的 rename 也失败 → 整体失败
    fake.renameFailures.set(REMOTE, { err: new Error('Permission denied'), remaining: 1 })

    const view = await invokeOk<JobView>(IPC_CHANNELS.ROLLBACK_START, {
      targetId,
      archiveId
    })
    const done = await waitTerminal(jobs, view.jobId)
    expect(done.status).toBe('failed')
    expect(done.error?.code).toBeTruthy()
    // 失败也要在台账里留痕
    expect(t.repo.releases.get(view.jobId)!.status).toBe('FAILED')
  })

  it('同一目标上已有回滚在跑 → 第二次被拒（E_TARGET_BUSY），不会排进队列', async () => {
    // 先占住车道：用一个不会立刻结束的任务
    const first = await invokeOk<JobView>(IPC_CHANNELS.ROLLBACK_START, {
      targetId,
      archiveId
    })
    expect(first.jobId).toBeTruthy()

    // 第一次还没结束（或刚结束）——用一个"运行中"的假任务占位更稳
    jobs.start({
      type: 'deploy',
      title: '占位发布',
      targetId,
      run: () => new Promise(() => undefined)
    })

    expect(await invokeErr(IPC_CHANNELS.ROLLBACK_START, { targetId, archiveId })).toBe(
      ErrorCode.E_TARGET_BUSY
    )
  })

  it('回滚失败时把补偿明细放进错误详情（界面要能说清"东西还在不在"）', async () => {
    fake.copyFileFailures.set(`${REMOTE}/index.html`, {
      err: new Error('模拟复制中断'),
      remaining: 1
    })
    fake.renameFailures.set(REMOTE, { err: new Error('Permission denied'), remaining: 1 })

    const view = await invokeOk<JobView>(IPC_CHANNELS.ROLLBACK_START, { targetId, archiveId })
    const done = await waitTerminal(jobs, view.jobId)
    const detail = done.error?.detail as
      | { failure?: { compensations?: Array<{ action: string; ok: boolean }> } }
      | undefined
    const comps = detail?.failure?.compensations ?? []
    expect(comps.some((c) => c.action === 'undo-archive')).toBe(true)
  })
})
