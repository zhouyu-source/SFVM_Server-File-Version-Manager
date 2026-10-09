/**
 * 发布残留的第二道清理（M6）。
 *
 * ## 为什么需要第二道
 *
 * `DeployService.run()` 自己的补偿（`compensate()`）用的**就是那条出问题的
 * ports** —— 断链、超时、通道被 sshd 回收时，它在服务器上什么都做不了。
 * 任务框架在任务进入终态时会调 `JobSpec.cleanup`，那里**另开一条新通道**再删一次：
 * 只要 SSH 还能连上（断的是那条会话，不是网络），残留就能当场清掉。
 *
 * 直接点发布时这道保险一直在（`ipc/deploy.ts` 的 `cleanup`），但**流水线里的
 * 发布步骤**曾经完全没有 —— `services/pipeline.ts` 的 `jobOf()` 没写 `cleanup`，
 * 于是流水线发布失败后 `.sfvm-staging-<id>` 与发布锁只能等 `LOCK_STALE_MS` 过期
 * 或人工走对账。这个文件把那段逻辑抽出来，**两个入口共用**（避免抄第二份）。
 *
 * ## 边界：只删能证明是自己留下的东西
 *
 * - 暂存目录：`stagingRootOf(remotePath, jobId)` —— 路径由**本次任务的 id** 决定；
 * - 发布锁：只有锁文件里写的 `releaseId === jobId` 才删。
 *
 * 不带这两个判据的清理，等于给了任务层一个"删任意远端路径 / 删别人锁"的开关
 * （另一台机器可能正在发布，它的锁也在同一个路径上）。
 */
import { normalizeRemotePath } from '../infra/remote-path'
import { lockPathOf, parseLockPayload, stagingRootOf } from '../infra/deploy-plan'
import type { Repositories } from '../db/repositories'
import type { DeployFsPort } from './deploy'
import type { DeployResidueCleanResult } from '../../shared/contracts/deploy'
import type { JobLogLevel } from '../../shared/contracts/job'

export interface DeployResidueCleanupDeps {
  repo: Repositories
  /**
   * 每次调用都**新开一条通道**的端口装配。
   *
   * 这里刻意与发布用的那批端口分开：走到清理时，旧通道多半已经不可用。
   * 返回值里的 `release` 由本函数在 `finally` 里调用（S2：通道是有限资源）。
   */
  openPorts: (targetId: string) => Promise<{
    ports: { fs: DeployFsPort }
    connectionId: string
    release?: () => void
  }>
  cleanResidue: (input: {
    targetId: string
    paths: string[]
    fs: DeployFsPort
  }) => Promise<DeployResidueCleanResult>
  /**
   * 放掉"发布中禁止自动重连"的标记。
   *
   * 任务的 `run` 通常在 `finally` 里已经放过；但如果它卡住迟迟不返回，
   * 就只剩清理这一条路能放 —— 所以这里再放一次（幂等）。
   */
  setBusy?: (connectionId: string, busy: boolean) => void
}

/** 与 `JobCleanupContext` 的形状对齐（`jobId` + 任务日志）。 */
export interface DeployResidueCleanupArgs {
  targetId: string
  jobId: string
  /** 任务为何终止（`'cancel' | 'quit' | 'failed'`）—— 只进日志文案 */
  reason: string
  log: (text: string, level?: JobLogLevel) => void
}

/**
 * 尽力清掉一次发布留下的远端痕迹。**永不抛错**（清理失败不能覆盖原始失败原因，
 * 方案书 §6.11）—— 清不掉时下一次发布的前置校验仍会认出这个残留并提示。
 */
export async function cleanupDeployResidue(
  deps: DeployResidueCleanupDeps,
  args: DeployResidueCleanupArgs
): Promise<void> {
  const { repo, openPorts, cleanResidue, setBusy } = deps
  const { targetId, jobId, reason, log } = args

  const target = repo.targets.get(targetId)
  if (!target) return

  try {
    // 关键：**新开一条通道**。失败时旧通道很可能已经不可用（MT-02 就是断链）
    const opened = await openPorts(targetId)
    try {
      setBusy?.(opened.connectionId, false)

      const remotePath = normalizeRemotePath(target.remotePath)
      const stagingRoot = stagingRootOf(remotePath, jobId)

      const st = await opened.ports.fs.stat(stagingRoot)
      if (!st.exists) {
        log(`清理检查：远端无暂存残留（${reason}）`)
      } else {
        const r = await cleanResidue({ targetId, paths: [stagingRoot], fs: opened.ports.fs })
        if (r.removed.length > 0) log(`已清理远端暂存目录 ${stagingRoot}`, 'warn')
        for (const f of r.failed) {
          log(`暂存目录未能清理（${f.reason}）：${f.path}`, 'warn')
        }
      }

      // 锁：只在"锁里写的正是本次任务"时才删。
      // 不这么判就等于给了任务层一个删别人锁的开关（另一台机器可能正在发布）。
      const lockPath = lockPathOf(remotePath)
      try {
        const text = await opened.ports.fs.readTextFile(lockPath)
        const lock = parseLockPayload(text, new Date())
        if (lock?.releaseId === jobId) {
          await opened.ports.fs.removeFile(lockPath)
          log('已释放远端发布锁', 'warn')
        } else if (lock) {
          log(`远端锁属于另一次发布（releaseId=${lock.releaseId}），不清理`, 'warn')
        } else if (text !== null) {
          log(`远端锁内容无法解析，未自动清理：${lockPath}`, 'warn')
        }
      } catch {
        // 读不到 = 没有锁，正常
      }
    } finally {
      // S2：这条补偿通道用完就关
      opened.release?.()
    }
  } catch (err) {
    log(
      `远端残留清理未完成：${(err as Error).message}` +
        '（可在恢复连接后重试，或在下一次发布时确认清理）',
      'warn'
    )
  }
}
