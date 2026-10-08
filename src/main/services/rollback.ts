/**
 * RollbackService（T13.1 ~ T13.5）。
 *
 * ## 回滚 = 把发布"反向"走一遍，但多一个前提
 *
 * 发布是：**归档当前 → 换上新版本**。
 * 回滚是：**归档当前 → 换上所选往期版本**。
 *
 * 前两步完全一样 —— 所以这里直接复用发布那条路径上的三样东西：
 * 归档（`ArchiveService.archiveVersion`）、换版（`rename` / `copyArtifactInto`）、
 * 锁（`infra/deploy-lock.ts`，**发布与回滚抢同一把锁**）。
 *
 * 多出来的那个前提是"**当前版本不能丢**"（计划书 B13 目标）。于是每个失败分支
 * 都要回答与发布同一个问题：
 *
 * > **此刻目标路径是空的，如果现在失败，用户还剩什么？**
 *
 * 具体地：
 * - 阶段 0/1 失败 → 远端零改动（锁已取到就放掉）；
 * - 阶段 2 失败 → 归档服务自己保证"目标要么原封不动、要么内容在归档目录里"；
 * - **阶段 3 失败 → 目标此刻是空的（rename）或半新半旧（copy），
 *   必须调 `archive.undoArchive()` 把刚归档的当前版本搬回来**。
 *   这是本文件最关键的一处补偿：没有它，用户点一次回滚就可能把线上版本弄没。
 * - 阶段 4/5/6 的失败一律"仅告警"：走到那里内容已经就位，
 *   把一次成功的回滚改成失败只会让用户以为要重试 —— 而重试会再归档一次。
 *
 * ## 一个容易写错的地方：`keepSource` 与搬运方式是**绑定**的
 *
 * 用户能选的是"这个版本还要不要留在版本库里"（`keepSource`）。它同时决定了搬运方式：
 *
 * | keepSource | 搬运     | 归档目录 | 台账行 |
 * | ---        | ---      | ---      | ---    |
 * | true（默认）| `copy`  | 完整保留 | 保留（状态仍 valid） |
 * | false      | `rename` | 删除     | 摘掉 |
 *
 * 不允许把它拆成"搬运方式"与"是否删除"两个独立开关：那样会出现
 * "rename + 保留"这种组合 —— 归档里的 payload 已经被搬走，台账却还在，
 * 版本库里从此多一条内容对不上的记录（而且它看起来是 `valid`）。
 *
 * ## 端口
 *
 * 与 `DeployService` 一样，本文件不 import electron / ssh2，副作用全经
 * `RollbackPorts` 注入 —— 于是"阶段 3 失败必须把当前版本搬回来"这种关键正确性
 * 用例能在单测里**真实跑完**（内存远端），而不是靠读代码相信它。
 */
import { AppError, ErrorCode, type ErrorCodeValue } from '../infra/errors'
import { logger } from '../infra/logger'
import { normalizeRemotePath } from '../infra/remote-path'
import { parentDirOf } from '../infra/archive-dir'
import { buildChmodCommand, buildDfCommand, parseDfOutput } from '../infra/remote-exec'
import { detectMountPoint } from '../infra/deploy-plan'
import { acquireRemoteLock, releaseRemoteLock } from '../infra/deploy-lock'
import { copyArtifactInto } from '../infra/copy-tree'
import { assertTransition } from '../infra/deploy-state'
import { joinRemote } from '../infra/hash-core'
import {
  MANIFEST_FILE_NAME,
  manifestToArtifactItems,
  parseManifestText
} from '../infra/manifest-io'
import { MAX_RELEASE_ITEMS_PERSIST } from '../../shared/contracts/archive'
import type { ReleaseItem } from '../../shared/contracts/hash'
import {
  ROLLBACK_SKIP_VERIFY_WARNING,
  ROLLBACK_STAGE_PROGRESS,
  rollbackStageText,
  type RollbackFailure,
  type RollbackOutcome,
  type RollbackPreview,
  type RollbackPreviewInput,
  type RollbackSide
} from '../../shared/contracts/rollback'
import { artifactPathOf, type ArchiveFsPort, type ArchivePorts, type ArchiveService } from './archive'
import type { RemoteHashPort } from './hash'
import type { Repositories } from '../db/repositories'
import type { ConnectionCapability } from '../infra/capability'

/** 日志级别（与 `JobLogLevel` 同形，避免服务层依赖任务契约）。 */
export type RollbackLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RollbackContext {
  signal: AbortSignal
  progress(p: { percent: number; stage?: string; message?: string }): void
  log(text: string, level?: RollbackLogLevel): void
}

/** 回滚需要的全部远端能力（比发布少一个 transfer：回滚不传任何东西上去）。 */
export interface RollbackPorts {
  /** 归档目录 + 锁 + 目标路径操作 */
  fs: ArchiveFsPort & {
    readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>>
    writeNewFile(path: string, content: string): Promise<void>
  }
  hash: RemoteHashPort
  exec(command: string): Promise<{ stdout: string; stderr: string; code: number | null }>
  capability: Pick<ConnectionCapability, 'hasSha256sum' | 'hasShasum' | 'platform' | 'homeDir'>
  /** 写进锁文件，便于在服务器上判断"是谁在操作" */
  hostname: string
}

export interface RollbackRunInput {
  targetId: string
  archiveId: string
  ports: RollbackPorts
  ctx: RollbackContext
  /** 台账行 id（= 任务 id），与发布同样三处一致 */
  rollbackId: string
  /** 保留来源版本（默认 true） */
  keepSource?: boolean
  /** 跳过归档完整性校验（T13.2） */
  skipVerify?: boolean
  cleanStaleLock?: boolean
  alignOwnership?: boolean
  operator?: string | null
  note?: string | null
}

/** 阶段 5 之后的台账/清理结果（供日志与返回）。 */
interface FinalizeResult {
  archivedVersionTag?: string
  sourceRemoved: boolean
}

export function createRollbackService(deps: {
  repo: Repositories
  archive: ArchiveService
  /**
   * 当前时间。默认取真实时间。
   *
   * 做成可注入的**只为一件事**：锁的陈旧判据（`LOCK_STALE_MS`）与时间有关，
   * 而单测里的"远端锁"是测试自己写进去的 —— 不可注入的话，
   * 测试要么等 30 分钟，要么只能测到"陈旧锁"那一个分支，永远测不到 `E_TARGET_BUSY`。
   * 发布侧 `createDeployService` 也是同样的做法。
   */
  now?: () => Date
}) {
  const { repo, archive } = deps
  const now = deps.now ?? ((): Date => new Date())

  /* ------------------------------------------------------------ 对比预览 */

  /**
   * 回滚前的对比数据（T13.3）。**纯本地，不连服务器。**
   *
   * 与 B12 的 `deploy.preview` / `archives.downloadPlan` 同一个取舍：
   * "这次操作会改动什么"应该离线就能看见，否则用户得先连上服务器才知道值不值得连。
   * 真正"能不能回滚"（归档内容还在不在、锁有没有被占）仍然由 `run` 的阶段 0 回答。
   *
   * 数据的**口径**必须标出来（`RollbackSide.origin`）：`current` 来自台账里
   * 最近一次成功操作的记录，是那次操作**当时**的快照 —— 用户完全可能在两次操作之间
   * 手工往目标目录塞过东西。把它当成"服务器现状"展示就是在撒谎。
   */
  function preview(input: RollbackPreviewInput): RollbackPreview {
    const target = repo.targets.get(input.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: input.targetId })

    const row = repo.archives.get(input.archiveId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { archiveId: input.archiveId })
    if (row.targetId !== input.targetId) {
      // 跨目标回滚没有意义：归档里的内容是另一个路径的，搬过去只会造成事故
      throw new AppError(
        ErrorCode.E_PARAM,
        { archiveId: input.archiveId, archiveTargetId: row.targetId, targetId: input.targetId },
        { message: '所选版本不属于这个目标', hint: '请到它所属目标的详情页执行回滚。' }
      )
    }

    const warnings: string[] = []
    const status = row.status === 'missing' || row.status === 'corrupt' ? row.status : 'valid'
    if (status === 'missing') {
      warnings.push('这个版本的归档目录已经不在服务器上了，回滚会失败（可先执行「校验」确认）。')
    } else if (status === 'corrupt') {
      warnings.push('上次校验发现这个版本的内容与清单不一致，回滚会把它原样换上线。建议先执行「校验」看差异。')
    }

    // 当前线上版本 = 台账里最近一次成功的操作（发布或回滚）
    const prev = repo.releases
      .listByTarget(input.targetId, 20)
      .find((r) => r.status === 'SUCCESS')
    const current: RollbackSide | null = prev
      ? {
          versionTag: prev.versionTag,
          rootHash: prev.rootHash,
          totalBytes: prev.totalBytes,
          fileCount: prev.fileCount,
          at: prev.finishedAt ?? prev.startedAt,
          origin: 'release'
        }
      : null
    if (!current) {
      warnings.push(
        '台账里没有这个目标的成功记录（目标可能是手工建的）。回滚前的当前版本仍会被归档，' +
          '但没有可对比的基线，请自行确认服务器上的内容确实是你要替换掉的。'
      )
    } else if (current.versionTag === row.versionTag) {
      warnings.push(
        '要回滚到的版本与当前线上版本号相同（内容一致，指纹相同）。执行回滚会先把当前版本归档、' +
          '再换成同一份内容 —— 结果不变，只是版本库里多一条记录。'
      )
    }

    return {
      targetId: target.id,
      targetName: target.name,
      remotePath: normalizeRemotePath(target.remotePath),
      kind: target.kind === 'file' ? 'file' : 'dir',
      current,
      target: {
        archiveId: row.id,
        versionTag: row.versionTag,
        rootHash: row.rootHash,
        totalBytes: row.totalBytes,
        fileCount: row.fileCount,
        at: row.archivedAt,
        origin: 'archive',
        status
      },
      warnings
    }
  }

  /* -------------------------------------------------------------- 主流程 */

  async function run(input: RollbackRunInput): Promise<RollbackOutcome> {
    const started = Date.now()
    const log = (text: string, level?: RollbackLogLevel): void => input.ctx.log(text, level)
    const progressAt = (stageIndex: number, ratio: number, message: string): void => {
      const r = ROLLBACK_STAGE_PROGRESS[stageIndex] ?? { from: 0, to: 100 }
      const pct = Math.max(0, Math.min(100, Math.round(r.from + (r.to - r.from) * ratio)))
      input.ctx.progress({ percent: pct, stage: rollbackStageText(stageIndex), message })
    }

    const keepSource = input.keepSource !== false
    const skipVerify = input.skipVerify === true
    const alignOwnership = input.alignOwnership !== false

    let stage = 0
    let lockHeld = false
    /** 阶段 2 归档出来的那条记录（阶段 3 失败时用它把当前版本搬回来） */
    let archivedByThisRun: { archiveId: string; versionTag: string; moveMode: 'rename' | 'copy' } | null =
      null
    const compensations: Array<{ action: string; ok: boolean; detail?: string }> = []

    const target = repo.targets.get(input.targetId)
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, { targetId: input.targetId })
    const remotePath = normalizeRemotePath(target.remotePath)
    const kind: 'dir' | 'file' = target.kind === 'file' ? 'file' : 'dir'

    const row = repo.archives.get(input.archiveId)
    if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { archiveId: input.archiveId })

    // 台账行先建出来：失败也要能在历史里看见（与发布同一取舍）
    repo.releases.create({
      id: input.rollbackId,
      targetId: target.id,
      action: 'rollback',
      versionTag: row.versionTag,
      status: 'PENDING',
      source: 'archive',
      archiveId: row.id,
      localPath: null,
      rootHash: row.rootHash,
      totalBytes: row.totalBytes,
      fileCount: row.fileCount,
      operator: input.operator ?? null,
      note: input.note ?? null,
      currentStep: rollbackStageText(0)
    })

    /** 组装错误时带上"已经做了哪些补偿"，失败视图直接展示它。 */
    const fail = (
      code: ErrorCodeValue,
      detail: Record<string, unknown>,
      text: { message: string; hint?: string }
    ): AppError =>
      new AppError(code, { ...detail, compensations }, {
        message: text.message,
        ...(text.hint ? { hint: text.hint } : {})
      })

    try {
      /* =============== 阶段 0：前置校验 =============== */
      stage = 0
      progressAt(0, 0, '前置校验')
      log(`开始回滚「${target.name}」→ ${remotePath}，目标版本 ${row.versionTag}`)

      if (row.targetId !== target.id) {
        throw fail(
          ErrorCode.E_PARAM,
          { archiveId: row.id, archiveTargetId: row.targetId },
          { message: '所选版本不属于这个目标，已中止（远端零改动）' }
        )
      }
      if ((row.kind === 'file' ? 'file' : 'dir') !== kind) {
        throw fail(
          ErrorCode.E_PARAM,
          { archiveKind: row.kind, targetKind: kind },
          {
            message: '所选版本的类型与目标不一致（一个文件、一个目录），已中止（远端零改动）',
            hint: '这通常说明目标被改过类型。请确认后重新建目标。'
          }
        )
      }

      // 归档内容必须在：否则"回滚"会先把当前版本归档掉、然后把目标留空
      const artifactAt = artifactPathOf(row.payloadPath, remotePath)
      if (!(await input.ports.fs.stat(row.payloadPath)).exists) {
        throw fail(
          ErrorCode.E_ARCHIVE_MISSING,
          { storagePath: row.storagePath, payloadPath: row.payloadPath },
          {
            message: `所选版本的归档内容不存在：${row.payloadPath}`,
            hint: `请检查 ${row.storagePath}，或换一个版本回滚。`
          }
        )
      }
      if (!(await input.ports.fs.stat(artifactAt)).exists) {
        throw fail(
          ErrorCode.E_ARCHIVE_MISSING,
          { storagePath: row.storagePath, artifactAt },
          {
            message: `归档目录里找不到要恢复的内容：${artifactAt}`,
            hint: `归档目录 ${row.storagePath} 可能与它的清单对不上，建议先执行「校验」。`
          }
        )
      }

      const targetExists = (await input.ports.fs.stat(remotePath)).exists
      if (!targetExists) {
        /**
         * 目标不存在 → 没有"当前版本"可归档。
         *
         * 这仍然是一次合法的操作（把版本库的一份内容铺到空目录上），但它**不是回滚**，
         * 而且比回滚少了"当前版本已入库"这层保护 —— 必须让用户知道。
         * 不阻止：发布那边对"目标不存在"的处理也是放行（首次发布）。
         */
        log(`远端目标 ${remotePath} 不存在，没有当前版本需要归档（将直接铺上所选版本）`, 'warn')
      }

      /* 换版/归档能否用原子 rename：目标是挂载点或跨设备时不能 */
      const mountInfo = await detectMountInfo(input.ports, remotePath)
      const canRename = !(mountInfo.isMountPoint || mountInfo.crossDevice)
      if (!canRename) {
        log(`换版将使用复制模式：${mountInfo.reason ?? '目标位于挂载点/跨设备'}`, 'warn')
      }
      const moveMode: 'rename' | 'copy' = canRename ? 'rename' : 'copy'

      await acquireRemoteLock({
        fs: input.ports.fs,
        remotePath,
        releaseId: input.rollbackId,
        hostname: input.ports.hostname,
        pid: process.pid,
        now: now(),
        cleanStaleLock: input.cleanStaleLock === true,
        log,
        onCleanStaleLock: ({ lockPath, previous }) => {
          repo.audit.write({
            level: 'warn',
            scope: 'rollback',
            refId: input.rollbackId,
            message: `清理陈旧远端锁 ${lockPath}`,
            detail: JSON.stringify({ lockPath, previous })
          })
        }
      })
      lockHeld = true

      /* =============== 阶段 1：校验归档完整性 =============== */
      stage = 1
      progressAt(1, 0, '校验归档完整性')
      if (skipVerify) {
        // 用户明确选了快速回滚：文案与界面用同一份常量，免得两边措辞不一致
        log(ROLLBACK_SKIP_VERIFY_WARNING, 'warn')
      } else {
        const v = await archive.verifyArchive({
          archiveId: row.id,
          ports: { fs: input.ports.fs, hash: input.ports.hash } satisfies ArchivePorts,
          signal: input.ctx.signal,
          log,
          onProgress: (done, total) =>
            progressAt(1, total > 0 ? done / total : 1, `校验归档 ${done}/${total}`)
        })
        if (!v.ok) {
          throw fail(
            ErrorCode.E_ARCHIVE_CORRUPT,
            { archiveId: row.id, status: v.status, diff: v.diff },
            {
              message: `所选版本的内容与它的清单不一致，已中止回滚（${v.message}）`,
              hint:
                '没有动过任何东西。若你确信要用这个版本，请勾选「跳过校验（快速回滚）」——' +
                '但要明白那会把当前内容直接换上线。'
            }
          )
        }
        log(`归档校验通过：${v.message}`)
      }

      /**
       * 顺手把"回滚到的这一版"的逐文件清单取下来（阶段 5 写台账时落库）。
       *
       * 这份清单干两件事：
       * 1. 下一次发布的**差异基准**（没有它，"这次发布会改动什么"只能退化成
       *    "全部新增"，用户看不出真实改动量）；
       * 2. 下一次发布归档旧版本时**省掉一次全量远端哈希** —— 这台机器出带宽
       *    只有 ~0.46 MB/s，几百 MB 的产物重算一次要几十分钟。
       *
       * 拿不到（manifest 读不了 / 形状对不上）就**不写**，只记一条警告：
       * 两件事都是锦上添花，不值得为它让回滚失败。
       */
      let artifactItems: ReleaseItem[] | null = null
      try {
        const text = await input.ports.fs.readTextFile(
          joinRemote(row.storagePath, MANIFEST_FILE_NAME)
        )
        artifactItems = manifestToArtifactItems(parseManifestText(text).manifest, {
          originalPath: remotePath,
          kind
        })
        if (!artifactItems) {
          log('所选版本的清单形状与目标对不上，本次不落逐文件清单（下次发布会现场计算远端指纹）', 'warn')
        }
      } catch (err) {
        log(`读取所选版本的清单失败，本次不落逐文件清单：${(err as Error).message}`, 'warn')
      }

      /* =============== 阶段 2：归档当前版本 =============== */
      stage = 2
      progressAt(2, 0, '归档当前版本')
      if (targetExists) {
        const archived = await archive.archiveVersion({
          targetId: target.id,
          ports: { fs: input.ports.fs, hash: input.ports.hash } satisfies ArchivePorts,
          // 不用上一版的清单省哈希：回滚时目标很可能已经被手工改过
          // （用户回滚往往就是因为现网不对），拿一份"可能对不上"的清单去省这一步
          // 会把错误哈希写进版本库。这里宁可慢，也不往版本库里埋坏数据。
          releaseId: input.rollbackId,
          operator: input.operator ?? null,
          note: `回滚前置归档（${row.versionTag} → 本版）`,
          moveMode,
          signal: input.ctx.signal,
          log,
          onProgress: (done, total) =>
            progressAt(2, total > 0 ? done / total : 1, `归档 ${done}/${total}`)
        })
        archivedByThisRun = {
          archiveId: archived.archive.id,
          versionTag: archived.archive.versionTag,
          moveMode
        }
        log(`已把回滚前的版本归档为 ${archived.archive.versionTag}，目标路径现在为空`)
      } else {
        log('目标路径不存在，跳过归档（没有当前版本可保全）')
      }

      /* =============== 阶段 3：就位 =============== */
      stage = 3
      progressAt(3, 0, '恢复所选版本')
      throwIfAborted(input.ctx.signal)

      // 保留来源 → 必须复制（rename 会把归档里的内容搬走，台账行就成了空壳）
      // 删除来源 → 优先 rename（快，且天然原子）
      const useRename = !keepSource && moveMode === 'rename'
      if (useRename) {
        await input.ports.fs.rename(artifactAt, remotePath)
      } else {
        await copyArtifactInto({
          fs: input.ports.fs,
          src: artifactAt,
          dst: remotePath,
          kind,
          signal: input.ctx.signal,
          onFile: (done, total) =>
            progressAt(3, total > 0 ? done / total : 1, `恢复 ${done}/${total}`)
        })
      }
      log(
        `已恢复版本 ${row.versionTag} 到 ${remotePath}` +
          (useRename ? '（来源版本已随之移入，待收尾删除归档目录）' : '（来源版本保留在版本库中）')
      )

      /* =============== 阶段 4：恢复权限 =============== */
      stage = 4
      progressAt(4, 0, '恢复权限')
      await alignTargetOwnership(input.ports, remotePath, log, alignOwnership)

      /* =============== 阶段 5：写入台账 =============== */
      stage = 5
      progressAt(5, 0, '写入台账')

      /**
       * 把"被这次回滚取代的那次操作"标成 `ROLLED_BACK`。
       *
       * 这条状态早就预留好了（`SUCCESS → ROLLED_BACK` 是状态机里唯一的终态出边），
       * 它回答的是"这条记录对应的内容还在线上吗" —— 不在，就该标出来。
       * 不标的话「发布历史」会显示一串 SUCCESS，用户看不出哪一版已经被换掉了。
       *
       * 顺带影响 `prevRelease()` 的挑选：它按 `status === 'SUCCESS'` 找上一版，
       * 被标掉的行不再参与 —— 正是我们要的（它的内容已经不在线上了）。
       */
      const superseded = repo.releases
        .listByTarget(target.id, 20)
        .find((r) => r.id !== input.rollbackId && r.status === 'SUCCESS')
      if (superseded) {
        assertTransition(superseded.status as 'SUCCESS', 'ROLLED_BACK')
        repo.releases.update(superseded.id, { status: 'ROLLED_BACK' })
        log(`已把被取代的版本 ${superseded.versionTag} 标记为 ROLLED_BACK`)
      }

      /**
       * 落逐文件清单。
       *
       * **回滚必须写**：它决定了"当前版本"这条台账记录是否带着明细。
       * B13 第一版没写，后果是回滚完详情页的「当前版本」显示空
       * （`preview` 当时把版本号与"清单是否存在"耦合在一起了，两处都修了）。
       */
      if (artifactItems && artifactItems.length > 0) {
        if (artifactItems.length <= MAX_RELEASE_ITEMS_PERSIST) {
          repo.releaseItems.addMany(
            artifactItems.map((i) => ({
              releaseId: input.rollbackId,
              relPath: i.relPath,
              hash: i.hash,
              size: i.size,
              mtime: i.mtime ?? null
            }))
          )
          log(`已把所选版本的逐文件清单记入台账（${artifactItems.length} 条），下次发布可比对差异`)
        } else {
          log(
            `文件数 ${artifactItems.length} 超过 ${MAX_RELEASE_ITEMS_PERSIST}，本次不落逐文件清单`,
            'warn'
          )
        }
      }

      await finalizeSource({
        keepSource,
        row: { id: row.id, storagePath: row.storagePath, versionTag: row.versionTag },
        fs: input.ports.fs,
        log
      })

      repo.releases.update(input.rollbackId, { currentStep: rollbackStageText(6) })

      /* =============== 阶段 6：收尾（不允许抛错） =============== */
      stage = 6
      progressAt(6, 0, '收尾')
      /**
       * **先真放掉锁、再把 lockHeld 置 false**。反过来（旧写法）会让"放锁失败"
       * 被记成"锁已放掉"，补偿里的 `if (lockHeld)` 于是跳过重试，锁就留在服务器上了 ——
       * 之后这个目标的所有发布都会被这把陈旧锁挡住。
       */
      await releaseRemoteLock(input.ports.fs, remotePath, log)
      lockHeld = false

      repo.releases.finish(input.rollbackId, 'SUCCESS')
      repo.targets.markDeployed(target.id)
      progressAt(6, 1, '回滚完成')
      log(`回滚完成：${remotePath} 现在是 ${row.versionTag}`)

      return {
        ok: true,
        rollbackId: input.rollbackId,
        targetId: target.id,
        versionTag: row.versionTag,
        ...(archivedByThisRun ? { archivedVersionTag: archivedByThisRun.versionTag } : {}),
        moveMode: useRename ? 'rename' : 'copy',
        verified: !skipVerify,
        durationMs: Date.now() - started
      }
    } catch (err) {
      /* ================= 失败：补偿 ================= */
      const failure = await compensate({
        err,
        stage,
        input,
        remotePath,
        kind,
        lockHeld,
        archivedByThisRun,
        compensations,
        log
      })
      try {
        repo.releases.finish(input.rollbackId, 'FAILED', `${failure.code}: ${failure.message}`)
        if (err instanceof AppError && err.code === ErrorCode.E_JOB_CANCELLED) {
          repo.releases.update(input.rollbackId, { currentStep: 'cancelled' })
        }
      } catch (e) {
        logger.error(`写回滚失败状态到台账时出错：${(e as Error).message}`)
      }
      return {
        ok: false,
        rollbackId: input.rollbackId,
        targetId: target.id,
        versionTag: row.versionTag,
        moveMode: keepSource ? 'copy' : 'rename',
        verified: !skipVerify,
        durationMs: Date.now() - started,
        failure
      }
    }
  }

  /* ---------------------------------------------------------------- 收尾 */

  /**
   * 来源版本的去留（T13.4 的后半段）。
   *
   * `keepSource = false` 时内容已经被 `rename` 搬走（或 `copy` 复制完），
   * 归档目录里剩下的东西对不上它的 manifest，**必须整条删掉**：
   * 目录删失败也照样摘台账行，但要如实说 —— 否则归档目录里会留下一个
   * "没有台账记录"的孤儿（B14 对账会把它报成异常，而那是我们自己造成的）。
   */
  async function finalizeSource(inputFn: {
    keepSource: boolean
    row: { id: string; storagePath: string; versionTag: string }
    fs: RollbackPorts['fs']
    log: (text: string, level?: RollbackLogLevel) => void
  }): Promise<FinalizeResult> {
    if (inputFn.keepSource) {
      inputFn.log(`${inputFn.row.versionTag} 已按选择保留在版本库中`)
      return { sourceRemoved: false }
    }
    try {
      await inputFn.fs.rmrf(inputFn.row.storagePath)
      inputFn.log(`已删除来源版本的归档目录 ${inputFn.row.storagePath}`)
    } catch (err) {
      logger.warn(`回滚后删除归档目录失败：${(err as Error).message}`)
      inputFn.log(
        `警告：归档目录 ${inputFn.row.storagePath} 未能删除，请手工清理（台账记录已摘除）`,
        'warn'
      )
    }
    repo.archives.remove(inputFn.row.id)
    return { sourceRemoved: true }
  }

  /* ---------------------------------------------------------------- 补偿 */

  async function compensate(args: {
    err: unknown
    stage: number
    input: RollbackRunInput
    remotePath: string
    kind: 'dir' | 'file'
    lockHeld: boolean
    archivedByThisRun: { archiveId: string; versionTag: string; moveMode: 'rename' | 'copy' } | null
    compensations: Array<{ action: string; ok: boolean; detail?: string }>
    log: (text: string, level?: RollbackLogLevel) => void
  }): Promise<RollbackFailure> {
    const { err, stage, remotePath, lockHeld } = args
    const appErr = err instanceof AppError ? err : null
    let code = appErr ? appErr.code : ErrorCode.E_UNKNOWN
    let hint = appErr?.hint
    const message = (err as Error).message

    /**
     * **阶段 3 失败 = 目标路径此刻可能是空的**。
     *
     * 必须把阶段 2 归档的当前版本搬回来，否则用户点一次回滚就把线上版本弄没了。
     * 与发布阶段 5 失败时的补偿是同一个动作、同一个理由。
     */
    if (stage === 3 && args.archivedByThisRun) {
      const a = args.archivedByThisRun

      /**
       * **顺序：先清掉本次留下的半个版本，再搬回旧版本。**
       *
       * 阶段 2 结束时目标路径必定是空的（归档是"搬走"或"复制后清空"，
       * 见 `archiveVersion`）。所以阶段 3 失败时，目标路径上如果有东西，
       * 那一定是**这次操作自己留下的不完整副本** —— 不清掉它，
       * `undoArchive` 会因为"目标已有内容"而拒绝搬回（它明确拒绝覆盖），
       * 用户就卡在"半新半旧 + 旧版本搬不回来"的死局里。
       *
       * 与发布侧 `compensate()` 的补偿顺序一致（那里也是"由外到内"）。
       */
      try {
        if ((await args.input.ports.fs.stat(remotePath)).exists) {
          await args.input.ports.fs.rmrf(remotePath)
          args.compensations.push({
            action: '清理换版残留',
            ok: true,
            detail: '目标路径上不完整的副本已清除'
          })
          args.log('已清除目标路径上不完整的副本，准备把回滚前的版本搬回来', 'warn')
        }
      } catch (e) {
        args.compensations.push({
          action: '清理换版残留',
          ok: false,
          detail: (e as Error).message
        })
        args.log(`清除目标残留失败：${(e as Error).message}`, 'warn')
      }

      try {
        await archive.undoArchive({
          archiveId: a.archiveId,
          ports: { fs: args.input.ports.fs, hash: args.input.ports.hash },
          // 去程是什么就按什么搬回来：去程 rename 过，归档里的内容已经不在原位
          moveMode: a.moveMode,
          log: args.log
        })
        args.compensations.push({
          action: 'undo-archive',
          ok: true,
          detail: `已把回滚前的版本 ${a.versionTag} 搬回 ${remotePath}`
        })
        args.log(`补偿成功：回滚前的版本 ${a.versionTag} 已恢复到目标路径`, 'warn')
      } catch (e) {
        args.compensations.push({
          action: 'undo-archive',
          ok: false,
          detail: (e as Error).message
        })
        logger.error(`回滚补偿失败：${(e as Error).message}`)
        args.log(
          `补偿失败：无法把 ${a.versionTag} 搬回 ${remotePath}。` +
            '内容仍在版本库里，可用「回滚」或从服务器上手工恢复。',
          'error'
        )
      }
    }

    if (lockHeld) {
      // 收尾阶段放锁失败时会走到这里再试一次。仍失败就**改成需要人工处理的指引**：
      // 这把锁会让该目标后续的发布一直被拒（E_DEPLOY_BLOCKED），用户必须知道去哪儿清。
      try {
        await releaseRemoteLock(args.input.ports.fs, remotePath, args.log)
      } catch (e) {
        code = ErrorCode.E_LOCK_STALE
        hint = '远端锁未能自动释放。请到「往期版本 → 对账」清理该目标的锁后再重试。'
        args.compensations.push({
          action: 'release-lock',
          ok: false,
          detail: (e as Error).message
        })
        args.log(
          `补偿失败：远端锁未能释放（${(e as Error).message}）。请到「往期版本 → 对账」清理该目标的锁。`,
          'error'
        )
      }
    }

    return {
      code,
      message,
      ...(hint ? { hint } : {}),
      compensations: args.compensations
    }
  }

  return { preview, run }
}

export type RollbackService = ReturnType<typeof createRollbackService>

/* ------------------------------------------------------------ 小工具 */

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AppError(ErrorCode.E_JOB_CANCELLED, { reason: 'aborted' }, { message: '回滚已取消' })
  }
}

/**
 * 探测目标是否位于挂载点 / 跨设备（决定能不能用原子 `rename`）。
 *
 * 两次 `df`：一次打目标本身、一次打父目录。与发布阶段 0 同一套判据
 * （`detectMountPoint`），所以"发布时能用 rename"与"回滚时能用 rename"结论一致 ——
 * 否则会出现"发布换得上去、回滚换不回来"这种只在一种目标上复现的怪事。
 *
 * `df` 失败不致命：拿不到就假定"可以 rename"，真失败了 `rename` 会抛错并在
 * 阶段 3 的补偿里被兜住。反过来（假定不能 rename）会让所有回滚都走慢速复制。
 */
async function detectMountInfo(
  ports: RollbackPorts,
  remotePath: string
): Promise<{ isMountPoint: boolean; crossDevice: boolean; reason?: string }> {
  const probe = async (p: string): Promise<{ filesystem: string; mountPoint: string } | null> => {
    try {
      const r = await ports.exec(buildDfCommand(p))
      if (r.code !== 0) return null
      return parseDfOutput(r.stdout)
    } catch {
      return null
    }
  }
  const [targetDf, parentDf] = await Promise.all([probe(remotePath), probe(parentDirOf(remotePath))])
  return detectMountPoint({ remotePath, targetDf, parentDf })
}

/**
 * 把目标路径的权限/属主对齐成"回滚前"的样子（尽力而为）。
 *
 * 这里用**归档前**记下的值吗？不是 —— 回滚没有"操作开始前"的 mode 可记，
 * 因为阶段 2 已经把原目标搬走了。所以这里只做一件事：把归档里那份内容的
 * 权限按现目标父目录的常规做法恢复（chmod 755 / 保留原属主）。
 *
 * 更准确地说：目录型目标在 `copy` 模式下新建出来的目录默认权限可能与原来不同，
 * 直接 chmod 一次至少保证"可遍历"（nginx 读静态文件就靠这个）。
 */
async function alignTargetOwnership(
  ports: RollbackPorts,
  remotePath: string,
  log: (text: string, level?: RollbackLogLevel) => void,
  enabled: boolean
): Promise<Array<{ action: 'chmod'; ok: boolean; detail?: string }>> {
  if (!enabled) return []
  const out: Array<{ action: 'chmod'; ok: boolean; detail?: string }> = []
  try {
    /**
     * 只对齐**目标路径自身**的权限，不递归。
     *
     * 理由与发布阶段 5 的 `alignOwnership` 相同：递归 `chmod -R` 会把目录的权限位
     * 套到所有文件上（755 的脚本变成 644，失去可执行位），而"一个 mode 值"
     * 本来就表达不了"目录 755 / 文件 644 / 脚本 755"这组事实。
     *
     * 这里固定用 755 而不是"恢复成回滚前的值"：回滚没有"操作前的 mode"可记 ——
     * 阶段 2 已经把原目标整体搬进版本库了。755 保证目录可被遍历
     * （nginx 读静态文件就靠这个），也是发布侧首次创建时的默认值。
     */
    const r = await ports.exec(buildChmodCommand({ mode: '755', path: remotePath }))
    const ok = r.code === 0
    out.push({ action: 'chmod', ok, ...(ok ? {} : { detail: r.stderr.trim() || `退出码 ${r.code}` }) })
    log(ok ? '已把目标目录权限设为 755' : '设置权限失败（仅告警）', ok ? 'info' : 'warn')
  } catch (err) {
    out.push({ action: 'chmod', ok: false, detail: (err as Error).message })
    log(`设置权限失败（仅告警）：${(err as Error).message}`, 'warn')
  }
  return out
}
