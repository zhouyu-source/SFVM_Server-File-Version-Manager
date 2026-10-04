/**
 * 远端发布锁的获取（**发布与回滚共用**）。
 *
 * ## 为什么单独抽出来
 *
 * 回滚和发布都做同一件事："把目标路径上的当前内容搬进版本库，再换一份上去"。
 * 这两件事**绝不能同时发生** —— 同时跑会让两次归档互相把对方的内容归档走，
 * 目标路径最后是什么全凭时序。所以它们必须抢同一把锁（`lockPathOf(remotePath)`）。
 *
 * 锁的实现留在两份文件里会立刻出问题：只要一边改了判据，另一边就成了缺口，
 * 而"并发下漏判"是最难在测试里暴露、却最容易在生产上咬人的一类 bug。
 *
 * ## 判据的核心：**不靠错误码，靠回头读一次**
 *
 * 各版本 OpenSSH 对 `O_EXCL` 创建失败的 SFTP 状态码并不统一
 * （`SSH_FX_FAILURE` / `SSH_FX_FILE_ALREADY_EXISTS` 都见过），所以这里不看错误码，
 * 而是失败后**回头读一次锁文件**：
 *
 * - 读不到 → 锁并不存在却写不进去 ⇒ 真实故障（权限 / 磁盘），如实抛出；
 * - 读到但解析不出 → 锁被改坏了，当作"陈旧"处理（否则用户永远发不了）；
 * - 读到且未过期 → 真的有人在跑，报 `E_TARGET_BUSY`；
 * - 读到且过期 → 报 `E_LOCK_STALE`，让用户明确确认后再清（不自动删：
 *   另一台机器上的长任务可能只是慢，不是死了）。
 */
import { AppError, ErrorCode } from './errors'
import { buildLockPayload, lockPathOf, parseLockPayload } from './deploy-plan'
import type { RemoteLockInfo } from '../../shared/contracts/deploy'

/** 取锁需要的三个 SFTP 原语（`DeployFsPort` 天然满足）。 */
export interface LockFsPort {
  writeNewFile(path: string, content: string): Promise<void>
  readTextFile(path: string): Promise<string>
  removeFile(path: string): Promise<void>
}

export interface AcquireRemoteLockInput {
  fs: LockFsPort
  /** 目标路径（锁在它的父目录下） */
  remotePath: string
  /** 本次操作的 id（发布 / 回滚）。写进锁文件，也用于"判断这把锁是不是我的" */
  releaseId: string
  hostname: string
  pid: number
  now: Date
  /** 用户是否已确认"可以清理陈旧锁" */
  cleanStaleLock: boolean
  log: (text: string, level?: 'info' | 'warn' | 'error') => void
  /** 清理掉陈旧锁时回调（调用方写审计用），不在锁逻辑里耦合 repo */
  onCleanStaleLock?: (info: { lockPath: string; previous: RemoteLockInfo | null }) => void
}

/**
 * 取锁；**成功即返回，失败抛错**（调用方不需要看返回值）。
 *
 * 抛出的错误码：
 * - `E_LOCK_STALE` —— 检测到陈旧锁且用户没确认清理；
 * - `E_TARGET_BUSY` —— 另一台机器/另一个任务正在跑，或锁内容无法解析；
 * - 其它 —— 写锁时的真实故障（原样抛出，不包装）。
 */
export async function acquireRemoteLock(input: AcquireRemoteLockInput): Promise<void> {
  const lockPath = lockPathOf(input.remotePath)
  const payload = buildLockPayload({
    releaseId: input.releaseId,
    hostname: input.hostname,
    pid: input.pid,
    now: input.now
  })

  try {
    await input.fs.writeNewFile(lockPath, payload)
    return
  } catch (err) {
    // 失败可能是"已被占用"，也可能是"真的写不进去"（权限/磁盘）。
    // **回头读一次**再判断 —— 各版本 OpenSSH 对 O_EXCL 失败的返回码不统一。
    let text: string | null
    try {
      text = await input.fs.readTextFile(lockPath)
    } catch {
      text = null
    }
    if (text === null) throw err // 锁不存在却写不进去 → 真实故障，如实抛出

    const existing = parseLockPayload(text, input.now)
    if (input.cleanStaleLock && (existing?.stale || existing === null)) {
      input.log('远端锁已陈旧/不可解析，按用户确认予以清理后继续', 'warn')
      input.onCleanStaleLock?.({ lockPath, previous: existing })
      await input.fs.removeFile(lockPath)
      await input.fs.writeNewFile(lockPath, payload)
      return
    }
    if (existing?.stale) {
      throw new AppError(
        ErrorCode.E_LOCK_STALE,
        { lockPath, lock: existing },
        {
          message: `检测到陈旧的发布锁（${existing.ts}，由 ${existing.hostname} 创建）`,
          hint: '确认没有其他人在发布后，重新发起时勾选「清理陈旧锁」，或手工删除该文件。'
        }
      )
    }
    throw new AppError(
      ErrorCode.E_TARGET_BUSY,
      { lockPath, lock: existing, lockUnreadable: existing === null },
      {
        message: existing
          ? `另一个操作正在进行中（${existing.hostname}，${existing.ts}）`
          : '远端锁文件存在且内容无法解析，为避免冲突已中止',
        hint: '请等待其结束后重试；若确认是残留，请在界面上确认清理后再试。'
      }
    )
  }
}

/**
 * 放锁：**尽力而为**，失败只记日志。
 *
 * 理由：锁本身会因超过 `LOCK_STALE_MS` 而失效，所以"没删掉"不会把目标永久锁死；
 * 而此刻调用方通常正处在收尾阶段（内容已经就位），把一次成功的操作改成失败更糟。
 */
export async function releaseRemoteLock(
  fs: Pick<LockFsPort, 'removeFile'>,
  remotePath: string,
  log?: (text: string, level?: 'info' | 'warn' | 'error') => void
): Promise<void> {
  try {
    await fs.removeFile(lockPathOf(remotePath))
  } catch (err) {
    log?.(`释放远端锁失败：${(err as Error).message}`, 'warn')
  }
}
