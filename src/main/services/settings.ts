/**
 * 应用设置服务（B15 / T15.1 ~ T15.3）。
 *
 * ## 职责边界
 *
 * 只管三件事：**读**（逐项容错解析）、**写**（校验 + 持久化 + 立即生效）、
 * **导出/导入**（JSON 往返）。它不认识传输、归档、会话，也不主动去"应用"任何东西 ——
 * 真正要用设置的服务通过注入的函数来取（`transferConcurrency()` 等）。
 *
 * ## 为什么"立即生效"不在这里做
 *
 * 有副作用的两项（日志级别）用一个注入的 `applyLogLevel` 回调处理；其余四项
 * **消费方读的时候现取**（下载落点、并发数、兼容模式、默认保留策略）。
 *
 * 这是刻意的：把"改了设置"变成"通知所有模块"，就要维护一张订阅表并在每个模块里
 * 注册/注销，而只要有一处忘了注册，那一项就变成"要重启才生效" —— 而这种 bug
 * 在测试里几乎不会暴露（测试通常在同一个进程里刚改完就立刻用）。
 * 现取则天然没有这个失败模式。
 */
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import {
  CONFIG_BUNDLE_SCHEMA_VERSION,
  SETTING_KEYS,
  buildSettings,
  parseConfigBundle,
  appSettingsPatchSchema,
  type AppSettings,
  type AppSettingsPatch,
  type ConfigImportInput,
  type ConfigImportResult,
  type ConfigBundle,
  type SettingsSnapshot
} from '../../shared/contracts/settings'
import { describeRetainPolicy, parseRetainPolicy } from '../../shared/contracts/workspace'
import type { Repositories } from '../db/repositories'
import type { LogLevelName } from '../../shared/contracts/settings'

export interface SettingsServiceDeps {
  repo: Repositories
  /** 应用版本，写进导出文件（便于回溯"这份配置是哪版导出的"） */
  appVersion: string
  /** 默认下载目录（`downloadDir` 为空时用它） */
  defaultDownloadDir: () => string
  /** 把日志级别应用到运行时（`logger.setLevel`）；**立即生效**靠它 */
  applyLogLevel: (level: LogLevelName | null) => void
  /** 仅测试：固定时间 */
  now?: () => Date
}

export interface SettingsService {
  snapshot(): SettingsSnapshot
  /** 供其它服务现取用（**不要缓存**，见文件头说明） */
  current(): AppSettings
  update(patch: AppSettingsPatch): SettingsSnapshot
  exportBundle(): ConfigBundle
  importBundle(input: ConfigImportInput): ConfigImportResult
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { repo, appVersion, defaultDownloadDir, applyLogLevel } = deps
  const now = deps.now ?? ((): Date => new Date())

  /** 读全量设置：缺失用默认（静默），坏了用默认 + 记 issue（告警）。 */
  function readAll(): { settings: AppSettings; issues: SettingsSnapshot['issues'] } {
    return buildSettings((key) => repo.settings.getValue(key) ?? null)
  }

  function snapshot(): SettingsSnapshot {
    const { settings, issues } = readAll()
    return {
      settings,
      issues,
      effectiveDownloadDir: settings.downloadDir ?? defaultDownloadDir()
    }
  }

  function persist(patch: AppSettingsPatch): void {
    for (const [name, value] of Object.entries(patch) as Array<[keyof AppSettings, unknown]>) {
      const key = SETTING_KEYS[name]
      if (key === undefined) continue
      // 统一按 JSON 存：数字与布尔读回来还是数字与布尔（裸字符串会退化成 "4" / "true"）
      repo.settings.set(key, JSON.stringify(value))
    }
  }

  function update(patch: AppSettingsPatch): SettingsSnapshot {
    const parsed = appSettingsPatchSchema.safeParse(patch)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      throw new AppError(ErrorCode.E_PARAM, { issues: parsed.error.issues }, {
        message: `设置项不合法：${first?.path.join('.') || '(未知项)'} ${first?.message ?? ''}`
      })
    }

    persist(parsed.data)

    // 日志级别有运行时副作用 → 立刻应用（其余四项由消费方现取）
    if (parsed.data.logLevel !== undefined) {
      applyLogLevel(parsed.data.logLevel)
      logger.info(`log level changed to ${parsed.data.logLevel ?? '(默认)'}`)
    }

    if (parsed.data.defaultRetainPolicy !== undefined) {
      logger.info(`default retain policy: ${describeRetainPolicy(parsed.data.defaultRetainPolicy)}`)
    }

    return snapshot()
  }

  /* ------------------------------------------------------------ 导出 */

  function exportBundle(): ConfigBundle {
    const { settings } = readAll()
    const connections = repo.connections.list()
    const environments = repo.environments.list()
    const targets = repo.targets.listAll()

    const connName = new Map(connections.map((c) => [c.id, c.name]))
    const envName = new Map(environments.map((e) => [e.id, e.name]))

    return {
      schemaVersion: CONFIG_BUNDLE_SCHEMA_VERSION,
      exportedAt: now().toISOString(),
      appVersion,
      // 恒为 false：`exportedConnectionSchema` 里根本没有密文字段
      containsCredentials: false,
      connections: connections.map((c) => ({
        name: c.name,
        host: c.host,
        port: c.port,
        username: c.username,
        authType: c.authType as 'password' | 'privateKey' | 'agent',
        privateKeyPath: c.privateKeyPath,
        hostKeyFingerprint: c.hostKeyFingerprint,
        keepaliveMs: c.keepaliveMs,
        autoConnect: c.autoConnect,
        remark: c.remark
      })),
      environments: environments.map((e) => ({
        name: e.name,
        envType: e.envType as 'prod' | 'test' | 'custom',
        description: e.description,
        color: e.color,
        sortOrder: e.sortOrder,
        // 按名字引用：id 是本机生成的，导出到别的机器必然对不上
        connectionName: connName.get(e.connectionId) ?? ''
      })),
      targets: targets.map((t) => ({
        name: t.name,
        kind: t.kind as 'dir' | 'file',
        remotePath: t.remotePath,
        archiveDir: t.archiveDir,
        localPath: t.localPath,
        localExclude: safeExclude(t.localExclude),
        verifyRemote: t.verifyRemote,
        retainPolicy: parseRetainPolicy(t.retainPolicy),
        deployStrategy: t.deployStrategy as 'rename' | 'copy',
        autoConnect: t.autoConnect,
        environmentName: envName.get(t.environmentId) ?? ''
      })),
      settings
    }
  }

  /* ------------------------------------------------------------ 导入 */

  function importBundle(input: ConfigImportInput): ConfigImportResult {
    const { bundle, error } = parseConfigBundle(input.text)
    if (!bundle) throw new AppError(ErrorCode.E_PARAM, {}, { message: error ?? '导出文件无法解析' })

    const warnings: string[] = []
    const result: ConfigImportResult = {
      connections: { created: 0, skipped: 0 },
      environments: { created: 0, skipped: 0 },
      targets: { created: 0, skipped: 0 },
      settingsApplied: false,
      warnings
    }

    /* ---- 1) 连接：按名字去重 ---- */
    const existingConn = new Map(repo.connections.list().map((c) => [c.name, c.id]))
    const connIdByName = new Map(existingConn)

    for (const c of bundle.connections) {
      if (existingConn.has(c.name)) {
        result.connections.skipped++
        warnings.push(`连接「${c.name}」已存在（按名称判断），跳过。`)
        continue
      }
      const row = repo.connections.create({
        name: c.name,
        host: c.host,
        port: c.port,
        username: c.username,
        authType: c.authType,
        // 凭据不进导出文件，导入后必须由用户重新填写
        secretCipher: null,
        privateKeyPath: c.privateKeyPath,
        hostKeyFingerprint: c.hostKeyFingerprint,
        keepaliveMs: c.keepaliveMs,
        autoConnect: c.autoConnect,
        remark: c.remark
      })
      connIdByName.set(c.name, row.id)
      result.connections.created++
      if (c.authType !== 'agent') {
        warnings.push(`连接「${c.name}」已导入，但**凭据需要重新填写**（导出文件不含密码 / 口令）。`)
      }
    }

    /* ---- 2) 环境：按名字去重；连接名找不到就跳过 ---- */
    const existingEnv = new Map(repo.environments.list().map((e) => [e.name, e.id]))
    const envIdByName = new Map(existingEnv)

    for (const e of bundle.environments) {
      if (existingEnv.has(e.name)) {
        result.environments.skipped++
        warnings.push(`环境「${e.name}」已存在（按名称判断），跳过。`)
        continue
      }
      const connectionId = connIdByName.get(e.connectionName)
      if (!connectionId) {
        result.environments.skipped++
        warnings.push(
          `环境「${e.name}」引用的连接「${e.connectionName || '(空)'}」不存在，已跳过 —— ` +
            '请先导入或手工新建该连接。'
        )
        continue
      }
      const row = repo.environments.create({
        name: e.name,
        envType: e.envType,
        connectionId,
        description: e.description,
        color: e.color,
        sortOrder: e.sortOrder
      })
      envIdByName.set(e.name, row.id)
      result.environments.created++
    }

    /* ---- 3) 目标：按 (环境, 远端路径) 去重 ----
     *
     * 用**路径**而不是名称判重，与 `workspace.create()` 的既有规则一致，
     * 而且挡住的正是危险的那一种：两个目标指向同一个远端路径 ——
     * 那意味着两次发布可能互相覆盖，而界面上看起来是"两个不相干的业务"。
     * 名称重复则无害（不同环境可以有同名目标）。
     *
     * 代价：用户在本机把某个目标的路径改掉之后，再导入旧配置会**新建**一条。
     * 那是有意为之 —— 导入是"把文件里的东西补进来"，不是"把我改过的改回去"。
     */
    for (const t of bundle.targets) {
      const environmentId = envIdByName.get(t.environmentName)
      if (!environmentId) {
        result.targets.skipped++
        warnings.push(
          `目标「${t.name}」归属的环境「${t.environmentName || '(空)'}」不存在，已跳过。`
        )
        continue
      }
      if (repo.targets.findByPath(environmentId, t.remotePath)) {
        result.targets.skipped++
        warnings.push(`目标「${t.name}」（${t.remotePath}）已存在，跳过。`)
        continue
      }
      repo.targets.create({
        environmentId,
        name: t.name,
        kind: t.kind,
        remotePath: t.remotePath,
        archiveDir: t.archiveDir,
        localPath: t.localPath,
        localExclude: JSON.stringify(t.localExclude),
        verifyRemote: t.verifyRemote,
        retainPolicy: t.retainPolicy ? JSON.stringify(t.retainPolicy) : null,
        deployStrategy: t.deployStrategy,
        autoConnect: t.autoConnect
      })
      result.targets.created++
    }

    /* ---- 4) 设置：只在调用方明确要求时应用 ---- */
    if (input.applySettings !== false && bundle.settings) {
      const parsed = appSettingsPatchSchema.safeParse(bundle.settings)
      if (parsed.success) {
        /**
         * **安全开关不随配置文件走**（B20）。
         *
         * 导入这件事的性质是"把别人机器上的配置搬过来"。如果导出文件里
         * `allowUserScripts` 是开的（它默认就是关的，开着说明对方主动开过，
         * 也可能被手工改过），照单应用就等于"导入同事的配置"顺手给本机装了个 shell。
         * 所以这一项一律忽略，并**明确告警**告诉用户去哪儿开 —— 静默忽略会让人
         * 以为"导入成功了、功能却没生效"，那更糟。
         */
        const { allowUserScripts, ...rest } = parsed.data
        persist(rest)
        if (allowUserScripts !== undefined) {
          warnings.push(
            allowUserScripts
              ? '导出文件里「开启自定义脚本」是开启的，出于安全考虑已忽略；需要的话请在「设置」页手动打开。'
              : '导出文件里的「开启自定义脚本」设置已忽略 —— 该开关只在本机手动修改。'
          )
        }
        // 设置不走 update()：那份实现会校验 + 记日志，这里的值已经过 schema，
        // 而且导入不该因为"某一项恰好坏了"就整批失败（其余三类已经写进去了）
        applyLogLevel(rest.logLevel ?? null)
        result.settingsApplied = true
      } else {
        warnings.push('导出文件里的设置项不合法，已跳过（其余内容已导入）。')
      }
    }

    logger.info(
      `config import: connections=${result.connections.created}/${result.connections.skipped} ` +
        `environments=${result.environments.created}/${result.environments.skipped} ` +
        `targets=${result.targets.created}/${result.targets.skipped} settings=${result.settingsApplied}`
    )
    return result
  }

  return { snapshot, current: () => readAll().settings, update, exportBundle, importBundle }
}

/** `localExclude` 存的是 JSON 文本，导入导出要用数组（解析失败按空数组，不抛错）。 */
function safeExclude(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
