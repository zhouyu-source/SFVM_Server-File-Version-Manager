/**
 * "在本机打开"相关的**纯逻辑**（B11 / T11.7）。
 *
 * 只构造命令，不 spawn —— 这样"在 Windows / macOS / Linux 上到底该起什么命令"
 * 可以被单测穷举，IPC 层那几行就只剩"起进程 + 兜错"。
 *
 * ## 为什么不拼 shell 字符串
 *
 * 路径来自用户在目标里配置的本地产物（也可能是本机日志目录）。虽然绝大多数情况下
 * 它是系统对话框选出来的真实路径，但**绝不能用字符串拼命令**：Windows 上
 * `cd /d` 与 `start` 都要经 cmd 二次解析，路径里一个 `&` 就能把后面变成另一条命令。
 * 所以这里一律返回 `{ command, args }`，路径**作为一个独立参数**交给 spawn ——
 * Node 会按平台规则给它加引号，不经过任何 shell 解析。
 *
 * Linux 分支同理：`-e sh -c 'cd "$1" && exec "$SHELL"' sh <path>` 把路径当
 * **位置参数**传进去，脚本里只引用 `$1`，同样没有注入面。
 */

export interface TerminalInvocation {
  command: string
  args: string[]
}

/**
 * 构造"在终端中打开某个目录"的命令。
 *
 * - Windows：`cmd /c start cmd /k cd /d <path>`
 *   必须带 `start`：不带就等于在当前进程那个**隐藏控制台**里跑（用户什么都看不到）；
 *   `/k` 让窗口留在那儿（`/c` 会跑完就关，等于闪一下）。
 * - macOS：`open -a Terminal <path>`。
 * - 其他（Linux）：先用 `x-terminal-emulator`（Debian 系的 alternatives 入口），
 *   起不来时 IPC 层再按 `terminalCandidates()` 依次试。
 */
export function buildTerminalInvocation(
  platform: NodeJS.Platform | string,
  path: string
): TerminalInvocation | null {
  const p = path.trim()
  if (!p) return null

  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/c', 'start', 'cmd.exe', '/k', 'cd', '/d', p] }
  }
  if (platform === 'darwin') {
    return { command: 'open', args: ['-a', 'Terminal', p] }
  }
  return {
    command: 'x-terminal-emulator',
    args: ['-e', 'sh', '-c', 'cd "$1" && exec "$SHELL"', 'sh', p]
  }
}

/** 终端候选（按顺序尝试，第一个能起来的就用）。Windows / macOS 只有一个。 */
export function terminalCandidates(
  platform: NodeJS.Platform | string,
  path: string
): TerminalInvocation[] {
  const primary = buildTerminalInvocation(platform, path)
  if (!primary) return []
  if (platform === 'win32' || platform === 'darwin') return [primary]
  return [
    primary,
    { command: 'gnome-terminal', args: ['--working-directory', path] },
    { command: 'konsole', args: ['--workdir', path] },
    { command: 'xfce4-terminal', args: ['--working-directory', path] },
    { command: 'xterm', args: ['-e', 'sh', '-c', 'cd "$1" && exec "$SHELL"', 'sh', path] }
  ]
}

/**
 * "打开所在目录"该用 `shell.openPath`（打开）还是 `shell.showItemInFolder`（选中）。
 *
 * - 目录型产物 → 打开这个目录本身（用户想进去看）；
 * - 文件型产物 → **选中**它。直接 `openPath` 一个 `.jar` 会用压缩软件把它解开，
 *   那不是用户想要的（他要的是"看看这个包在哪儿 / 发给别人"）。
 * - 路径不存在 → null，由调用方给出明确文案。
 */
export function revealModeFor(kind: 'dir' | 'file' | null): 'open' | 'reveal' | null {
  if (kind === 'dir') return 'open'
  if (kind === 'file') return 'reveal'
  return null
}
