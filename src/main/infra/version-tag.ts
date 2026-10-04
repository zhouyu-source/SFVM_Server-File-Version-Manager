/**
 * 版本号生成（T09.2 / T09.5）。
 *
 * 方案书 §5.4：
 * ```
 * versionTag = <yyyyMMdd-HHmmss>_<rootHash 前 7 位>[_<序号>]
 * ```
 *
 * 三个容易做错的地方，这里逐一钉死：
 *
 * 1. **时区**：必须按**客户端本地时区**生成（§5.4 明文）。如果拿 `toISOString()`
 *    的 UTC 去拼，东八区的用户会看到"归档时间比自己的操作时间早 8 小时"，
 *    而运维在服务器上 `ls` 出来的目录名也和自己的日志对不上。
 * 2. **同秒冲突**：一秒内归档两次（完全可能 —— 一次发布里归档两个目标、
 *    或用户手快点了两次）会撞上同一个目录名。此时追加 `-2`、`-3`，
 *    **绝不静默覆盖**：覆盖等于把上一个版本悄悄删了。
 * 3. **哈希前缀**：写进目录名的是 `rootHash` 前 7 位，所以 `rootHash` 必须先算出来
 *    —— 这决定了归档流程里"算哈希"必须排在"定目录名"之前（见 `services/archive.ts`）。
 *
 * 本文件是纯逻辑（`exists` 由调用方注入），因此可以完整单测，
 * 包括"连续 5 次冲突后明确报错"这种在真机上很难构造的路径。
 */
import { AppError, ErrorCode } from './errors'
import { VERSION_TAG_PATTERN } from '../../shared/contracts/archive'

/** 冲突重试上限（方案书 §6.7 第 3 步："最多 5 次"）。 */
export const MAX_VERSION_TAG_ATTEMPTS = 5

export const ROOT_HASH_PREFIX_LENGTH = 7

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * ISO-8601 带**本地时区偏移**（`2025-06-12T14:30:15+08:00`）。
 *
 * 不用 `toISOString()`：那是 UTC + `Z`，与 §5.4"按客户端本地时区"的要求不符。
 * 也不能省掉偏移量 —— 没有偏移的本地时间在跨时区排查时是不可解析的。
 */
export function toLocalIso(at: Date): string {
  // getTimezoneOffset 返回的是"UTC - 本地"的分钟数（东八区为 -480），所以要取反
  const offsetMinutes = -at.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}` +
    `T${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  )
}

/** `yyyyMMdd-HHmmss`（本地时区）。 */
export function formatTagTime(at: Date): string {
  return (
    `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}` +
    `-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`
  )
}

/** 取 `rootHash` 的前 7 位（小写）。长度不足说明调用方传错了东西。 */
export function rootHashPrefix(rootHash: string): string {
  if (typeof rootHash !== 'string' || !/^[0-9a-fA-F]{7,}$/.test(rootHash)) {
    throw new AppError(
      ErrorCode.E_PARAM,
      { rootHash, reason: 'root-hash-not-hex' },
      { message: '无法生成版本号：rootHash 不是合法的十六进制哈希' }
    )
  }
  return rootHash.slice(0, ROOT_HASH_PREFIX_LENGTH).toLowerCase()
}

/**
 * 基础版本号（不带序号）。
 *
 * 例：`formatVersionTag(new Date('2025-06-12T14:30:15+08:00'), 'a1b2c3d4…')`
 * → `20250612-143015_a1b2c3d`（在 UTC+8 机器上）。
 */
export function formatVersionTag(at: Date, rootHash: string): string {
  return `${formatTagTime(at)}_${rootHashPrefix(rootHash)}`
}

/**
 * 追加序号（从 2 开始，与 §5.4 示例的 `-2`、`-3` 一致）。
 * `seq < 2` 时返回基础版本号本身 —— 让调用方不必自己分支。
 */
export function withSequence(base: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 2) return base
  return `${base}-${seq}`
}

export function isVersionTag(value: unknown): value is string {
  return typeof value === 'string' && VERSION_TAG_PATTERN.test(value)
}

export interface ResolveVersionTagInput {
  rootHash: string
  /** 用于生成时间部分；测试可注入固定时间 */
  now?: Date
  /**
   * 期望的基础版本号（不含序号）。省略时按 `now + rootHash` 生成。
   *
   * 存在的理由（B10 提出的需求）：一次发布在阶段 1 就算出了新内容的指纹，
   * 于是它当场得到一个版本号；将来这次内容被下一次发布归档时，
   * 若重新按"归档时刻 + 指纹"生成，会得到**另一个号** —— 用户在"往期版本"
   * 列表里看到的号，与他印象里那次发布对不上（同一份内容两个名字）。
   *
   * 传进来的是我们自己上一轮生成的号，但仍要校验形状：这是唯一一处
   * "外部字符串会进入远端目录名"的地方，不做校验就等于开了个拼路径的口子。
   * 若传入的号已带序号（`…-2`），**剥掉序号**再当基础号用，
   * 否则会拼出 `…-2-2` 这种既丑又不合规的名字。
   */
  baseTag?: string
  /** 判断该版本号在归档目录里是否已被占用 */
  exists: (versionTag: string, attempt: number) => Promise<boolean>
  /** 冲突重试上限，默认 5 */
  maxAttempts?: number
}

/** 剥掉序号并校验形状；非法则抛 `E_PARAM`。 */
function normalizeBaseTag(tag: string): string {
  const m = /^(\d{8}-\d{6}_[0-9a-f]{7})(?:-\d+)?$/.exec(tag)
  if (!m) {
    throw new AppError(
      ErrorCode.E_PARAM,
      { tag, reason: 'not-a-version-tag' },
      { message: `指定的版本号不合规：${JSON.stringify(tag)}` }
    )
  }
  return m[1]!
}

export interface ResolvedVersionTag {
  versionTag: string
  /** 为了拿到这个版本号试了几次（1 = 一次命中，无冲突） */
  attempts: number
}

/**
 * 解析出一个**未被占用**的版本号。
 *
 * 与 `resolveVersionTag` 的区别：这个版本把 usage 暴露出来，
 * 便于 service 层把"发生了冲突"写进日志与任务控制台 —— 冲突是应该被看见的信号，
 * 不是可以吞掉的重试噪音。
 */
export async function resolveVersionTagDetailed(
  input: ResolveVersionTagInput
): Promise<ResolvedVersionTag> {
  const base =
    input.baseTag !== undefined
      ? normalizeBaseTag(input.baseTag)
      : formatVersionTag(input.now ?? new Date(), input.rootHash)
  const maxAttempts = Math.max(1, input.maxAttempts ?? MAX_VERSION_TAG_ATTEMPTS)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = withSequence(base, attempt)
    if (!(await input.exists(candidate, attempt))) {
      return { versionTag: candidate, attempts: attempt }
    }
  }

  throw new AppError(
    ErrorCode.E_VERSION_TAG_CONFLICT,
    { base, maxAttempts },
    {
      message: `版本号 ${base} 连续 ${maxAttempts} 次都冲突（归档目录里已有同名版本）`,
      hint: '请稍后重试；若反复冲突，说明归档目录里堆积了同一秒的旧版本，可手工清理。'
    }
  )
}

/** 只要版本号的简写。 */
export async function resolveVersionTag(input: ResolveVersionTagInput): Promise<string> {
  return (await resolveVersionTagDetailed(input)).versionTag
}
