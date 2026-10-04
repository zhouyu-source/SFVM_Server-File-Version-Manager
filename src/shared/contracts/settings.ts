/**
 * 应用设置的跨进程契约（B15 / T15.1 ~ T15.3）。
 *
 * ## 为什么单开一份契约而不是散在各处的常量
 *
 * 这些值有**两个消费方**：设置页（读写）与真正用它的服务（传输 / 校验 / 归档 / 下载）。
 * 两处各自写一份默认值，迟早会出现"界面显示 4、实际跑了 2"这种错位 —— 而且这种错位
 * 没人会立刻发现（4 和 2 都"看起来合理"）。
 *
 * ## 存储形态：一个 key 一行，不是一个 JSON 大对象
 *
 * `app_settings` 就支持 key/value。按 key 存的好处是**坏一个不影响其它**：
 * 一个写坏的 `transferConcurrency` 只让那一项退回默认值，不会让整个设置页打不开。
 * 代价是要多一层"逐项解析 + 非法项列表"，`buildSettings()` 就是这个。
 */
import { z } from 'zod'
import { retainPolicySchema } from './workspace'

/* ------------------------------------------------------------- 日志级别 */

/** 与 electron-log 一致（`infra/logger.ts` 的 `LogLevel`）。 */
export const LOG_LEVELS = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'] as const
export type LogLevelName = (typeof LOG_LEVELS)[number]

export const LOG_LEVEL_LABELS: Record<LogLevelName, string> = {
  error: '仅错误',
  warn: '警告及以上',
  info: '常规信息（推荐）',
  verbose: '详细',
  debug: '调试',
  silly: '全部（含内部细节，日志增长很快）'
}

/* --------------------------------------------------------------- 取值范围 */

/** 传输并发数的下限 / 上限：`transfer.ts` 的 `clampInt` 也是这个区间。 */
export const TRANSFER_CONCURRENCY_MIN = 1
export const TRANSFER_CONCURRENCY_MAX = 8
export const DEFAULT_TRANSFER_CONCURRENCY = 4

/** 新建目标的默认保留份数（T15.2：默认 20 个）。 */
export const DEFAULT_RETAIN_COUNT = 20

/* ------------------------------------------------------------------- 契约 */

export const appSettingsSchema = z.object({
  /**
   * 默认下载目录。
   *
   * `null` = 用"系统下载目录/sfvm-downloads"（由主进程接线层算）。
   * 不在这里写死一个绝对路径：用户目录在别人的机器上不一样，
   * 写死了换台机器就是一条不存在的路径。
   */
  downloadDir: z.string().min(1).nullable(),
  /** 传输并发数（同一连接内并行传输的文件数） */
  transferConcurrency: z.number().int().min(TRANSFER_CONCURRENCY_MIN).max(TRANSFER_CONCURRENCY_MAX),
  /** 日志级别；`null` = 按开发/生产各自的默认（dev=debug / prod=info） */
  logLevel: z.enum(LOG_LEVELS).nullable(),
  /**
   * 算法兼容模式（T15.1）。
   *
   * 远端既没有 `sha256sum` 也没有 `shasum` 时是否允许降级为 SFTP 流式计算。
   * - 开（默认）：能校验，但大目录慢；
   * - 关：直接报错中止，**不静默跳过校验** —— 有些环境宁可拒绝发布，
   *   也不接受"用一条慢链路跑出来的校验结果"。
   */
  hashCompatMode: z.boolean(),
  /** 新建目标的默认保留策略；`null` = 新建目标默认不清理 */
  defaultRetainPolicy: retainPolicySchema.nullable()
})
export type AppSettings = z.infer<typeof appSettingsSchema>

/** 部分更新：只改传进来的那几项。 */
export const appSettingsPatchSchema = appSettingsSchema.partial()
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>

export const DEFAULT_APP_SETTINGS: AppSettings = {
  downloadDir: null,
  transferConcurrency: DEFAULT_TRANSFER_CONCURRENCY,
  logLevel: null,
  hashCompatMode: true,
  defaultRetainPolicy: { mode: 'count', value: DEFAULT_RETAIN_COUNT }
}

/** `app_settings` 表里的 key —— 与设置项同名，避免多一层映射。 */
export const SETTING_KEYS = {
  downloadDir: 'download.dir',
  transferConcurrency: 'transfer.concurrency',
  logLevel: 'log.level',
  hashCompatMode: 'hash.compatMode',
  defaultRetainPolicy: 'archive.defaultRetainPolicy'
} as const satisfies Record<keyof AppSettings, string>

export type SettingsKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS]

/** 某一项读出来但解析不过时给用户的说明（不抛错，退回默认值）。 */
export const settingIssueSchema = z.object({
  key: z.string(),
  /** 中文设置项名，直接展示 */
  label: z.string(),
  /** 存进去的原始文本（截断展示，便于用户/我们判断是不是手工改坏了） */
  raw: z.string(),
  /** 实际生效的值（默认值） */
  fallbackText: z.string()
})
export type SettingIssue = z.infer<typeof settingIssueSchema>

export const settingsSnapshotSchema = z.object({
  settings: appSettingsSchema,
  /** 有几项读不出来、已经退回默认值 */
  issues: z.array(settingIssueSchema),
  /** 默认下载目录（`downloadDir` 为空时由系统下载目录推导）—— 展示用 */
  effectiveDownloadDir: z.string()
})
export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>

/** 设置项的中文名（设置页与告警都用它，不要各写一份）。 */
export const SETTING_LABELS: Record<keyof AppSettings, string> = {
  downloadDir: '默认下载目录',
  transferConcurrency: '传输并发数',
  logLevel: '日志级别',
  hashCompatMode: '算法兼容模式',
  defaultRetainPolicy: '默认保留策略'
}

/**
 * 逐项解析 `app_settings` 里读出来的原始文本。
 *
 * **纯函数**：输入是"读 key 的函数"，输出是"设置 + 解析不了的项"。
 * 这样"某一项坏了会怎样"能在单测里逐项钉住，不需要真的去写坏数据库。
 *
 * 逐项规则：
 * - 值缺失（`null`）→ 用默认值，**不算问题**（没配过是正常状态）；
 * - 值存在但解析失败 → 用默认值，**记进 `issues`**（配了但坏了是异常状态）。
 *
 * 这个"缺"与"坏"的区分沿用 B09 保留策略的既有口径：前者正常静默，后者必须告警 ——
 * 否则用户改了设置却没生效，界面上一点提示都没有。
 */
export function buildSettings(read: (key: string) => string | null): {
  settings: AppSettings
  issues: SettingIssue[]
} {
  const issues: SettingIssue[] = []
  const out: AppSettings = { ...DEFAULT_APP_SETTINGS }

  /**
   * 逐项解析的结果。
   *
   * **必须三值**，不能拿 `null` 兼任"解析失败"：好几个设置项的**合法值本来就是
   * `null`**（下载目录"跟随系统"、日志级别"跟随默认"、保留策略"不清理"）。
   * 用 `null` 表示失败的话，用户把设置改回"跟随默认"之后，下一次读就会
   * 记一条"存储的值无法解析"的告警 —— 而且**永远消不掉**，因为它是自己刚写进去的。
   * （这个 bug 是 B15 写单测时抓到的。）
   */
  type Parsed<K extends keyof AppSettings> =
    | { ok: true; value: AppSettings[K] }
    | { ok: false }

  const bad = (): { ok: false } => ({ ok: false })

  /** 逐项：缺失用默认（静默），坏了用默认 + 记问题。 */
  const take = <K extends keyof AppSettings>(
    name: K,
    parse: (text: string) => Parsed<K>,
    fallbackText: string
  ): void => {
    const raw = read(SETTING_KEYS[name])
    if (raw === null || raw === undefined || raw === '') return
    const parsed = parse(raw)
    if (!parsed.ok) {
      issues.push({
        key: SETTING_KEYS[name],
        label: SETTING_LABELS[name],
        raw: raw.length > 120 ? `${raw.slice(0, 120)}…` : raw,
        fallbackText
      })
      return
    }
    out[name] = parsed.value
  }

  /** 标量取值：先按 JSON 解析，失败再当裸字符串（手工写库时常常不带引号）。 */
  const scalar = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  take('downloadDir', (t) => {
    const v = scalar(t)
    // `null`（或空串）是合法的"跟随系统下载目录"，不是错误
    if (v === null || v === '') return { ok: true, value: null }
    if (typeof v !== 'string' || !v.trim()) return bad()
    return { ok: true, value: v.trim() }
  }, '系统下载目录下的 sfvm-downloads')

  take('transferConcurrency', (t) => {
    const v = scalar(t)
    // 手工写库时常常不带引号，"6" 也认（但要注意 `'"6"'` 会被 JSON 解析成字符串 '6'）
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isInteger(n)) return bad()
    if (n < TRANSFER_CONCURRENCY_MIN || n > TRANSFER_CONCURRENCY_MAX) return bad()
    return { ok: true, value: n }
  }, String(DEFAULT_TRANSFER_CONCURRENCY))

  take('logLevel', (t) => {
    const v = scalar(t)
    if (v === null || v === '') return { ok: true, value: null }
    return (LOG_LEVELS as readonly string[]).includes(String(v))
      ? { ok: true, value: v as LogLevelName }
      : bad()
  }, '按开发/生产默认')

  take('hashCompatMode', (t) => {
    const v = scalar(t)
    if (typeof v === 'boolean') return { ok: true, value: v }
    // 手工写库时可能是裸的 true / false（`scalar` 会退化成字符串）、或 1 / 0
    if (v === 'true' || v === 1) return { ok: true, value: true }
    if (v === 'false' || v === 0) return { ok: true, value: false }
    return bad()
  }, '开启')

  take('defaultRetainPolicy', (t) => {
    const v = scalar(t)
    // `null` = 不自动清理，是合法值
    if (v === null) return { ok: true, value: null }
    const r = retainPolicySchema.safeParse(v)
    return r.success ? { ok: true, value: r.data } : bad()
  }, '不自动清理')

  return { settings: out, issues }
}

/* ----------------------------------------------------------- 配置导出/导入 */

export const CONFIG_BUNDLE_SCHEMA_VERSION = 1

/**
 * 导出文件里的连接。
 *
 * **刻意没有** `secretCipher`（密码 / 私钥口令，经 safeStorage 加密后的密文）。
 * 导入端即便收到这个字段也无从解开 —— 它绑定的是**导出那台机器**的密钥环，
 * 换机器就是一段无意义的密文。所以导出直接不写它（T15.3 的硬要求：导出文件里搜不到密码）。
 *
 * `hostKeyFingerprint` 保留：它是公开信息（服务器公钥指纹），
 * 带着它导入后不用重新信任一遍主机密钥。
 */
export const exportedConnectionSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  authType: z.enum(['password', 'privateKey', 'agent']),
  privateKeyPath: z.string().nullable(),
  hostKeyFingerprint: z.string().nullable(),
  keepaliveMs: z.number().int(),
  autoConnect: z.boolean(),
  remark: z.string().nullable()
})
export type ExportedConnection = z.infer<typeof exportedConnectionSchema>

export const exportedEnvironmentSchema = z.object({
  name: z.string().min(1),
  envType: z.enum(['prod', 'test', 'custom']),
  description: z.string().nullable(),
  color: z.string().nullable(),
  sortOrder: z.number().int(),
  /** 绑定的连接**按名字**引用：id 是本机生成的，换机器必然不同 */
  connectionName: z.string()
})
export type ExportedEnvironment = z.infer<typeof exportedEnvironmentSchema>

export const exportedTargetSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['dir', 'file']),
  remotePath: z.string().min(1),
  archiveDir: z.string().nullable(),
  localPath: z.string().nullable(),
  localExclude: z.array(z.string()),
  verifyRemote: z.boolean(),
  retainPolicy: retainPolicySchema.nullable(),
  deployStrategy: z.enum(['rename', 'copy']),
  autoConnect: z.boolean(),
  /** 归属环境**按名字**引用；找不到就先记一条告警、跳过这个目标 */
  environmentName: z.string()
})
export type ExportedTarget = z.infer<typeof exportedTargetSchema>

export const configBundleSchema = z.object({
  schemaVersion: z.number().int().min(1),
  exportedAt: z.string(),
  appVersion: z.string(),
  /**
   * 恒为 `false`，写进文件里而不是只靠文档说明。
   *
   * 这一点值得一条 schema 约束：将来若有人给导出加上凭据，**必须**同时把这个
   * 字面量改成别的形状，那时所有"导入端 / 测试 / 文档"都会同时报错提醒他 ——
   * 而只在注释里写"不含凭据"，改了不会有人发现。
   */
  containsCredentials: z.literal(false),
  connections: z.array(exportedConnectionSchema),
  environments: z.array(exportedEnvironmentSchema),
  targets: z.array(exportedTargetSchema),
  /** 设置；导入端只应用能解析的项 */
  settings: appSettingsSchema.optional()
})
export type ConfigBundle = z.infer<typeof configBundleSchema>

/** 逐类统计导入结果（每类都给 created / skipped，跳过的原因在 warnings 里）。 */
const importCountSchema = z.object({ created: z.number().int(), skipped: z.number().int() })

export const configImportResultSchema = z.object({
  connections: importCountSchema,
  environments: importCountSchema,
  targets: importCountSchema,
  /** 设置是否被应用（导出文件里没带设置时为 false） */
  settingsApplied: z.boolean(),
  /**
   * 逐条说明为什么跳过/降级。
   *
   * 导入**不能只报总数**："导入 12 条、跳过 3 条"对用户毫无用处 ——
   * 他需要知道是哪 3 条、为什么（重名？环境不存在？），才能决定要不要手工补。
   */
  warnings: z.array(z.string())
})
export type ConfigImportResult = z.infer<typeof configImportResultSchema>

export const configImportInputSchema = z.object({
  /** 导出文件的内容（渲染进程读文件后原样传过来） */
  text: z.string().min(1),
  /** 是否一并应用文件里的设置 */
  applySettings: z.boolean().optional()
})
export type ConfigImportInput = z.infer<typeof configImportInputSchema>

/** 解析导出文件；失败时抛出带具体原因的说明（不要丢给用户一句"格式错误"）。 */
export function parseConfigBundle(text: string): {
  bundle: ConfigBundle | null
  error: string | null
} {
  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch (e) {
    return { bundle: null, error: `文件不是合法的 JSON：${(e as Error).message}` }
  }
  const r = configBundleSchema.safeParse(json)
  if (!r.success) {
    const first = r.error.issues[0]
    const where = first?.path.join('.') || '(根)'
    return { bundle: null, error: `导出文件结构不符合预期，位置「${where}」：${first?.message}` }
  }
  return { bundle: r.data, error: null }
}
