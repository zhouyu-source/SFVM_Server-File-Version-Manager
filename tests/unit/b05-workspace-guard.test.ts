/**
 * M8 回归：删除目标 / 删除环境前必须确认"该目标上没有任务在跑"。
 *
 * ## 为什么单独立一条 IPC 层用例
 *
 * 这个守卫**只能在 IPC 层拦**：`WorkspaceService` 本身不持有任务服务，
 * 而删除动作是级联的（目标 → releases / archives 台账全删）。
 * 真出事时的样子是"任务台显示已完成，但结果查不到" —— 那是数据损坏，
 * 不是界面小毛病，所以用真实 handler（`__invokeIpc`）把**拒绝**这件事钉死：
 * 拒绝之后目标与环境必须**一个都没少**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __invokeIpc, __resetIpcHandlers } from '../stubs/electron'
import type { IpcResult } from '@shared/ipc'
import { IPC_CHANNELS } from '@shared/channels'
import { ErrorCode } from '@shared/errors'
import { unregisterAllHandlers } from '@main/infra/ipc'
import { registerWorkspaceHandlers } from '@main/ipc/workspace'
import { createWorkspaceService } from '@main/services/workspace'
import { createJobService, type JobService } from '@main/services/job'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

async function invokeErrCode(channel: string, arg?: unknown): Promise<string> {
  const env = (await __invokeIpc(channel, arg)) as IpcResult<unknown>
  expect(env.ok).toBe(false)
  return (env as unknown as { code: string }).code
}

async function invokeOk<T>(channel: string, arg?: unknown): Promise<T> {
  const env = (await __invokeIpc(channel, arg)) as IpcResult<T>
  if (!env.ok) throw new Error(`IPC 失败：${env.code} ${env.message}`)
  return env.data
}

/** 起一个"卡住不结束"的任务，让目标处于忙碌状态。 */
function startBusyJob(jobs: JobService, targetId: string): { release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  jobs.start({
    type: 'deploy',
    title: '发布（进行中）',
    targetId,
    async run() {
      await gate
    }
  })
  return { release }
}

/** 放行任务并等它真的离开活跃集合（否则用例之间会串味）。 */
async function releaseAndWaitIdle(
  jobs: JobService,
  busy: { release: () => void },
  targetId: string
): Promise<void> {
  busy.release()
  for (let i = 0; i < 300; i += 1) {
    if (!jobs.hasActiveForTarget(targetId)) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`等待任务结束超时：${targetId}`)
}

describe('工作区 IPC 的删除守卫（M8）', () => {
  let t: TestDb
  let jobs: JobService

  beforeEach(() => {
    t = makeTestDb()
    jobs = createJobService()

    // 用**真实**的 WorkspaceService（它只是 repo 的一层包装，不碰 electron/ssh2）：
    // 删除目标/环境返回的是 `{ removedReleases }` / `{ removedTargets }` 这类
    // 经过级联统计的结果，替身很容易假造出"删掉了但返回形状不对"的假象。
    const workspace = createWorkspaceService({ repo: t.repo, defaultRetainPolicy: () => null })

    registerWorkspaceHandlers({
      workspace,
      connections: {} as never,
      pool: {} as never,
      repo: t.repo,
      jobs
    })
  })

  afterEach(() => {
    unregisterAllHandlers()
    __resetIpcHandlers()
    t.cleanup()
  })

  it('目标上任务在跑 → 删除目标被拒（E_TARGET_BUSY），目标与台账都还在', async () => {
    const { env, target } = seedBasic(t.repo)
    const busy = startBusyJob(jobs, target.id)

    const code = await invokeErrCode(IPC_CHANNELS.TARGETS_REMOVE, { id: target.id })
    expect(code).toBe(ErrorCode.E_TARGET_BUSY)

    // 关键：一个字都没删 —— 台账行还在，任务收尾时不会写孤儿
    expect(t.repo.targets.get(target.id)).toBeDefined()
    expect(t.repo.environments.get(env.id)).toBeDefined()

    await releaseAndWaitIdle(jobs, busy, target.id)
  })

  it('目标空闲 → 正常删除', async () => {
    const { target } = seedBasic(t.repo)
    const r = await invokeOk<{ removedReleases: number }>(IPC_CHANNELS.TARGETS_REMOVE, {
      id: target.id
    })
    expect(r.removedReleases).toBe(0)
    expect(t.repo.targets.get(target.id)).toBeUndefined()
  })

  it('环境里任一目标在跑 → 删除环境被拒（级联删除同样会毁掉在跑任务的台账）', async () => {
    const { env, target } = seedBasic(t.repo)
    const busy = startBusyJob(jobs, target.id)

    const code = await invokeErrCode(IPC_CHANNELS.ENV_REMOVE, { id: env.id })
    expect(code).toBe(ErrorCode.E_TARGET_BUSY)

    expect(t.repo.environments.get(env.id)).toBeDefined()
    expect(t.repo.targets.get(target.id)).toBeDefined()

    await releaseAndWaitIdle(jobs, busy, target.id)
  })

  it('环境整体空闲 → 正常删除', async () => {
    const { env } = seedBasic(t.repo)
    const r = await invokeOk<{ removedTargets: number }>(IPC_CHANNELS.ENV_REMOVE, { id: env.id })
    expect(r.removedTargets).toBe(1)
    expect(t.repo.environments.get(env.id)).toBeUndefined()
  })

  it('非当前目标的忙碌不影响本目标删除（守卫按 targetId 精确判定）', async () => {
    const { env, target } = seedBasic(t.repo)
    const other = t.repo.targets.create({
      environmentId: env.id,
      name: '另一个目标',
      kind: 'file',
      remotePath: '/opt/svc/other.jar'
    })
    const busy = startBusyJob(jobs, other.id)

    // other 在跑，但 target 是空闲的 → 删 target 必须放行
    await invokeOk(IPC_CHANNELS.TARGETS_REMOVE, { id: target.id })
    expect(t.repo.targets.get(target.id)).toBeUndefined()

    await releaseAndWaitIdle(jobs, busy, other.id)
  })
})
