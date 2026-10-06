/**
 * 渲染进程 API 封装（T01.7）。
 *
 * 职责（方案书 §4.3：组件里不直接写 window.sfvm.xxx）：
 * 1. 解包 IpcResult 信封；
 * 2. 失败时抛带中文文案与错误码的业务异常，而不是把信封透给组件；
 * 3. 统一兜底：通道调用本身异常（如主进程未注册）也转成同一种异常。
 *
 * 组件里写 `const data = await api.app.ping()`，不需要 if (r.ok) 判断。
 */
import { describeError } from '../../../shared/errors'
import type { IpcResult } from '../../../shared/ipc'
import type {
  PingOutput,
  AppInfoOutput,
  DataLocationOutput,
  SetDataLocationOutput
} from '../../../shared/contracts/app'
import type {
  ConnectionView,
  ConnectionInput,
  ConnectionPatch,
  TestResult,
  CredentialStatus
} from '../../../shared/contracts/connection'
import type { ConnectionState } from '../../../shared/contracts/connection-state'
import type {
  EnvironmentView,
  EnvironmentInput,
  TargetView,
  TargetInput,
  TargetCreateResult,
  HealthReport,
  LocalArtifactInfo,
  OpenShellResult,
  PickArtifactInput,
  PickDirectoryInput,
  PickExecutableInput
} from '../../../shared/contracts/workspace'
import type {
  JobCancelResult,
  JobClearResult,
  JobDemoInput,
  JobListFilter,
  JobLogBatch,
  JobProgress,
  JobView
} from '../../../shared/contracts/job'
import type {
  ArchiveDetail,
  ArchiveDetailInput,
  ArchiveDownloadInput,
  ArchiveDownloadPlan,
  ArchiveDownloadPlanInput,
  ArchiveRemoveInput,
  ArchiveRemoveResult,
  ArchiveSummary,
  ArchiveView,
  ArchiveVerifyResult,
  RetentionResult
} from '../../../shared/contracts/archive'
import type {
  RollbackPreview,
  RollbackPreviewInput,
  RollbackStartInput
} from '../../../shared/contracts/rollback'
import type {
  AppSettingsPatch,
  ConfigImportInput,
  ConfigImportResult,
  SettingsSnapshot
} from '../../../shared/contracts/settings'
import type { MenuCommandPayload } from '../../../shared/contracts/menu'
import type {
  DiagnoseInput,
  ReconcileInput,
  ReconcileReport,
  RecoverInput,
  RecoverResult,
  RecoveryDiagnosis,
  RemoteLockInfoView,
  StartupScan
} from '../../../shared/contracts/reconcile'
import type {
  DeployCurrentVersion,
  DeployCleanResidueInput,
  DeployPrecheckReport,
  DeployPreview,
  DeployResidueCleanResult,
  DeployStartInput
} from '../../../shared/contracts/deploy'
import type {
  ScriptCapabilities,
  ScriptRunDetailInput,
  ScriptRunListInput,
  ScriptRunStepInput,
  ScriptRunView
} from '../../../shared/contracts/script'
import type {
  PipelineDetailInput,
  PipelineListInput,
  PipelinePreview,
  PipelinePreviewInput,
  PipelineRemoveInput,
  PipelineRunInput,
  PipelineRunStepInput,
  PipelineSaveInput,
  PipelineView
} from '../../../shared/contracts/pipeline'

/** 跨进程业务异常。组件可捕获后按 code 分支，或用 message 直接展示。 */
export class IpcBusinessError extends Error {
  readonly code: string
  readonly hint?: string
  readonly detail?: unknown

  constructor(code: string, message: string, hint?: string, detail?: unknown) {
    super(message)
    this.name = 'IpcBusinessError'
    this.code = code
    this.hint = hint
    this.detail = detail
  }

  /** 说明 + 建议，用于一次性展示给用户。 */
  toUserText(): string {
    return this.hint ? `${this.message}\n${this.hint}` : this.message
  }
}

/** 解包信封：成功返回 data，失败抛 IpcBusinessError。 */
function unwrap<T>(result: IpcResult<T>, channel: string): T {
  if (result && result.ok === true) return result.data

  // 走到这里说明失败。code/message 可能缺失（主进程崩溃、通道未注册等）
  const code = (result && !result.ok && result.code) || 'E_UNKNOWN'
  const desc = describeError(code)
  const message = (result && !result.ok && result.message) || desc.message
  const hint = (result && !result.ok && result.hint) || desc.hint
  const detail = result && !result.ok ? result.detail : { channel }

  throw new IpcBusinessError(code, message, hint, detail)
}

/** 包一层，兜住"根本没能发出请求"的情况。 */
async function call<T>(channel: string, invoke: () => Promise<IpcResult<T>>): Promise<T> {
  try {
    return unwrap(await invoke(), channel)
  } catch (err) {
    if (err instanceof IpcBusinessError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new IpcBusinessError(
      'E_UNKNOWN',
      describeError('E_UNKNOWN').message,
      `通道 ${channel} 调用失败：${msg}`
    )
  }
}

export const api = {
  app: {
    ping: (): Promise<PingOutput> => call('app:ping', () => window.sfvm.app.ping()),
    info: (): Promise<AppInfoOutput> => call('app:info', () => window.sfvm.app.info()),
    /** 选择私钥文件；取消返回 null */
    pickPrivateKey: (): Promise<{ path: string } | null> =>
      call('app:pickPrivateKey', () => window.sfvm.app.pickPrivateKey()),

    /** 选择本地产物；取消返回 null（B11 / T11.1） */
    pickArtifact: (input: PickArtifactInput): Promise<{ path: string } | null> =>
      call('app:pickArtifact', () => window.sfvm.app.pickArtifact(input)),

    /** 在文件管理器里打开/选中一个本地路径（B11 / T11.7） */
    revealPath: (path: string): Promise<OpenShellResult> =>
      call('app:revealPath', () => window.sfvm.app.revealPath(path)),

    /** 在本机终端里打开一个本地目录（B11 / T11.7） */
    openTerminal: (path: string): Promise<OpenShellResult> =>
      call('app:openTerminal', () => window.sfvm.app.openTerminal(path)),

    /** 选择一个本地目录（下载保存位置）；取消返回 null（B12 / T12.3） */
    pickDirectory: (input: PickDirectoryInput): Promise<{ path: string } | null> =>
      call('app:pickDirectory', () => window.sfvm.app.pickDirectory(input)),

    /** 选择一个可执行文件；取消返回 null（B20） */
    pickExecutable: (input: PickExecutableInput): Promise<{ path: string } | null> =>
      call('app:pickExecutable', () => window.sfvm.app.pickExecutable(input)),

    /** 读数据目录状态（B18） */
    dataLocationGet: (): Promise<DataLocationOutput> =>
      call('app:dataLocation.get', () => window.sfvm.app.dataLocationGet()),

    /**
     * 改数据目录：复制台账 + 写指针，**重启后生效**（B18）。
     * 失败时不抛错，返回 `{ ok:false, reason }` —— 原因本身就是给用户看的说明。
     */
    dataLocationSet: (dir: string | null): Promise<SetDataLocationOutput> =>
      call('app:dataLocation.set', () => window.sfvm.app.setDataLocation({ dir }))
  },

  connections: {
    list: (): Promise<ConnectionView[]> =>
      call('connections.list', () => window.sfvm.connections.list()),

    get: (id: string): Promise<ConnectionView> =>
      call('connections.get', () => window.sfvm.connections.get(id)),

    create: (input: ConnectionInput): Promise<ConnectionView> =>
      call('connections.create', () => window.sfvm.connections.create(input)),

    update: (id: string, patch: ConnectionPatch): Promise<ConnectionView> =>
      call('connections.update', () => window.sfvm.connections.update(id, patch)),

    remove: (id: string): Promise<{ removed: boolean }> =>
      call('connections.remove', () => window.sfvm.connections.remove(id)),

    test: (params: { id?: string; input?: ConnectionInput }): Promise<TestResult> =>
      call('connections.test', () => window.sfvm.connections.test(params)),

    connect: (id: string): Promise<ConnectionState> =>
      call('connections.connect', () => window.sfvm.connections.connect(id)),

    disconnect: (id: string): Promise<{ disconnected: boolean }> =>
      call('connections.disconnect', () => window.sfvm.connections.disconnect(id)),

    state: (id: string): Promise<ConnectionState> =>
      call('connections.state', () => window.sfvm.connections.state(id)),

    /** 首次连接后确认信任指纹（TOFU 落库） */
    trustHostKey: (
      id: string,
      keyType: string,
      fingerprint: string
    ): Promise<{ trusted: boolean }> =>
      call('connections.trustHostKey', () =>
        window.sfvm.connections.trustHostKey(id, keyType, fingerprint)
      ),

    /** 本机能否安全保存密码（T03.2 / T04.4） */
    credentialStatus: (): Promise<CredentialStatus> =>
      call('connections.credentialStatus', () => window.sfvm.connections.credentialStatus()),

    /**
     * 订阅连接状态变化。
     * 注意这是**事件**不是 invoke，没有 IpcResult 信封，因此不走 call()。
     */
    onState: (cb: (state: ConnectionState) => void): (() => void) =>
      window.sfvm.connections.onState(cb)
  },

  /* ---------------------------------------------- 工作环境与目标（B05） */
  env: {
    list: (): Promise<EnvironmentView[]> => call('env.list', () => window.sfvm.env.list()),
    get: (id: string): Promise<EnvironmentView> => call('env.get', () => window.sfvm.env.get(id)),
    create: (input: EnvironmentInput): Promise<EnvironmentView> =>
      call('env.create', () => window.sfvm.env.create(input)),
    update: (id: string, patch: Partial<EnvironmentInput>): Promise<EnvironmentView> =>
      call('env.update', () => window.sfvm.env.update(id, patch)),
    remove: (id: string): Promise<{ removedTargets: number }> =>
      call('env.remove', () => window.sfvm.env.remove(id)),
    /** 删除前的说明（含"不动服务器文件"的提示），供确认弹窗展示 */
    describeRemoval: (id: string): Promise<{ targetCount: number; warning: string }> =>
      call('env.describeRemoval', () => window.sfvm.env.describeRemoval(id))
  },

  targets: {
    list: (environmentId: string): Promise<TargetView[]> =>
      call('targets.list', () => window.sfvm.targets.list(environmentId)),
    get: (id: string): Promise<TargetView> =>
      call('targets.get', () => window.sfvm.targets.get(id)),
    create: (input: TargetInput & { createMissingDir?: boolean }): Promise<TargetCreateResult> =>
      call('targets.create', () => window.sfvm.targets.create(input)),
    update: (id: string, patch: Partial<TargetInput>): Promise<TargetView> =>
      call('targets.update', () => window.sfvm.targets.update(id, patch)),
    remove: (id: string): Promise<{ removedReleases: number; removedArchives: number }> =>
      call('targets.remove', () => window.sfvm.targets.remove(id)),
    /** 体检：传 id 查已保存的目标，或传 input 查表单里的草稿目标（只读探测） */
    healthCheck: (params: { id?: string; input?: TargetInput }): Promise<HealthReport> =>
      call('targets.healthCheck', () => window.sfvm.targets.healthCheck(params)),
    /** 仅推导归档目录（不连服务器），供表单实时预览 */
    previewArchiveDir: (remotePath: string, archiveDir?: string | null): Promise<string> =>
      call('targets.previewArchiveDir', () =>
        window.sfvm.targets.previewArchiveDir(remotePath, archiveDir)
      ),

    /** 本地产物轻量探测（不连服务器、不算哈希）—— 详情页徽标用 */
    artifactStat: (targetId: string): Promise<LocalArtifactInfo> =>
      call('targets.artifactStat', () => window.sfvm.targets.artifactStat(targetId))
  },

  /* ----------------------------------------------------- 任务编排（B08） */
  jobs: {
    list: (filter?: JobListFilter): Promise<JobView[]> =>
      call('job.list', () => window.sfvm.jobs.list(filter)),

    get: (jobId: string): Promise<JobView | null> =>
      call('job.get', () => window.sfvm.jobs.get(jobId)),

    cancel: (jobId: string): Promise<JobCancelResult> =>
      call('job.cancel', () => window.sfvm.jobs.cancel(jobId)),

    retry: (jobId: string): Promise<JobView> => call('job.retry', () => window.sfvm.jobs.retry(jobId)),

    activeForTarget: (targetId: string): Promise<JobView[]> =>
      call('job.activeForTarget', () => window.sfvm.jobs.activeForTarget(targetId)),

    /** 自检（假）任务：任务控制台/退出保护出问题时，先跑它定位 */
    startDemo: (input?: JobDemoInput): Promise<JobView> =>
      call('job.startDemo', () => window.sfvm.jobs.startDemo(input)),

    clearFinished: (): Promise<JobClearResult> =>
      call('job.clearFinished', () => window.sfvm.jobs.clearFinished()),

    /* 以下是**事件**订阅，没有 IpcResult 信封，因此不走 call() */
    onState: (cb: (job: JobView) => void): (() => void) => window.sfvm.jobs.onState(cb),
    onProgress: (cb: (progress: JobProgress) => void): (() => void) =>
      window.sfvm.jobs.onProgress(cb),
    onLog: (cb: (batch: JobLogBatch) => void): (() => void) => window.sfvm.jobs.onLog(cb)
  },

  /* ------------------------------------------------- 往期版本（B09） */
  archives: {
    /** 往期版本列表（按归档时间倒序）：纯读台账，离线也能看 */
    list: (targetId: string): Promise<ArchiveView[]> =>
      call('archives.list', () => window.sfvm.archives.list(targetId)),

    /** 校验某个往期版本：会连服务器重算哈希，耗时取决于产物大小 */
    verify: (archiveId: string): Promise<ArchiveVerifyResult> =>
      call('archives.verify', () => window.sfvm.archives.verify(archiveId)),

    /** 立即执行保留策略；返回删了什么、失败什么（失败不回滚台账） */
    applyRetention: (targetId: string): Promise<RetentionResult> =>
      call('archives.applyRetention', () => window.sfvm.archives.applyRetention(targetId)),

    /** 台账口径的占用汇总（不连服务器）：条数 / 总字节 / 状态分布 / 时间跨度 */
    summary: (targetId: string): Promise<ArchiveSummary> =>
      call('archives.summary', () => window.sfvm.archives.summary(targetId)),

    /** 版本明细：读远端 manifest，返回摘要 + 一页文件清单（会连服务器） */
    detail: (input: ArchiveDetailInput): Promise<ArchiveDetail> =>
      call('archives.detail', () => window.sfvm.archives.detail(input)),

    /** 下载计划：算"会落到哪个本地目录"（不连服务器） */
    downloadPlan: (input: ArchiveDownloadPlanInput): Promise<ArchiveDownloadPlan> =>
      call('archives.downloadPlan', () => window.sfvm.archives.downloadPlan(input)),

    /** 下载一个往期版本；返回任务视图，进度订阅 jobs.onProgress */
    download: (input: ArchiveDownloadInput): Promise<JobView> =>
      call('archives.download', () => window.sfvm.archives.download(input)),

    /** 手工删除勾选的版本；逐条返回结果（哪几个删了、哪几个没删成、为什么） */
    remove: (input: ArchiveRemoveInput): Promise<ArchiveRemoveResult> =>
      call('archives.remove', () => window.sfvm.archives.remove(input))
  },

  /* ------------------------------------------------------- 发布（B10） */
  deploy: {
    /** 前置校验（会连服务器；第一次发布也要先跑它，用户才知道"会发生什么"） */
    precheck: (targetId: string): Promise<DeployPrecheckReport> =>
      call('deploy.precheck', () => window.sfvm.deploy.precheck(targetId)),

    /** 发起发布：返回任务视图；进度与日志订阅 jobs.onProgress / jobs.onLog */
    start: (input: DeployStartInput): Promise<JobView> =>
      call('deploy.start', () => window.sfvm.deploy.start(input)),

    /** 取消本次发布（内部走 JobService 的取消，清理由任务层负责） */
    cancel: (jobId: string): Promise<JobCancelResult> =>
      call('deploy.cancel', () => window.sfvm.deploy.cancel(jobId)),

    /** 清理远端残留（只接受 precheck 报出来的路径） */
    cleanResidue: (input: DeployCleanResidueInput): Promise<DeployResidueCleanResult> =>
      call('deploy.cleanResidue', () => window.sfvm.deploy.cleanResidue(input)),

    /** 发布确认弹窗的差异预览（本地产物 vs 上次成功发布的清单；不连服务器） */
    preview: (targetId: string): Promise<DeployPreview> =>
      call('deploy.preview', () => window.sfvm.deploy.preview(targetId)),

    /** 当前线上版本（纯台账）：目标详情页的「当前版本」用它 */
    currentVersion: (targetId: string): Promise<DeployCurrentVersion> =>
      call('deploy.currentVersion', () => window.sfvm.deploy.currentVersion(targetId))
  },

  /* ------------------------------------------------------ 回滚（B13） */
  rollback: {
    /** 回滚对比预览：当前版本 vs 所选往期版本（不连服务器） */
    preview: (input: RollbackPreviewInput): Promise<RollbackPreview> =>
      call('rollback.preview', () => window.sfvm.rollback.preview(input)),

    /** 发起回滚；返回任务视图，进度订阅 jobs.onProgress */
    start: (input: RollbackStartInput): Promise<JobView> =>
      call('rollback.start', () => window.sfvm.rollback.start(input))
  },

  /* ------------------------------------------------ 设置与配置（B15） */
  settings: {
    /** 读全量设置 + 默认下载目录 */
    get: (): Promise<SettingsSnapshot> => call('settings.get', () => window.sfvm.settings.get()),

    /** 改设置；返回改完之后的快照 */
    update: (patch: AppSettingsPatch): Promise<SettingsSnapshot> =>
      call('settings.update', () => window.sfvm.settings.update(patch)),

    /** 导出配置：拿 JSON 文本（不写文件） */
    export: (): Promise<{ text: string; suggestedName: string }> =>
      call('settings.export', () => window.sfvm.settings.export()),

    /** 导出到文件；用户取消返回 { path: null } */
    exportToFile: (): Promise<{ path: string | null }> =>
      call('settings.exportToFile', () => window.sfvm.settings.exportToFile()),

    /** 从文件导入；用户取消返回 null */
    importFromFile: (): Promise<ConfigImportResult | null> =>
      call('settings.importFromFile', () => window.sfvm.settings.importFromFile()),

    /** 从文本导入（粘贴） */
    import: (input: ConfigImportInput): Promise<ConfigImportResult> =>
      call('settings.import', () => window.sfvm.settings.import(input))
  },

  /* ------------------------------------------------ 自定义脚本（B20） */
  scripts: {
    capabilities: (): Promise<ScriptCapabilities> =>
      call('scripts.capabilities', () => window.sfvm.scripts.capabilities()),

    /** 跑一条脚本：立刻返回任务视图，进度与日志走 jobs.onProgress / onLog */
    runStep: (input: ScriptRunStepInput): Promise<JobView> =>
      call('scripts.runStep', () => window.sfvm.scripts.runStep(input)),

    runs: (input: ScriptRunListInput): Promise<ScriptRunView[]> =>
      call('scripts.runs', () => window.sfvm.scripts.runs(input)),

    runDetail: (input: ScriptRunDetailInput): Promise<ScriptRunView> =>
      call('scripts.runDetail', () => window.sfvm.scripts.runDetail(input))
  },

  /* ---------------------------------------- 自动化流水线（B21 / T21.5） */
  pipelines: {
    list: (input: PipelineListInput): Promise<PipelineView[]> =>
      call('pipelines.list', () => window.sfvm.pipelines.list(input)),

    detail: (input: PipelineDetailInput): Promise<PipelineView> =>
      call('pipelines.get', () => window.sfvm.pipelines.detail(input)),

    save: (input: PipelineSaveInput): Promise<PipelineView> =>
      call('pipelines.save', () => window.sfvm.pipelines.save(input)),

    remove: (input: PipelineRemoveInput): Promise<{ removed: boolean }> =>
      call('pipelines.remove', () => window.sfvm.pipelines.remove(input)),

    /** 「会执行什么」：纯本地，不连服务器 */
    preview: (input: PipelinePreviewInput): Promise<PipelinePreview> =>
      call('pipelines.preview', () => window.sfvm.pipelines.preview(input)),

    /** 一键跑整条 */
    run: (input: PipelineRunInput): Promise<JobView> =>
      call('pipelines.run', () => window.sfvm.pipelines.run(input)),

    /** 只跑其中一步 */
    runStep: (input: PipelineRunStepInput): Promise<JobView> =>
      call('pipelines.runStep', () => window.sfvm.pipelines.runStep(input))
  },

  /* ------------------------------------------------ 菜单命令（B15 / T15.7） */
  menu: {
    /** 订阅菜单命令。事件订阅没有 IpcResult 信封，因此不走 call()。 */
    onCommand: (cb: (payload: MenuCommandPayload) => void): (() => void) =>
      window.sfvm.menu.onCommand(cb)
  },

  /* ------------------------------------------------ 对账与恢复（B14） */
  reconcile: {
    /** 启动残留扫描（纯本地），应用启动时调一次 */
    startupScan: (): Promise<StartupScan> =>
      call('reconcile.startupScan', () => window.sfvm.reconcile.startupScan()),

    /** 对账：补录远端多出来的版本、标记已失效的版本，可选深度校验 */
    run: (input: ReconcileInput): Promise<ReconcileReport> =>
      call('reconcile.run', () => window.sfvm.reconcile.run(input)),

    /** 崩溃恢复的现场勘察 */
    diagnose: (input: DiagnoseInput): Promise<RecoveryDiagnosis> =>
      call('reconcile.diagnose', () => window.sfvm.reconcile.diagnose(input)),

    /** 按选定方式收场（恢复旧版本 / 放弃并清理） */
    recover: (input: RecoverInput): Promise<RecoverResult> =>
      call('reconcile.recover', () => window.sfvm.reconcile.recover(input)),

    /** 看一眼远端锁（是谁的、什么时候的） */
    lockInfo: (targetId: string): Promise<RemoteLockInfoView> =>
      call('reconcile.lockInfo', () => window.sfvm.reconcile.lockInfo(targetId)),

    /** 人工确认后删锁 */
    removeLock: (targetId: string): Promise<{ removed: boolean; path: string }> =>
      call('reconcile.removeLock', () => window.sfvm.reconcile.removeLock(targetId))
  }
}
