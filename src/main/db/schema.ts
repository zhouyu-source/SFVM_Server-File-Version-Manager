/**
 * SQLite 表结构（T02.2 ~ T02.5）。
 *
 * 严格对应《方案书》§5.2 的 DDL，共 8 张表：
 *   connections / known_hosts / environments / targets
 *   releases / release_items / archives / app_settings / audit_logs
 *
 * 约定（避免后续批次各写各的）：
 * - 主键统一 TEXT uuid，由 `newId()` 生成（见 db/id.ts）
 * - 时间统一存 **ISO-8601 带时区偏移的字符串**（如 2025-06-12T14:30:15+08:00）：
 *   便于人读、便于跨时区排查，且远端 manifest 也用同一格式
 * - 布尔用 INTEGER 0/1（Drizzle 的 `{ mode: 'boolean' }`）
 * - JSON 字段（local_exclude / retain_policy）存 TEXT，读写处负责解析
 */
import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

/* ------------------------------------------------------------------ 连接 */

export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull().default(22),
  username: text('username').notNull(),
  /** 'password' | 'privateKey' | 'agent' */
  authType: text('auth_type').notNull(),
  /** safeStorage 加密后的密码或私钥口令；**永远不从渲染进程写这里** */
  secretCipher: text('secret_cipher'),
  /** 私钥文件绝对路径（仅存路径，不存内容） */
  privateKeyPath: text('private_key_path'),
  /** SHA256:xxx，首次连接后写入（TOFU） */
  hostKeyFingerprint: text('host_key_fingerprint'),
  keepaliveMs: integer('keepalive_ms').notNull().default(15000),
  autoConnect: integer('auto_connect', { mode: 'boolean' }).notNull().default(false),
  lastConnectedAt: text('last_connected_at'),
  remark: text('remark'),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now)
})

/** 主机指纹历史：一台机器多算法/多指纹时保留多条 */
export const knownHosts = sqliteTable(
  'known_hosts',
  {
    id: text('id').primaryKey(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    keyType: text('key_type').notNull(),
    fingerprint: text('fingerprint').notNull(),
    trustedAt: text('trusted_at').notNull().default(now)
  },
  (t) => [unique('uq_known_hosts_host_port_type').on(t.host, t.port, t.keyType)]
)

/* -------------------------------------------------------------- 工作环境 */

export const environments = sqliteTable('environments', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  /** 'prod' | 'test' | 'custom' */
  envType: text('env_type').notNull(),
  description: text('description'),
  connectionId: text('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'restrict' }),
  /** UI 标识色，生产=红，测试=蓝 */
  color: text('color'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now)
})

/* ---------------------------------------------------------- 受管目标资源 */

export const targets = sqliteTable(
  'targets',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 'dir' | 'file' */
    kind: text('kind').notNull(),
    /** /opt/app/dist 或 /opt/svc/order.jar */
    remotePath: text('remote_path').notNull(),
    /** 默认 <父目录>/<basename>.versions，可覆盖 */
    archiveDir: text('archive_dir'),
    /** 本地构建产物路径 */
    localPath: text('local_path'),
    /** JSON 数组，如 [".map", "*.log"] */
    localExclude: text('local_exclude'),
    hashAlgo: text('hash_algo').notNull().default('sha256'),
    verifyRemote: integer('verify_remote', { mode: 'boolean' }).notNull().default(true),
    /** JSON: {"mode":"count","value":10} */
    retainPolicy: text('retain_policy'),
    /** 'rename' | 'copy' */
    deployStrategy: text('deploy_strategy').notNull().default('rename'),
    autoConnect: integer('auto_connect', { mode: 'boolean' }).notNull().default(false),
    lastDeployAt: text('last_deploy_at'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now)
  },
  (t) => [unique('uq_targets_env_path').on(t.environmentId, t.remotePath)]
)

/* ---------------------------------------------------- 发布记录（台账主表） */

export const releases = sqliteTable(
  'releases',
  {
    id: text('id').primaryKey(),
    targetId: text('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    /** 'deploy' | 'rollback' */
    action: text('action').notNull(),
    /** 20250612-143015_a1b2c3d */
    versionTag: text('version_tag').notNull(),
    /** PENDING/UPLOADING/VERIFYING/ARCHIVING/SWAPPING/SUCCESS/FAILED/ROLLED_BACK */
    status: text('status').notNull(),
    /** 'local' | 'archive' */
    source: text('source'),
    localPath: text('local_path'),
    /** rollback 时的来源版本 */
    archiveId: text('archive_id'),
    /** 目录指纹 / 文件哈希 */
    rootHash: text('root_hash'),
    totalBytes: integer('total_bytes').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    operator: text('operator'),
    note: text('note'),
    currentStep: text('current_step'),
    errorMessage: text('error_message'),
    startedAt: text('started_at').notNull().default(now),
    finishedAt: text('finished_at')
  },
  (t) => [index('idx_releases_target_time').on(t.targetId, t.startedAt)]
)

/** 发布文件清单：大目录逐文件记录，用于精确校验与差异展示 */
export const releaseItems = sqliteTable(
  'release_items',
  {
    id: text('id').primaryKey(),
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    relPath: text('rel_path').notNull(),
    hash: text('hash').notNull(),
    size: integer('size').notNull(),
    mtime: text('mtime')
  },
  (t) => [unique('uq_release_items_release_path').on(t.releaseId, t.relPath)]
)

/* ------------------------------------------------------ 归档版本（往期库） */

export const archives = sqliteTable(
  'archives',
  {
    id: text('id').primaryKey(),
    targetId: text('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    versionTag: text('version_tag').notNull(),
    /** 远端 <archive_dir>/<version_tag> */
    storagePath: text('storage_path').notNull(),
    /** <storage_path>/payload */
    payloadPath: text('payload_path').notNull(),
    /** 'dir' | 'file' */
    kind: text('kind').notNull(),
    rootHash: text('root_hash').notNull(),
    totalBytes: integer('total_bytes').notNull(),
    fileCount: integer('file_count').notNull(),
    archivedAt: text('archived_at').notNull().default(now),
    releaseId: text('release_id'),
    note: text('note'),
    /** 'valid' | 'missing' | 'corrupt' */
    status: text('status').notNull().default('valid')
  },
  (t) => [
    unique('uq_archives_target_tag').on(t.targetId, t.versionTag),
    index('idx_archives_target_time').on(t.targetId, t.archivedAt)
  ]
)

/* ------------------------------------------------------------ 应用设置 */

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(now)
})

/* -------------------------------------------------------- 操作日志 / 审计 */

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: text('ts').notNull().default(now),
    /** 'info' | 'warn' | 'error' */
    level: text('level').notNull(),
    /**
     * 'connection' | 'deploy' | 'archive' | 'app' | 'script'
     *
     * `script`（B20/B21）：脚本与流水线的执行。这是全应用唯一"用户填什么就
     * 执行什么"的功能，`script_runs` 回答"成没成"，审计回答"谁在什么时候
     * 对着哪台机器做了什么"—— 多人共用一个发布账号时，能查的只有后者。
     */
    scope: text('scope').notNull(),
    refId: text('ref_id'),
    message: text('message').notNull(),
    /** JSON，**已脱敏** */
    detail: text('detail')
  },
  (t) => [index('idx_audit_ts').on(t.ts)]
)

/* ------------------------------------------------------ 脚本运行记录（B20） */

/**
 * 一次「脚本运行」。
 *
 * 为什么必须落库：任务框架**不保留 `run()` 的返回值**，进程一重启就完全失忆，
 * 而"上一次那步成没成、退出码多少、输出了什么"恰恰是用户唯一想看的东西。
 *
 * 不变量：`status` 为 `running` 的行，其 `jobId` 一定对应一个刚刚发生过的任务；
 * 进程被强杀时可能留下 `running`，界面上按"未正常结束"如实展示即可 ——
 * 不去猜它成功（那是谎报）。
 */
export const scriptRuns = sqliteTable(
  'script_runs',
  {
    id: text('id').primaryKey(),
    targetId: text('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    /** 跑它的任务 id（任务本身不落库，这里只用于"任务台 ↔ 运行记录"对号） */
    jobId: text('job_id').notNull(),
    /** 'step'（目标页单条脚本，B20）| 'pipeline'（多步流水线，B21） */
    trigger: text('trigger').notNull().default('step'),
    /** B21 的流水线 id；B20 恒为 null。刻意不建外键：pipelines 表在 B21 才出现 */
    pipelineId: text('pipeline_id'),
    title: text('title').notNull(),
    /** 'running' | 'succeeded' | 'failed' | 'cancelled' */
    status: text('status').notNull().default('running'),
    startedAt: text('started_at').notNull().default(now),
    finishedAt: text('finished_at'),
    /** 谁发起的（本机 hostname）；多人共用一台机器时才有意义 */
    operator: text('operator'),
    errorMessage: text('error_message')
  },
  (t) => [index('idx_script_runs_target_time').on(t.targetId, t.startedAt)]
)

/**
 * 运行里的一个步骤。
 *
 * 输出分两处存：**完整输出**在 `output_path` 指向的文件里（单步设体积上限），
 * 库里只留 `output_tail`（最后 200 行 / 32KB）。理由见 `contracts/script.ts` 文件头。
 */
export const scriptStepRuns = sqliteTable(
  'script_step_runs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => scriptRuns.id, { onDelete: 'cascade' }),
    /** 1 起；B20 恒为 1 */
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    /** 'local' | 'remote' */
    kind: text('kind').notNull(),
    /** 本机步骤用的解释器（'powershell' | 'gitbash'）；远端步骤为 null */
    shell: text('shell'),
    status: text('status').notNull().default('running'),
    /** 进程退出码；null = 没拿到（超时被杀、连接断开等） */
    exitCode: integer('exit_code'),
    startedAt: text('started_at').notNull().default(now),
    finishedAt: text('finished_at'),
    durationMs: integer('duration_ms'),
    /** 完整输出的落盘位置；null = 这次没落盘 */
    outputPath: text('output_path'),
    outputBytes: integer('output_bytes').notNull().default(0),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    /** 库内保留的输出尾部 */
    outputTail: text('output_tail'),
    errorMessage: text('error_message')
  },
  (t) => [unique('uq_script_step_runs_run_seq').on(t.runId, t.seq)]
)

/* ---------------------------------------------------------- 自动化流水线（B21） */

/**
 * 一条自动化流水线。**绑定到目标**：步骤里既有"在本机构筑"也有"在服务器重启服务"，
 * 而这两件事都只能是"针对某个目标"的（发布更不用说，它本来就要目标）。
 */
export const pipelines = sqliteTable(
  'pipelines',
  {
    id: text('id').primaryKey(),
    targetId: text('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now)
  },
  (t) => [
    index('idx_pipelines_target').on(t.targetId),
    // 同名流水线在同一目标下没有意义，而且会让"一键执行"的按钮分不清谁是谁
    unique('uq_pipelines_target_name').on(t.targetId, t.name)
  ]
)

/**
 * 流水线里的一步。
 *
 * `seq` 是**顺序**而不是数组下标：步骤要能整体上移/下移，用连续整数最省心
 * （保存时整组重写，所以不会出现空洞）。`UNIQUE(pipeline_id, seq)` 保证
 * "读出来的顺序"是确定的 —— 只按 `seq` 排序而没有唯一约束时，
 * 两条同序号的步骤在不同查询里可能换位置，而这在一个"顺序执行"的功能里是致命的。
 *
 * `script` 对 `deploy` 步骤恒为空串（见 `contracts/pipeline.ts` 的说明）；
 * 这里不给它建约束是因为"空"是业务规则，而建 CHECK 会让迁移更难写 ——
 * 规则由契约层在**存下来的那一刻**拦住。
 */
export const pipelineSteps = sqliteTable(
  'pipeline_steps',
  {
    id: text('id').primaryKey(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    /** 1 起 */
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    /** 'local' | 'remote' | 'deploy' */
    kind: text('kind').notNull(),
    script: text('script').notNull().default(''),
    /** 本机步骤的解释器（'powershell' | 'gitbash'）；远端/发布步骤为 null */
    shell: text('shell'),
    cwd: text('cwd'),
    timeoutMs: integer('timeout_ms').notNull(),
    /** 'stop' | 'continue' */
    onFailure: text('on_failure').notNull().default('stop')
  },
  (t) => [unique('uq_pipeline_steps_pipeline_seq').on(t.pipelineId, t.seq)]
)

/* ------------------------------------------------------------------ 类型 */

export type Connection = typeof connections.$inferSelect
export type NewConnection = typeof connections.$inferInsert
export type KnownHost = typeof knownHosts.$inferSelect
export type NewKnownHost = typeof knownHosts.$inferInsert
export type Environment = typeof environments.$inferSelect
export type NewEnvironment = typeof environments.$inferInsert
export type Target = typeof targets.$inferSelect
export type NewTarget = typeof targets.$inferInsert
export type Release = typeof releases.$inferSelect
export type NewRelease = typeof releases.$inferInsert
export type ReleaseItem = typeof releaseItems.$inferSelect
export type NewReleaseItem = typeof releaseItems.$inferInsert
export type Archive = typeof archives.$inferSelect
export type NewArchive = typeof archives.$inferInsert
export type AppSetting = typeof appSettings.$inferSelect
export type AuditLog = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert
export type ScriptRun = typeof scriptRuns.$inferSelect
export type NewScriptRun = typeof scriptRuns.$inferInsert
export type ScriptStepRun = typeof scriptStepRuns.$inferSelect
export type NewScriptStepRun = typeof scriptStepRuns.$inferInsert
export type Pipeline = typeof pipelines.$inferSelect
export type NewPipeline = typeof pipelines.$inferInsert
export type PipelineStep = typeof pipelineSteps.$inferSelect
export type NewPipelineStep = typeof pipelineSteps.$inferInsert

/** 全部业务表，供备份/自检统计使用 */
export const ALL_TABLES = [
  'connections',
  'known_hosts',
  'environments',
  'targets',
  'releases',
  'release_items',
  'archives',
  'app_settings',
  'audit_logs',
  'script_runs',
  'script_step_runs',
  'pipelines',
  'pipeline_steps'
] as const
