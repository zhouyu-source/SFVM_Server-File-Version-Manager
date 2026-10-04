/**
 * 单测用的 electron 替身。
 *
 * 为什么需要：单测跑在 Node 下，没有 Electron 运行时；而 `src/main` 里多个模块
 * （logger / credential / db）会 import electron。用 `vi.mock('electron', ...)`
 * 逐个文件写既重复又容易漏导出（曾因为只给了 safeStorage、
 * 结果 logger 需要的 BrowserWindow 找不到而整套加载失败）。
 *
 * 这里统一提供被引用到的命名导出，并在 vitest.config.ts 里用 alias 指向本文件。
 *
 * safeStorage 是**内存实现**：加解密可往返，但进程结束即失效；
 * 真正的"是否可用"由测试通过 `__setEncryptionAvailable` 控制，用于覆盖降级路径（T03.2）。
 */

let encryptionAvailable = true
const memoryCipher = new Map<string, string>()
let seq = 0

export const safeStorage = {
  isEncryptionAvailable: (): boolean => encryptionAvailable,
  encryptString: (plain: string): Buffer => {
    if (!encryptionAvailable) throw new Error('encryption unavailable')
    const key = `cipher-${++seq}`
    memoryCipher.set(key, plain)
    return Buffer.from(key, 'utf8')
  },
  decryptString: (buf: Buffer): string => {
    if (!encryptionAvailable) throw new Error('encryption unavailable')
    const key = buf.toString('utf8')
    const v = memoryCipher.get(key)
    if (v === undefined) throw new Error('cannot decrypt: unknown cipher')
    return v
  },
  getSelectedStorageBackend: (): string => (encryptionAvailable ? 'test-backend' : 'basic_text')
}

/** 供测试切换加密可用性（覆盖 T03.2 的降级路径）。 */
export function __setEncryptionAvailable(v: boolean): void {
  encryptionAvailable = v
}

/** 清空内存密文，避免用例间串味。 */
export function __resetCipherStore(): void {
  memoryCipher.clear()
  seq = 0
}

/* ---------------------------------------------------- 以下为占位，够 import 即可 */

/**
 * 事件记录器：让 `app.on(...)` 在单测里可断言（B08 的退出保护要用）。
 * 之前这里是个空函数，于是"退出保护到底有没有挂上"在单测里完全测不到。
 */
type Listener = (...args: unknown[]) => void
const appListeners = new Map<string, Set<Listener>>()

export const app = {
  name: 'SFVM',
  getPath: (name: string): string => `/tmp/sfvm-test/${name}`,
  getVersion: (): string => '0.0.0-test',
  getAppPath: (): string => process.cwd(),
  whenReady: async (): Promise<void> => undefined,
  on: (event: string, fn: Listener): void => {
    const set = appListeners.get(event) ?? new Set<Listener>()
    set.add(fn)
    appListeners.set(event, set)
  },
  removeListener: (event: string, fn: Listener): void => {
    appListeners.get(event)?.delete(fn)
  },
  quit: (): void => undefined,
  exit: (): void => undefined,
  commandLine: { appendSwitch: (): void => undefined },
  disableHardwareAcceleration: (): void => undefined,
  requestSingleInstanceLock: (): boolean => true
}

/** 触发 app 事件（测试用）。返回是否有监听器处理。 */
export function __emitApp(event: string, ...args: unknown[]): boolean {
  const set = appListeners.get(event)
  if (!set || set.size === 0) return false
  for (const fn of [...set]) fn(...args)
  return true
}

export function __appListenerCount(event: string): number {
  return appListeners.get(event)?.size ?? 0
}

export function __resetAppListeners(): void {
  appListeners.clear()
}

export const BrowserWindow = Object.assign(
  function BrowserWindow(): unknown {
    return {}
  },
  {
    getAllWindows: (): unknown[] => [],
    getFocusedWindow: (): unknown => null
  }
)

/**
 * 文件对话框替身：结果由测试注入（`__setOpenDialogResult`）。
 * 不注入时默认"用户取消"，这样忘记注入的用例不会莫名其妙地拿到一个路径。
 */
let openDialogResult: { canceled: boolean; filePaths: string[] } = {
  canceled: true,
  filePaths: []
}
let lastOpenDialogOptions: unknown = null

export function __setOpenDialogResult(r: { canceled: boolean; filePaths: string[] }): void {
  openDialogResult = r
}

/** 最近一次 showOpenDialog 的选项（断言"目录型只给 openDirectory"要用）。 */
export function __lastOpenDialogOptions(): unknown {
  return lastOpenDialogOptions
}

export function __resetOpenDialog(): void {
  openDialogResult = { canceled: true, filePaths: [] }
  lastOpenDialogOptions = null
}

export const dialog = {
  /**
   * 用 `...args: unknown[]` 而不是空参数：真实签名有两种 —— `(options)` 与
   * `(window, options)`，替身声明成"无参"会让 `mock.calls[0][0]` 变成越界访问
   * （`Tuple type '[]' of length '0' has no element at index '0'`），
   * 而这类断言恰恰是验"弹窗文案对不对"的唯一手段。
   */
  showMessageBox: async (..._args: unknown[]): Promise<{ response: number }> => ({ response: 0 }),
  showMessageBoxSync: (..._args: unknown[]): number => 0,
  showErrorBox: (): void => undefined,
  showOpenDialog: async (...args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> => {
    // 真实签名有两种：(options) 与 (window, options)
    lastOpenDialogOptions = args.length > 1 ? args[1] : args[0]
    return openDialogResult
  }
}

/* ----------------------------------------------- shell（B11 / T11.7） */

const shellCalls: Array<{ fn: string; arg: string }> = []
let openPathError = ''

export function __shellCalls(): Array<{ fn: string; arg: string }> {
  return [...shellCalls]
}

export function __setOpenPathError(msg: string): void {
  openPathError = msg
}

export function __resetShell(): void {
  shellCalls.length = 0
  openPathError = ''
}

export const shell = {
  openExternal: async (): Promise<void> => undefined,
  /** 打开目录/文件；返回空串表示成功（真实 Electron 的语义） */
  openPath: async (p: string): Promise<string> => {
    shellCalls.push({ fn: 'openPath', arg: p })
    return openPathError
  },
  /** 在文件管理器里选中文件（无返回值） */
  showItemInFolder: (p: string): void => {
    shellCalls.push({ fn: 'showItemInFolder', arg: p })
  }
}

/**
 * ipcMain 替身：**记录** handler，让单测能真的调用它们。
 * 只记录不实现，等于 IPC 层永远测不到（"注册了但形状不对"这类问题会漏到人工测试）。
 */
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown
const ipcHandlers = new Map<string, IpcHandler>()

export const ipcMain = {
  handle: (channel: string, fn: IpcHandler): void => {
    ipcHandlers.set(channel, fn)
  },
  removeHandler: (channel: string): void => {
    ipcHandlers.delete(channel)
  },
  on: (): void => undefined
}

/** 调用已注册的 handler（测试用）。 */
export function __invokeIpc(channel: string, arg?: unknown): Promise<unknown> {
  const h = ipcHandlers.get(channel)
  if (!h) throw new Error(`未注册的 IPC 通道：${channel}`)
  return Promise.resolve(h({}, arg))
}

export function __registeredIpc(): string[] {
  return [...ipcHandlers.keys()].sort()
}

export function __resetIpcHandlers(): void {
  ipcHandlers.clear()
}

export const ipcRenderer = {
  invoke: async (): Promise<unknown> => undefined,
  on: (): void => undefined,
  removeListener: (): void => undefined
}

/* ----------------------------------------------- Menu（B15 / T15.7） */

/**
 * 菜单替身。
 *
 * `Menu.buildFromTemplate` 在单测里只做两件事：把模板原样留下来（供断言）
 * 并**补上 displayLabel** —— 这一点是刻意模仿 Electron 的：真实运行时
 * `MenuItem` 会把 `label` 与 `role` 合成为一个显示名，很多"菜单少了一项"
 * 的 bug 只有在拿到 `MenuItem` 之后才看得出来。
 */
let lastMenuTemplate: unknown[] | null = null

export function __lastMenuTemplate(): unknown[] | null {
  return lastMenuTemplate
}

export function __resetMenu(): void {
  lastMenuTemplate = null
}

export const Menu = {
  buildFromTemplate: (template: unknown[]): { items: unknown[]; template: unknown[] } => {
    lastMenuTemplate = template
    return { items: template, template }
  },
  setApplicationMenu: (_menu: unknown): void => undefined,
  getApplicationMenu: (): unknown => (lastMenuTemplate ? { template: lastMenuTemplate } : null)
}

export const contextBridge = {
  exposeInMainWorld: (): void => undefined
}

export const session = {}

export default {
  safeStorage,
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  ipcMain,
  ipcRenderer,
  contextBridge,
  session
}
