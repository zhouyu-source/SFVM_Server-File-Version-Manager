/**
 * T10.12 单测：发布的 IPC 接线。
 *
 * ## 这一层要证明的东西
 *
 * IPC 层最容易犯的错是"**看起来接上了，其实没接**"：通道注册了但入参形状不对、
 * 任务起了但没挂到目标车道、取消之后没人清理远端残留、复用了断掉的通道去清理。
 * 所以这里真的调用注册进去的 handler（`__invokeIpc`），断言的是：
 *
 * - `deploy.start` 起的任务的 `type` / `targetId` 对不对，`releaseId` 是不是任务 id；
 * - 发布期间连接被标记 busy（T03.6：发布中禁止自动重连）；
 * - 同一目标第二次发布被拒，而不是排进队列变成"发了两版";
 * - 失败清理的**边界**：只删本次任务的暂存目录，以及锁里 releaseId 与本次一致的锁；
 *   别人留下的锁一个都不许动。
 *
 * ## 为什么 `DeployService` 用替身
 *
 * 服务自身的正确性已由 `b10-deploy.test.ts` 用内存远端整条跑过一遍；
 * 这里要验的是"端口、任务、busy、清理"这四件事有没有接上。
 * 真连 SFTP 的那一段（`openPorts`）由真机集成测试覆盖（T10.13 / T10.14）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __invokeIpc,
  __registeredIpc,
  __resetIpcHandlers
} from '../stubs/electron'
import type { IpcResult } from '@shared/ipc'
import { IPC_CHANNELS } from '@shared/channels'
import { ErrorCode } from '@shared/errors'
import { isTerminalStatus, type JobView } from '@shared/contracts/job'
import type {
  DeployOutcome,
  DeployPrecheckReport,
  DeployResidueCleanResult
} from '@shared/contracts/deploy'
import { unregisterAllHandlers } from '@main/infra/ipc'
import { registerDeployHandlers, type OpenedPorts } from '@main/ipc/deploy'
import { createJobService, type JobService } from '@main/services/job'
import { buildLockPayload, lockPathOf, stagingRootOf } from '@main/infra/deploy-plan'
import type { DeployFsPort, DeployPorts, DeployService } from '@main/services/deploy'
import type { Repositories } from '@main/db/repositories'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

/* ------------------------------------------------------------ 远端替身 */

/** 只实现清理路径会用到的那几个方法 —— 其余端口方法在本层不会被调用。 */
class MiniRemote {
  files = new Map<string, string>()
  dirs = new Set<string>(['/'])

  putDir(path: string): void {
    const segs = path.split('/').filter(Boolean)
    let cur = ''
    for (const s of segs) {
      cur += `/${s}`
      this.dirs.add(cur)
    }
  }

  putFile(path: string, content: string): void {
    const idx = path.lastIndexOf('/')
    if (idx > 0) this.putDir(path.slice(0, idx))
    this.files.set(path, content)
  }

  has(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path)
  }

  asFsPort(): DeployFsPort {
    const port = {
      stat: async (p: string) => {
        const f = this.files.get(p)
        if (f !== undefined) return { exists: true, isDirectory: false, size: f.length }
        if (this.dirs.has(p)) return { exists: true, isDirectory: true, size: 0 }
        return { exists: false, isDirectory: false, size: 0 }
      },
      mkdirp: async (p: string) => this.putDir(p),
      rename: async (from: string, to: string) => {
        const v = this.files.get(from)
        this.files.delete(from)
        if (v !== undefined) this.files.set(to, v)
      },
      removeFile: async (p: string) => {
        this.files.delete(p)
      },
      rmrf: async (p: string) => {
        this.files.delete(p)
        for (const k of [...this.files.keys()]) if (k.startsWith(`${p}/`)) this.files.delete(k)
        for (const d of [...this.dirs]) if (d === p || d.startsWith(`${p}/`)) this.dirs.delete(d)
      },
      readTextFile: async (p: string) => {
        const v = this.files.get(p)
        if (v === undefined) throw new Error(`no such file: ${p}`)
        return v
      },
      writeTextChunks: async (p: string, chunks: Iterable<string>) => {
        let text = ''
        for (const c of chunks) text += c
        this.putFile(p, text)
      },
      listFiles: async () => [],
      copyFile: async (src: string, dst: string) => {
        const v = this.files.get(src)
        if (v !== undefined) this.putFile(dst, v)
      },
      readdir: async (p: string) =>
        [...this.files.keys(), ...this.dirs]
          .filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'))
          .map((k) => ({
            name: k.slice(p.length + 1),
            isDirectory: this.dirs.has(k),
            size: this.files.get(k)?.length ?? 0
          })),
      writeNewFile: async (p: string, content: string) => {
        if (this.has(p)) throw new Error('EEXIST')
        this.putFile(p, content)
      }
    }
    return port as unknown as DeployFsPort
  }
}

/* ------------------------------------------------------------ 工具 */

async function invokeOk<T>(channel: string, arg?: unknown): Promise<T> {
  const env = (await __invokeIpc(channel, arg)) as IpcResult<T>
  if (!env.ok) throw new Error(`IPC 失败：${env.code} ${env.message}`)
  return env.data
}

async function invokeErr(channel: string, arg?: unknown): Promise<string> {
  const env = (await __invokeIpc(channel, arg)) as IpcResult<unknown>
  expect(env.ok).toBe(false)
  return (env as { code: string }).code
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('等待条件超时')
}

const OK_OUTCOME: DeployOutcome = {
  ok: true,
  releaseId: 'rel',
  targetId: 'tgt',
  versionTag: '20250612-143015_abcdef0',
  status: 'SUCCESS',
  strategy: 'rename',
  rootHash: 'a'.repeat(64),
  fileCount: 1,
  totalBytes: 1,
  durationMs: 1,
  alignment: []
}

/* ------------------------------------------------------------ 用例 */

describe('发布 IPC 接线（T10.12）', () => {
  let t: TestDb
  let repo: Repositories
  let jobs: JobService
  let remote: MiniRemote
  let targetId: string
  let deploy: {
    precheck: ReturnType<typeof vi.fn>
    run: ReturnType<typeof vi.fn>
    cleanResidue: ReturnType<typeof vi.fn>
    busyTargets: () => string[]
    whenIdle: () => Promise<void>
  }
  let openCalls: string[]
  let busyLog: Array<{ connectionId: string; busy: boolean }>
  /** S2：每次 `openPorts` 拿到的通道被 `release()` 掉时记一笔（通道泄漏的哨兵） */
  let releasedIds: string[]

  beforeEach(() => {
    t = makeTestDb()
    repo = t.repo
    jobs = createJobService()
    remote = new MiniRemote()
    openCalls = []
    busyLog = []
    releasedIds = []

    const seeded = seedBasic(repo, { kind: 'dir', remotePath: '/opt/app/dist' })
    targetId = seeded.target.id

    deploy = {
      precheck: vi.fn(async (): Promise<DeployPrecheckReport> => ({
        ok: true,
        items: [{ key: 'connection', label: '连接可用', level: 'ok', detail: '已连接' }],
        needConfirm: false,
        residue: []
      })),
      run: vi.fn(async () => OK_OUTCOME),
      cleanResidue: vi.fn(
        async (input: { paths: string[] }): Promise<DeployResidueCleanResult> => {
          for (const p of input.paths) await remote.asFsPort().rmrf(p)
          return { removed: input.paths, failed: [] }
        }
      ),
      busyTargets: () => [],
      whenIdle: async () => undefined
    }

    registerDeployHandlers({
      deploy: deploy as unknown as DeployService,
      jobs,
      connections: { connect: async () => undefined } as never,
      pool: {
        isOnline: () => true,
        capabilityOf: () => undefined,
        sftp: async () => {
          throw new Error('单测不该走 pool.sftp（openPorts 已被注入）')
        },
        exec: async () => {
          throw new Error('单测不该走 pool.exec')
        },
        setBusy: (connectionId: string, busy: boolean) => busyLog.push({ connectionId, busy })
      } as never,
      repo,
      hostname: () => 'builder.local',
      openPorts: async (id: string): Promise<OpenedPorts> => {
        openCalls.push(id)
        // S2：真实 `createDeployPortsOpener` 会给出 release；这里给一个哨兵，
        // 好让"每次开的通道都被还回去了"在单测里可见
        return {
          connectionId: 'conn-1',
          ports: { fs: remote.asFsPort() } as unknown as DeployPorts,
          release: () => releasedIds.push(id)
        }
      }
    })
  })

  afterEach(() => {
    unregisterAllHandlers()
    __resetIpcHandlers()
    t.cleanup()
  })

  it('注册了四个通道（少一个就是"接线漏了"）', () => {
    const registered = __registeredIpc()
    for (const ch of [
      IPC_CHANNELS.DEPLOY_PRECHECK,
      IPC_CHANNELS.DEPLOY_START,
      IPC_CHANNELS.DEPLOY_CANCEL,
      IPC_CHANNELS.DEPLOY_CLEAN_RESIDUE
    ]) {
      expect(registered).toContain(ch)
    }
  })

  it('deploy.precheck：装配好端口再交给服务，原样返回报告', async () => {
    const report = await invokeOk<DeployPrecheckReport>(IPC_CHANNELS.DEPLOY_PRECHECK, {
      targetId
    })
    expect(report.ok).toBe(true)
    expect(deploy.precheck).toHaveBeenCalledTimes(1)
    expect(deploy.precheck.mock.calls[0]?.[0]).toMatchObject({ targetId })
    expect(openCalls).toEqual([targetId])
    // S2：一次 precheck = 一条通道，用完必须还回去
    expect(releasedIds).toEqual([targetId])
  })

  it('deploy.start：起一个目标车道的 deploy 任务，releaseId 就是任务 id，期间连接标记 busy', async () => {
    const released = deferred()
    deploy.run.mockImplementation(async () => {
      await released.promise
      return OK_OUTCOME
    })

    const view = await invokeOk<JobView>(IPC_CHANNELS.DEPLOY_START, {
      targetId,
      note: '修复订单超时'
    })
    expect(view.type).toBe('deploy')
    expect(view.targetId).toBe(targetId)
    expect(view.title).toContain('发布')

    await waitFor(() => deploy.run.mock.calls.length === 1)
    const arg = deploy.run.mock.calls[0]?.[0] as { releaseId: string; note: string | null }
    // releaseId 必须等于任务 id：台账行 id 与任务 id 一致，排障时不用对照两份编号
    expect(arg.releaseId).toBe(view.jobId)
    expect(arg.note).toBe('修复订单超时')
    // 发布期间禁止自动重连（T03.6）
    expect(busyLog).toEqual([{ connectionId: 'conn-1', busy: true }])

    released.resolve()
    await waitFor(() => {
      const cur = jobs.get(view.jobId)
      return cur !== undefined && isTerminalStatus(cur.status)
    })
    expect(busyLog).toEqual([
      { connectionId: 'conn-1', busy: true },
      { connectionId: 'conn-1', busy: false }
    ])
    expect(jobs.get(view.jobId)?.status).toBe('succeeded')
    // S2：发布跑完后这条通道必须被还回去 —— 否则一次发布就在服务器上留一条 session
    expect(releasedIds).toEqual([targetId])
  })

  it('deploy.run 返回 ok:false 时任务必须记成失败（B11 回归：曾经被记成"已完成"）', async () => {
    /**
     * 这条是 B11 做失败视图时发现的**静默失败**：
     * `DeployService.run()` 失败时返回 `{ok:false}` 而不是抛错，
     * 而 `JobService.execute()` 只把"抛出来的异常"当失败 ——
     * 于是"发布失败"在界面上显示成**绿色的"已完成"**，用户以为版本换上了。
     * 现在 ipc 层会在 ok:false 时抛 AppError，并带上 failure 明细供 UI 展示。
     */
    const failed: DeployOutcome = {
      ok: false,
      releaseId: 'rel',
      targetId,
      versionTag: '20250612-143015_abcdef0',
      status: 'FAILED',
      strategy: 'rename',
      rootHash: 'a'.repeat(64),
      fileCount: 1,
      totalBytes: 1,
      durationMs: 1,
      failure: {
        stage: 3,
        stageText: '远端逐文件校验',
        code: ErrorCode.E_VERIFY_MISMATCH,
        message: '远端校验未通过：缺失 1 个',
        hint: '暂存目录会被清理，目标路径未做任何改动。',
        compensations: [{ action: '清理暂存目录', ok: true }]
      }
    }
    deploy.run.mockImplementation(async () => failed)

    const view = await invokeOk<JobView>(IPC_CHANNELS.DEPLOY_START, { targetId })
    await waitFor(() => isTerminalStatus(jobs.get(view.jobId)?.status ?? 'failed'))

    const job = jobs.get(view.jobId)!
    expect(job.status, '发布失败却显示"已完成"，用户会以为版本换上了').toBe('failed')
    expect(job.error?.code).toBe(ErrorCode.E_VERIFY_MISMATCH)
    expect(job.error?.message).toBe('远端校验未通过：缺失 1 个')
    expect(job.error?.hint).toContain('目标路径未做任何改动')

    // 失败视图（T11.5）要展示"已执行的收尾动作"，所以必须把 failure 原样带过去
    const detail = job.error?.detail as
      | { failure?: { stage?: number; compensations?: Array<{ action: string }> } }
      | undefined
    expect(detail?.failure?.stage).toBe(3)
    expect(detail?.failure?.compensations?.map((c) => c.action)).toEqual(['清理暂存目录'])
  })

  it('deploy.start：同一目标已有发布在跑时直接拒绝（不排队 —— 排队会变成"发了两版"）', async () => {
    const released = deferred()
    deploy.run.mockImplementation(async () => {
      await released.promise
      return OK_OUTCOME
    })

    await invokeOk<JobView>(IPC_CHANNELS.DEPLOY_START, { targetId })
    await waitFor(() => deploy.run.mock.calls.length === 1)

    expect(await invokeErr(IPC_CHANNELS.DEPLOY_START, { targetId })).toBe(ErrorCode.E_TARGET_BUSY)

    released.resolve()
    await waitFor(() => jobs.list().every((j) => isTerminalStatus(j.status)))
    expect(jobs.list().filter((j) => j.type === 'deploy')).toHaveLength(1)
  })

  it('deploy.start：入参缺 targetId 被 Zod 拦下，不会起任务', async () => {
    expect(await invokeErr(IPC_CHANNELS.DEPLOY_START, {})).toBe(ErrorCode.E_PARAM)
    expect(jobs.list()).toHaveLength(0)
  })

  it('deploy.cancel：真的取消掉任务；失败清理**只删自己留下的东西**', async () => {
    const releaseId: string[] = []
    deploy.run.mockImplementation(async (arg: { releaseId: string }) => {
      releaseId.push(arg.releaseId)
      // 模拟"发布中途卡住"：一直不返回，等取消信号
      await new Promise((_r, reject) => {
        const timer = setTimeout(() => reject(new Error('本用例应当被取消')), 5000)
        const onAbort = (): void => {
          clearTimeout(timer)
          reject(Object.assign(new Error('已取消'), { code: ErrorCode.E_JOB_CANCELLED }))
        }
        ;(arg as unknown as { ctx: { signal: AbortSignal } }).ctx.signal.addEventListener(
          'abort',
          onAbort,
          { once: true }
        )
      })
      return OK_OUTCOME
    })

    const view = await invokeOk<JobView>(IPC_CHANNELS.DEPLOY_START, { targetId })
    await waitFor(() => releaseId.length === 1)
    const rid = releaseId[0] as string

    // 现场：本次任务的暂存目录 + 一把**别人的**锁
    const staging = stagingRootOf('/opt/app/dist', rid)
    remote.putFile(`${staging}/payload/index.html`, 'half')
    const myLock = lockPathOf('/opt/app/dist')
    remote.putFile(
      myLock,
      buildLockPayload({
        releaseId: rid,
        hostname: 'builder.local',
        pid: 1,
        now: new Date()
      })
    )

    const cancelled = await invokeOk<{ cancelled: boolean }>(IPC_CHANNELS.DEPLOY_CANCEL, {
      jobId: view.jobId
    })
    expect(cancelled.cancelled).toBe(true)

    await waitFor(() => {
      const cur = jobs.get(view.jobId)
      return cur !== undefined && isTerminalStatus(cur.status)
    })
    // 清理用的是**一条新通道**（openPorts 被再次调用），不是那条已经卡死的旧通道
    await waitFor(() => remote.has(staging) === false)
    expect(openCalls.length).toBeGreaterThanOrEqual(2)
    // S2：开的每一条通道（发布那条 + 补偿那条）都要还回去，一条都不能留在池里
    expect(releasedIds.length).toBe(openCalls.length)
    expect(remote.has(myLock)).toBe(false)
    // busy 也要放掉（run 卡住时只有 cleanup 能放）
    expect(busyLog.at(-1)).toEqual({ connectionId: 'conn-1', busy: false })
  })

  it('失败清理不碰别人的锁（锁里 releaseId 不是本次任务就留着）', async () => {
    const releaseId: string[] = []
    deploy.run.mockImplementation(async (arg: { releaseId: string }) => {
      releaseId.push(arg.releaseId)
      throw Object.assign(new Error('链路断了'), { code: ErrorCode.E_UPLOAD_INTERRUPTED })
    })

    const view = await invokeOk<JobView>(IPC_CHANNELS.DEPLOY_START, { targetId })
    // 兜底值用 'failed'（而不是 'pending'）：`isTerminalStatus` 只接受任务**终态**，
    // 而 'pending' 不在它的入参联合类型里 —— 写 'pending' 会直接编译不过。
    // 语义上也对："查不到这条任务"就当它已经结束了。
    await waitFor(() => isTerminalStatus(jobs.get(view.jobId)?.status ?? 'failed'))

    const lockPath = lockPathOf('/opt/app/dist')
    remote.putFile(
      lockPath,
      buildLockPayload({
        releaseId: 'someone-else',
        hostname: 'other-host',
        pid: 9,
        now: new Date()
      })
    )
    // 再跑一次：这次失败清理会看到那把"别人的锁"
    await invokeOk<JobView>(IPC_CHANNELS.DEPLOY_START, { targetId })
    await waitFor(() => remote.has(lockPath) === true && openCalls.length >= 3)
    // 等一下让 cleanup 的异步流程跑完（它已经没别的事可做）
    await new Promise((r) => setTimeout(r, 20))

    expect(remote.has(lockPath)).toBe(true)
    expect(remote.files.get(lockPath)).toContain('someone-else')
  })

  it('deploy.cleanResidue：把路径交给服务，并如实返回删除结果', async () => {
    const staging = '/opt/app/.sfvm-staging-x'
    remote.putFile(`${staging}/payload/a`, 'x')

    const r = await invokeOk<DeployResidueCleanResult>(IPC_CHANNELS.DEPLOY_CLEAN_RESIDUE, {
      targetId,
      paths: [staging]
    })
    expect(r.removed).toEqual([staging])
    expect(remote.has(staging)).toBe(false)
    expect(deploy.cleanResidue).toHaveBeenCalledTimes(1)
  })

  it('deploy.cleanResidue：路径条数上限 50（避免这个入口变成"删任意路径"的开关）', async () => {
    const paths = Array.from({ length: 51 }, (_v, i) => `/opt/app/.sfvm-staging-${i}`)
    expect(await invokeErr(IPC_CHANNELS.DEPLOY_CLEAN_RESIDUE, { targetId, paths })).toBe(
      ErrorCode.E_PARAM
    )
    expect(deploy.cleanResidue).not.toHaveBeenCalled()
  })
})
