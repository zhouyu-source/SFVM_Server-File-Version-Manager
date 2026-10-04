/**
 * IPC 通道名常量。
 *
 * 主进程注册与 preload 白名单都引用这里，避免两端字符串不一致
 * （写错一个字符就变成"通道不存在"的运行时错误，很难查）。
 */
export const IPC_CHANNELS = {
  /* ---------------------------------------------------------- 应用级 */
  APP_PING: 'app:ping',
  APP_INFO: 'app:info',
  /** 选择一个私钥文件（用途限定，不返回文件内容） */
  APP_PICK_PRIVATE_KEY: 'app:pickPrivateKey',
  /** 选择本地产物：目录型选目录、文件型选文件；取消返回 null（B11 / T11.1） */
  APP_PICK_ARTIFACT: 'app:pickArtifact',
  /** 在本机文件管理器里打开（目录）或选中（文件）一个本地路径（B11 / T11.7） */
  APP_REVEAL_PATH: 'app:revealPath',
  /** 在本机终端里打开一个本地目录（B11 / T11.7） */
  APP_OPEN_TERMINAL: 'app:openTerminal',
  /** 选择一个本地目录（默认值可给，用于下载保存位置）；取消返回 null（B12 / T12.3） */
  APP_PICK_DIRECTORY: 'app:pickDirectory',
  /** 读数据目录状态：生效目录 / 配置目录 / 日志目录（B18） */
  APP_DATA_LOCATION_GET: 'app:dataLocation.get',
  /** 改数据目录：复制台账 + 写指针文件，重启后生效（B18） */
  APP_DATA_LOCATION_SET: 'app:dataLocation.set',

  /* ------------------------------------------------------ 连接管理 T03.9 */
  CONNECTIONS_LIST: 'connections.list',
  CONNECTIONS_GET: 'connections.get',
  CONNECTIONS_CREATE: 'connections.create',
  CONNECTIONS_UPDATE: 'connections.update',
  CONNECTIONS_REMOVE: 'connections.remove',
  CONNECTIONS_TEST: 'connections.test',
  CONNECTIONS_CONNECT: 'connections.connect',
  CONNECTIONS_DISCONNECT: 'connections.disconnect',
  CONNECTIONS_STATE: 'connections.state',
  /** 首次连接后确认信任该主机指纹（TOFU） */
  CONNECTIONS_TRUST_KEY: 'connections.trustKey',
  /** 本机 safeStorage 是否可用（T03.2） */
  CONNECTIONS_CREDENTIAL_STATUS: 'connections.credentialStatus',
  /** 刻意保留的"禁止通道"：用于验证明文凭据不会经 IPC 外泄 */
  CONNECTIONS_REVEAL_SECRET: 'connections.revealSecret',

  /* -------------------------------------------------- 任务编排（B08 / T08.5） */
  JOB_LIST: 'job.list',
  JOB_GET: 'job.get',
  JOB_CANCEL: 'job.cancel',
  /** 重试 = 新建任务，保留原任务记录（方案书 §6.11） */
  JOB_RETRY: 'job.retry',
  /** 查询某目标上是否有进行中的任务（发布前置校验用） */
  JOB_ACTIVE_FOR_TARGET: 'job.activeForTarget',
  /** 自检（假）任务：sleep + 进度模拟，也是给用户的诊断入口 */
  JOB_START_DEMO: 'job.startDemo',
  /** 清理已结束任务的记录 */
  JOB_CLEAR_FINISHED: 'job.clearFinished',

  /* -------------------------------------------------- 事件推送（主 → 渲染） */
  /** 连接状态变化，载荷为 ConnectionState */
  EVT_CONNECTION_STATE: 'connections:state',
  /** 任务状态变化（立即推送，不节流），载荷为 JobView */
  EVT_JOB_STATE: 'job:state',
  /** 任务进度（200ms 节流），载荷为 JobProgress */
  EVT_JOB_PROGRESS: 'job:progress',
  /** 任务日志（200ms 批量），载荷为 JobLogBatch */
  EVT_JOB_LOG: 'job:log',
  /**
   * 菜单命令（B15 / T15.7），载荷为 `MenuCommandPayload`。
   *
   * 快捷键只在原生菜单里注册，渲染进程收不到按键事件 —— 所以「⌘N 新建连接」
   * 这类行为必须由主进程**翻译成命令推下来**，渲染进程才知道该做什么。
   */
  EVT_MENU_COMMAND: 'menu:command',

  /* -------------------------------------------------- 往期版本（B09 / T09.7） */
  ARCHIVES_LIST: 'archives.list',
  /** 重算远端哈希比对 manifest；不一致则把该版本标记为 corrupt */
  ARCHIVES_VERIFY: 'archives.verify',
  /** 手动执行一次保留策略（发布成功后也会自动异步执行） */
  ARCHIVES_APPLY_RETENTION: 'archives.applyRetention',
  /** 台账口径的占用汇总：条数 / 总字节 / 状态分布 / 时间跨度（**不连服务器**，T12.6） */
  ARCHIVES_SUMMARY: 'archives.summary',
  /** 版本明细：读远端 manifest，返回摘要 + 一页文件清单（**会连服务器**，T12.7） */
  ARCHIVES_DETAIL: 'archives.detail',
  /** 下载计划：算"会落到哪个本地目录"（**不连服务器**，T12.3 第一步） */
  ARCHIVES_DOWNLOAD_PLAN: 'archives.downloadPlan',
  /** 下载一个往期版本：内部走 JobService（可取消、有进度） */
  ARCHIVES_DOWNLOAD: 'archives.download',
  /**
   * 手工删除勾选的往期版本（T12.5）。
   *
   * **刻意不任务化**：结果必须逐条如实返回（哪几个删了、哪几个没删成、为什么），
   * 而任务框架只保留 `JobView`、不保存 `run()` 的返回值（B11 的教训）。
   * 删除条目上限 200，单次是"用户勾选"的量级，前端用一个带 loading 的确认弹窗
   * 承载即可；等真出现"一次删几千个"的需求，再迁到任务框架。
   */
  ARCHIVES_REMOVE: 'archives.remove',

  /* ------------------------------------------------------ 发布（B10 / T10.12） */
  /** 阶段 0 前置校验（full：连本地产物指纹与磁盘余量一起给，供确认弹窗用） */
  DEPLOY_PRECHECK: 'deploy.precheck',
  /** 发起发布：内部走 JobService（同一目标串行、可取消、有进度） */
  DEPLOY_START: 'deploy.start',
  /** 取消一次发布（默认走 JobService 的取消通道） */
  DEPLOY_CANCEL: 'deploy.cancel',
  /** 清理远端残留（只接受被残留识别器认出来的路径，见 deployCleanResidueInputSchema） */
  DEPLOY_CLEAN_RESIDUE: 'deploy.cleanResidue',
  /**
   * 发布确认弹窗用的**差异预览**（B11 / T11.3）：本地产物 vs 上次成功发布的清单，
   * 给出新增 / 修改 / 删除的条数。比 precheck 多一次本地哈希，所以**只在用户
   * 真的点了「发布」**时才调，不要拿它做列表页的装饰。
   */
  DEPLOY_PREVIEW: 'deploy.preview',
  /**
   * 当前线上版本（纯台账，不连服务器、不读本地文件）。
   * 目标详情页的「当前版本」用它 —— 别再拿 `deploy.preview` 代替：
   * 那个要求配了本地产物路径，还会算一次全量本地指纹。
   */
  DEPLOY_CURRENT_VERSION: 'deploy.currentVersion',

  /* ------------------------------------------------------ 回滚（B13 / T13.1~T13.5） */
  /**
   * 回滚前的**对比预览**（T13.3）：当前版本 vs 所选往期版本。
   * **纯本地**（读台账），与 `deploy.preview` 同一取舍 —— 离线也能先看清要改什么。
   */
  ROLLBACK_PREVIEW: 'rollback.preview',
  /** 发起回滚：走 JobService（同一目标串行、可取消、有进度），与发布抢同一把远端锁 */
  ROLLBACK_START: 'rollback.start',

  /* ------------------------------------------------ 对账与恢复（B14 / T14.1~T14.6） */
  /** 启动残留扫描：**纯本地**（只读台账启的非终态记录），启动时就能算 */
  RECONCILE_STARTUP_SCAN: 'reconcile.startupScan',
  /** 对账：列远端归档目录 → 与台账比对（补录 / 标缺失 / 可选深度校验） */
  RECONCILE_RUN: 'reconcile.run',
  /** 崩溃恢复的现场勘察：这次操作走到哪、目标现在什么样、能选什么 */
  RECONCILE_DIAGNOSE: 'reconcile.diagnose',
  /** 按选定方式收场（恢复旧版本 / 放弃并清理），结果逐条返回 */
  RECONCILE_RECOVER: 'reconcile.recover',
  /** 看一眼远端锁（是谁的、什么时候的） */
  RECONCILE_LOCK_INFO: 'reconcile.lockInfo',
  /** 人工确认后删锁（契约要求 confirmed: true） */
  RECONCILE_REMOVE_LOCK: 'reconcile.removeLock',

  /* ------------------------------------------------ 设置与配置（B15 / T15.1~T15.3） */
  /** 读全量设置 + 默认下载目录（设置页用） */
  SETTINGS_GET: 'settings.get',
  /** 改设置；返回改完之后的快照 */
  SETTINGS_UPDATE: 'settings.update',
  /** 导出配置：返回 JSON 文本 + 建议文件名（不写文件） */
  SETTINGS_EXPORT: 'settings.export',
  /** 导出到文件（弹保存对话框） */
  SETTINGS_EXPORT_TO_FILE: 'settings.exportToFile',
  /** 从文本导入 */
  SETTINGS_IMPORT: 'settings.import',
  /** 从文件导入（弹打开对话框） */
  SETTINGS_IMPORT_FROM_FILE: 'settings.importFromFile',

  /* ------------------------------------------ 工作环境与目标（B05 / T05.8） */
  ENV_LIST: 'env.list',
  ENV_GET: 'env.get',
  ENV_CREATE: 'env.create',
  ENV_UPDATE: 'env.update',
  ENV_REMOVE: 'env.remove',
  /** 删除前的"将影响什么"说明（含"不动服务器文件"的明确提示） */
  ENV_DESCRIBE_REMOVAL: 'env.describeRemoval',

  TARGETS_LIST: 'targets.list',
  TARGETS_GET: 'targets.get',
  TARGETS_CREATE: 'targets.create',
  TARGETS_UPDATE: 'targets.update',
  TARGETS_REMOVE: 'targets.remove',
  /** 对目标执行一次体检（只读，不写远端） */
  TARGETS_HEALTH_CHECK: 'targets.healthCheck',
  /** 仅推导归档目录，供表单实时预览（不连服务器） */
  TARGETS_PREVIEW_ARCHIVE_DIR: 'targets.previewArchiveDir',
  /** 本地产物轻量探测（只 stat + 目录遍历：文件数/体积/最近变动），**离线也能看** */
  TARGETS_ARTIFACT_STAT: 'targets.artifactStat'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/** 事件通道集合，便于 preload 只放行这些的订阅。 */
export const IPC_EVENT_CHANNELS = [
  IPC_CHANNELS.EVT_CONNECTION_STATE,
  IPC_CHANNELS.EVT_JOB_STATE,
  IPC_CHANNELS.EVT_JOB_PROGRESS,
  IPC_CHANNELS.EVT_JOB_LOG,
  IPC_CHANNELS.EVT_MENU_COMMAND
] as const
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]
