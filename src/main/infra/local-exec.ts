/**
 * 本机脚本执行的**纯逻辑**（B20 / T20.2）。
 *
 * 这里只做"把一段脚本翻译成一次 `spawn` 调用"以及周边那几件容易出错的小事：
 * 解释器选择、命令行构造、输出按行切分、子进程环境的清理、超时钳制。
 * **不 import electron、不做任何 I/O** —— 于是"Windows 上到底会执行什么"
 * 可以在单测里逐条断言，而不必真的起一个进程。
 *
 * 真正的 `spawn` 在 `services/script-runner.ts`。
 *
 * ## 为什么没有 cmd.exe
 *
 * 用户在界面上只能选 PowerShell 或 Git Bash。批处理在引号、`%` 展开、`errorlevel`
 * 与代码页上到处都是坑，同一个脚本换台机器行为就变 —— 这不是能力取舍，
 * 而是"少一个必然出问题的选项"。
 *
 * ## 为什么 PowerShell 走 `-EncodedCommand`
 *
 * 把多行脚本直接当 `-Command` 的参数传，要在三层转义里活着出来
 * （Node 的 argv → PowerShell 的解析 → 脚本自己），而 `-Command` 对多行的处理
 * 还与引号、换行有关；再叠加 Windows 控制台代码页，中文参数经常变成乱码。
 * `-EncodedCommand` 收的是 **UTF-16LE 的 base64**，一次绕开全部三个问题：
 * 不需要引号转义、天然支持多行、编码是显式指定的（不依赖控制台代码页）。
 * 代价是命令行不可读 —— 而"这次到底跑了什么"本来也**不靠命令行留档**
 * （B20 的单步脚本是临时输入、不落库，见 `services/script.ts` 文件头）。
 *
 * 另外还得在脚本前面垫两句（`POWERSHELL_PREAMBLE`）—— 那两处都是真机踩出来的，
 * 别当成装饰删掉。
 *
 * ## 为什么 Git Bash 要带 `-l` 且必须设 `CHERE_INVOKING=1`
 *
 * 不带 `-l`（login shell）时，`/etc/profile` 不会被读，`/usr/bin` 等目录不进 PATH，
 * 于是 `mvn` / `node` 这类工具在 Git Bash 里"明明装了却找不到"。
 * 但 Git for Windows 的 `/etc/profile` 结尾有一段**会 `cd "$HOME"`**
 * —— 于是登录 shell 会把 `spawn` 传进去的 `cwd` 顶掉，用户填的工作目录形同虚设。
 * 官方的开关就是环境变量 `CHERE_INVOKING=1`（Git Bash 快捷方式自己也是这么用的），
 * 设上之后 profile 不再改目录。
 */
import { StringDecoder } from 'node:string_decoder'
import { LOCAL_SHELLS, type LocalShell } from '../../shared/contracts/script'

/* ------------------------------------------------------------ 解释器探测 */

/**
 * 各解释器的候选路径（按优先级）。前几个是常见安装位置，最后是"交给 PATH"。
 *
 * 单独列出来而不是只依赖 PATH：Windows 上装完 Git for Windows 之后，
 * `bash.exe` 常常**不在** PATH 里（Git Bash 快捷方式用的是绝对路径），
 * 只查 PATH 会得出"没装 Git Bash"的结论。
 */
export const SHELL_EXE_CANDIDATES: Record<LocalShell, readonly string[]> = {
  powershell: [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'pwsh',
    'powershell'
  ],
  gitbash: [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'bash'
  ]
}

/**
 * 平台默认解释器。
 *
 * 非 Windows 平台回落到 `gitbash`（它拼出来的就是普通的 `bash -lc`），
 * 这样同一个函数在两个平台上都有意义 —— 这套代码当下只出 Windows 包，
 * 但把"平台分支"收在这里，比散在服务层好。
 */
export function defaultShellForPlatform(platform: NodeJS.Platform): LocalShell {
  return platform === 'win32' ? 'powershell' : 'gitbash'
}

/** 判断一个候选值是不是"绝对路径"（决定要不要做存在性检查）。 */
export function isAbsoluteCandidate(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

/** 归一化用户填的 Git Bash 路径（去空白、去掉误带上的引号）。 */
export function normalizeShellPath(raw: string): string {
  let v = raw.trim()
  // 用户很可能是从资源管理器"复制路径"（带引号）或从快捷方式属性里抄出来的
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim()
  }
  return v
}

/* -------------------------------------------------------------- 命令行 */

export interface LocalCommand {
  command: string
  args: string[]
}

/**
 * PowerShell 的 `-EncodedCommand` 载荷：脚本按 **UTF-16LE** 编码再 base64。
 *
 * 不是 UTF-8 —— 这是 PowerShell 自己的约定（它内部就是 UTF-16 字符串）。
 * 传 UTF-8 的 base64 会得到一堆乱码命令，且**不报错**，只是行为全错。
 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 每段 PowerShell 脚本前面都要垫的两句（**真机 E2E 抓到的问题**，不是洁癖）。
 *
 * 1. `[Console]::OutputEncoding = UTF8`
 *
 *    这是本批次唯一一个"界面上会直接看出来"的坑：**PowerShell 往管道写 stdout 时
 *    用的是控制台输出代码页**（简体中文 Windows 上是 936/GBK），而不是 UTF-8。
 *    于是脚本里的中文输出按 UTF-8 解码会变成 `b20-???-ok` —— 而脚本本身、退出码、
 *    耗时**全都是对的**，只有文字是乱的。真窗口 E2E 第一次跑就是这么红的：
 *
 *        expected 'b20-本机输出-ok'  received 'b20-???-ok'
 *
 *    修法只能是让 PowerShell 自己改用 UTF-8 写。
 *    （Git Bash 不需要：它的输出本来就是 UTF-8。）
 *
 * 2. `$ProgressPreference = "SilentlyContinue"`
 *
 *    PowerShell 的进度流（比如首次加载模块时的"正在准备首次使用模块"）
 *    在 stderr 被重定向时会**序列化成一坨 CLIXML**，把我们真正关心的输出淹掉：
 *
 *        #< CLIXML
 *        <Objs Version="1.1.0.1" ...><Obj S="progress" ...><AV>正在准备…</AV>...
 *
 *    用户看到的就是"日志里冒出一堆 XML"。关掉进度流即可。
 *
 * 两句都包在 `try` 里 / 是赋值，**不会影响退出码**（`exit 7` 仍然是 7）。
 * 脚本原文不落库（B20 的单步是临时输入），所以这两句也无法从运行记录里看出来 ——
 * 这也是为什么这里要写得足够清楚。
 */
export const POWERSHELL_PREAMBLE = [
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  '$ProgressPreference = "SilentlyContinue"'
].join('\n')

/** 把前导语句垫到用户脚本前面（只用于构造 `-EncodedCommand` 的载荷）。 */
export function withPowerShellPreamble(script: string): string {
  return `${POWERSHELL_PREAMBLE}\n${script}`
}

/**
 * 构造一次本机执行。
 *
 * `exePath` 由调用方（服务层）探测给出 —— 这里不碰文件系统，所以传什么就用什么。
 */
export function buildLocalCommand(input: {
  shell: LocalShell
  exePath: string
  script: string
}): LocalCommand {
  if (input.shell === 'powershell') {
    return {
      command: input.exePath,
      args: [
        '-NoLogo',
        // 不读用户 profile：profile 里可能有 `Set-Location`、
        // 提示符重定义、甚至 `Read-Host` —— 都会把"非交互执行"变成"卡住"
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        // 载荷 = 前导语句 + 用户脚本（前导语句干什么是 `POWERSHELL_PREAMBLE` 的事）
        encodePowerShellCommand(withPowerShellPreamble(input.script))
      ]
    }
  }
  return {
    command: input.exePath,
    // `-l` 见文件头；`-c` 后面整段脚本作为**一个** argv 传进去，
    // 不经过任何 shell 插值（spawn 不走 shell）
    args: ['-l', '-c', input.script]
  }
}

/* -------------------------------------------------------------- 子环境 */

/**
 * 给子进程准备环境变量。
 *
 * **必须删掉 `ELECTRON_RUN_AS_NODE`**：本机环境里预置了这个变量时，任何
 * Electron 可执行文件（包括我们 spawn 出去的）都会退化成纯 Node —— 这个坑
 * 在本项目的真窗口 E2E 上实打实踩过（见 HANDOFF §1.4），不删的话
 * "用户脚本里调了什么工具"会莫名其妙地失败。
 *
 * Git Bash 额外加 `CHERE_INVOKING=1`（见文件头：否则 `/etc/profile` 会 `cd $HOME`）。
 */
export function buildChildEnv(
  shell: LocalShell,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.ELECTRON_RUN_AS_NODE
  if (shell === 'gitbash') env.CHERE_INVOKING = '1'
  return env
}

/* ------------------------------------------------------------ 输出切分 */

/**
 * 把"上一块剩下的半行 + 这一块新到的文本"切成完整的行。
 *
 * `pending` 是不以换行结尾的尾巴，必须由调用方跨块保留 —— 网络与管道的分块边界
 * 与行的边界毫无关系，不保留就会把一行切成两条日志。
 *
 * 只认 `\n`：`\r` 的处理是"去掉行尾的 `\r`"（Windows 的 CRLF、以及
 * PowerShell 用 `\r` 重绘进度行留下的残渣）。
 */
export function splitOutputLines(
  pending: string,
  text: string
): { lines: string[]; pending: string } {
  const joined = pending + text
  const parts = joined.split('\n')
  const rest = parts.pop() ?? ''
  const lines = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  return { lines, pending: rest }
}

/**
 * 增量 UTF-8 解码器。
 *
 * 为什么不能让调用方自己 `chunk.toString('utf8')`：**chunk 边界可能正好落在
 * 一个多字节字符中间**（管道与网络的分块边界跟字符边界毫无关系）。那样每一块
 * 换个位置就可能乱码 —— 中文输出上尤其明显，而且是"偶尔乱一下"，属于最难查的
 * 那一类。`StringDecoder` 会把不完整的尾巴字节留到下一块。
 *
 * `end()` 是**必需**的：解码器内部可能还压着几个字节，不收尾就丢掉最后半个字符。
 *
 * 注意 stdout 与 stderr 必须**各用一个实例**：两个流是独立分块的，
 * 共用一个解码器会让 A 流的半个字符去吃 B 流的字节。
 */
export function createChunkDecoder(): { push: (chunk: Buffer) => string; end: () => string } {
  const decoder = new StringDecoder('utf8')
  return {
    push(chunk: Buffer): string {
      return decoder.write(chunk)
    },
    end(): string {
      return decoder.end()
    }
  }
}

/* ---------------------------------------------------------- 进程树结束 */

/**
 * 结束整棵进程树。
 *
 * **必须杀树，不能只杀直接子进程**：`mvn` / `npm` 这类工具自己还会拉起
 * 编译器和 JVM；只杀父进程会留下一堆孤儿占着端口和文件锁，用户重跑就报
 * "端口被占用"，而任务台显示"已取消"。这是本地执行里最容易被忽略的一环。
 *
 * - Windows：`taskkill /PID <pid> /T /F`（`/T` 就是整棵树，`/F` 强制）
 * - POSIX：给**进程组**发信号（负号 pid）—— 这要求 spawn 时 `detached: true`，
 *   调用方必须照做，否则杀的是写错的 pid。
 */
export function buildKillTreeCommand(
  platform: NodeJS.Platform,
  pid: number
): LocalCommand {
  if (platform === 'win32') {
    return { command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
  }
  return { command: 'kill', args: ['-TERM', `-${pid}`] }
}

/** 判据：这个 shell 值是不是合法取值（供设置项与 IPC 入参共用）。 */
export function isLocalShell(value: unknown): value is LocalShell {
  return typeof value === 'string' && (LOCAL_SHELLS as readonly string[]).includes(value)
}
