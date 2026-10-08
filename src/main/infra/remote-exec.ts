/**
 * 远端命令执行的白名单与参数转义（T08.1 / T08.2）。
 *
 * B07 先做了"哈希与校验必需"的子集（因为 T07.5 的能力分支与 T07.7 的
 * `sha256sum -c` 必须真的在远端跑命令），B08 在这里补全方案书 §8.3 的整张表：
 * `df` / `chmod` / `chown`，以及完整的能力探测与注入用例矩阵。
 *
 * ## 核心约束（方案书 §8.3 / §10.5）
 *
 * **调用方永远不能提供命令字符串。** 只能调用具名方法、传入参数；
 * 命令由本文件的模板拼出。这样"命令注入"在类型层面就不成立，
 * 而不是靠运行时过滤字符串——过滤方案总会有绕过方式。
 *
 * 参数侧仍有三道防线，缺一不可：
 * 1. 路径先过 `assertSafeRemotePath`（拦 `..`、换行、控制字符）
 * 2. 非路径参数走专用校验器（`assertModeBits` 八进制权限位、`assertIdNumber` UID/GID 整数）
 * 3. 再过 `quoteShellArg`（单引号包裹 + 内部单引号转义为 `'\''`）
 *
 * 第 3 步不能省：即使路径合法，`/opt/it's here` 这类含单引号的路径
 * 直接拼进命令同样会截断参数。
 *
 * ## 出口自检
 *
 * `assertCommandAllowed()` 是最后一道闸：**所有真正送去执行的命令都要过它**
 * （连接池 `SshConnectionPool.exec` 与本文件的能力探测都已接入）。
 * 一旦将来有人绕开模板直接拼字符串，会在开发阶段就炸出来。
 *
 * 本文件是**纯逻辑**（无 I/O），因此可以完整单测。
 */
import { AppError, ErrorCode } from './errors'
import { assertSafeRemotePath } from './remote-path'

/**
 * 本文件允许出现的命令（方案书 §8.3 的完整白名单）。
 *
 * 注意刻意**没有** `rm` / `mv` / `cp` / `cat` —— 文件操作一律走 SFTP（方案书 §8.3），
 * 远端只跑"读信息"、"调权限"和"校验"三类命令。
 *
 * 几个不显然的成员：
 * - `cd` 是 shell 内建，出现的原因是 `sha256sum -c` 按当前目录解析相对路径。
 * - `printf` 用于取家目录（`printf %s "$HOME"`）；不用 `echo $HOME`，
 *   因为 `echo` 对转义与换行的处理因 shell 而异。
 * - `test` 用于写权限探测（`test -w <路径>`）。**刻意只用退出码**，
 *   不拼 `&& echo yes || echo no` —— 那会把 `echo` 也拖进白名单，
 *   而退码本来就能表达结果，少一个程序就少一个攻击面。
 */
export const ALLOWED_COMMANDS = [
  'uname',
  'command',
  'printf',
  'cd',
  'sha256sum',
  'shasum',
  'df',
  'chmod',
  'chown',
  'test'
] as const

export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number]

/** 命令被拒绝时抛出的错误，便于单测断言"拦的是哪一类"。 */
export class UnsafeCommandError extends AppError {
  constructor(reason: string, detail?: unknown) {
    super(ErrorCode.E_PATH_UNSAFE, detail, {
      message: `拒绝执行非白名单命令：${reason}`,
      hint: '这是一次内部错误，请把日志反馈给开发者。'
    })
    this.name = 'UnsafeCommandError'
  }
}

/**
 * 单引号包裹一个 shell 参数。**不许省略**：这是参数层的最后一道防线。
 *
 * 单引号内的内容 shell 一律不做解释，因此只需处理"参数自身含单引号"：
 * 闭合当前引号、插入一个转义单引号、再重新开引号（`'\''`）。
 * 空字符直接拒绝 —— shell 无法在参数中传递 NUL。
 */
export function quoteShellArg(value: unknown): string {
  if (typeof value !== 'string') throw new UnsafeCommandError('参数不是字符串', { value })
  if (value.includes('\0')) throw new UnsafeCommandError('参数含空字符', { value })
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 校验并规范化远端路径，再交给 `quoteShellArg`。 */
export function quoteRemotePath(value: unknown): string {
  const r = assertSafeRemotePath(value)
  if (!r.ok) throw new UnsafeCommandError(`路径不合法（${r.reason}）`, { value, reason: r.reason })
  return quoteShellArg(r.normalized)
}

/* ------------------------------------------------------------ 命令模板 */

export type HashCheckTool = 'sha256sum' | 'shasum'

export interface HashCheckOptions {
  tool: HashCheckTool
  /** relPath 相对的目录（远端绝对路径） */
  cwd: string
  /** 清单文件（远端绝对路径） */
  manifestPath: string
  /**
   * 是否加 `--status`（只留退出码、不输出逐文件结果）。
   *
   * 默认 **false**：方案书 §6.6 要求把差异明细展示给用户，
   * 而 `--status` 会把"哪个文件坏了"一并吞掉。退出码仍作为兜底判定。
   */
  status?: boolean
}

/**
 * `cd <cwd> && <tool> -c <manifest>`
 *
 * 为什么必须 `cd`：`sha256sum -c` 是按**当前目录**解析清单里的相对路径的，
 * 不切过去就会把 `dist/a.js` 当成 `$HOME/dist/a.js`，得到"文件缺失"的假告警。
 * 这里的 `&&` 是本模板写死的连接符，不是用户可传入的内容。
 */
export function buildHashCheckCommand(opts: HashCheckOptions): string {
  const cwd = quoteRemotePath(opts.cwd)
  const manifest = quoteRemotePath(opts.manifestPath)
  const status = opts.status ? ' --status' : ''
  // BSD / macOS 的 shasum 需要 `-a 256` 指定算法，与 sha256sum 的默认行为对齐
  const invoker = opts.tool === 'sha256sum' ? `sha256sum -c${status}` : `shasum -a 256 -c${status}`
  return `cd ${cwd} && ${invoker} ${manifest}`
}

/** `uname -s`：平台探测。 */
export function buildUnameCommand(): string {
  return 'uname -s'
}

/** `command -v <cmd>`：能力探测。cmd 受限于白名单。 */
export function buildCommandVCommand(cmd: AllowedCommand): string {
  if (!(ALLOWED_COMMANDS as readonly string[]).includes(cmd)) {
    throw new UnsafeCommandError('不在白名单内的命令', { cmd })
  }
  return `command -v ${cmd}`
}

/** `printf %s "$HOME"`：取家目录。用 printf 而不是 `echo $HOME`，避免换行与转义差异。 */
export function buildHomeCommand(): string {
  return 'printf %s "$HOME"'
}

/* -------------------------------------------------------------- 磁盘空间 */

/**
 * `df -Pk <路径>`：探测该路径所在文件系统的可用空间（T08.1，方案书 §8.3）。
 *
 * 为什么是 `-Pk` 而不是别的写法：
 * - `-P`（POSIX 输出格式）保证**一行一个文件系统、绝不折行** —— 否则设备名过长时
 *   `df` 会把一条记录拆成两行，按列解析就会错位；
 * - `-k` 固定以 1024 字节为单位。不加的话块大小随实现而变（GNU 默认 1K，
 *   但环境变量 `DF_BLOCK_SIZE` / `POSIXLY_CORRECT` 会改掉它），算出来差 512 倍。
 *
 * 刻意**不**用 `--output=avail`：那是 GNU 扩展，BSD / macOS 的 `df` 不认。
 */
export function buildDfCommand(probePath: unknown): string {
  return `df -Pk ${quoteRemotePath(probePath)}`
}

export interface DiskSpaceInfo {
  /** 可用空间（字节） */
  availableBytes: number
  /** 已用空间（字节），仅用于展示 */
  usedBytes: number
  /** 总空间（字节），仅用于展示 */
  totalBytes: number
  filesystem: string
  mountPoint: string
}

/**
 * 解析 `df -Pk` 的输出（纯逻辑，独立单测）。
 *
 * 为什么必须抽出来单测：解析错了会导致两种相反的误判 ——
 * 误判"空间不足"会无谓阻止发布，误判"空间充足"则会传到一半失败并留下远端垃圾。
 *
 * 返回 `null` 表示**没能解析出结果**（路径不存在、`df` 报错、输出异常）。
 * 调用方必须把 `null` 当作"探测失败"，而不是"空间为 0"。
 *
 * 实现要点：扫描**所有**能解析的行并取最后一条。`-P` 在主流实现上不折行，
 * 但万一设备名里带空格导致首行解析失败，取最后一条仍是正确的那条数据行。
 */
export function parseDfOutput(stdout: string): DiskSpaceInfo | null {
  if (typeof stdout !== 'string') return null
  let found: DiskSpaceInfo | null = null

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const f = line.split(/\s+/)
    // POSIX 格式固定 6 列：Filesystem 1024-blocks Used Available Capacity Mounted-on
    if (f.length < 6) continue
    const [, blocks, used, avail, capacity] = f
    // 表头（Filesystem 1024-blocks ...）的三个数字列都不是纯数字，天然被排除
    if (!/^\d+$/.test(blocks) || !/^\d+$/.test(used) || !/^\d+$/.test(avail)) continue
    if (!/^\d+%$/.test(capacity)) continue

    // Mounted-on 可能含空格，故用"前 5 列定长 + 剩余全部"重组
    const mountPoint = f.slice(5).join(' ')
    found = {
      availableBytes: Number(avail) * 1024,
      usedBytes: Number(used) * 1024,
      totalBytes: (Number(used) + Number(avail)) * 1024,
      filesystem: f[0],
      mountPoint
    }
  }

  return found
}

/* -------------------------------------------------------- 权限位与属主 */

/** 权限位：3~4 位八进制（方案书 §10.5）。 */
const MODE_BITS = /^[0-7]{3,4}$/

/** uid / gid 上限：Linux 的 uid_t 是无符号 32 位。 */
export const MAX_ID_VALUE = 4294967295

/**
 * 校验八进制权限位（T08.2）。
 *
 * `chmod` 的参数是**最容易出注入**的位置之一：它是少数"非路径参数"，
 * 早期版本若直接拼接，`chmod 755 /x; rm -rf /` 就能成立。
 *
 * 接受 3 位（`644`）与 4 位（`0644`、`4755` 即 setuid）。
 * 允许 4 位的特殊位是刻意的：T10.9 要"恢复原权限"，而原权限可能带 setuid/sticky。
 */
export function assertModeBits(mode: unknown): string {
  if (typeof mode !== 'string') throw new UnsafeCommandError('权限位必须是字符串', { mode })
  if (!MODE_BITS.test(mode)) {
    throw new UnsafeCommandError(`权限位必须是 3~4 位八进制数字：${JSON.stringify(mode)}`, { mode })
  }
  return mode
}

/**
 * 校验 UID / GID（T08.2）：必须是非负整数，且不超过 uid_t 上限。
 *
 * 同时接受 string 与 number：调用方可能从 SFTP 的 `Stats` 拿到 number，
 * 也可能从 UI 表单拿到 string。统一归一化成十进制字符串再拼命令。
 * 拒绝 `-1`、`1e3`、`0x10`、`1.5`、`+0`、带空格等一切非纯数字形态。
 */
export function assertIdNumber(value: unknown, field = 'id'): string {
  const s = typeof value === 'number' ? String(value) : value
  if (typeof s !== 'string') {
    throw new UnsafeCommandError(`${field} 必须是整数`, { value })
  }
  if (!/^\d{1,10}$/.test(s)) {
    throw new UnsafeCommandError(`${field} 必须是非负整数：${JSON.stringify(s)}`, { value })
  }
  const n = Number(s)
  if (!Number.isSafeInteger(n) || n > MAX_ID_VALUE) {
    throw new UnsafeCommandError(`${field} 超出可表示范围：${s}`, { value })
  }
  return s
}

/** `chmod <mode> <路径>`（T08.1）。 */
export function buildChmodCommand(opts: { mode: unknown; path: unknown }): string {
  return `chmod ${assertModeBits(opts.mode)} ${quoteRemotePath(opts.path)}`
}

/**
 * `chown <uid>:<gid> <路径>`（T08.1）。
 *
 * 注意：非 root 用户执行 `chown` 会失败（EPERM）。按方案书 §8.3，
 * 这是**允许失败**的操作（"仅在用户具备权限时尝试，失败仅告警"），
 * 所以这里只负责把命令拼对，是否忽略失败由调用方（T10.9）决定。
 */
export function buildChownCommand(opts: { uid: unknown; gid: unknown; path: unknown }): string {
  const uid = assertIdNumber(opts.uid, 'uid')
  const gid = assertIdNumber(opts.gid, 'gid')
  return `chown ${uid}:${gid} ${quoteRemotePath(opts.path)}`
}

/**
 * `test -w <路径>`：路径是否可写（供 T03.7 的能力探测与 T10.2 的前置校验）。
 *
 * 用**退出码**表达结果（0 = 可写），不拼 `&& echo yes || echo no`：
 * 少引入一个程序（`echo`）就少一个白名单成员，攻击面更小。
 */
export function buildWriteProbeCommand(probePath: unknown): string {
  return `test -w ${quoteRemotePath(probePath)}`
}

/* ------------------------------------------------------- 命令出口自检 */

/** 一个命令段：原始文本 + "去掉被引号包裹内容"后的骨架（用于查命令替换）。 */
interface Segment {
  raw: string
  /** 只保留单引号之外的文本；引号内的 `$(` / 反引号是字面量，不展开 */
  unquotedSkeleton: string
}

/**
 * 按 shell 分隔符切段，**但跳过单引号内部**。
 *
 * 为什么需要引号感知（B08 修正）：
 * 朴素地 `split(/[;|&]/)` 会把引号内的分号也当成分隔符 ——
 * 于是 `/opt/a;b` 这种**合法**路径会被误判成注入而拒绝执行（fail-closed 的假告警）。
 * 引号内的内容 shell 一律不解释，分隔符在那里只是普通字符，所以必须跳过。
 *
 * 引号规则按 POSIX：单引号内一切字面量（含 `\`）；引号**外** `\` 转义下一个字符
 * —— 这正是我们生成 `'\''` 转义的方法，不按这个规则解析会数错引号配平。
 *
 * 引号不配平一律视为不安全（调用方可能是手拼的字符串）。
 */
export function splitShellSegments(command: string): Segment[] {
  const segments: Segment[] = []
  let raw = ''
  let skeleton = ''
  let inQuote = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (inQuote) {
      raw += ch
      if (ch === "'") inQuote = false
      continue
    }
    if (ch === "'") {
      inQuote = true
      raw += ch
      continue
    }
    if (ch === '\\') {
      // 转义：下一个字符是字面量，不参与分隔符判定
      const next = command[i + 1] ?? ''
      raw += ch + next
      skeleton += ch + next
      i++
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      segments.push({ raw, unquotedSkeleton: skeleton })
      raw = ''
      skeleton = ''
      // 成对的 || 或 && 只算一个分隔符
      if (command[i + 1] === ch) i++
      continue
    }
    raw += ch
    skeleton += ch
  }

  if (inQuote) throw new UnsafeCommandError('命令中的单引号不配平', { command })
  segments.push({ raw, unquotedSkeleton: skeleton })
  return segments
}

/**
 * 纵深防御：任何被真正送去执行的命令都要过这里。
 *
 * 命令全由上面的模板生成，理论上不该失败。之所以仍然保留：
 * 一旦将来有人图省事绕开模板直接拼字符串，这道检查会在开发阶段就炸出来，
 * 而不是在生产上悄悄执行一条任意命令。
 *
 * 五重判定：
 * 1. 每个命令段的首个 token 必须在白名单（挡 `rm -rf /`、`cd x && cat ...`）
 * 2. 引号外的命令替换（反引号 / `$(`）一律拒绝（挡"第二次求值"）
 * 3. 单引号必须配平
 * 4. 引号外的换行/控制字符一律拒绝（换行是 shell 的隐藏分隔符，见 P2-8）
 * 5. 引号外的 `>` 重定向一律拒绝（远端只跑只读探测命令，见 P2-9）
 */
export function assertCommandAllowed(command: string): void {
  if (typeof command !== 'string' || !command.trim()) {
    throw new UnsafeCommandError('空命令')
  }
  if (command.includes('\0')) throw new UnsafeCommandError('命令含空字符')

  for (const { raw, unquotedSkeleton } of splitShellSegments(command)) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    /**
     * P2-8：**引号外**的换行/控制字符一律拒绝。
     *
     * `splitShellSegments` 只按 `;` / `|` / `&` 切段，**不把换行当分隔符** ——
     * 于是 `test -w /x<换行>rm -rf /` 会被当成"一段以 test 开头的命令"整个放行，
     * 而 shell 会在换行处另起一条命令。引号内的换行是合法数据（不进 skeleton），
     * 所以只查骨架，与 `assertSafeRemotePath` 对路径同一条规则。
     */
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(unquotedSkeleton)) {
      throw new UnsafeCommandError('命令含引号外的换行或控制字符', { command })
    }

    /**
     * P2-9：引号外的 `>`（含 `>>`、`2>`）一律拒绝。
     *
     * 白名单里的命令全是**探测类**（uname / df / test / sha256sum …），不需要重定向；
     * 而重定向能改写远端文件，等于绕过"文件操作一律走 SFTP、远端只跑只读命令"的约束。
     */
    if (unquotedSkeleton.includes('>')) {
      throw new UnsafeCommandError('命令含重定向（> / >>）', { command })
    }

    const first = trimmed.split(/\s+/)[0] as string
    if (!(ALLOWED_COMMANDS as readonly string[]).includes(first)) {
      throw new UnsafeCommandError(`命令段以非白名单程序开头：${first}`, { command })
    }
    if (/`|\$\(/.test(unquotedSkeleton)) {
      throw new UnsafeCommandError('命令含命令替换', { command })
    }
  }
}
