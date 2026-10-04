/**
 * 对账与崩溃恢复（B14 / T14.1 ~ T14.6）。
 *
 * ## B14 与前几批的形态不同
 *
 * 前面都是"我要做一件事"（发布 / 下载 / 回滚），B14 是**"上次没做完、或者账对不上，
 * 现在怎么办"**。所以这里的契约不是"一次操作的入参出参"，而是**一份诊断报告**：
 * 用户需要先看见"现场是什么样"，再决定做什么。
 *
 * ## 一句话原则：**远端是真相来源**
 *
 * 台账（本地 SQLite）只是**缓存**：换台电脑、删了数据库、应用崩在换版窗口里，
 * 服务器上的归档目录都还在，而且每个版本目录里的 `manifest.json` 是自描述的
 * （方案书 §5.3）。所以对账的方向永远是：
 *
 * ```
 * 远端归档目录 ──读 manifest──> 重建/修正台账
 * ```
 *
 * **不是**"拿台账去核对我以为服务器上有什么"。后者在数据库被删之后就什么都没有了。
 *
 * 由此推出两条硬规则：
 *
 * 1. **补录的每一个字段都来自 manifest**，绝不从台账推断、也不"差不多就行"
 *    （`archivedAt` 也来自 manifest，否则 MT-06 的"时间与重建前一致"无从谈起）；
 * 2. **manifest 缺失的目录不补录**。没有 manifest 就无法知道这个版本的内容清单、
 *    指纹与归档时间 —— 补录进去只会得到一条既不能校验、也不能回滚的记录。
 *    这种目录如实**报告**出来，由用户决定手工处理。
 */
import { z } from 'zod'

/* -------------------------------------------------- 启动残留扫描（T14.4） */

/**
 * 一条"可能没做完"的操作（台账里的非终态记录）。
 *
 * 这一份**纯本地**（只读 SQLite），所以启动时就能算出来，不依赖任何连接。
 * 远端那一半（真的暂存目录、锁文件）要连上去才知道，放在 `diagnose` 里做。
 */
export const unfinishedReleaseSchema = z.object({
  releaseId: z.string(),
  targetId: z.string(),
  targetName: z.string(),
  environmentName: z.string(),
  /** 'deploy' | 'rollback' */
  action: z.string(),
  /** PENDING / UPLOADING / VERIFYING / ARCHIVING / SWAPPING */
  status: z.string(),
  versionTag: z.string(),
  startedAt: z.string(),
  /** 走到哪一步了（`cancelled` 表示用户主动取消、但没跑完收尾） */
  currentStep: z.string().nullable()
})
export type UnfinishedRelease = z.infer<typeof unfinishedReleaseSchema>

export const startupScanSchema = z.object({
  /** 扫描时刻（界面显示"上次检查于 …"） */
  scannedAt: z.string(),
  unfinished: z.array(unfinishedReleaseSchema)
})
export type StartupScan = z.infer<typeof startupScanSchema>

/* ---------------------------------------------------------- 对账（T14.1~T14.3） */

export const reconcileInputSchema = z.object({
  targetId: z.string().min(1),
  /**
   * 深度校验：逐文件比对内容与 manifest（慢 —— 要读一遍服务器上的全部内容）。
   * 默认 false，此时只做**结构对账**（目录在不在、manifest 在不在、清单能不能解析、
   * 汇总字段与明细对不对得上）。
   */
  deep: z.boolean().optional(),
  /** 是否补录"远端有、台账没有"的版本。默认 true */
  adopt: z.boolean().optional(),
  /** 是否把"台账有、远端没有"的标成 missing。默认 true */
  markMissing: z.boolean().optional()
})
export type ReconcileInput = z.infer<typeof reconcileInputSchema>

/** 补录/修正一条台账记录时用的依据。 */
export const adoptResultSchema = z.object({
  versionTag: z.string(),
  /** 台账行 id */
  archiveId: z.string(),
  archivedAt: z.string(),
  fileCount: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  /**
   * `adopted` = 台账里原本没有，这次补上了；
   * `updated` = 台账里有但关键字段与 manifest 对不上（被人改过 / 老版本写的），已按远端修正。
   */
  how: z.enum(['adopted', 'updated'])
})

export const reconcileReportSchema = z.object({
  targetId: z.string(),
  targetName: z.string(),
  remotePath: z.string(),
  archiveDir: z.string(),
  /** 归档目录本身在不在（不在 = 这个目标还没归档过任何版本） */
  archiveDirExists: z.boolean(),
  counts: z.object({
    /** 远端有、台账没有（本次补录） */
    adopted: z.number().int().min(0),
    /** 台账有但远端已经没了 */
    markedMissing: z.number().int().min(0),
    /** 深度校验发现内容与 manifest 不符 */
    corrupt: z.number().int().min(0),
    /** 两边都有且没发现问题 */
    ok: z.number().int().min(0),
    /** 远端目录里的东西认不出是版本目录（不是 `<版本号>` 形态） */
    unrecognized: z.number().int().min(0),
    /** 认得出是版本目录、但没有 manifest（**不补录**，需要人工处理） */
    withoutManifest: z.number().int().min(0)
  }),
  adopted: z.array(adoptResultSchema),
  missing: z.array(z.object({ versionTag: z.string(), archiveId: z.string() })),
  corrupt: z.array(z.object({ versionTag: z.string(), reason: z.string() })),
  /** 逐条结论（界面展开看明细用） */
  items: z.array(
    z.object({
      versionTag: z.string(),
      /** 台账里有没有这一条 */
      inLedger: z.boolean(),
      /** 远端目录在不在 */
      onRemote: z.boolean(),
      hasManifest: z.boolean(),
      status: z.enum(['valid', 'missing', 'corrupt', 'adopted', 'updated', 'no-manifest']),
      archivedAt: z.string().nullable(),
      fileCount: z.number().int().min(0).nullable(),
      totalBytes: z.number().int().min(0).nullable(),
      note: z.string().nullable()
    })
  ),
  /** 认不出形态的条目名（原样列出，便于用户去服务器上核对） */
  unrecognized: z.array(z.string()),
  /** 对账时发现的远端锁（T14.6） */
  lock: z
    .object({
      path: z.string(),
      releaseId: z.string().nullable(),
      hostname: z.string().nullable(),
      ts: z.string().nullable(),
      stale: z.boolean(),
      /** 内容读不懂（被改坏了） */
      unreadable: z.boolean()
    })
    .nullable(),
  /** 对账时发现的暂存残留（`<父目录>/.sfvm-staging-*`） */
  stagingResidue: z.array(z.string()),
  deep: z.boolean(),
  durationMs: z.number().int().min(0)
})
export type ReconcileReport = z.infer<typeof reconcileReportSchema>

/* ------------------------------------------------- 崩溃恢复引导（T14.5） */

export const diagnoseInputSchema = z.object({
  targetId: z.string().min(1),
  releaseId: z.string().min(1)
})
export type DiagnoseInput = z.infer<typeof diagnoseInputSchema>

export type RecoverMode = 'restore-old' | 'abandon'

/**
 * "崩在中间"的现场勘察结果。
 *
 * 它要回答的是三句话：**这次操作走到哪一步了？目标路径现在是什么样？
 * 用户还剩什么？** 三个选项的可用性也从这三句里推出来：
 *
 * - 有归档、目标为空 → 可以 `restore-old`（把归档的旧版本搬回来）；
 * - 有归档、目标有内容 → **不能** restore（`undoArchive` 拒绝覆盖，
 *   而且此时"目标里的东西是不是这次操作搞坏的"没人判断得了）→ 只能 `abandon` 或人工介入；
 * - 任何情况都可以 `abandon`（把台账行收尾 + 清掉能证明是自己留下的残留）。
 */
export const recoveryDiagnosisSchema = z.object({
  releaseId: z.string(),
  targetId: z.string(),
  targetName: z.string(),
  remotePath: z.string(),
  release: z.object({
    action: z.string(),
    status: z.string(),
    versionTag: z.string(),
    startedAt: z.string(),
    currentStep: z.string().nullable()
  }),
  /** 目标路径现状 */
  target: z.object({ exists: z.boolean(), isDirectory: z.boolean() }),
  /** 这次操作归档出来的旧版本（阶段 4 成功过才有） */
  archive: z
    .object({
      archiveId: z.string(),
      versionTag: z.string(),
      /** 归档内容还在不在（决定 restore-old 能不能用） */
      storageExists: z.boolean()
    })
    .nullable(),
  lock: z
    .object({ path: z.string(), releaseId: z.string().nullable(), stale: z.boolean() })
    .nullable(),
  staging: z.array(z.string()),
  /** 用户可以选的动作（服务端判定，界面据此决定按钮可用性） */
  options: z.array(z.object({ mode: z.enum(['restore-old', 'abandon', 'retry']), enabled: z.boolean(), reason: z.string() })),
  /** 一句话概括现场（界面直接展示） */
  summary: z.string()
})
export type RecoveryDiagnosis = z.infer<typeof recoveryDiagnosisSchema>

export const recoverInputSchema = z.object({
  targetId: z.string().min(1),
  releaseId: z.string().min(1),
  mode: z.enum(['restore-old', 'abandon']),
  /** 是否顺带清掉能证明是本目标留下的暂存残留与锁 */
  cleanResidue: z.boolean().optional(),
  note: z.string().max(500).nullable().optional()
})
export type RecoverInput = z.infer<typeof recoverInputSchema>

export const recoverResultSchema = z.object({
  releaseId: z.string(),
  mode: z.enum(['restore-old', 'abandon']),
  status: z.enum(['success', 'partial']),
  actions: z.array(
    z.object({ action: z.string(), ok: z.boolean(), detail: z.string().optional() })
  ),
  /** 需要人工处理的事项（失败的动作会进这里） */
  manualCleanup: z.array(z.string())
})
export type RecoverResult = z.infer<typeof recoverResultSchema>

/* ------------------------------------------------- 陈旧锁清理（T14.6） */

export const remoteLockInputSchema = z.object({ targetId: z.string().min(1) })
export type RemoteLockInput = z.infer<typeof remoteLockInputSchema>

export const remoteLockInfoSchema = z.object({
  targetId: z.string(),
  remotePath: z.string(),
  exists: z.boolean(),
  path: z.string(),
  releaseId: z.string().nullable(),
  hostname: z.string().nullable(),
  pid: z.number().nullable(),
  ts: z.string().nullable(),
  /** 超过 `LOCK_STALE_MS` 未更新 */
  stale: z.boolean(),
  /** 内容读不懂 */
  unreadable: z.boolean()
})
export type RemoteLockInfoView = z.infer<typeof remoteLockInfoSchema>

export const removeRemoteLockInputSchema = z.object({
  targetId: z.string().min(1),
  /** 必须显式确认：这是"人工判断后清理"，不是自动行为（方案书 §6.8） */
  confirmed: z.literal(true)
})
export type RemoveRemoteLockInput = z.infer<typeof removeRemoteLockInputSchema>

/** 强行清理锁时的提示文案（界面与服务端共用一份）。 */
export const LOCK_REMOVE_HINT =
  '远端锁只应由人确认后清理：它可能是另一台机器上正在进行的发布。' +
  '只有在确认没有其他人在操作这个目标时，才该删除它。'
