/**
 * 应用级快捷键与菜单命令（B15 / T15.7）。
 *
 * ## 为什么这份表要放在 shared
 *
 * 同一组快捷键有**两个消费方**：主进程的菜单（真正注册加速键）与设置页的
 * 「快捷键」列表（展示给用户看）。两处各写一份，迟早会出现"界面写着 ⌘R、
 * 实际注册的是 ⌘⇧R"这种错位 —— 而用户按下无效的键时只会觉得"这软件坏了"。
 *
 * 放在 shared 之后，改一处两处同时变。
 */
import type { MenuActionId } from './contracts/menu'

export interface ShortcutDef {
  /** 菜单项 id —— 见 `contracts/menu.ts` 里 `MenuActionId` 的说明 */
  id: MenuActionId
  label: string
  /** Electron 的 accelerator 写法（注册用） */
  accelerator: string
  /** 一句话说明这个快捷键做什么（设置页展示用） */
  description: string
}

/**
 * 全局快捷键。
 *
 * 刻意**不用**这几个常见的系统快捷键：
 * - `CmdOrCtrl+W` / `CmdOrCtrl+Q` —— 关窗 / 退出，交给系统角色；
 * - `CmdOrCtrl+P` —— 用户会以为是"打印"；
 * - `CmdOrCtrl+R` 单独留给"刷新"，**不**同时注册"强制重载"（两者撞车时
 *   后注册的会静默失效，而"哪个生效"取决于注册顺序，很难查）。
 */
export const APP_SHORTCUTS: readonly ShortcutDef[] = [
  {
    id: 'new-connection',
    label: '新建连接',
    accelerator: 'CmdOrCtrl+N',
    description: '跳到连接页并打开新建连接表单'
  },
  {
    id: 'refresh',
    label: '刷新界面',
    accelerator: 'CmdOrCtrl+R',
    description: '重新加载界面并重新拉取连接与环境状态'
  },
  {
    id: 'settings',
    label: '打开设置',
    accelerator: 'CmdOrCtrl+,',
    description: '跳转到设置页'
  },
  {
    id: 'open-logs',
    label: '打开日志目录',
    accelerator: 'CmdOrCtrl+Shift+L',
    description: '在文件管理器里打开日志所在目录'
  },
  {
    id: 'open-data',
    label: '打开数据目录',
    accelerator: 'CmdOrCtrl+Shift+D',
    description: '在文件管理器里打开台账数据库所在目录'
  }
]

/**
 * 把 Electron 的 accelerator 写法转成用户看的写法。
 *
 * Windows / Linux 上 `CmdOrCtrl` 实际是 **Ctrl**，直接显示 `CmdOrCtrl+R`
 * 会让用户去试 ⌘ 或 Command 键；macOS 上则相反，显示 Ctrl 是错的。
 */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const parts = accelerator.split('+').map((p) => {
    switch (p) {
      case 'CmdOrCtrl':
      case 'CommandOrControl':
        return isMac ? '⌘' : 'Ctrl'
      case 'Cmd':
      case 'Command':
        return '⌘'
      case 'Ctrl':
        return isMac ? '⌃' : 'Ctrl'
      case 'Shift':
        return isMac ? '⇧' : 'Shift'
      case 'Alt':
        return isMac ? '⌥' : 'Alt'
      default:
        return p
    }
  })
  // macOS 的习惯是不加分隔符（⌘⇧L），Windows 上要加（Ctrl+Shift+L）
  return parts.join(isMac ? '' : '+')
}
