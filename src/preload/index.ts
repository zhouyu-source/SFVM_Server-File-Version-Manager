import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI, type ElectronAPI } from '@electron-toolkit/preload'
import { IPC_CHANNELS } from '../shared/channels'
import type { IpcResult } from '../shared/ipc'
import type {
  PingOutput,
  AppInfoOutput,
  DataLocationOutput,
  SetDataLocationInput,
  SetDataLocationOutput
} from '../shared/contracts/app'
import type { ConnectionView, ConnectionInput, TestResult } from '../shared/contracts/connection'
import type { ConnectionState } from '../shared/contracts/connection-state'
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
} from '../shared/contracts/workspace'
import type {
  JobCancelResult,
  JobClearResult,
  JobDemoInput,
  JobListFilter,
  JobLogBatch,
  JobProgress,
  JobView
} from '../shared/contracts/job'
import type {
  ArchiveDetail,
  ArchiveDetailInput,
  ArchiveDownloadInput,
  ArchiveDownloadPlan,
  ArchiveDownloadPlanInput,
  ArchiveRemoveInput,
  ArchiveRemoveResult,
  ArchiveSummary,
  ArchiveVerifyResult,
  ArchiveView,
  RetentionResult
} from '../shared/contracts/archive'
import type {
  DeployCleanResidueInput,
  DeployCurrentVersion,
  DeployPrecheckReport,
  DeployPreview,
  DeployResidueCleanResult,
  DeployStartInput
} from '../shared/contracts/deploy'
import type {
  RollbackPreview,
  RollbackPreviewInput,
  RollbackStartInput
} from '../shared/contracts/rollback'
import type {
  AppSettingsPatch,
  ConfigImportInput,
  ConfigImportResult,
  SettingsSnapshot
} from '../shared/contracts/settings'
import type { MenuCommandPayload } from '../shared/contracts/menu'
import type {
  ScriptCapabilities,
  ScriptRunDetailInput,
  ScriptRunListInput,
  ScriptRunView
} from '../shared/contracts/script'
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
} from '../shared/contracts/pipeline'
import type {
  DiagnoseInput,
  ReconcileInput,
  ReconcileReport,
  RecoverInput,
  RecoverResult,
  RecoveryDiagnosis,
  RemoteLockInfoView,
  StartupScan
} from '../shared/contracts/reconcile'

/**
 * Preload 白名单（方案书 §8.2）。
 *
 * 只做「暴露 + 形状约束」，不承载业务逻辑：
 * - 每个方法显式列出一个通道，**不接受渲染进程传通道名**
 *   （否则等于把整个 ipcMain 暴露出去，白名单失去意义）
 * - 返回值统一是 IpcResult 信封，由 renderer/api 层解包
 * - **凭据相关的明文永远不出现在这个对象上**：入参只接受用户输入的明文
 *   （主进程内立即加密），出参一律是脱敏视图（只有 hasSecret 布尔量）
 */
const api = {
  app: {
    ping: (): Promise<IpcResult<PingOutput>> => ipcRenderer.invoke(IPC_CHANNELS.APP_PING),
    info: (): Promise<IpcResult<AppInfoOutput>> => ipcRenderer.invoke(IPC_CHANNELS.APP_INFO),
    /** 选择私钥文件；返回 null 表示用户取消。只回传路径，不回传内容 */
    pickPrivateKey: (): Promise<IpcResult<{ path: string } | null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_PICK_PRIVATE_KEY),

    /** 选择本地产物（目录型选目录、文件型选文件）；返回 null 表示用户取消 */
    pickArtifact: (input: PickArtifactInput): Promise<IpcResult<{ path: string } | null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_PICK_ARTIFACT, input),

    /** 在文件管理器里打开（目录）或选中（文件）一个本地路径 */
    revealPath: (path: string): Promise<IpcResult<OpenShellResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_REVEAL_PATH, { path }),

    /** 在本机终端里打开一个本地目录 */
    openTerminal: (path: string): Promise<IpcResult<OpenShellResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_TERMINAL, { path }),

    /** 选择一个本地目录（下载保存位置）；返回 null 表示用户取消（B12 / T12.3） */
    pickDirectory: (input: PickDirectoryInput): Promise<IpcResult<{ path: string } | null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_PICK_DIRECTORY, input),

    /** 选择一个可执行文件；返回 null 表示用户取消（B20） */
    pickExecutable: (input: PickExecutableInput): Promise<IpcResult<{ path: string } | null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_PICK_EXECUTABLE, input),

    /** 读数据目录状态：生效目录 / 配置目录 / 日志目录（B18） */
    dataLocationGet: (): Promise<IpcResult<DataLocationOutput>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_DATA_LOCATION_GET),

    /** 改数据目录：复制台账 + 写指针，重启后生效（B18） */
    setDataLocation: (input: SetDataLocationInput): Promise<IpcResult<SetDataLocationOutput>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_DATA_LOCATION_SET, input)
  },

  connections: {
    list: (): Promise<IpcResult<ConnectionView[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_LIST),
    get: (id: string): Promise<IpcResult<ConnectionView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_GET, { id }),
    create: (input: ConnectionInput): Promise<IpcResult<ConnectionView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_CREATE, input),
    update: (id: string, patch: Partial<ConnectionInput>): Promise<IpcResult<ConnectionView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_UPDATE, { id, patch }),
    remove: (id: string): Promise<IpcResult<{ removed: boolean }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_REMOVE, { id }),

    /** 连接测试：可测已保存的连接（传 id），也可测表单里未保存的参数（传 input） */
    test: (params: { id?: string; input?: ConnectionInput }): Promise<IpcResult<TestResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_TEST, params),

    connect: (id: string): Promise<IpcResult<ConnectionState>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_CONNECT, { id }),
    disconnect: (id: string): Promise<IpcResult<{ disconnected: boolean }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_DISCONNECT, { id }),
    state: (id: string): Promise<IpcResult<ConnectionState>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_STATE, { id }),

    /** 首次连接后确认信任该主机指纹（TOFU 落库） */
    trustHostKey: (
      id: string,
      keyType: string,
      fingerprint: string
    ): Promise<IpcResult<{ trusted: boolean }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_TRUST_KEY, { id, keyType, fingerprint }),

    /** 本机能否安全保存密码（T03.2） */
    credentialStatus: (): Promise<
      IpcResult<{ available: boolean; backend: string; reason?: string }>
    > => ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_CREDENTIAL_STATUS),

    /** 订阅连接状态变化；返回取消订阅函数 */
    onState: (cb: (state: ConnectionState) => void): (() => void) => {
      const handler = (_e: unknown, state: ConnectionState): void => cb(state)
      ipcRenderer.on(IPC_CHANNELS.EVT_CONNECTION_STATE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EVT_CONNECTION_STATE, handler)
    }
  },

  /* -------------------------------------------- 工作环境与目标（B05） */
  env: {
    list: (): Promise<IpcResult<EnvironmentView[]>> => ipcRenderer.invoke(IPC_CHANNELS.ENV_LIST),
    get: (id: string): Promise<IpcResult<EnvironmentView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ENV_GET, { id }),
    create: (input: EnvironmentInput): Promise<IpcResult<EnvironmentView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ENV_CREATE, input),
    update: (id: string, patch: Partial<EnvironmentInput>): Promise<IpcResult<EnvironmentView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ENV_UPDATE, { id, patch }),
    remove: (id: string): Promise<IpcResult<{ removedTargets: number }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ENV_REMOVE, { id }),
    /** 删除前的"将影响什么"说明（强调不动服务器文件） */
    describeRemoval: (id: string): Promise<IpcResult<{ targetCount: number; warning: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ENV_DESCRIBE_REMOVAL, { id })
  },

  targets: {
    list: (environmentId: string): Promise<IpcResult<TargetView[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.TARGETS_LIST, { environmentId }),
    get: (id: string): Promise<IpcResult<TargetView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.TARGETS_GET, { id }),
    /** 新建目标会先体检；createMissingDir 仅用于用户明确选择"现在创建空目录" */
    create: (
      input: TargetInput & { createMissingDir?: boolean }
    ): Promise<IpcResult<TargetCreateResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.TARGETS_CREATE, input),
    update: (id: string, patch: Partial<TargetInput>): Promise<IpcResult<TargetView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.TARGETS_UPDATE, { id, patch }),
    remove: (
      id: string
    ): Promise<IpcResult<{ removedReleases: number; removedArchives: number }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.TARGETS_REMOVE, { id }),
    /** 体检：传 id 查已保存的目标，或传 input 查表单里的草稿目标（只读探测） */
    healthCheck: (params: { id?: string; input?: TargetInput }): Promise<IpcResult<HealthReport>> =>
      ipcRenderer.invoke(IPC_CHANNELS.TARGETS_HEALTH_CHECK, params),
    previewArchiveDir: (
      remotePath: string,
      archiveDir?: string | null
    ): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(IPC_CHANNELS.TARGETS_PREVIEW_ARCHIVE_DIR, { remotePath, archiveDir }),

    /** 本地产物的轻量探测（只 stat + 目录遍历，**不连服务器、不算哈希**） */
    artifactStat: (targetId: string): Promise<IpcResult<LocalArtifactInfo>> =>
      ipcRenderer.invoke(IPC_CHANNELS.TARGETS_ARTIFACT_STAT, { targetId })
  },

  /* ----------------------------------------------------- 任务编排（B08） */
  jobs: {
    list: (filter?: JobListFilter): Promise<IpcResult<JobView[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JOB_LIST, filter),
    get: (jobId: string): Promise<IpcResult<JobView | null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JOB_GET, { jobId }),
    cancel: (jobId: string): Promise<IpcResult<JobCancelResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JOB_CANCEL, { jobId }),
    /** 重试 = 新建任务，原任务记录保留（方案书 §6.11） */
    retry: (jobId: string): Promise<IpcResult<JobView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JOB_RETRY, { jobId }),
    /** 某目标上是否有进行中的任务（发布前置校验要用） */
    activeForTarget: (targetId: string): Promise<IpcResult<JobView[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JOB_ACTIVE_FOR_TARGET, { targetId }),
    /** 自检（假）任务：验证任务控制台与退出保护是否正常 */
    startDemo: (input?: JobDemoInput): Promise<IpcResult<JobView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JOB_START_DEMO, input),
    clearFinished: (): Promise<IpcResult<JobClearResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JOB_CLEAR_FINISHED),

    /** 任务状态变化（立即推送）。返回取消订阅函数 */
    onState: (cb: (job: JobView) => void): (() => void) => {
      const handler = (_e: unknown, job: JobView): void => cb(job)
      ipcRenderer.on(IPC_CHANNELS.EVT_JOB_STATE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EVT_JOB_STATE, handler)
    },
    /** 任务进度（主进程已按 200ms 节流） */
    onProgress: (cb: (progress: JobProgress) => void): (() => void) => {
      const handler = (_e: unknown, progress: JobProgress): void => cb(progress)
      ipcRenderer.on(IPC_CHANNELS.EVT_JOB_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EVT_JOB_PROGRESS, handler)
    },
    /** 任务日志（主进程已按 200ms 批量推送） */
    onLog: (cb: (batch: JobLogBatch) => void): (() => void) => {
      const handler = (_e: unknown, batch: JobLogBatch): void => cb(batch)
      ipcRenderer.on(IPC_CHANNELS.EVT_JOB_LOG, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EVT_JOB_LOG, handler)
    }
  },

  /* ------------------------------------------------ 往期版本（B09） */
  archives: {
    /** 某目标的往期版本列表（按归档时间倒序）；纯读台账，不连服务器 */
    list: (targetId: string): Promise<IpcResult<ArchiveView[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ARCHIVES_LIST, { targetId }),
    /** 重算远端哈希比对 manifest，并把结论落进台账 status */
    verify: (archiveId: string): Promise<IpcResult<ArchiveVerifyResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ARCHIVES_VERIFY, { archiveId }),
    /** 立即执行一次保留策略（发布成功后也会自动异步执行） */
    applyRetention: (targetId: string): Promise<IpcResult<RetentionResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ARCHIVES_APPLY_RETENTION, { targetId }),

    /** 台账口径的占用汇总（不连服务器，T12.6） */
    summary: (targetId: string): Promise<IpcResult<ArchiveSummary>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ARCHIVES_SUMMARY, { targetId }),

    /** 版本明细：读远端 manifest，返回摘要 + 一页文件清单（T12.7） */
    detail: (input: ArchiveDetailInput): Promise<IpcResult<ArchiveDetail>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ARCHIVES_DETAIL, input),

    /** 下载计划：算"会落到哪个本地目录"（不连服务器，T12.3） */
    downloadPlan: (input: ArchiveDownloadPlanInput): Promise<IpcResult<ArchiveDownloadPlan>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ARCHIVES_DOWNLOAD_PLAN, input),

    /** 下载一个往期版本：返回任务视图，进度走 jobs.onProgress（T12.3） */
    download: (input: ArchiveDownloadInput): Promise<IpcResult<JobView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ARCHIVES_DOWNLOAD, input),

    /** 手工删除勾选的版本；逐条返回结果（T12.5） */
    remove: (input: ArchiveRemoveInput): Promise<IpcResult<ArchiveRemoveResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ARCHIVES_REMOVE, input)
  },

  /* ------------------------------------------------------ 发布（B10） */
  deploy: {
    /**
     * 阶段 0 前置校验（full）：
     * 连接 / 本地产物（含指纹与体积）/ 远端目标 / 父目录可写 / 磁盘余量 /
     * 残留 / 锁 / 未结束的发布记录。UI 的确认弹窗直接拿这份报告渲染。
     */
    precheck: (targetId: string): Promise<IpcResult<DeployPrecheckReport>> =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_PRECHECK, { targetId }),

    /** 发起发布：立刻返回任务视图，进度/日志走 jobs.onProgress / onLog */
    start: (input: DeployStartInput): Promise<IpcResult<JobView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_START, input),

    /** 取消一次发布（等价于 job.cancel，单独留一个入口是为了语义清晰） */
    cancel: (jobId: string): Promise<IpcResult<JobCancelResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_CANCEL, { jobId }),

    /** 清理远端残留；只接受 precheck 报出来的那些路径 */
    cleanResidue: (input: DeployCleanResidueInput): Promise<IpcResult<DeployResidueCleanResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_CLEAN_RESIDUE, input),

    /**
     * 发布确认弹窗的差异预览（本地产物 vs 上次成功发布的清单）。
     * **不连服务器**：离线也能先看清"这次会改动什么"。
     */
    preview: (targetId: string): Promise<IpcResult<DeployPreview>> =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_PREVIEW, { targetId }),

    /** 当前线上版本（纯台账，不连服务器、不读本地文件） */
    currentVersion: (targetId: string): Promise<IpcResult<DeployCurrentVersion>> =>
      ipcRenderer.invoke(IPC_CHANNELS.DEPLOY_CURRENT_VERSION, { targetId })
  },

  /* ------------------------------------------------------ 回滚（B13） */
  rollback: {
    /**
     * 回滚前的对比预览（T13.3）：当前版本（台账里最近一次成功操作）
     * vs 所选往期版本。**不连服务器**。
     */
    preview: (input: RollbackPreviewInput): Promise<IpcResult<RollbackPreview>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ROLLBACK_PREVIEW, input),

    /** 发起回滚：立刻返回任务视图，进度/日志走 jobs.onProgress / onLog */
    start: (input: RollbackStartInput): Promise<IpcResult<JobView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.ROLLBACK_START, input)
  },

  /* ------------------------------------------------ 设置与配置（B15） */
  settings: {
    get: (): Promise<IpcResult<SettingsSnapshot>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),

    update: (patch: AppSettingsPatch): Promise<IpcResult<SettingsSnapshot>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, patch),

    /** 导出：拿 JSON 文本 + 建议文件名（不写文件） */
    export: (): Promise<IpcResult<{ text: string; suggestedName: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_EXPORT),

    /** 导出到文件（弹保存对话框）；用户取消时 path 为 null */
    exportToFile: (): Promise<IpcResult<{ path: string | null }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_EXPORT_TO_FILE),

    /** 从文件导入（弹打开对话框）；用户取消返回 null */
    importFromFile: (): Promise<IpcResult<ConfigImportResult | null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_IMPORT_FROM_FILE),

    /** 从文本导入（粘贴用） */
    import: (input: ConfigImportInput): Promise<IpcResult<ConfigImportResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_IMPORT, input)
  },

  /* ------------------------------------------------ 自定义脚本（B20） */
  scripts: {
    /** 总闸状态 + 本机可用的解释器（决定界面把哪些选项灰掉） */
    capabilities: (): Promise<IpcResult<ScriptCapabilities>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SCRIPTS_CAPABILITIES),

    /** 某个目标的运行记录（纯读台账） */
    runs: (input: ScriptRunListInput): Promise<IpcResult<ScriptRunView[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SCRIPTS_RUNS, input),

    /** 一次运行的详情 */
    runDetail: (input: ScriptRunDetailInput): Promise<IpcResult<ScriptRunView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SCRIPTS_RUN_DETAIL, input)
  },

  /* ---------------------------------------- 自动化流水线（B21 / T21.5） */
  pipelines: {
    /** 某个目标下的流水线（含步骤，按 seq 排好） */
    list: (input: PipelineListInput): Promise<IpcResult<PipelineView[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINES_LIST, input),

    detail: (input: PipelineDetailInput): Promise<IpcResult<PipelineView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINES_GET, input),

    /** 新建（不传 pipelineId）或整体覆盖保存 */
    save: (input: PipelineSaveInput): Promise<IpcResult<PipelineView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINES_SAVE, input),

    remove: (input: PipelineRemoveInput): Promise<IpcResult<{ removed: boolean }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINES_REMOVE, input),

    /** 「会执行什么」：纯本地展开，确认对话框据此渲染 */
    preview: (input: PipelinePreviewInput): Promise<IpcResult<PipelinePreview>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINES_PREVIEW, input),

    /** 一键跑整条；立刻返回任务视图，进度/日志走 jobs.onProgress / onLog */
    run: (input: PipelineRunInput): Promise<IpcResult<JobView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINES_RUN, input),

    /** 只跑其中一步（其余步骤不会被触发） */
    runStep: (input: PipelineRunStepInput): Promise<IpcResult<JobView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PIPELINES_RUN_STEP, input)
  },

  /* ------------------------------------------------ 菜单命令（B15 / T15.7） */
  menu: {
    /** 订阅主进程推来的菜单命令；返回取消订阅函数 */
    onCommand: (cb: (payload: MenuCommandPayload) => void): (() => void) => {
      const handler = (_e: unknown, payload: MenuCommandPayload): void => cb(payload)
      ipcRenderer.on(IPC_CHANNELS.EVT_MENU_COMMAND, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EVT_MENU_COMMAND, handler)
    }
  },

  /* ------------------------------------------------ 对账与恢复（B14） */
  reconcile: {
    /** 启动残留扫描（纯本地：只读台账里的非终态记录） */
    startupScan: (): Promise<IpcResult<StartupScan>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RECONCILE_STARTUP_SCAN, {}),

    /** 对账：列远端归档目录并与台账比对，返回完整报告 */
    run: (input: ReconcileInput): Promise<IpcResult<ReconcileReport>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RECONCILE_RUN, input),

    /** 崩溃恢复的现场勘察 */
    diagnose: (input: DiagnoseInput): Promise<IpcResult<RecoveryDiagnosis>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RECONCILE_DIAGNOSE, input),

    /** 收场（恢复旧版本 / 放弃并清理） */
    recover: (input: RecoverInput): Promise<IpcResult<RecoverResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RECONCILE_RECOVER, input),

    /** 看一眼远端锁 */
    lockInfo: (targetId: string): Promise<IpcResult<RemoteLockInfoView>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RECONCILE_LOCK_INFO, { targetId }),

    /**
     * 人工确认后删锁。
     * `confirmed` 在契约层被固定成 `true` —— 这个入口不能"顺手调一下"。
     */
    removeLock: (targetId: string): Promise<IpcResult<{ removed: boolean; path: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RECONCILE_REMOVE_LOCK, { targetId, confirmed: true })
  }
}

export type SfvmApi = typeof api

/**
 * 形状自检：确保暴露出去的对象与渲染进程声明的类型一致。
 * 若两边对不上，这里会编译失败 —— 比等到运行时报 undefined 好得多。
 * 类型声明见 src/renderer/src/types/global.d.ts。
 */
type ExposedWindow = Window & { electron: ElectronAPI; sfvm: SfvmApi }
const assertWindowShape = (w: ExposedWindow): void => void w
void assertWindowShape

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('sfvm', api)
  } catch (error) {
    console.error('contextBridge 暴露失败：', error)
  }
} else {
  // contextIsolation 固定开启（方案书 §3.2），保留分支仅为排查方便。
  // 用 globalThis 而不是 window：preload 目标可能是无 DOM 的上下文，
  // 这里只是赋值，不需要 window 的类型声明。
  const g = globalThis as unknown as { electron?: ElectronAPI; sfvm?: SfvmApi }
  g.electron = electronAPI
  g.sfvm = api
}
