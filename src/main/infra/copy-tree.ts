/**
 * 远端内部的"复制一份产物"（T10.8 的内核）。
 *
 * ## 为什么需要它
 *
 * 发布的默认换版动作是 `rename`：同文件系统内瞬间完成、外部进程（nginx / JVM）
 * 不会读到半个版本。但当**目标路径本身是一个挂载点**时，暂存目录（建在目标的父目录下）
 * 与目标就不在同一个文件系统上，`rename` 会报 `EXDEV`。
 *
 * 关键推论：**这种情况下"归档"也会失败**。归档的动作是
 * `rename(目标 → <archive_dir>/<tag>/payload/<basename>)`，源在目标自己的文件系统上，
 * 而 `<archive_dir>` 默认在父目录（另一个文件系统）—— 同样跨设备。
 * 所以支持 `copy` 策略不是"换版时换个动作"，而是**归档与换版两步都必须能复制**。
 *
 * ## 一条硬约束：源只在副本确认完整之后才被清空
 *
 * 归档方向（目标 → 归档目录）的复制如果只做了一半就失败，**目标必须原封不动**。
 * 否则会出现最坏的组合："归档没成，现网也没了"。因此本模块的顺序固定为：
 *
 * ```
 * 1. 复制所有文件
 * 2. 重新列出副本，逐条比对 (relPath, size) —— 与源完全一致才继续
 * 3. 调用方在步骤 2 通过后，才允许删除源
 * ```
 *
 * 比对用的是 `(relPath, size)` 而不是哈希：哈希意味着把每个文件再读一遍，
 * 会让 copy 模式的成本翻倍；而大小 + 相对路径集合不一致已经能覆盖
 * "漏传了文件"、"复制被截断"这两类真实故障。**内容是否逐字节正确由步骤 3 之后的
 * 远端校验（`verifyRemote`）兜底** —— 阶段 3 已经对暂存做过一次，
 * 归档则会在 B12 的"校验往期版本"里做。
 *
 * 本模块不 import electron，副作用全部由 `CopyFsPort` 注入。
 */
import { posix } from 'node:path'
import { joinRemote } from './hash-core'

/** 复制用到的远端操作（SFTP）。 */
export interface CopyFsPort {
  /** 该路径是否存在、是文件还是目录 */
  stat(path: string): Promise<{ exists: boolean; isDirectory: boolean; size: number }>
  mkdirp(path: string): Promise<void>
  /** 递归删除（`remote-fs` 的三层防护仍在调用点生效） */
  rmrf(path: string): Promise<void>
  /** 单文件复制（SFTP 无原生 copy，实现里是 readStream → writeStream） */
  copyFile(srcAbsPath: string, dstAbsPath: string): Promise<void>
  /** 递归列出目录下的文件（relPath 相对于传入的 root） */
  listFiles(root: string): Promise<Array<{ relPath: string; size: number }>>
}

export interface CopyArtifactInput {
  fs: CopyFsPort
  /** 源：目录型是目录，文件型是那个文件 */
  src: string
  /** 目的地：目录型会建出这个目录，文件型会建出这个文件 */
  dst: string
  kind: 'dir' | 'file'
  signal?: AbortSignal
  /** 每复制完一个文件回调一次（用于进度） */
  onFile?: (done: number, total: number, relPath: string) => void
}

export interface CopyArtifactResult {
  files: number
  bytes: number
}

/** 复制过程中的失败。调用方负责包成自己的错误码与中文文案。 */
export class CopyArtifactError extends Error {
  readonly stage: 'list' | 'copy' | 'verify'
  constructor(stage: 'list' | 'copy' | 'verify', message: string) {
    super(message)
    this.name = 'CopyArtifactError'
    this.stage = stage
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CopyArtifactError('copy', '已取消')
}

/** 比较两份 (relPath, size) 清单是否完全一致（顺序无关）。 */
export function sameFileSet(
  a: readonly { relPath: string; size: number }[],
  b: readonly { relPath: string; size: number }[]
): boolean {
  if (a.length !== b.length) return false
  const byPath = (xs: readonly { relPath: string; size: number }[]): string[] =>
    xs.map((x) => `${x.relPath}\0${x.size}`).sort()
  const ka = byPath(a)
  const kb = byPath(b)
  for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return false
  return true
}

/**
 * 把 `src` 复制成 `dst`（**不清空 src** —— 是否删除源由调用方在验证通过后决定）。
 *
 * 复制完成后会重新列出 `dst` 并与 `src` 的清单比对；不一致则抛
 * `CopyArtifactError('verify')`，此时 `src` 仍然完好。
 */
export async function copyArtifactInto(input: CopyArtifactInput): Promise<CopyArtifactResult> {
  const { fs } = input
  throwIfAborted(input.signal)

  const srcStat = await fs.stat(input.src)
  if (!srcStat.exists) {
    throw new CopyArtifactError('list', `源路径不存在：${input.src}`)
  }

  /* ---- 文件型：单文件复制，验证用大小 ---- */
  if (input.kind === 'file') {
    if (srcStat.isDirectory) {
      throw new CopyArtifactError('list', `期望文件但 ${input.src} 是目录`)
    }
    const parent = posix.dirname(input.dst)
    if (parent && parent !== '.') await fs.mkdirp(parent)
    throwIfAborted(input.signal)
    await fs.copyFile(input.src, input.dst)
    input.onFile?.(1, 1, posix.basename(input.dst))

    const dstStat = await fs.stat(input.dst)
    if (!dstStat.exists || dstStat.isDirectory || dstStat.size !== srcStat.size) {
      throw new CopyArtifactError(
        'verify',
        `副本大小与源不一致：源 ${srcStat.size} 字节，副本 ` +
          `${dstStat.exists ? `${dstStat.size} 字节` : '不存在'}`
      )
    }
    return { files: 1, bytes: srcStat.size }
  }

  /* ---- 目录型：递归复制 ---- */
  const srcFiles = await fs.listFiles(input.src)
  const total = srcFiles.length
  await fs.mkdirp(input.dst)

  let bytes = 0
  let done = 0
  for (const f of srcFiles) {
    throwIfAborted(input.signal)
    const from = joinRemote(input.src, f.relPath)
    const to = joinRemote(input.dst, f.relPath)
    const parent = posix.dirname(to)
    if (parent && parent !== '.') await fs.mkdirp(parent)
    await fs.copyFile(from, to)
    bytes += f.size
    done += 1
    input.onFile?.(done, total, f.relPath)
  }

  /* ---- 验证：副本的文件集合必须与源一致 ---- */
  const dstFiles = await fs.listFiles(input.dst)
  if (!sameFileSet(srcFiles, dstFiles)) {
    const missing = srcFiles.filter(
      (s) => !dstFiles.some((d) => d.relPath === s.relPath && d.size === s.size)
    )
    throw new CopyArtifactError(
      'verify',
      `复制结果与源不一致：${missing.length} 个文件缺失或大小不符` +
        (missing.length > 0
          ? `（如 ${missing
              .slice(0, 3)
              .map((m) => m.relPath)
              .join('、')}）`
          : '')
    )
  }

  return { files: total, bytes }
}
