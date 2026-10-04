/**
 * 往期版本下载的**纯逻辑**（B12 / T12.3~T12.4）。
 *
 * 这里只放"给定输入就能算出结果"的东西：目录命名、冲突改名、阶段进度、
 * 清单安全校验。真正的 IO（读远端 manifest、下载、本地改名）在
 * `services/archive-download.ts`，它把下面这些当作零件用。
 *
 * ## 两条不变量（写错了都是"用户的数据不见了"级别）
 *
 * 1. **写入的位置只能由主进程拼**。渲染进程可以传 `finalName`（单层名字），
 *    但 `saveDir` 与 `finalName` 的拼接、以及"暂存目录在哪个父目录下"全在这里定。
 *    让渲染进程传完整路径，等于把"往哪写"的决定权交给了一个可能被注入的层。
 * 2. **暂存与最终目录必须是同一个父目录下的兄弟**。跨目录改名的语义是"复制 + 删除"，
 *    Windows 上还会因占用失败 —— 下载了 10 GB 却在最后一步失败是最亏的失败方式。
 */
import { posix, win32 } from 'node:path'
import { isSafeRelPath } from './hash-core'

/** 暂存目录前缀：`.sfvm-part-<archiveId>`。以点开头是为了在文件管理器里默认不显眼。 */
export const LOCAL_STAGING_PREFIX = '.sfvm-part-'

/**
 * 同名目录已存在时最多往后找多少个候选（`-2` … `-51`）。
 *
 * 有上限：没有上限的循环在"目录真的堆了一堆同名"时会一直转下去，
 * 而那时正确的结果是报错让用户自己选，不是替他造一个 `-4821`。
 */
export const LOCAL_NAME_MAX_ATTEMPTS = 50

/**
 * 文件系统非法字符（Windows 严格，Unix 宽松 —— 取并集，因为同一个产物
 * 可能在两种系统上都被下载）。也包含控制字符：它们在部分文件系统上会直接失败，
 * 而在终端里显示时能把一行日志搞乱。
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

/** Windows 保留设备名：不能作为文件名（`CON`、`NUL`、`COM1`…，含带扩展名的形式）。 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

/**
 * 把一个远端来的名字净化成**单层、跨平台可用**的本地目录名。
 *
 * 目标名来自用户配置（`target.name`），版本号来自远端目录名 —— 两者都不是
 * 本地文件系统能直接信任的输入。净化而不是拒绝：拒绝会让"目标名里有个冒号"
 * 这种小事变成"这个版本永远下载不了"。
 */
export function sanitizeLocalName(raw: string): string {
  let s = raw.normalize('NFC').replace(ILLEGAL_CHARS, '_')
  // Windows 不允许结尾是点或空格（会静默截断，造成"名字对不上"）
  s = s.replace(/[. ]+$/g, '')
  // 折叠连续下划线：`a::b` 净化后是 `a__b`，不好看但也不该被当成路径
  s = s.replace(/_{2,}/g, '_')
  s = s.trim()
  if (s === '' || s === '.' || s === '..') return 'archive'
  if (RESERVED_NAMES.has(s.toLowerCase())) return `_${s}`
  // 255 是多数文件系统的单层上限；留出版本号后缀的空间由调用方保证
  return s.length > 120 ? s.slice(0, 120) : s
}

/**
 * 最终目录名：`<目标名>-<版本号>`。
 *
 * 带上目标名是为了"一个下载目录里躺着多个目标的产物"时还能认出来；
 * 版本号在后（同目标的多个版本按名字排序就是时间序）。
 */
export function buildArchiveDirName(targetName: string, versionTag: string): string {
  const name = sanitizeLocalName(targetName)
  const tag = sanitizeLocalName(versionTag)
  return `${name}-${tag}`
}

/** 暂存目录名（单层）。用归档 id 而不是版本号：同一版本在下载被中断后重下时能原地覆盖。 */
export function stagingNameOf(archiveId: string): string {
  return `${LOCAL_STAGING_PREFIX}${sanitizeLocalName(archiveId)}`
}

/**
 * 在 `preferred` 已被占用时，依次尝试 `preferred-2`、`preferred-3`…
 *
 * 返回第一个没被占用的名字，以及"是不是改过名"。全部被占用时返回 null ——
 * 由调用方决定怎么报错（这个函数不认识错误码，也不该认识）。
 *
 * `isTaken` 允许返回 Promise：占用判断要真的去 `stat` 文件系统，而异步判定
 * 硬塞进同步循环里只会逼调用方预先算好一整批候选。
 */
export async function pickFreeDirName(
  preferred: string,
  isTaken: (name: string) => boolean | Promise<boolean>,
  maxAttempts = LOCAL_NAME_MAX_ATTEMPTS
): Promise<{ name: string; adjustedFrom: string | null } | null> {
  if (!(await isTaken(preferred))) return { name: preferred, adjustedFrom: null }
  for (let i = 2; i <= maxAttempts; i++) {
    const candidate = `${preferred}-${i}`
    if (!(await isTaken(candidate))) return { name: candidate, adjustedFrom: preferred }
  }
  return null
}

/**
 * 把 `name` 拼到 `dir` 下，并断言结果确实在 `dir` 之内。
 *
 * 这是一个**兜底断言**：`finalName` 在契约层已经拒绝过分隔符，但"路径拼装"
 * 是那种一旦出错就无法回头的地方，多一次 `..`/绝对路径检查的成本可以忽略。
 * 同时兼容 Windows 与 POSIX 两种分隔符的绝对路径写法。
 */
export function joinInside(dir: string, name: string): string {
  if (name === '' || name.includes('/') || name.includes('\\')) {
    throw new Error(`目录名不合法（不允许路径分隔符）：${JSON.stringify(name)}`)
  }
  const isWin = /^[a-zA-Z]:[\\/]/.test(dir) || dir.includes('\\')
  const p = isWin ? win32 : posix
  const joined = p.resolve(dir, name)
  const base = p.resolve(dir)
  if (joined !== p.join(base, name) || p.dirname(joined) !== base) {
    throw new Error(`拒绝把目录写到 ${JSON.stringify(dir)} 之外：${JSON.stringify(name)}`)
  }
  return joined
}

/* ------------------------------------------------------------ 阶段进度 */

/**
 * 下载的四个阶段与它们在 0~100 里的区间。
 *
 * 区间取值与发布（`DEPLOY_STAGE_PROGRESS`）同一个思路：**阶段之间要留出
 * 足够的跨度**，否则进度条会在最后一步长时间停在 99%。这里把大头（92%）留给
 * 真正的字节传输，因为它才是耗时的那一段。
 */
export const DOWNLOAD_STAGES = [
  { key: 'manifest', label: '读取版本清单', from: 0, to: 3 },
  { key: 'fetch', label: '下载文件', from: 3, to: 92 },
  { key: 'verify', label: '本地复核', from: 92, to: 97 },
  { key: 'finalize', label: '整理目录', from: 97, to: 100 }
] as const

export type DownloadStageKey = (typeof DOWNLOAD_STAGES)[number]['key']

export function downloadStageRange(key: DownloadStageKey): { from: number; to: number } {
  const def = DOWNLOAD_STAGES.find((s) => s.key === key)
  return def ? { from: def.from, to: def.to } : { from: 0, to: 0 }
}

/** 把"传输已经完成 n/total 字节"映射到该阶段的百分数（不越过区间上界）。 */
export function mapStagePercent(
  key: DownloadStageKey,
  done: number,
  total: number
): number {
  const { from, to } = downloadStageRange(key)
  if (!(total > 0)) return from
  const ratio = Math.min(1, Math.max(0, done / total))
  return from + Math.floor((to - from) * ratio)
}

/* -------------------------------------------------------- 清单安全校验 */

/**
 * 找出 manifest 里**逃出 payload 目录**的 relPath。
 *
 * 这是下载路径上唯一一处"远端内容能决定本地写哪"的地方，所以必须显式拦住：
 * 一个被改坏的（或恶意构造的）manifest 只要写上 `../../.ssh/authorized_keys`，
 * 下载就会把远端文件写到产物目录之外。
 *
 * 判据 = 归档侧那套 `isSafeRelPath` **加上**两条"本地文件系统专有"的约束。
 * 分层而不是重写：前者的语义（相对、无 `.`/`..`、无换行/空字符）是两边共用的
 * 底线，后者是本地才在乎的东西（见 `isSafeLocalRelPath`）。两边口径若各写一份，
 * 迟早出现"能归档却下不回来"这种没人能解释的怪事。
 *
 * 返回前 20 个（够了：用户要的是"有问题"，不是"全部有问题的清单"）。
 */
export function unsafeRelPathsOf(relPaths: readonly string[]): string[] {
  const bad: string[] = []
  for (const p of relPaths) {
    if (!isSafeLocalRelPath(p)) {
      bad.push(p)
      if (bad.length >= 20) break
    }
  }
  return bad
}

/**
 * 本地下载才需要的两条额外约束（在 `isSafeRelPath` 之上）：
 *
 * - **含 `\\` 或盘符前缀**：`C:\foo` 在 `isSafeRelPath` 下是"合法相对路径"
 *   （它只认 `/`），但在本地它会被当成一个**带反斜杠的文件名**（POSIX）或
 *   被 Windows 当成另一处位置。归档侧不需要禁它（远端 SFTP 路径统一用 `/`），
 *   下载侧必须禁。
 * - **超长**：单条 relPath 上限 4096 —— 拼接后超过各系统的 PATH_MAX 时，
 *   报错会发生在"写到第 3000 个文件时"，那时用户已经等了几分钟。
 */
export function isSafeLocalRelPath(relPath: string): boolean {
  if (relPath.length > 4096) return false
  if (relPath.includes('\\')) return false
  if (/^[a-zA-Z]:/.test(relPath)) return false
  return isSafeRelPath(relPath)
}
