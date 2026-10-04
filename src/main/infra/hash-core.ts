/**
 * 哈希聚合、清单文本与差异比对的**纯逻辑**（T07.3 / T07.7 / T07.8）。
 *
 * 单独抽出来的理由：这一层决定了"两端算出的指纹是否可比"，
 * 一旦排序或拼接方式不一致，会出现"文件完全一样但校验失败"的假告警，
 * 极难排查。纯函数 + 单测是唯一能把这件事钉死的办法。
 *
 * ## rootHash 算法（方案书 §6.6）
 *
 * ```
 * items 按 relPath 的 UTF-8 字节序升序排列
 * 对每个 item 依次 update:  relPath  utf8  +  "\0"  +  hash  ascii  +  "\n"
 * rootHash = sha256(以上拼接串).hex
 * ```
 *
 * 注意几个刻意的选择：
 * - **不含 size / mtime**：换个文件系统、重打一次包，内容没变就不该改指纹
 * - **排序按 UTF-8 字节序而非 JS 默认的 UTF-16 码元序**：两者对 BMP 之外的
 *   字符（emoji、部分生僻汉字）排序结果不同，会让"同一份产物在两台机器上算出
 *   不同指纹"。必须显式用 Buffer.compare
 * - **空目录的指纹 = sha256("")**（`e3b0c442…`），是确定值而非报错，
 *   便于"首次发布空目录"这种场景也能走完流程
 */

import { createHash } from 'node:crypto'
import type { HashMismatch, ReleaseItem, VerifyDiff } from '../../shared/contracts/hash'

/** sha256("") 的值。空目录的 rootHash 就取它。 */
export const EMPTY_ROOT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** 控制字符里会破坏"行式清单"的三个：\n \r \0。 */
const BREAKS_LINE_FORMAT = /[\r\n\0]/

/** relPath 合法性：相对、无 `..`/`.` 段、不含换行或空字符。 */
export function isSafeRelPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.startsWith('/')) return false
  if (BREAKS_LINE_FORMAT.test(p)) return false
  return !p.split('/').some((s) => s === '' || s === '.' || s === '..')
}

/**
 * 规范化本地遍历产生的相对路径。
 * 返回 null 表示该路径不可用（调用方应报错而不是默默跳过）。
 */
export function normalizeRelPath(input: string): string | null {
  if (typeof input !== 'string' || !input) return null
  const p = input.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!isSafeRelPath(p)) return null
  return p
}

/** 按 relPath 的 **UTF-8 字节序**比较。 */
export function compareRelPathUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** 返回按 UTF-8 字节序排序后的**新数组**（不改动入参）。 */
export function sortByRelPathUtf8<T extends { relPath: string }>(items: readonly T[]): T[] {
  return [...items].sort((x, y) => compareRelPathUtf8(x.relPath, y.relPath))
}

/** 聚合指纹。入参会先排序，因此调用方无需保证顺序。 */
export function computeRootHash(items: readonly { relPath: string; hash: string }[]): string {
  const h = createHash('sha256')
  for (const it of sortByRelPathUtf8(items)) {
    h.update(it.relPath, 'utf8')
    h.update('\0')
    h.update(it.hash, 'ascii')
    h.update('\n')
  }
  return h.digest('hex')
}

export function sumBytes(items: readonly { size: number }[]): number {
  let n = 0
  for (const it of items) n += it.size
  return n
}

/* ------------------------------------------------- 远端暂存路径拼接 */

/** `joinRemote('/a/b', 'x/y')` → `/a/b/x/y`（不做任何安全性判断，路径已由 relPath 校验保证）。 */
export function joinRemote(dir: string, relPath: string): string {
  const base = dir.replace(/\/+$/, '')
  return `${base}/${relPath}`
}

/* ------------------------------------------- sha256sum 清单文本（T07.7） */

/**
 * GNU coreutils 的转义规则：文件名含 `\` 或 `\n` 时，
 * 该行以 `\` 开头，且名内的 `\` → `\\`、换行 → `\n`（字面两字符）。
 * 不做这层转义，含反斜杠的文件名会让 `sha256sum -c` 解析错行。
 */
export function escapeSha256SumPath(relPath: string): { text: string; escaped: boolean } {
  if (!/[\\\n]/.test(relPath)) return { text: relPath, escaped: false }
  return {
    text: relPath.replace(/\\/g, '\\\\').replace(/\n/g, '\\n'),
    escaped: true
  }
}

/** 反转义 coreutils 回显的文件名。 */
export function unescapeSha256SumPath(text: string, escaped: boolean): string {
  if (!escaped) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length) {
      const n = text[i + 1]
      if (n === '\\') {
        out += '\\'
        i++
        continue
      }
      if (n === 'n') {
        out += '\n'
        i++
        continue
      }
    }
    out += c
  }
  return out
}

/**
 * 生成 `sha256sum -c` 可消费的清单文本。
 *
 * 分隔符用**两个空格**（coreutils 的文本模式）；`sha256sum -c` 同时接受
 * ` *`（二进制模式），我们用文本模式，因为它对人类可读更友好，
 * 且在 Linux 上校验结果完全等价。
 */
export function buildSha256SumFile(items: readonly { relPath: string; hash: string }[]): string {
  if (items.length === 0) return ''
  const lines = sortByRelPathUtf8([...items]).map((it) => {
    const { text, escaped } = escapeSha256SumPath(it.relPath)
    return `${escaped ? '\\' : ''}${it.hash}  ${text}`
  })
  return `${lines.join('\n')}\n`
}

export type CheckLineStatus = 'ok' | 'failed' | 'unreadable'

export interface ParsedCheckLine {
  relPath: string
  status: CheckLineStatus
  /** 原始行，排障用 */
  raw: string
}

/**
 * 解析 `sha256sum -c`（不带 `--status`）的 stdout。
 *
 * 为什么不加 `--status`：加了以后只剩退出码，"哪个文件坏了"就没了，
 * 而方案的 §6.6 要求把差异明细展示给用户。所以刻意跑不带 `--status` 的形式，
 * 自行解析逐文件结果，退出码作为兜底。
 *
 * 只识别 `<名字>: OK` / `<名字>: FAILED` / `<名字>: FAILED open or read`
 * 三种行；`sha256sum: WARNING: …` 之类的诊断行、以及 stderr 的
 * `<name>: No such file or directory` 一律忽略。
 */
export function parseSha256SumOutput(stdout: string): ParsedCheckLine[] {
  const out: ParsedCheckLine[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line) continue

    const escaped = line.startsWith('\\')
    const body = escaped ? line.slice(1) : line

    // 用贪婪匹配吃掉名字里的 `: `，取最后一个冒号分隔
    const m = /^(.*): (OK|FAILED(?: open or read)?)$/.exec(body)
    if (!m) continue
    const name = unescapeSha256SumPath(m[1] as string, escaped)
    const kind = m[2] as string
    const status: CheckLineStatus =
      kind === 'OK' ? 'ok' : kind === 'FAILED' ? 'failed' : 'unreadable'
    out.push({ relPath: name, status, raw: rawLine })
  }
  return out
}

/** 该 tool 的 `-c` 调用长什么样（供 remote-exec 组成命令；此处只出参数，便于单测）。 */
export function hashCheckArgs(tool: 'sha256sum' | 'shasum'): string[] {
  return tool === 'sha256sum' ? ['-c'] : ['-a', '256', '-c']
}

/* ------------------------------------------------------ 差异比对（T07.8） */

export function emptyDiff(): VerifyDiff {
  return { missing: [], extra: [], mismatch: [], matchedCount: 0, ok: true }
}

function finalizeDiff(d: VerifyDiff): VerifyDiff {
  d.missing.sort(compareRelPathUtf8)
  d.extra.sort(compareRelPathUtf8)
  d.mismatch.sort((a, b) => compareRelPathUtf8(a.relPath, b.relPath))
  d.ok = d.missing.length === 0 && d.extra.length === 0 && d.mismatch.length === 0
  return d
}

/**
 * 用"远端逐文件哈希"比对清单 —— SFTP 降级路径用它，可以判出全部三类差异。
 *
 * @param actual 远端实际文件的 `relPath → hash`
 */
export function diffByHashes(
  expected: readonly ReleaseItem[],
  actual: ReadonlyMap<string, string>
): VerifyDiff {
  const diff = emptyDiff()
  const expectedMap = new Map<string, string>()

  for (const it of expected) {
    expectedMap.set(it.relPath, it.hash)
    const got = actual.get(it.relPath)
    if (got === undefined) {
      diff.missing.push(it.relPath)
    } else if (got !== it.hash) {
      diff.mismatch.push({
        relPath: it.relPath,
        expected: it.hash,
        actual: got
      } satisfies HashMismatch)
    } else {
      diff.matchedCount++
    }
  }

  for (const relPath of actual.keys()) {
    if (!expectedMap.has(relPath)) diff.extra.push(relPath)
  }

  return finalizeDiff(diff)
}

/**
 * 用 `sha256sum -c` 的逐行结果比对清单 —— 命令路径用它。
 *
 * 与 `diffByHashes` 的差别（也是这个模式固有的局限，需在代码里说清楚）：
 * - 拿到的是 OK / FAILED，**拿不到远端实际的哈希值**，故 mismatch.actual 为 null
 * - 命令只检查清单里列出的文件，**判不出 `extra`**（远端多出来的文件）。
 *   因此 extra 恒为空；"有没有多余文件"由 B10 的远端 walk + 本函数组合判定
 */
export function diffByCheckOutput(
  expected: readonly ReleaseItem[],
  lines: readonly ParsedCheckLine[]
): VerifyDiff {
  const diff = emptyDiff()
  const statusOf = new Map<string, CheckLineStatus>()
  for (const l of lines) statusOf.set(l.relPath, l.status)

  for (const it of expected) {
    const st = statusOf.get(it.relPath)
    if (st === undefined) {
      // 清单里列了、但命令没报这一行：说明清单文本本身有问题（格式错/被截断），
      // 保守地按"缺失"处理并让整体校验失败
      diff.missing.push(it.relPath)
    } else if (st === 'ok') {
      diff.matchedCount++
    } else if (st === 'unreadable') {
      diff.missing.push(it.relPath)
    } else {
      diff.mismatch.push({ relPath: it.relPath, expected: it.hash, actual: null })
    }
  }

  // 命令回显里出现、但清单里没有的行：视为远端异常
  const expectedSet = new Set(expected.map((i) => i.relPath))
  for (const l of lines) {
    if (!expectedSet.has(l.relPath)) diff.extra.push(l.relPath)
  }

  return finalizeDiff(diff)
}

/** 差异规模的一句话描述，供日志与 UI 摘要。 */
export function describeDiff(diff: VerifyDiff): string {
  if (diff.ok) return `校验通过（${diff.matchedCount} 个文件一致）`
  const parts: string[] = []
  if (diff.mismatch.length) parts.push(`内容不一致 ${diff.mismatch.length} 个`)
  if (diff.missing.length) parts.push(`缺失 ${diff.missing.length} 个`)
  if (diff.extra.length) parts.push(`多余 ${diff.extra.length} 个`)
  return `校验失败：${parts.join('、')}`
}
