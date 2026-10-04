/**
 * B12 单测：版本库的 IPC 接线（T12.3 ~ T12.7）。
 *
 * ## 这一层要证明的东西
 *
 * IPC 层最容易犯的错是"看起来接上了，其实没接"：
 * 通道注册了但入参形状不对、任务起了但没挂到目标车道、失败被记成成功、
 * 取消之后本地的半截内容没人收拾。B11 已经在这里栽过一次
 * （"发布失败却显示成功"），所以本文件里有两条断言是专门钉这件事的：
 *
 * 1. 下载失败时任务必须进 `failed`，**绝不能**是 `succeeded`；
 * 2. 取消下载之后，本地暂存目录要被清掉（用户明确说了不要了）。
 *
 * ## 为什么下载的端口是注入的
 *
 * 真连 SFTP 的那一段（`openPorts`）由真机集成测试覆盖。这里换掉的是
 * "端口从哪来"，而**不换**使用端口的逻辑：计划、校验顺序、失败保留产物、
 * 任务收尾这些真正会写错的地方仍然被真实执行。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { __invokeIpc, __resetIpcHandlers } from '../stubs/electron'
import { IPC_CHANNELS } from '@shared/channels'
import { ErrorCode } from '@shared/errors'
import { isTerminalStatus, type JobView } from '@shared/contracts/job'
import type {
  ArchiveDownloadPlan,
  ArchiveRemoveResult,
  ArchiveSummary
} from '@shared/contracts/archive'
import type { IpcResult } from '@shared/ipc'
import { unregisterAllHandlers } from '@main/infra/ipc'
import { registerArchiveHandlers } from '@main/ipc/archive'
import { createArchiveService } from '@main/services/archive'
import { createArchiveDownloadService } from '@main/services/archive-download'
import { createJobService, type JobService } from '@main/services/job'
import { createTransfer, type TransferPort } from '@main/services/transfer'
import { computeRootHash } from '@main/infra/hash-core'
import { MANIFEST_FILE_NAME } from '@main/infra/manifest-io'
import { AppError } from '@main/infra/errors'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'
import type { Repositories } from '@main/db/repositories'

/* ------------------------------------------------------------------ 工具 */

// IPC 信封是**扁平**的：{ ok:true, data } / { ok:false, code, message, hint? }
// （不是 { ok:false, error:{...} }）—— 判错码时要按 code 取，别再套一层
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

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('等待条件超时')
}

const tmpDirs: string[] = []
function makeTmp(prefix = 'sfvm-b12ipc-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/* -------------------------------------------------------------- 内存远端 */

class MemoryRemote implements TransferPort {
  files = new Map<string, Buffer>()
  put(path: string, content: string): void {
    this.files.set(path, Buffer.from(content))
  }
  async statSize(p: string): Promise<number | null> {
    return this.files.get(p)?.length ?? null
  }
  async ensureDir(): Promise<void> {
    /* 无 */
  }
  async fastPut(): Promise<void> {
    throw new Error('不支持上传')
  }
  async fastGet(remotePath: string, localPath: string, onStep?: (n: number) => void): Promise<void> {
    const buf = this.files.get(remotePath)
    if (!buf) throw new Error(`no such file: ${remotePath}`)
    mkdirSync(dirname(localPath), { recursive: true })
    writeFileSync(localPath, buf)
    onStep?.(buf.length)
  }
  createReadStream(): NodeJS.ReadableStream {
    throw new Error('本替身不走流式分支')
  }
  createWriteStream(): NodeJS.WritableStream {
    throw new Error('本替身不走流式分支')
  }
  async rename(): Promise<void> {
    /* 无 */
  }
  async removeFile(): Promise<void> {
    /* 无 */
  }
}

/* ------------------------------------------------------------------ 夹具 */

describe('版本库 IPC 接线（T12.3 ~ T12.7）', () => {
  let t: TestDb
  let repo: Repositories
  let jobs: JobService
  let remote: MemoryRemote
  let saveDir: string
  let targetId: string
  let archiveId: string
  let versionTag: string
  let rootHash: string
  let busyLog: Array<{ connectionId: string; busy: boolean }>
  /** 注入的传输层：默认能正常下载；用例可以换成"卡住""抛错" */
  let transferOverride: ((files: Array<{ localPath: string }>) => Promise<unknown>) | null

  const VERSION_TAG = '20260901-120000_ab12cd3'
  const STORAGE = `/opt/app/archives/dist-${VERSION_TAG}`
  const PAYLOAD = `${STORAGE}/payload`

  beforeEach(() => {
    __resetIpcHandlers()
    unregisterAllHandlers()

    t = makeTestDb()
    repo = t.repo
    jobs = createJobService()
    remote = new MemoryRemote()
    busyLog = []
    transferOverride = null
    saveDir = makeTmp()

    const seeded = seedBasic(repo, { kind: 'dir', remotePath: '/opt/app/dist' })
    targetId = seeded.target.id

    const items = [{ relPath: 'dist/index.html', hash: sha256('hello'), size: 5 }]
    rootHash = computeRootHash(items)
    versionTag = VERSION_TAG
    const row = repo.archives.create({
      targetId,
      versionTag,
      storagePath: STORAGE,
      payloadPath: PAYLOAD,
      kind: 'dir',
      rootHash,
      totalBytes: 5,
      fileCount: 1,
      releaseId: null,
      note: null,
      status: 'valid'
    })
    archiveId = row.id

    remote.put(`${PAYLOAD}/dist/index.html`, 'hello')
    remote.put(
      `${STORAGE}/${MANIFEST_FILE_NAME}`,
      JSON.stringify({
        schemaVersion: 1,
        targetName: '前端产物',
        originalPath: '/opt/app/dist',
        kind: 'dir',
        versionTag,
        archivedAt: '2026-09-01T12:00:00+08:00',
        hashAlgo: 'sha256',
        rootHash,
        totalBytes: 5,
        fileCount: 1,
        files: [{ relPath: 'dist/index.html', hash: sha256('hello'), size: 5, mtime: null }]
      })
    )

    registerArchiveHandlers({
      archive: createArchiveService({ repo }),
      download: createArchiveDownloadService({ repo }),
      jobs,
      connections: {} as never,
      /**
       * 连接池替身：下载走注入的端口，但 `archives.detail` 走的是真实的
       * `openPorts` 接线，所以要能给出"一条可用的通道"。
       * 只实现 detail 会用到的那一个方法（`readFile`）—— 替身越小，
       * "哪条路径真的被走过"越清楚。
       */
      pool: {
        setBusy: (connectionId: string, busy: boolean) => busyLog.push({ connectionId, busy }),
        isOnline: () => true,
        capabilityOf: () => ({ homeDir: '/root' }),
        exec: async () => '',
        sftp: async () => ({
          readFile: (path: string, cb: (err: Error | null, data: Buffer) => void) => {
            const buf = remote.files.get(path)
            if (!buf) {
              cb(Object.assign(new Error('no such file'), { code: 2 }), Buffer.alloc(0))
              return
            }
            cb(null, buf)
          }
        })
      } as never,
      repo,
      defaultSaveDir: () => saveDir,
      openDownloadPorts: async () => ({
        connectionId: 'conn-1',
        source: {
          stat: async () => ({ exists: true, isDirectory: true, size: 0 }),
          readTextFile: async (path: string) => {
            const buf = remote.files.get(path)
            if (!buf) throw new AppError(ErrorCode.E_ARCHIVE_MISSING, { path })
            return buf.toString('utf8')
          }
        },
        transfer: {
          download: (
            files: Array<{
              remotePath: string
              localPath: string
              size?: number
              expectedHash?: string
            }>
          ) => {
            if (transferOverride) {
              return transferOverride(files as Array<{ localPath: string }>) as never
            }
            return createTransfer(remote, { retryDelay: () => 1 }).download(files)
          }
        } as never
      })
    })
  })

  afterEach(() => {
    while (tmpDirs.length > 0) {
      try {
        rmSync(tmpDirs.pop() as string, { recursive: true, force: true })
      } catch {
        /* Windows 偶发占用 */
      }
    }
  })

  /* ------------------------------------------------------------ 汇总 */

  it('archives.summary：纯台账聚合，不连服务器', async () => {
    const s = await invokeOk<ArchiveSummary>(IPC_CHANNELS.ARCHIVES_SUMMARY, { targetId })
    expect(s.count).toBe(1)
    expect(s.totalBytes).toBe(5)
    expect(s.byStatus.valid).toBe(1)
  })

  /* ------------------------------------------------------------ 计划 */

  it('archives.downloadPlan：不传 saveDir 时用默认位置，传了就用传的', async () => {
    const def = await invokeOk<ArchiveDownloadPlan>(IPC_CHANNELS.ARCHIVES_DOWNLOAD_PLAN, {
      archiveId
    })
    expect(def.saveDir).toBe(saveDir)
    expect(def.finalName).toBe(`订单服务-${versionTag}`)

    const other = makeTmp('sfvm-b12ipc-other-')
    const custom = await invokeOk<ArchiveDownloadPlan>(IPC_CHANNELS.ARCHIVES_DOWNLOAD_PLAN, {
      archiveId,
      saveDir: other
    })
    expect(custom.saveDir).toBe(other)
    expect(custom.finalPath).toBe(join(other, `订单服务-${versionTag}`))
  })

  /* ------------------------------------------------------------ 下载 */

  it('archives.download：起一个 download 任务，跑完后内容落盘、busy 正确开合', async () => {
    const view = await invokeOk<JobView>(IPC_CHANNELS.ARCHIVES_DOWNLOAD, {
      archiveId,
      saveDir,
      finalName: `订单服务-${versionTag}`
    })

    expect(view.type).toBe('download')
    expect(view.targetId).toBe(targetId)

    await waitFor(() => isTerminalStatus(jobs.get(view.jobId)?.status ?? 'running'))
    expect(jobs.get(view.jobId)?.status).toBe('succeeded')

    // 内容真的到了最终目录
    expect(readFileSync(join(saveDir, `订单服务-${versionTag}`, 'dist/index.html'), 'utf8')).toBe(
      'hello'
    )
    // 暂存目录不留
    expect(existsSync(join(saveDir, `.sfvm-part-${archiveId}`))).toBe(false)
    // 下载期间连接被标 busy（禁止自动重连），结束后放开
    expect(busyLog).toEqual([
      { connectionId: 'conn-1', busy: true },
      { connectionId: 'conn-1', busy: false }
    ])
  })

  it('**下载失败时任务必须进 failed**（B11 的教训：失败不能被记成成功）', async () => {
    transferOverride = async () => {
      throw new AppError(ErrorCode.E_VERIFY_MISMATCH, { relPath: 'dist/index.html' })
    }

    const view = await invokeOk<JobView>(IPC_CHANNELS.ARCHIVES_DOWNLOAD, {
      archiveId,
      saveDir,
      finalName: `订单服务-${versionTag}`
    })
    await waitFor(() => isTerminalStatus(jobs.get(view.jobId)?.status ?? 'running'))

    const job = jobs.get(view.jobId)
    expect(job?.status).toBe('failed')
    expect(job?.error?.code).toBe(ErrorCode.E_VERIFY_MISMATCH)
    // 失败时保留产物：错误详情里要有暂存目录（T12.4）
    expect((job?.error?.detail as { stagingPath?: string } | undefined)?.stagingPath).toBe(
      join(saveDir, `.sfvm-part-${archiveId}`)
    )
    // 台账要变成 corrupt，列表上就能看到"已损坏"
    expect(repo.archives.get(archiveId)!.status).toBe('corrupt')
  })

  it('取消下载：任务进 cancelled，且任务收尾把本地暂存目录清掉', async () => {
    transferOverride = (files) =>
      new Promise((_resolve, reject) => {
        // 等取消信号：模拟"正在传大文件时被取消"
        const timer = setInterval(() => {
          const staging = join(saveDir, `.sfvm-part-${archiveId}`)
          if (existsSync(staging)) {
            clearInterval(timer)
            reject(new AppError(ErrorCode.E_JOB_CANCELLED, {}))
          }
        }, 2)
        setTimeout(() => {
          clearInterval(timer)
          if (files.length >= 0) reject(new AppError(ErrorCode.E_JOB_CANCELLED, {}))
        }, 1500)
      }) as never

    const view = await invokeOk<JobView>(IPC_CHANNELS.ARCHIVES_DOWNLOAD, {
      archiveId,
      saveDir,
      finalName: `订单服务-${versionTag}`
    })
    const staging = join(saveDir, `.sfvm-part-${archiveId}`)
    await waitFor(() => existsSync(staging))
    await jobs.cancel(view.jobId)
    await waitFor(() => isTerminalStatus(jobs.get(view.jobId)?.status ?? 'running'))

    expect(jobs.get(view.jobId)?.status).toBe('cancelled')
    // 用户说了"不要了"，半截内容不该留在他的下载目录里
    await waitFor(() => !existsSync(staging), 2000)
  })

  /* ------------------------------------------------------------ 删除 */

  it('archives.remove：跨目标一次删除被拒（"连哪台服务器"必须唯一）', async () => {
    const other = seedBasic(repo, { kind: 'dir', remotePath: '/opt/other/dist' })
    const otherRow = repo.archives.create({
      targetId: other.target.id,
      versionTag: '20260902-120000_bbbbbbb',
      storagePath: '/opt/other/archives/x',
      payloadPath: '/opt/other/archives/x/payload',
      kind: 'dir',
      rootHash,
      totalBytes: 1,
      fileCount: 1,
      releaseId: null,
      note: null,
      status: 'valid'
    })

    const code = await invokeErr(IPC_CHANNELS.ARCHIVES_REMOVE, {
      archiveIds: [archiveId, otherRow.id]
    })
    expect(code).toBe(ErrorCode.E_PARAM)
  })

  it('archives.remove：该目标有任务在跑时拒绝（正在发布的版本不能被删）', async () => {
    // 起一个不会结束的任务占住这个目标的车道
    jobs.start({
      type: 'demo',
      title: '占位任务',
      targetId,
      run: () => new Promise(() => undefined)
    })
    await waitFor(() => jobs.activeForTarget(targetId).length > 0)

    const code = await invokeErr(IPC_CHANNELS.ARCHIVES_REMOVE, { archiveIds: [archiveId] })
    expect(code).toBe(ErrorCode.E_TARGET_BUSY)
  })

  it('archives.remove：空数组 / 未知 id 都走明确错误码，不静默成功', async () => {
    // 入参 schema 挡住空数组（.min(1)）
    expect(await invokeErr(IPC_CHANNELS.ARCHIVES_REMOVE, { archiveIds: [] })).toBe(
      ErrorCode.E_PARAM
    )
    // 台账里查不到的 id：连服务器之前就该报错
    expect(await invokeErr(IPC_CHANNELS.ARCHIVES_REMOVE, { archiveIds: ['nope'] })).toBe(
      ErrorCode.E_NOT_FOUND
    )
  })

  /**
   * 「正常删除」这一条**故意不在这里测**。
   *
   * 删远端目录要走真实的 SFTP（`rmrf` = stat + readdir + unlink/rmdir 的递归），
   * 在这里伪造一整条 ssh2 形状的通道，造出来的替身比被测逻辑还复杂，
   * 而且它证明不了我们的接线是对的。删除的语义（部分失败、id 不存在、
   * 重复 id）由 `b12-archive-remove.test.ts` 用内存远端覆盖；
   * "点删除 → 服务器上的目录真的没了"由真窗口 E2E 覆盖。
   */
  it('archives.remove：删除语义在服务层与 E2E 覆盖（此处仅作说明）', () => {
    const shape: ArchiveRemoveResult = { removed: [], failed: [], freedBytes: 0 }
    expect(shape.freedBytes).toBe(0)
  })

  /* ------------------------------------------------------------ 明细 */

  it('archives.detail：返回 manifest 摘要与一页清单', async () => {
    const d = await invokeOk<{ files: unknown[]; total: number; versionTag: string }>(
      IPC_CHANNELS.ARCHIVES_DETAIL,
      { archiveId, offset: 0, limit: 200 }
    )
    expect(d.versionTag).toBe(versionTag)
    expect(d.total).toBe(1)
    expect(d.files).toHaveLength(1)
  })

  it('archives.detail：归档 id 不存在时报 E_NOT_FOUND', async () => {
    expect(await invokeErr(IPC_CHANNELS.ARCHIVES_DETAIL, { archiveId: 'nope' })).toBe(
      ErrorCode.E_NOT_FOUND
    )
  })
})
