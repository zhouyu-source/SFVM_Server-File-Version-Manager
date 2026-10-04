/**
 * 远端能力探测的结果解析（T03.7 的纯逻辑部分）。
 *
 * ssh2 / shell 命令的输出五花八门，解析错了会导致后续发布走错分支
 * （例如误判"有 sha256sum"而实际没有 → 校验阶段才炸）。
 * 所以把解析单独抽出来单测。
 */
import type { VerifyMode } from '../../shared/contracts/hash'

export type RemotePlatform = 'linux' | 'darwin' | 'windows' | 'unknown'

export interface ConnectionCapability {
  /** 是否有 sha256sum（Linux 常用） */
  hasSha256sum: boolean
  /** 是否有 shasum（macOS / BSD） */
  hasShasum: boolean
  /** 是否有 df（磁盘空间检查） */
  hasDf: boolean
  platform: RemotePlatform
  /** 远端家目录，用于放临时清单文件（$HOME/.sfvm-tmp/） */
  homeDir: string
  /** 远端 SSH 服务标识，排障用 */
  serverBanner?: string
}

/** 由 `uname -s` 的输出判断平台。 */
export function parsePlatform(unameOutput: string): RemotePlatform {
  const s = unameOutput.trim().toLowerCase()
  if (!s) return 'unknown'
  // MINGW / MSYS / CYGWIN 说明是 Windows 上的类 Unix 环境
  if (s.includes('mingw') || s.includes('msys') || s.includes('cygwin')) return 'windows'
  if (s.startsWith('linux')) return 'linux'
  if (s.startsWith('darwin')) return 'darwin'
  // uname 不存在或报错时，可能本身就是 Windows
  if (s.includes('windows')) return 'windows'
  return 'unknown'
}

/**
 * 判断 `command -v <tool>` 的输出是否表示"存在"。
 *
 * 注意：不同 shell 的失败输出不同 —— 空字符串、非零退出、或回显一条错误。
 * 这里只认"看起来像路径"的结果，避免把报错文本当成命令存在。
 */
export function commandExists(output: string): boolean {
  const s = output.trim()
  if (!s) return false
  // 常见失败输出
  if (/not found|no .* in|command not found|未找到/i.test(s)) return false
  // 正常情况：输出一个绝对路径或命令名（取最后一行，兼容登录横幅）
  const last =
    s
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .pop() ?? ''
  return /^[/\w.\\-]+$/.test(last.trim())
}

/** 有 sha256sum 或 shasum 之一，就可以走远端命令校验（比分块读取快得多）。 */
export function hasRemoteHashTool(
  cap: Pick<ConnectionCapability, 'hasSha256sum' | 'hasShasum'>
): boolean {
  return cap.hasSha256sum || cap.hasShasum
}

/** 校验时该用哪条命令。 */
export function pickHashCommand(
  cap: Pick<ConnectionCapability, 'hasSha256sum' | 'hasShasum'>
): string | null {
  if (cap.hasSha256sum) return 'sha256sum'
  if (cap.hasShasum) return 'shasum -a 256'
  return null
}

/**
 * 远端校验走哪条分支（T07.5）。
 *
 * 这个决策必须在**发布前**做出来，因为两条路径的耗时差一个量级：
 * 命令路径（sha256sum / shasum）是远端本地读盘算哈希，
 * 降级路径要把整个产物**通过 SFTP 拉回本地**再算 —— 300MB 的产物
 * 在 10MB/s 的链路上要多花 30 秒。UI 要据此提前提示用户。
 */
export function pickVerifyMode(
  cap: Pick<ConnectionCapability, 'hasSha256sum' | 'hasShasum'>,
  verifyRemoteEnabled: boolean
): VerifyMode {
  if (!verifyRemoteEnabled) return 'disabled'
  if (cap.hasSha256sum) return 'sha256sum'
  if (cap.hasShasum) return 'shasum'
  return 'sftp-stream'
}

/** 汇总一份可读的能力说明，用于 UI 徽标与排障日志。 */
export function describeCapability(cap: ConnectionCapability): string {
  const parts = [`平台=${cap.platform}`, `home=${cap.homeDir || '(未知)'}`]
  if (cap.hasSha256sum) parts.push('sha256sum=有')
  else if (cap.hasShasum) parts.push('shasum=有')
  else parts.push('远端哈希工具=无（将降级为流式计算）')
  if (!cap.hasDf) parts.push('df=无（跳过磁盘空间检查）')
  return parts.join('，')
}
