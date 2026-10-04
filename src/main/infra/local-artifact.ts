/**
 * 本地产物探测的**纯逻辑**（B11 / T11.1~T11.2）。
 *
 * 这里只做"给定 mtime 与当前时间能得出什么结论"这类判断，IO 在 `ipc/workspace.ts`。
 * 拆开的理由与 B09 的 `retention.ts` 一致：这类边界（刚好 24 小时、时钟回拨、
 * 非法时间戳、类型不符）靠人工点界面覆盖不到，而判断错了是**误导用户** ——
 * 要么天天报"产物可能过期"让人麻木，要么明明过期却不提示。
 *
 * B17 追加了「本地文件名 vs 服务器端文件名」这一项：它同样是"提不提醒"的判断，
 * 而且**必须与发布链路用同一个函数** —— 否则会出现"界面说会改名、发布却按原名走"
 * 这类两边不一致的坑。
 */
import { basename } from 'node:path'
import { posixBasename } from './archive-dir'

/**
 * "可能已过期"的阈值：24 小时（T11.2 原文：`mtime` 超 24 小时显示黄色徽标）。
 *
 * 只提示、不阻止发布：一个稳定的产物（手工维护的静态包）完全可能几天不变，
 * 把它当错误拦下来，用户很快就会学会"无视这个提示"，那提示就白做了。
 */
export const ARTIFACT_STALE_MS = 24 * 60 * 60 * 1000

/**
 * 是否"可能已过期"。
 *
 * 时间戳非法（NaN）或**晚于当前时间**时返回 false：
 * - 非法：拿不到 mtime 就不该说它过期（"产物存不存在"由另一条判断负责）；
 * - 未来时间：系统时钟被回拨、或文件来自另一台机器时的常见现象。
 *   报"过期"是错的，报"刚刚改过"同样没意义 —— 这里选择不提示。
 */
export function isArtifactStale(mtimeMs: number | null | undefined, now: number): boolean {
  if (mtimeMs === null || mtimeMs === undefined || !Number.isFinite(mtimeMs)) return false
  if (!Number.isFinite(now)) return false
  const age = now - mtimeMs
  if (age < 0) return false
  return age > ARTIFACT_STALE_MS
}

/**
 * "最近一次变动" = 一批 mtime 里**较新**的那个（非法值忽略；全不可用返回 null）。
 *
 * 为什么不是只取目录自身的 mtime：**就地覆盖写文件不会改父目录的 mtime**。
 * 只看目录 mtime 时，一个刚被 `vite build` 就地重写过的产物可能仍显示"3 天前"，
 * 于是用户看到一枚"可能过期"的徽标却刚刚构建过 —— 提示一旦不可信就会被无视。
 * 取"目录 mtime 与全部文件 mtime 的较新者"两种情形都覆盖得到，且不需要读文件内容。
 */
export function newestMtimeOf(values: ReadonlyArray<number | null | undefined>): number | null {
  let best: number | null = null
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue
    if (best === null || v > best) best = v
  }
  return best
}

/**
 * 距今多久的人类可读文案（"刚刚 / 3 小时前 / 3 天前"）。
 *
 * 用整数量级而不是精确值：这个数字只用来让用户判断"这是不是我刚构建的那一份"，
 * 秒级精度没有意义，反而占更宽的位置。
 */
export function describeAge(mtimeMs: number | null | undefined, now: number): string | null {
  if (mtimeMs === null || mtimeMs === undefined || !Number.isFinite(mtimeMs)) return null
  const age = now - mtimeMs
  if (age < 0) return '时间在未来'
  const minutes = Math.floor(age / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

/**
 * 目标类型与本地路径类型不符时的说明（UI 直接展示）。
 *
 * 提前在详情页说清楚，比让用户点了"发布"再收到 `E_LOCAL_PATH_KIND` 好得多 ——
 * 那时用户已经期待过一次发布，失望成本更高。
 */
export function describeKindMismatch(input: {
  targetKind: 'dir' | 'file'
  localKind: 'dir' | 'file' | null
}): string | null {
  if (!input.localKind || input.localKind === input.targetKind) return null
  const want = input.targetKind === 'dir' ? '目录' : '文件'
  const got = input.localKind === 'dir' ? '目录' : '文件'
  return `目标是${want}型，而本地路径是${got} —— 请修正本地产物配置`
}

/* -------------------------------------------- 文件名对齐（B17 / T17.2） */

/**
 * 文件型目标的「本地文件名 vs 服务器端文件名」。
 *
 * ## 为什么只有文件型目标存在这个问题
 *
 * 目录型目标是把**内容整体**搬进目标目录（`rename(payload → /opt/web/dist)`），
 * 目标目录叫什么名字与产物里的文件无关；而文件型目标要 rename 的是
 * `payload/<服务器端文件名>` 这**一个文件**，它的名字由目标的 `remotePath`
 * 决定。所以一旦本地产物的文件名与配置不一致，换版就会去找一个不存在的路径
 * —— 这正是 B17 要修的那个 bug（修法是"上传就按配置名落盘"，见
 * `infra/deploy-plan.ts` 的 `alignArtifactItems`）。
 *
 * ## 返回 null 的三种情况（都不是"不一致"）
 *
 * - 目录型目标：概念上不适用；
 * - 两边任一为空：还没配本地产物 / 配置残缺，由别的检查项负责（在这里报"不一致"
 *   会与"未配置本地产物"的错误项重复，且提示毫无可操作性）；
 * - 名字完全相同：一切正常，界面不该多说一句话。
 *
 * 比较是**逐字节**的：Windows 本机不区分大小写，但服务器（Linux）区分，
 * 所以 `Order.jar` 与 `order.jar` 必须按"不一致"处理 —— 否则发布时换版会失败。
 */
export interface FileNameAlignment {
  /** 本地产物的文件名（取本地路径的 basename） */
  localName: string
  /** 目标配置里的服务器端文件名（取 `remotePath` 的 basename） */
  remoteName: string
}

export function fileNameAlignmentOf(input: {
  targetKind: 'dir' | 'file'
  localPath: string | null | undefined
  remotePath: string | null | undefined
}): FileNameAlignment | null {
  if (input.targetKind !== 'file') return null
  const localPath = input.localPath?.trim() ?? ''
  const remotePath = input.remotePath?.trim() ?? ''
  if (!localPath || !remotePath) return null
  // 本地路径用平台的 `basename`（Windows 上 `\` 与 `/` 都认），
  // 与 `hashLocalArtifact` 生成 relPath 的口径**必须是同一个函数**。
  const localName = basename(localPath)
  const remoteName = posixBasename(remotePath)
  if (!localName || !remoteName || localName === remoteName) return null
  return { localName, remoteName }
}

/** 不一致时的中文说明（目标详情页直接展示；发布链路用同一句话记日志）。 */
export function describeNameMismatch(a: FileNameAlignment): string {
  return (
    `本地产物文件名是 ${a.localName}，服务器端文件名是 ${a.remoteName}：` +
    `发布时会以 ${a.remoteName} 上传到服务器（不会沿用本地的文件名）`
  )
}
