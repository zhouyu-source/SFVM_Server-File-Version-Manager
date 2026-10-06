import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { initLogger, logFilePath, logger, setLogLevel } from './infra/logger'
import {
  cleanupAbandonedDataDir,
  clearDataLocation,
  logDirOf,
  readDataLocation,
  sameDir,
  writeDataLocation
} from './infra/data-location'
import { commandTargetWindow, installAppMenu } from './menu'
import { toAppError } from './infra/errors'
import { registerSettingsHandlers } from './ipc/settings'
import { createSettingsService } from './services/settings'
import { createDataLocationService } from './services/data-location'
import { readFile as readTextFile, writeFile as writeTextFile } from 'node:fs/promises'
import { registerAppHandlers } from './ipc/app'
import { registerConnectionHandlers } from './ipc/connections'
import { registerWorkspaceHandlers } from './ipc/workspace'
import { registerArchiveHandlers } from './ipc/archive'
import { registerDeployHandlers } from './ipc/deploy'
import { registerRollbackHandlers } from './ipc/rollback'
import { registerReconcileHandlers } from './ipc/reconcile'
import { registerScriptHandlers } from './ipc/script'
import { closeAppDatabase, getRepositories, openAppDatabase, openedDataDir, backupDatabaseTo } from './db'
import { DB_FILENAME } from './db/client'
import { SshConnectionPool } from './services/ssh-client'
import { createConnectionService } from './services/connection'
import { createWorkspaceService } from './services/workspace'
import { createJobService } from './services/job'
import { createArchiveService } from './services/archive'
import { createArchiveDownloadService } from './services/archive-download'
import { createDeployService } from './services/deploy'
import { createRollbackService } from './services/rollback'
import { createReconcileService } from './services/reconcile'
import { createScriptService } from './services/script'
import {
  attachJobEventPush,
  createJobGuard,
  registerJobHandlers,
  type JobGuard
} from './ipc/job'
import { IPC_CHANNELS } from '../shared/channels'
import { DEFAULT_DOWNLOAD_DIR_NAME } from '../shared/contracts/archive'

/**
 * 启动看门狗超时（毫秒）。
 * 见《开发计划书》B00 记录：本机安全软件会拦截渲染进程沙箱，表现为
 * 「主进程活着但窗口永不出现」的隐形僵尸，并占住单实例锁导致后续启动全部静默退出。
 * 因此窗口在超时内未渲染完成时，必须显式提示并退出，绝不能挂着不动。
 */
const RENDER_TIMEOUT_MS = is.dev ? 60_000 : 30_000

/**
 * 备好的数据目录（B18）。
 *
 * 只在 `whenReady` 里解析一次，之后三个地方要用它：日志落点、数据库位置、
 * 以及 `logStartup()` 的第三个写入目标。放在模块级是因为 `logStartup()`
 * 在 ready 之前也会被调用（单实例锁那条分支），那时它还是 null。
 */
let bootstrapDataDir: string | null = null

/**
 * 启动日志三路径：项目内 + userData + 数据目录，任一可写即可
 * （用户机器上 userData 侧可能不可写；数据目录则可能还没解析出来）。
 *
 * 第三份是 B18 加的：数据目录可配之后，"日志都在 `<数据目录>/log` 里"
 * 必须包括 `startup.log` —— 否则用户改完数据目录，在新目录里只看到
 * electron-log 的 `main.log`，而最关键的启动过程日志还留在旧地方。
 */
function logStartup(line: string): void {
  const stamp = new Date().toISOString()
  const entry = `[${stamp}] ${line}\n`
  const targets = [
    join(process.cwd(), '.logs', 'startup.log'),
    join(app.getPath('userData'), 'logs', 'startup.log'),
    ...(bootstrapDataDir ? [join(logDirOf(bootstrapDataDir), 'startup.log')] : [])
  ]
  for (const target of targets) {
    try {
      mkdirSync(join(target, '..'), { recursive: true })
      appendFileSync(target, entry, 'utf8')
    } catch {
      // 某个路径不可写是预期情况，继续尝试下一个
    }
  }
}

/**
 * 本机适配（默认关闭）：部分 Windows 机器上安全软件会拦截 Chromium 的 **GPU 进程**，
 * 表现为 gpu_process_host.cc 反复报 `GPU process launch failed: error_code=18`，
 * 随后 `gpu_data_manager_impl_private.cc` 判定 GPU 不可用并 FATAL 退出
 * （退出码 -2147483645）。
 *
 * 这里只关 GPU 相关能力，**不动渲染进程沙箱** —— 本工具要保管 SSH 密码并操作生产服务器，
 * 渲染进程沙箱是重要防线，不能用 --no-sandbox 换启动。
 *
 * 用法：set SFVM_DISABLE_GPU=1 && pnpm dev
 * 参考《开发计划书》B00「环境问题：Windows 安全软件拦截 Electron 进程沙箱」。
 *
 * **门控（B16）**：只在 `is.dev`（即未打包）时读环境变量。产物里即使有人设了同名
 * 环境变量也不会生效 —— 否则"产物禁止带这些开关"就只是口头约定，一旦用户机器上
 * 恰好存在该变量，防线会被静默削掉。E2E 用裸 `electron .` 驱动 out/，`app.isPackaged`
 * 为 false，因此开发期与 E2E 都照旧可用。
 */
if (is.dev && process.env['SFVM_DISABLE_GPU'] === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  logStartup('SFVM_DISABLE_GPU=1 - GPU disabled (workaround for GPU process launch failure)')
}

/**
 * 开发期逃生开关（**仅开发期使用，绝不可写进打包产物**）。
 *
 * 本机安全软件会让 Chromium 的进程沙箱初始化失败，表现为渲染进程
 * `render-process-gone {"reason":"launch-failed","exitCode":18}`、窗口永不出现。
 * 关掉沙箱可让开发继续，但会削弱防线 —— 本工具保管 SSH 密码并操作生产服务器，
 * 所以这里坚持「显式开启才生效」，并且构建产物不得设置该变量。
 *
 * 用法：set SFVM_NO_SANDBOX=1 && pnpm dev:nosandbox
 *
 * **门控（B16）**：同 `SFVM_DISABLE_GPU` —— 打包产物内**无论环境变量怎么写都不生效**
 * （见 `.tools/HANDOFF.md` §2.4）。产物里没有任何启动开关，渲染进程沙箱恒为开。
 */
if (is.dev && process.env['SFVM_NO_SANDBOX'] === '1') {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('disable-setuid-sandbox')
  logStartup('SFVM_NO_SANDBOX=1 - renderer sandbox DISABLED (development workaround only)')
}

let rendererLaunched = false
let watchdog: NodeJS.Timeout | undefined
/** 连接池句柄，退出时用于断开所有 SSH 会话（B03） */
let sshPool: SshConnectionPool | undefined
/** 退出保护句柄（B08）：窗口关闭与 before-quit 都要经过它 */
let jobGuard: JobGuard | undefined
/** 任务事件推送的退订函数（B08）：退出时先断，避免推给已销毁的窗口 */
let detachJobPush: (() => void) | undefined

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'SFVM',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线（方案书 §3.2）：这三点不得放宽
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => {
    rendererLaunched = true
    if (watchdog) clearTimeout(watchdog)
    win.show()
    logStartup('window ready-to-show: renderer is alive, showing window')
  })

  // B08 退出保护：有运行中任务时，关窗口要先确认（方案书 §6.11）
  jobGuard?.attachWindow(win)

  // 用户点击外链时交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 渲染进程崩溃/启动失败必须有明确提示，否则表现为「命令跑完什么都没发生」。
  // 注意：这里一律用**非阻塞** showMessageBox。用 showMessageBoxSync 会阻塞主进程，
  // 无人点确定时会挂成僵尸并占住单实例锁（《开发计划书》B00 记录过的坑）。
  win.webContents.on('render-process-gone', (_event, details) => {
    logStartup(`render-process-gone ${JSON.stringify(details)}`)
    if (details.reason === 'launch-failed') {
      rendererLaunched = true // 阻止 window-all-closed 提前退出，保证提示能被看到
      void dialog
        .showMessageBox({
          type: 'error',
          title: 'SFVM 启动失败',
          message: '渲染进程无法启动',
          detail:
            `Electron 报告原因：${details.reason}（exitCode=${details.exitCode}）\n\n` +
            '常见原因：安全软件拦截了 Electron 的进程沙箱。\n' +
            '处理：把 node_modules\\electron\\dist\\electron.exe 加入安全软件信任区；\n' +
            '临时绕过：pnpm dev:nosandbox',
          buttons: ['退出']
        })
        .finally(() => app.exit(1))
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// 单实例锁：失败时不再静默退出，而是给出可诊断的信息（方案书 B00 遗留教训）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  logStartup('requestSingleInstanceLock returned false - another instance holds the lock')
  void app.whenReady().then(async () => {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'SFVM 已在运行',
      message: '另一个 SFVM 实例正在运行，本次启动已退出。',
      detail:
        `应用路径：${app.getAppPath()}\n` +
        `数据目录：${readDataLocation(app.getPath('userData')).dir}\n` +
        `Electron：${process.versions.electron}\n\n` +
        '若确认没有实例在运行，说明有残留的隐形僵尸进程占着单实例锁，' +
        '请在任务管理器中结束 electron 进程后重试。',
      buttons: ['确定']
    })
    app.exit(0)
  })
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    /**
     * B18：**先解析数据目录**，再初始化日志、再开库。
     *
     * 顺序不能反：日志要落到 `<数据目录>/log`、数据库要开在数据目录里，
     * 两者都依赖这一步。解析只读一个指针文件，读不出来就回退默认目录 ——
     * 但回退的**原因**必须写进启动日志与设置页，不能静默（用户会看到
     * "我的数据怎么不见了"，而真相是"自定义目录这台机器上挂不上"）。
     */
    const defaultDataDir = app.getPath('userData')
    const resolved = readDataLocation(defaultDataDir)
    bootstrapDataDir = resolved.dir

    // B01：先初始化日志，之后所有环节都用带脱敏的 logger
    initLogger({ logDir: logDirOf(resolved.dir) })
    const banner =
      `app ready: electron=${process.versions.electron} node=${process.versions.node} ` +
      `userData=${defaultDataDir} dataDir=${resolved.dir} ` +
      `logDir=${logDirOf(resolved.dir)} cwd=${process.cwd()}`
    logger.info(banner)
    logStartup(banner)
    if (resolved.reason) {
      logger.warn(`dataLocation: ${resolved.reason}`)
      logStartup(`dataLocation: ${resolved.reason}`)
    }
    electronApp.setAppUserModelId('com.sfvm.app')

    // B02：打开数据库（含外键/WAL 设置与自动迁移、迁移前备份）
    try {
      openAppDatabase(resolved.dir)
    } catch (err) {
      // `AppError` 的 message 只说"发生了什么"，hint 才是"该怎么办" —— 两个都要给用户看。
      // 以前只取 `e.message`，于是"迁移脚本缺失 → 请重新获取完整安装包"这类
      // **可照做的建议会被丢掉**，用户拿到的只有一句干巴巴的失败原因，
      // 结果就是本次事故（产物打不开）只能靠翻日志才查得出来。
      const e = toAppError(err)
      logger.error(`database init failed: ${e.toUserText()}`)
      // 不静默继续：数据库是台账来源，起不来就不该让用户以为一切正常
      void dialog
        .showMessageBox({
          type: 'error',
          title: 'SFVM 数据库初始化失败',
          message: '无法打开本地台账数据库，应用将退出。',
          detail:
            `${e.toUserText()}\n\n` +
            `数据目录：${resolved.dir}\n` +
            '迁移前的备份文件（sfvm.db.bak-*）也保留在该目录中，可据此恢复。',
          buttons: ['退出']
        })
        .finally(() => app.exit(1))
      return
    }

    /**
     * B18：清掉"上一处数据目录"。
     *
     * 三条顺序上的讲究：
     * 1. **必须在新库已经打开成功之后**。新目录里的库要是起不来，旧目录那一份
     *    就是用户唯一的退路 —— 先删就真没救了（上面那个分支会弹框退出，不删）。
     * 2. 在**日志已经指向新目录之后**（`initLogger` 在前面），所以清掉旧 `log/`
     *    不会碰到正在写的日志文件。
     * 3. 清单里的每一项都走 `cleanupAbandonedDataDir()` 的守卫：认领过、不是当前
     *    目录、不是它的上级、不是根目录/主目录，才真的删。
     *
     * 失败项（多半是"仍被别的进程占用"）留在清单里，下次启动再试；
     * 其余情况都要把清单重写干净，免得每次启动都做无用功。
     */
    if (resolved.cleanupDirs.length > 0) {
      const stillPending: string[] = []
      for (const dir of resolved.cleanupDirs) {
        const r = cleanupAbandonedDataDir(dir, {
          currentDir: resolved.dir,
          defaultDir: defaultDataDir,
          dbFileName: DB_FILENAME
        })
        const line = r.gone
          ? `dataLocation cleanup: 已删除原数据目录 ${r.dir}`
          : `dataLocation cleanup: ${r.dir} — ${r.reason}`
        logger.info(line)
        logStartup(line)
        if (r.retry) stillPending.push(r.dir)
      }
      try {
        if (sameDir(resolved.dir, defaultDataDir) && stillPending.length === 0) {
          clearDataLocation(defaultDataDir)
        } else {
          writeDataLocation(defaultDataDir, resolved.dir, stillPending)
        }
      } catch (err) {
        logger.warn(`dataLocation cleanup: 更新待清理清单失败：${(err as Error).message}`)
      }
    }

    /**
     * B18：数据目录服务。
     *
     * 必须建在 `registerAppHandlers()` **之前**：它要读"当前生效目录"
     * （此时已开库，拿得到），并跟着 IPC 注册一起接进去。
     */
    const dataLocationService = createDataLocationService({
      defaultDir: () => app.getPath('userData'),
      currentDir: () => openedDataDir() ?? app.getPath('userData'),
      logFile: logFilePath,
      backupTo: async (dir) => {
        await backupDatabaseTo(dir)
      },
      log: (m) => logger.info(m)
    })

    // B01：统一 IPC 注册框架（入参 Zod 校验 + IpcResult 信封）
    registerAppHandlers({ dataLocation: dataLocationService })

    /**
     * 「允许执行自定义脚本」总闸的取值函数（B20）。
     *
     * 连接池比设置服务先构造，所以这里先放一个**默认拒绝**的实现，
     * 等设置服务建好之后再换成真正的读法（见下面的赋值处）。
     * 默认值取"拒绝"是刻意的：万一哪次改动漏了这一句，后果是"用户脚本用不了"，
     * 而不是"悄悄给本机开了个可执行任意命令的入口"。
     */
    let allowUserScripts = (): boolean => false

    // B03：SSH 连接池 + 连接管理服务
    const pool = new SshConnectionPool({ allowRawExec: () => allowUserScripts() })
    const repo = getRepositories()

    /**
     * B15：应用设置（T15.1~T15.3）。
     *
     * 建在**所有业务服务之前**：新建目标要继承默认保留策略（T15.2），
     * 传输要取并发数、校验要取算法兼容模式 —— 它们都靠注入的函数现取。
     *
     * 日志级别在这里落一次地：`initLogger()` 用的是开发/生产默认，
     * 而用户选过的级别存在数据库里，必须**先开库、后应用**。
     */
    const settingsService = createSettingsService({
      repo,
      appVersion: app.getVersion(),
      // 默认下载到"系统下载目录/sfvm-downloads"（T12.3）。
      // 放在接线层算是因为要 `app.getPath`，而服务与 ipc 层刻意不 import electron。
      defaultDownloadDir: () => join(app.getPath('downloads'), DEFAULT_DOWNLOAD_DIR_NAME),
      applyLogLevel: setLogLevel
    })
    // 应用用户选过的日志级别（没选过时给 null，等于"跟随默认"）
    setLogLevel(settingsService.current().logLevel)
    // B20：把总闸接到真正的设置项上（默认拒绝的占位实现到此为止）
    allowUserScripts = () => settingsService.current().allowUserScripts

    registerSettingsHandlers({
      settings: settingsService,
      // 文件对话框留在接线层（ipc/settings.ts 刻意不 import electron）
      saveTextFile: async ({ suggestedName, text }) => {
        const r = await dialog.showSaveDialog({
          title: '导出配置',
          defaultPath: join(app.getPath('documents'), suggestedName),
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (r.canceled || !r.filePath) return null
        await writeTextFile(r.filePath, text, 'utf8')
        return { path: r.filePath }
      },
      openTextFile: async () => {
        const r = await dialog.showOpenDialog({
          title: '导入配置',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (r.canceled || r.filePaths.length === 0) return null
        const path = r.filePaths[0]!
        return { path, text: await readTextFile(path, 'utf8') }
      }
    })

    // B15：应用菜单与加速键（T15.7）
    installAppMenu({
      logFile: logFilePath,
      // B18：菜单里的"打开数据目录"要跟着配置走，不能再写死 userData
      userDataDir: () => openedDataDir() ?? app.getPath('userData'),
      send: (command) => {
        const win = commandTargetWindow()
        if (win && !win.isDestroyed()) win.webContents.send(IPC_CHANNELS.EVT_MENU_COMMAND, { command })
      }
    })

    const connectionService = createConnectionService({ repo, pool })
    registerConnectionHandlers(connectionService)
    sshPool = pool

    // B05：工作环境与目标资源
    const workspaceService = createWorkspaceService({
      repo,
      // T15.2：新建目标时继承设置里的默认保留策略
      defaultRetainPolicy: () => settingsService.current().defaultRetainPolicy
    })
    registerWorkspaceHandlers({
      workspace: workspaceService,
      connections: connectionService,
      pool,
      repo
    })

    // B08：任务编排（队列 + 进度推送 + 退出保护）
    //
    // 顺序有讲究：**先建事件推送、再注册 handler**。
    // 否则"注册完 handler 到挂上推送"之间产生的任务事件会丢，
    // 表现为渲染进程看不到第一个任务（实际发生过这类时序漏洞）。
    const jobService = createJobService()
    detachJobPush = attachJobEventPush({ jobs: jobService })
    registerJobHandlers({ jobs: jobService })
    jobGuard = createJobGuard({ jobs: jobService })

    // B09：往期版本（归档 / 校验 / 保留策略）+ B12：下载 / 明细 / 手工删除
    // 归档与校验都要远端 SFTP，因此与工作区一样依赖连接池；端口在主进程接线层组装
    const archiveService = createArchiveService({
      repo,
      // T15.1：算法兼容模式 —— 关掉后遇到没有 hash 工具的服务器直接报错
      hashCompat: () => settingsService.current().hashCompatMode
    })
    const archiveDownloadService = createArchiveDownloadService({
      repo,
      transferConcurrency: () => settingsService.current().transferConcurrency
    })
    registerArchiveHandlers({
      archive: archiveService,
      download: archiveDownloadService,
      jobs: jobService,
      connections: connectionService,
      pool,
      repo,
      // 默认下载位置：设置里填过就用它，否则"系统下载目录/sfvm-downloads"（T12.3/T15.1）。
      // 取的是**当前值**而不是启动时的快照 —— 用户改完设置不必重启。
      defaultSaveDir: () =>
        settingsService.current().downloadDir ?? join(app.getPath('downloads'), DEFAULT_DOWNLOAD_DIR_NAME)
    })

    // B14：对账与崩溃恢复（远端是真相来源）
    // 依赖归档服务（深度校验走它的 verifyArchive）与连接池；端口在接线层组装
    const reconcileService = createReconcileService({ repo, archive: archiveService })
    registerReconcileHandlers({
      reconcile: reconcileService,
      connections: connectionService,
      pool,
      repo
    })

    // B10：发布主流程（两阶段提交式换版）
    // 依赖 JobService（发布以任务形式跑，复用队列/取消/进度推送）与归档服务（阶段 4）
    const deployService = createDeployService({
      repo,
      archive: archiveService,
      transferConcurrency: () => settingsService.current().transferConcurrency,
      hashCompat: () => settingsService.current().hashCompatMode
    })
    registerDeployHandlers({
      deploy: deployService,
      jobs: jobService,
      connections: connectionService,
      pool,
      repo
    })

    // B13：回滚（把一个往期版本恢复为当前版本，当前版本先归档、不丢）。
    // 与发布共用归档服务与**同一把远端锁**（infra/deploy-lock.ts），
    // 所以它同样以任务形式跑：进度、取消、日志全走 B08 已有那一套。
    const rollbackService = createRollbackService({ repo, archive: archiveService })
    registerRollbackHandlers({
      rollback: rollbackService,
      jobs: jobService,
      connections: connectionService,
      pool,
      repo
    })

    // B20：自定义脚本（本机 / 服务器各能跑一条，留档在 script_runs）
    // 依赖 JobService（脚本以任务形式跑，与同目标的发布/回滚**共用车道**即天然互斥）
    const scriptService = createScriptService({
      repo,
      // 总闸现取：用户随时可能关掉，而"关掉之后正在排队的任务也不该再跑"要靠它
      allowUserScripts: () => allowUserScripts(),
      gitBashPath: () => settingsService.current().gitBashPath,
      // 完整输出落在数据目录的日志区（B18 起日志跟着数据目录走）
      runsDir: () =>
        join(logDirOf(openedDataDir() ?? app.getPath('userData')), 'script-runs')
    })
    registerScriptHandlers({
      scripts: scriptService,
      jobs: jobService,
      connections: connectionService,
      pool,
      repo
    })

    // 连接状态变化转发给渲染进程（T03.3 的状态广播）
    pool.onState((state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.EVT_CONNECTION_STATE, state)
      }
    })

    // 自动登录（方案书 §7.3）：失败不阻塞启动，因此不 await
    void connectionService.autoConnectAll().catch((err) => {
      logger.warn(`auto connect failed: ${(err as Error).message}`)
    })

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    createWindow()

    // 看门狗：窗口迟迟不渲染则明确报错并退出，避免隐形僵尸占住单实例锁
    watchdog = setTimeout(() => {
      if (rendererLaunched) return
      logStartup(`watchdog fired after ${RENDER_TIMEOUT_MS}ms without ready-to-show`)
      rendererLaunched = true
      // 非阻塞弹窗 + 兜底强制退出：绝不允许「挂着一个对话框的僵尸」
      void dialog
        .showMessageBox({
          type: 'error',
          title: 'SFVM 启动超时',
          message: `窗口在 ${RENDER_TIMEOUT_MS / 1000} 秒内没有渲染完成，应用将退出。`,
          detail:
            '常见原因：安全软件拦截了 Electron 的进程沙箱，渲染进程无法创建。\n\n' +
            '请检查：\n' +
            '1. 把 node_modules\\electron\\dist\\electron.exe 加入安全软件信任区；\n' +
            '2. 或使用 pnpm dev:nosandbox 绕过；\n' +
            `3. 启动日志：${join(process.cwd(), '.logs', 'startup.log')}`,
          buttons: ['退出']
        })
        .finally(() => app.exit(1))
      setTimeout(() => app.exit(1), 15_000)
    }, RENDER_TIMEOUT_MS)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前关闭数据库，确保 WAL 检查点落盘、句柄释放
app.on('will-quit', () => {
  // 顺序：先解除任务侧的事件推送与退出保护，再断 SSH、关库。
  // 反过来的话，退订前的事件推送会打到已销毁的 webContents（只留噪声日志）。
  detachJobPush?.()
  jobGuard?.dispose()
  sshPool?.disconnectAll()
  closeAppDatabase()
})
