/**
 * 归档目录推导（T05.4）。
 *
 * 方案书 §6.7 规定：归档目录默认是「目标同父目录下的 `<basename>.versions`」。
 * 必须同父目录，才能保证换版用 `rename` 时**同文件系统**（否则 EXDEV），
 * 这是整个原子换版方案的前提。
 */
import { normalizeRemotePath, requireSafeRemotePath } from './remote-path'

export interface ArchiveDirInput {
  remotePath: string
  /** 用户自定义覆盖；为空则按规则推导 */
  archiveDir?: string | null
  kind?: 'dir' | 'file'
}

/**
 * posix dirname：只用字符串处理，不引入 path 模块的差异行为。
 */
function posixDirname(p: string): string {
  const normalized = normalizeRemotePath(p)
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '/'
  return normalized.slice(0, idx)
}

function posixBasename(p: string): string {
  const normalized = normalizeRemotePath(p)
  const idx = normalized.lastIndexOf('/')
  return idx < 0 ? normalized : normalized.slice(idx + 1)
}

/**
 * 推导归档目录。
 *
 * - 自定义 `archiveDir` 优先：**必须先过 `requireSafeRemotePath`**（P1-3）——
 *   之前只做 `normalizeRemotePath`（折叠斜杠），相对路径、`..`、换行都能原样
 *   通过，注释里"已规范化为绝对路径"是一句空话；归档会写到工作区外的任意位置。
 * - 否则 `<父目录>/<basename>.versions`
 *
 * 例：
 *   /opt/app/dist      → /opt/app/dist.versions
 *   /opt/svc/order.jar → /opt/svc/order.jar.versions
 */
export function resolveArchiveDir(input: ArchiveDirInput): string {
  const remotePath = normalizeRemotePath(input.remotePath)

  if (input.archiveDir && input.archiveDir.trim()) {
    return normalizeRemotePath(requireSafeRemotePath(input.archiveDir.trim()))
  }

  const parent = posixDirname(remotePath)
  const base = posixBasename(remotePath)
  // 父目录是根时避免出现 `//xxx.versions`
  return parent === '/' ? `/${base}.versions` : `${parent}/${base}.versions`
}

/**
 * 判断目标类型：`.jar` 视为文件，其余视为目录。
 * 用户可在 UI 上手动切换（方案书 §6.4），所以这只是默认值。
 */
export function inferTargetKind(remotePath: string): 'dir' | 'file' {
  const base = posixBasename(remotePath).toLowerCase()
  return base.endsWith('.jar') ? 'file' : 'dir'
}

/** 目标路径的父目录（用于"父目录可写"体检与暂存目录定位）。 */
export function parentDirOf(remotePath: string): string {
  return posixDirname(remotePath)
}

export { posixBasename, posixDirname }
