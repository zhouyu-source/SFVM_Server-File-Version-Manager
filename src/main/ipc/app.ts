/**
 * 应用级 IPC 通道（T01.5 的示范通道 + B04 需要的文件选择 + B11 的本地外壳）。
 */
import {
  dialog,
  shell,
  BrowserWindow,
  type OpenDialogOptions,
  type BrowserWindow as BW
} from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { registerHandler } from '../infra/ipc'
import { logger } from '../infra/logger'
import { AppError, ErrorCode } from '../infra/errors'
import { IPC_CHANNELS } from '../../shared/channels'
import {
  openTerminalInputSchema,
  pickArtifactInputSchema,
  pickDirectoryInputSchema,
  pickExecutableInputSchema,
  revealPathInputSchema,
  type OpenShellResult
} from '../../shared/contracts/workspace'
import { setDataLocationInput } from '../../shared/contracts/app'
import type { DataLocationService } from '../services/data-location'
import { revealModeFor, terminalCandidates } from '../infra/open-shell'

/**
 * 可注入点：**只用于单测**。
 *
 * `openTerminal` 会真的起一个终端窗口 —— 单测里绝不能真起（会在开发机上弹出黑框），
 * 所以把 "怎么 spawn" 换掉，但**不换**"选哪个候选、怎么回退、什么时候返回失败"
 * 这些逻辑（那些才是会写错的地方）。
 */
export interface AppHandlerDeps {
  spawn?: typeof spawn
  /**
   * 数据目录服务（B18）。
   *
   * **可选**：本机能力的那几个单测（`b11-app-ipc`）只关心对话框与终端回退链，
   * 不该被迫先造一个数据目录环境出来。没传时对应通道不注册，
   * 接线层（`index.ts`）总是会传。
   */
  dataLocation?: DataLocationService
}

/**
 * 起完进程后**让出一个 tick**，看它有没有立刻以 `'error'` 结束（L14）。
 *
 * `spawn()` 对"命令不存在"（ENOENT）**不抛**，它是异步通过 `'error'` 事件报的。
 * 不挂监听就是主进程未捕获异常；挂了但不等一个 tick 又会立刻 `return {ok:true}`，
 * 把一次失败报成成功。所以这里两条都做：挂监听 + 竞一个 tick。
 *
 * 监听器**不摘**：之后才发生的 `'error'` 仍由它吸收，不会再冒成未捕获异常。
 */
function waitForSpawnOutcome(child: ChildProcess): Promise<Error | null> {
  return new Promise((resolve) => {
    let settled = false
    child.on('error', (err: Error) => {
      if (settled) return
      settled = true
      resolve(err)
    })
    setImmediate(() => {
      if (settled) return
      settled = true
      resolve(null)
    })
  })
}

export function registerAppHandlers(deps: AppHandlerDeps = {}): void {
  const spawnProcess = deps.spawn ?? spawn

  /** 取一个可用的父窗口：模态对话框挂到它上面，否则在 macOS 上会飘成独立窗口。 */
  const parentWindow = (): BW | null =>
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null

  // 通路自检：渲染进程能拿到 {pong:true, at} 就说明 preload -> 主进程 已打通
  registerHandler(IPC_CHANNELS.APP_PING, null, () => ({
    pong: true as const,
    at: new Date().toISOString()
  }))

  /**
   * 运行环境信息。
   *
   * B18 收缩成一个字段：设置页「关于」不再展示版本 / Electron / Chromium / Node /
   * 平台 / 运行模式，只留「数据目录 / 日志目录」（那两个走 `app:dataLocation.*`）。
   * 仍然保留这个通道是因为快捷键表要靠 `platform` 决定显示 `Ctrl` 还是 `⌘`。
   */
  registerHandler(IPC_CHANNELS.APP_INFO, null, () => ({
    platform: process.platform
  }))

  /**
   * 选择私钥文件（B04 / T04.4）。
   *
   * 刻意做成**用途限定**的通道（只能选私钥，且不返回文件内容），
   * 而不是暴露通用的"任意文件对话框"给渲染进程 —— 那等于把文件系统访问
   * 变相开放出去。返回 null 表示用户取消。
   *
   * 实现注意（踩过的坑：表现为"点浏览没有任何反应"）：
   * - filters 里**不要**写 `extensions: ['']`：空扩展名会生成畸形过滤器，
   *   在 Windows 上会让 showOpenDialog 静默失败。
   * - `showHiddenFiles` 是 **macOS 专属**属性；在 Windows/Linux 上传它没有意义，
   *   用户通过对话框自带的"显示隐藏项"仍可进入 `.ssh` 目录。
   * - 必须有日志与错误处理：失败时不能静默，否则用户只看到"没反应"。
   */
  registerHandler(IPC_CHANNELS.APP_PICK_PRIVATE_KEY, null, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null

    const options: OpenDialogOptions = {
      title: '选择 SSH 私钥文件',
      buttonLabel: '选择',
      properties: process.platform === 'darwin' ? ['openFile', 'showHiddenFiles'] : ['openFile'],
      // 常见私钥扩展名；不使用通配扩展名，避免畸形过滤器
      filters: [
        {
          name: '私钥文件',
          extensions: ['pem', 'key', 'ppk', 'rsa', 'ed25519', 'ecdsa', 'dsa', 'openssh', 'txt']
        },
        { name: '全部文件', extensions: ['*'] }
      ]
    }

    try {
      logger.info(`pickPrivateKey: opening dialog (parent=${win ? 'focused' : 'none'})`)
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)

      if (result.canceled || result.filePaths.length === 0) {
        logger.info('pickPrivateKey: canceled by user')
        return null
      }
      // 只回传路径：私钥内容永远不进渲染进程
      logger.info('pickPrivateKey: file selected')
      return { path: result.filePaths[0] }
    } catch (err) {
      logger.error(`pickPrivateKey failed: ${(err as Error).message}`)
      throw new AppError(ErrorCode.E_UNKNOWN, { original: (err as Error).message })
    }
  })

  /**
   * 选择本地产物（B11 / T11.1）。
   *
   * 与 `pickPrivateKey` 同样刻意做成**用途限定**的通道：只能选目录或文件，
   * 且只回传路径、不读内容。渲染进程因此永远拿不到"任意读盘"的能力 ——
   * 沙箱化 preload 下它本来也没有 fs，这个通道是唯一的例外，
   * 所以边界必须卡在"用户亲手选了一个路径"这一步上。
   */
  registerHandler(IPC_CHANNELS.APP_PICK_ARTIFACT, pickArtifactInputSchema, async (input) => {
    const win = parentWindow()
    const options: OpenDialogOptions = {
      title: input.kind === 'dir' ? '选择本地产物目录' : '选择本地产物文件',
      buttonLabel: '选择',
      // defaultPath 只用来"落到用户上次的位置"，不存在时 Electron 会忽略它
      ...(input.current ? { defaultPath: input.current } : {}),
      // 目录型目标选目录、文件型目标选文件 —— 让对话框本身就替用户挡掉一半错误
      // （否则用户很容易选中 dist 的父目录，然后在发布时才发现类型不符）
      properties: input.kind === 'dir' ? ['openDirectory'] : ['openFile']
    }

    try {
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      return { path: result.filePaths[0] }
    } catch (err) {
      logger.error(`pickArtifact failed: ${(err as Error).message}`)
      throw new AppError(ErrorCode.E_UNKNOWN, { original: (err as Error).message })
    }
  })

  /**
   * 选择一个本地目录（B12 / T12.3：下载保存位置）。
   *
   * 只允许选目录（`openDirectory` + `createDirectory`）：下载要往这个位置里
   * 建一个子目录，选到一个文件是没法用的。`createDirectory` 让用户能当场新建
   * 一个（macOS 上才生效，Windows 的目录对话框本来就带"新建文件夹"）。
   */
  registerHandler(IPC_CHANNELS.APP_PICK_DIRECTORY, pickDirectoryInputSchema, async (input) => {
    const win = parentWindow()
    const options: OpenDialogOptions = {
      title: '选择下载保存位置',
      buttonLabel: '选择此目录',
      ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
      properties: ['openDirectory', 'createDirectory']
    }

    try {
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      return { path: result.filePaths[0] }
    } catch (err) {
      logger.error(`pickDirectory failed: ${(err as Error).message}`)
      throw new AppError(ErrorCode.E_UNKNOWN, { original: (err as Error).message })
    }
  })

  /**
   * 选择一个可执行文件（B20：设置「Git Bash 路径」）。
   *
   * 与上面几个同属"用途限定"的选路通道：**只回传路径、不读内容**。
   * 这里额外挂一个可执行文件过滤（Windows 上 Git 的安装目录里同时有
   * `bash.exe`、`git-bash.exe`、`sh.exe`，不过滤的话很容易选错一个能起、
   * 但行为不同的壳）。过滤器只是"默认顺序"，用户仍可切到"所有文件"
   * —— 所以服务层那边还要再做一次存在性校验，不能只信对话框。
   */
  registerHandler(IPC_CHANNELS.APP_PICK_EXECUTABLE, pickExecutableInputSchema, async (input) => {
    const win = parentWindow()
    const options: OpenDialogOptions = {
      title: input.title,
      buttonLabel: '选择',
      ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
      properties: ['openFile'],
      filters: [
        { name: '可执行文件', extensions: ['exe', 'cmd', 'bat', 'com'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }

    try {
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      return { path: result.filePaths[0] }
    } catch (err) {
      logger.error(`pickExecutable failed: ${(err as Error).message}`)
      throw new AppError(ErrorCode.E_UNKNOWN, { original: (err as Error).message })
    }
  })

  /**
   * 在文件管理器里"打开所在目录"或选中文件（B11 / T11.7）。
   *
   * 两个 Electron API 的差别是有意的，不是随便选：
   * - 目录 → `shell.openPath`：进入这个目录；
   * - 文件 → `shell.showItemInFolder`：**选中**它。用 openPath 打开一个 `.jar`
   *   会用压缩软件把它解开，那不是用户点这个按钮想要的结果。
   *
   * 路径不存在时给出明确理由，而不是静默失败 —— "点了没反应"是本项目最烦人的
   * 一类问题（见 HANDOFF §3）。
   */
  registerHandler(IPC_CHANNELS.APP_REVEAL_PATH, revealPathInputSchema, async ({ path }) => {
    const st = await statOrNull(path)
    if (!st) return { ok: false, reason: `路径不存在：${path}` } satisfies OpenShellResult

    const mode = revealModeFor(st.kind)
    if (!mode) return { ok: false, reason: `不支持的路径类型：${path}` } satisfies OpenShellResult

    if (mode === 'reveal') {
      shell.showItemInFolder(path)
      return { ok: true } satisfies OpenShellResult
    }
    const err = await shell.openPath(path)
    if (err) return { ok: false, reason: err } satisfies OpenShellResult
    return { ok: true } satisfies OpenShellResult
  })

  /**
   * 在本机终端里打开某个目录（B11 / T11.7）。
   *
   * 命令由 `buildTerminalInvocation()` 构造（纯函数、可单测），这里只负责
   * "起进程 + 在候选终端之间回退"。**绝不拼 shell 字符串** —— 路径作为独立参数
   * 交给 spawn，见 `infra/open-shell.ts` 的说明。
   */
  registerHandler(IPC_CHANNELS.APP_OPEN_TERMINAL, openTerminalInputSchema, async ({ path }) => {
    const st = await statOrNull(path)
    if (!st) return { ok: false, reason: `路径不存在：${path}` } satisfies OpenShellResult
    if (st.kind !== 'dir') {
      return { ok: false, reason: '只能在终端里打开目录，请选择产物所在目录' } satisfies OpenShellResult
    }

    const candidates = terminalCandidates(process.platform, path)
    let lastErr = '没有可用的终端程序'
    for (const inv of candidates) {
      let child: ChildProcess
      try {
        // detached + 不 stdio 继承：终端是新窗口，不该挂在本应用的进程树上
        // （否则应用一退出，用户刚打开的终端会被一起收走）
        child = spawnProcess(inv.command, inv.args, { detached: true, stdio: 'ignore' })
      } catch (err) {
        // 少数实现会**同步**抛（我们的单测替身就是这种）
        lastErr = (err as Error).message
        continue
      }

      /**
       * L14：`spawn()` 是**同步返回**的，"命令不存在"（ENOENT）这类失败却是
       * **异步**通过 `'error'` 事件报出来的 —— 它不抛。以前这里既没挂 `'error'`
       * 监听、又无条件 `return {ok:true}`，于是 Linux 上候选终端全都不存在时：
       * 主进程冒出未捕获异常（`'error'` 无监听者时 Node 会直接抛），
       * 而界面那边只看到"点了没反应"。
       *
       * 现在起完进程先**让出一个 tick** 等 `'error'`：没等到才算真的起来了；
       * 等到了就把原因记下、继续试下一个候选。监听器不摘 —— 之后真出别的错
       * （例如后来才 EACCES）也被这一条兜住，不会再变成未捕获异常。
       */
      const failed = await waitForSpawnOutcome(child)
      if (failed) {
        lastErr = failed.message
        continue
      }

      // `unref` 让父进程不必等它；某些替身/极简实现没有这个方法
      if (typeof child.unref === 'function') child.unref()
      logger.info(`openTerminal: ${inv.command} ${JSON.stringify(inv.args)}`)
      return { ok: true } satisfies OpenShellResult
    }
    return { ok: false, reason: lastErr } satisfies OpenShellResult
  })

  /**
   * 数据目录（B18）。
   *
   * 两个通道都**不抛业务错误**，而是返回带中文 `reason` 的结果：
   * 失败原因（目标目录已有台账、目录建不出来、复制失败）都是用户自己能处置的，
   * 需要的是一句能照做的说明，而不是一个错误码。
   * 与本文件的 `revealPath` / `openTerminal` 保持同一风格。
   */
  if (deps.dataLocation) {
    const dataLocation = deps.dataLocation

    registerHandler(IPC_CHANNELS.APP_DATA_LOCATION_GET, null, () => dataLocation.get())

    registerHandler(IPC_CHANNELS.APP_DATA_LOCATION_SET, setDataLocationInput, async (input) => {
      const result = await dataLocation.set(input.dir)
      if (result.ok) {
        logger.info(
          `dataLocation.set: configured=${result.state.configuredDir} ` +
            `restartRequired=${result.restartRequired}` +
            (result.warnings.length ? ` warnings=${result.warnings.length}` : '')
        )
      } else {
        // 失败必须留痕：用户报"改不了数据目录"时，界面上那句话往往已经消失了
        logger.warn(`dataLocation.set failed: ${result.reason}`)
      }
      return result
    })
  }
}

/** 探测一个本地路径的类型；不存在或读不到都返回 null（调用方给文案）。 */
async function statOrNull(path: string): Promise<{ kind: 'dir' | 'file' | null } | null> {
  try {
    const st = await fsp.stat(path)
    return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null }
  } catch {
    return null
  }
}
