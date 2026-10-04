/**
 * 应用菜单与加速键（B15 / T15.7）。
 *
 * ## 拆成"模板"与"安装"两半
 *
 * `buildAppMenuTemplate()` 是**纯函数**（依赖全部注入），`installAppMenu()` 只是
 * `Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(deps)))`。
 *
 * 这样"菜单里有哪些项、加速键是什么、点了会发哪条命令"能在单测里逐条断言，
 * 而不需要真的起一个 Electron 应用再去找菜单 —— 后者在 CI 上几乎是不可测的，
 * 结果就是这类代码通常**完全没有测试**，改坏了也没人知道。
 *
 * ## 为什么用 `send` 回调而不是在这里直接操作窗口
 *
 * 本模块不认识窗口。命令要发给"当前聚焦的那个窗口"，而"哪个窗口"是
 * 接线层的事；这里只管"用户点了这一项"。
 */
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { APP_SHORTCUTS } from '../shared/shortcuts'
import type { MenuCommand } from '../shared/contracts/menu'

export interface AppMenuDeps {
  /** 日志文件路径（取不到时返回空串） */
  logFile: () => string
  /** 数据目录（台账数据库所在目录） */
  userDataDir: () => string
  /** 把命令推给渲染进程 */
  send: (command: MenuCommand) => void
  /** 平台是否 macOS（默认取实际平台；可注入便于单测两种形态） */
  isMac?: boolean
  /** 打开一个本地路径（默认 `shell.openPath`） */
  openPath?: (path: string) => Promise<string>
  /** 在窗口里打开一个本地目录（默认走 openPath；macOS 为 Finder） */
  revealPath?: (path: string) => Promise<void>
  /** 关于对话框（默认 `dialog.showMessageBox`） */
  showAbout?: (text: string) => void
}

/**
 * 找一个"能收命令"的窗口。
 *
 * 优先聚焦窗口；没有聚焦的（比如用户点了 Dock 图标但没窗口在前）就退回第一个
 * 可见窗口 —— 否则菜单点了没反应，而用户手里的窗口明明就在屏幕上。
 *
 * 导出给接线层用：`send` 的实现在那里，它需要知道发给谁。
 */
export function commandTargetWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

/** 把 accelerator 的展示写法交给渲染层（设置页）—— 这里只要能注册即可。 */
export function buildAppMenuTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  const isMac = deps.isMac ?? process.platform === 'darwin'
  const acc = (id: string): string =>
    APP_SHORTCUTS.find((s) => s.id === id)?.accelerator ?? ''

  const openDir = async (dir: string, title: string): Promise<void> => {
    if (!dir) {
      void dialog.showMessageBox({ type: 'warning', title, message: '暂时拿不到这个目录的路径。' })
      return
    }
    if (deps.revealPath) {
      await deps.revealPath(dir)
      return
    }
    const err = await (deps.openPath ?? shell.openPath)(dir)
    // `shell.openPath` 用**返回字符串**表示失败（空串才是成功），不是抛异常 ——
    // 不判这一下，用户点了没反应且完全不知道原因。
    if (err && !deps.openPath) {
      void dialog.showMessageBox({ type: 'error', title, message: err })
    }
  }

  /** 日志是文件，要"在所在目录里选中它"，不能用打开目录的方式（会把 .log 交给编辑器）。 */
  const dirOf = (filePath: string): string => filePath.replace(/[\\/][^\\/]+$/, '')

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 ${app.name}` },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    })
  }

  template.push({
    label: '文件',
    submenu: [
      {
        label: '新建连接',
        accelerator: acc('new-connection'),
        click: () => deps.send('new-connection')
      },
      {
        label: '刷新界面',
        accelerator: acc('refresh'),
        click: () => deps.send('refresh')
      },
      { type: 'separator' },
      {
        // 标题与 `APP_SHORTCUTS` 里那条**逐字一致**：设置页要按标题去菜单里核对，
        // 两处各写一个（"设置…" vs "打开设置"）会让"同一份数据"的保证落空
        label: '打开设置',
        accelerator: acc('settings'),
        click: () => deps.send('settings')
      },
      { type: 'separator' },
      isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
    ]
  })

  template.push({
    label: '视图',
    submenu: [
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
      { type: 'separator' },
      // 开发者工具只在开发模式给：生产环境把它交给用户，等于请人去改 DOM 与本地状态。
      ...(process.env.NODE_ENV === 'development' || process.env.ELECTRON_RENDERER_URL
        ? [{ role: 'toggleDevTools' as const, label: '开发者工具' }]
        : [])
    ]
  })

  template.push({
    label: '帮助',
    submenu: [
      {
        label: '打开日志目录',
        accelerator: acc('open-logs'),
        click: () => void openDir(dirOf(deps.logFile()), '打开日志目录')
      },
      {
        label: '打开数据目录',
        accelerator: acc('open-data'),
        click: () => void openDir(deps.userDataDir(), '打开数据目录')
      },
      { type: 'separator' },
      {
        label: `关于 ${app.name}`,
        click: () => {
          const text =
            `${app.name} ${app.getVersion()}\n` +
            `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}\n` +
            `Node ${process.versions.node}\n\n` +
            `数据目录：${deps.userDataDir()}`
          if (deps.showAbout) deps.showAbout(text)
          else void dialog.showMessageBox({ type: 'info', title: `关于 ${app.name}`, message: text })
        }
      }
    ]
  })

  // Windows / Linux 上给一个"窗口"菜单，方便用户找回被隐藏的窗口
  if (!isMac) {
    template.push({
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' }
      ]
    })
  }

  return template
}

/** 安装应用菜单。重复调用会替换掉旧菜单（幂等）。 */
export function installAppMenu(deps: AppMenuDeps): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(deps)))
}
