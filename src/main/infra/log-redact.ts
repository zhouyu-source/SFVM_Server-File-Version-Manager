/**
 * 日志脱敏（T01.2）。
 *
 * 原则：在数据交给 electron-log **之前**脱敏，而不是事后过滤文本。
 * 事后按字符串匹配不可靠 —— 密码可能被 JSON.stringify 转义、可能截断、
 * 也可能出现在 Error.message 里，正则容易漏。
 *
 * 本模块只做纯函数，便于单测（T01.2 的验收点就是单测）。
 */

/** 命中即整值替换的键名（小写比较，含常见变体）。 */
const SECRET_KEYS = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'secretcipher',
  'secret_cipher',
  'token',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'credential',
  'credentials',
  'authorization',
  'auth'
])

export const REDACTED = '***'

/** 键名是否是敏感字段。 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ''))
}

/**
 * 递归脱敏任意可序列化结构。
 *
 * - 敏感键的值整段替换为 `***`，不保留长度（长度本身也是信息）
 * - 处理循环引用，避免脱敏过程自己炸掉
 * - 非普通对象（Date / Error / Buffer / 函数）按需转换，不让它们漏出内容
 * - 深度上限防止超深结构拖垮日志调用
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[depth-limit]'
  if (value === null || value === undefined) return value

  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return value
  }
  if (type === 'function') return '[function]'
  if (type === 'symbol') return String(value)

  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    // message / stack 是自由文本，密码可能被拼进去（如 `auth failed for <pw>`），
    // 而 logger 恰好会打印 err.stack —— 所以这里必须过一遍文本脱敏，不能原样保留。
    return {
      name: value.name,
      message: scrubText(value.message),
      stack: value.stack ? scrubText(value.stack) : undefined,
      // Error 上可能被挂了额外字段（如 password），一并递归处理
      ...(redact(Object.fromEntries(Object.entries(value)), depth + 1, seen) as object)
    }
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`
  if (ArrayBuffer.isView(value)) return `[TypedArray ${value.byteLength} bytes]`

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[circular]'
    seen.add(value as object)

    if (Array.isArray(value)) {
      return value.map((item) => redact(item, depth + 1, seen))
    }

    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : redact(v, depth + 1, seen)
    }
    return out
  }

  return String(value)
}

/**
 * 兜底：对最终要写盘的**字符串**再做一次关键字扫描。
 *
 * 这是第二道防线，覆盖「调用方把凭据拼进消息文本」的情况
 * （如 `log.info('connecting with password=hunter2')`）。
 *
 * **能力边界（重要）**：只认「有标识」的形态 —— 键值对、JSON、URL 凭据。
 * 纯自由文本里的**裸串**（如 `auth failed for hunter2`）无法可靠识别：
 * 任何正则都会漏，而放宽规则又会误伤正常日志。
 * 因此约定是：凭据必须以结构化字段形式传给 logger，不要拼进自由文本。
 *
 * ## 性能：这里的两个正则必须是**线性**的（B20 修）
 *
 * 这个函数在每一条日志与每一次脚本输出上都跑，而脚本输出一次可以有 8MB。
 * 原来的 URL 那条写的是 `(\w+:\/\/[^:/\s]+:)([^@\s]+)(@)`：`\w+` 是贪婪的，
 * 在一个**没有匹配**的长字符串上（编译日志、base64 串、压缩过的 JS —— 全是没有
 * 空格的连续 token），每个起始位置都会把整段扫一遍再逐个回退，于是总代价是
 * O(n²)。实测：10K 字符 65ms、100K 字符 **6.4 秒** —— 8MB 的输出会把主进程
 * 冻住到天荒地老。
 *
 * 修法是**把所有量词都变成有界量词**：协议名 ≤32、用户名密码 ≤256。
 * 真实凭据远短于这个上限，而有界量词让"匹配失败"的代价也变成常数。
 * （顺带要求协议名以字母开头，比原来的 `\w+` 更贴合实际形态。）
 */
const SCHEME_WITH_AUTHORITY = /([a-z][a-z0-9+.-]{1,31}:\/\/)([^@\s/]{1,256})@/gi

export function scrubText(text: string): string {
  return (
    text
      // JSON 形态："password":"xxx"
      .replace(
        /("?(?:password|passwd|passphrase|secret|token|api_?key)"?\s*[:=]\s*)("?)([^"',\s}]+)/gi,
        (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}`
      )
      // URL 形态：https://user:pass@host —— 只替换"密码"那一段，用户名保留
      // （排障时要看的是"用哪个账号连的"，不是密码）
      .replace(SCHEME_WITH_AUTHORITY, (m, scheme: string, userinfo: string) => {
        const colon = userinfo.lastIndexOf(':')
        // 没有 `user:pass` 的形态（只有用户名）就不动它
        if (colon < 0) return m
        return `${scheme}${userinfo.slice(0, colon)}:${REDACTED}@`
      })
  )
}
