/**
 * 远端路径安全校验（T05.3）。
 *
 * 为什么单独抽成纯逻辑：这是**路径逃逸的第一道防线**（方案书 §10.4）。
 * 远端路径会被拼进 shell 命令（`chmod` / `df` / `sha256sum`），
 * 一旦允许 `..`、换行或空字符，就可能越权操作受管目标之外的目录。
 *
 * 校验规则（严格按方案书 §6.4）：
 * 1. 必须是绝对路径（以 `/` 开头）
 * 2. 不能是根目录 `/`
 * 3. 不能包含 `..` 路径段（含各种变形）
 * 4. 不能包含空字符 NUL
 * 5. 长度 ≤ 4096
 *
 * 额外加固（方案书未列，但属于同类风险，故一并拦下并测试固定）：
 * 6. 不能包含换行 / 回车 —— 它们能截断单引号包裹的 shell 参数，
 *    是命令注入的经典载体
 * 7. 不能包含其他控制字符（\x00-\x1f）
 * 8. 拒绝末尾是 `.` 或 `..` 的段（`.` 段本身无害但通常意味着输入有误）
 */

export type PathRejectReason =
  | 'not-absolute'
  | 'is-root'
  | 'has-parent-segment'
  | 'has-null'
  | 'too-long'
  | 'has-newline'
  | 'has-control-char'
  | 'empty'
  | 'has-dot-segment'

export interface PathCheckOk {
  ok: true
  /** 规范化后的路径（折叠重复斜杠、去掉末尾斜杠，根目录除外） */
  normalized: string
}

export interface PathCheckFail {
  ok: false
  reason: PathRejectReason
  /** 面向用户的中文说明 */
  message: string
}

export type PathCheckResult = PathCheckOk | PathCheckFail

export const MAX_REMOTE_PATH_LENGTH = 4096

const REASON_TEXT: Record<PathRejectReason, string> = {
  empty: '路径不能为空',
  'not-absolute': '路径必须是绝对路径（以 / 开头）',
  'is-root': '不允许把根目录作为受管目标',
  'has-parent-segment': '路径不能包含 .. （会逃逸出受管目录）',
  'has-null': '路径包含非法字符',
  'too-long': `路径长度不能超过 ${MAX_REMOTE_PATH_LENGTH} 个字符`,
  'has-newline': '路径不能包含换行符',
  'has-control-char': '路径包含不可见的控制字符',
  'has-dot-segment': '路径包含无效的 . 或 .. 段'
}

function fail(reason: PathRejectReason): PathCheckFail {
  return { ok: false, reason, message: REASON_TEXT[reason] }
}

/** 规范化：折叠重复斜杠；去掉末尾斜杠（保留根 `/`）。 */
export function normalizeRemotePath(input: string): string {
  const collapsed = input.replace(/\/{2,}/g, '/')
  if (collapsed === '/') return '/'
  return collapsed.replace(/\/+$/, '')
}

/**
 * 校验远端路径。返回规范化后的路径或明确的中文失败原因。
 */
export function assertSafeRemotePath(input: unknown): PathCheckResult {
  if (typeof input !== 'string') return fail('empty')
  const raw = input

  if (raw.length === 0) return fail('empty')
  if (raw.length > MAX_REMOTE_PATH_LENGTH) return fail('too-long')
  if (raw.includes('\0')) return fail('has-null')
  // 换行/回车单独给文案：它是最危险的注入载体，值得让用户看懂
  if (/[\r\n]/.test(raw)) return fail('has-newline')
  // 其余控制字符（排除上面已处理的）
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return fail('has-control-char')

  if (!raw.startsWith('/')) return fail('not-absolute')

  const normalized = normalizeRemotePath(raw)
  if (normalized === '/') return fail('is-root')

  const segments = normalized.split('/').filter((s) => s.length > 0)
  for (const seg of segments) {
    if (seg === '..') return fail('has-parent-segment')
    if (seg === '.') return fail('has-dot-segment')
  }

  return { ok: true, normalized }
}

/**
 * 便捷布尔版，并在失败时抛错 —— 供 service 层在写库前调用。
 * 抛错时带上中文原因，便于 UI 直接展示。
 */
export class UnsafePathError extends Error {
  readonly reason: PathRejectReason
  constructor(reason: PathRejectReason, message: string) {
    super(message)
    this.name = 'UnsafePathError'
    this.reason = reason
  }
}

export function requireSafeRemotePath(input: unknown): string {
  const r = assertSafeRemotePath(input)
  if (!r.ok) throw new UnsafePathError(r.reason, r.message)
  return r.normalized
}

/**
 * 判断 `child` 是否位于 `parent` 之下（用于"不越界"检查）。
 * 两者都应已通过 assertSafeRemotePath。
 *
 * 注意用 `parent + '/'` 前缀比较，避免 `/opt/app2` 被误判为 `/opt/app` 的子路径。
 */
export function isPathUnder(child: string, parent: string): boolean {
  const a = normalizeRemotePath(child)
  const b = normalizeRemotePath(parent)
  if (a === b) return true
  return a.startsWith(`${b}/`)
}
