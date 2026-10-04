/**
 * 数据库连接与迁移（T02.6 / T02.7 / T02.8）。
 *
 * 要点：
 * - 数据库落在 `<userData>/sfvm.db`（方案书 §6.5 / T02.6）
 * - 打开后立即设 WAL + 外键开启：
 *   SQLite 的外键默认**关闭**，方案书里写了 ON DELETE CASCADE/RESTRICT，
 *   不显式打开的话这些约束全部失效 —— 这是最容易踩的坑
 * - 启动时自动迁移（drizzle 的 migrate），二次启动不重复执行
 * - 迁移前自动备份 `sfvm.db` → `sfvm.db.bak-<版本>-<时间>`，保留最近 3 份
 *
 * 本模块刻意不 import electron：路径由调用方注入，
 * 这样单测可以直接给临时目录，不需要 Electron 运行时。
 */
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>

export interface OpenDbOptions {
  /** 数据库文件所在目录（生产为 app.getPath('userData')） */
  dataDir: string
  /** 迁移 SQL 所在目录；不传则跳过迁移 */
  migrationsFolder?: string
  /** 迁移前备份保留份数，默认 3（T02.8） */
  backupKeep?: number
  /** 当前 schema 版本号，用于备份文件命名 */
  schemaVersion?: string
  /** 迁移细节，便于排查 */
  onLog?: (msg: string) => void
}

export interface OpenedDb {
  db: Db
  /** 底层 better-sqlite3 句柄，迁移/备份/自检需要 */
  raw: Database.Database
  file: string
  close: () => void
}

export const DB_FILENAME = 'sfvm.db'

/** 备份文件名前缀，便于清理与识别 */
export const BACKUP_PREFIX = `${DB_FILENAME}.bak-`

/**
 * 打开数据库；若提供了 migrationsFolder 则执行迁移（含备份）。
 */
export function openDatabase(opts: OpenDbOptions): OpenedDb {
  const { dataDir, migrationsFolder, backupKeep = 3, schemaVersion = 'unknown', onLog } = opts
  const log = onLog ?? (() => {})
  const file = join(dataDir, DB_FILENAME)

  mkdirSync(dataDir, { recursive: true })
  log(`db: opening ${file}`)

  const raw = new Database(file)

  // --- 关键 PRAGMA（顺序无关，但都必须在实际读写前设置）---
  // WAL：读写并发更好，且崩溃后恢复更可靠
  raw.pragma('journal_mode = WAL')
  // 外键必须显式打开，否则方案书的 CASCADE / RESTRICT 全部形同虚设
  raw.pragma('foreign_keys = ON')
  // 平衡安全与速度：断电极端场景下最多丢最后一个事务
  raw.pragma('synchronous = NORMAL')
  raw.pragma('busy_timeout = 5000')

  // 迁移（T02.7）+ 迁移前备份（T02.8）
  if (migrationsFolder) {
    // 把**迁移来源**写进日志：产物打不开的那次事故里，日志只能看到"没跑迁移"，
    // 看不出它到底从哪个目录找的、找没找到 —— 这条是事后定位的关键证据。
    log(`db: migrations from ${migrationsFolder}`)
    const needsMigration = hasPendingMigration(raw, migrationsFolder)
    if (needsMigration) {
      // 只在库里**确实已有用户数据**时才备份。
      // 否则全新安装也会生成一个空库备份：既没意义，又会占掉"保留 3 份"的名额
      // （连接打开时 better-sqlite3 会立即创建 0 字节文件，所以不能靠"文件是否存在"判断）。
      if (hasUserTables(raw)) {
        backupDatabase(raw, dataDir, schemaVersion, backupKeep, log)
      } else {
        log('db: fresh database (no user tables), skip backup')
      }
      log('db: applying migrations')
      migrate(drizzle(raw, { schema }), { migrationsFolder })
      log('db: migrations applied')
    } else {
      log('db: schema up to date, skip migration')
    }
  }

  const db = drizzle(raw, { schema })
  return {
    db,
    raw,
    file,
    close: () => raw.close()
  }
}

/**
 * 判断是否需要迁移：比对已应用的迁移记录与迁移文件数量。
 * 不做精确哈希比对 —— drizzle 自己维护 __drizzle_migrations 表，
 * 这里只需要判断"要不要走 migrate()"，多跑一次 migrate() 是幂等的。
 */
function hasPendingMigration(raw: Database.Database, migrationsFolder: string): boolean {
  try {
    const journalPath = join(migrationsFolder, 'meta', '_journal.json')
    // journal 缺失说明迁移目录**不完整**（只拷了 .sql、没拷 meta/）。
    // 这里以前返回 false = "无需迁移"，于是又是一个静默空库 —— 与"目录整个找不到"
    // 是同一个错误模式。改成保守地认为"需要迁移"：migrate() 幂等，
    // 真有问题它自己会抛，比如现在这样。
    if (!existsSync(journalPath)) return true

    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: unknown[] }
    const fileCount = journal.entries?.length ?? 0
    if (fileCount === 0) return false

    // 表不存在 => 全新库，需要迁移
    const tableExists = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`)
      .get() as { name?: string } | undefined
    if (!tableExists?.name) return true

    const applied = raw.prepare(`SELECT count(*) AS c FROM __drizzle_migrations`).get() as {
      c: number
    }
    return applied.c < fileCount
  } catch {
    // 判断失败时保守地执行迁移（migrate 幂等，安全）
    return true
  }
}

/**
 * 库里是否已有**用户表**（用于判断"是否值得备份"）。
 * drizzle 自己的 `__drizzle_migrations` 与 SQLite 内部的 `sqlite_%` 不算。
 */
export function hasUserTables(raw: Database.Database): boolean {
  try {
    const rows = raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
      name: string
    }[]
    return rows.some((r) => !r.name.startsWith('sqlite_') && !r.name.startsWith('__drizzle'))
  } catch {
    // 判断不了时保守地认为"有" —— 宁可多备份一次，也不要漏备份
    return true
  }
}

/**
 * 迁移前备份（T02.8）。
 *
 * 用 SQLite 的 `VACUUM INTO` 而不是直接复制文件，原因：
 * 库跑在 **WAL 模式**下，尚未检查点的事务只在 `-wal` 里。直接 `copyFileSync`
 * 只拷主库文件，备份可能**不含最新数据**（实测还会连带产生 `-shm` / `-wal` 附带文件）。
 * `VACUUM INTO` 会写出一个**单文件、内容完整且已整理**的副本，恢复时直接改名即可用。
 *
 * 备份失败只记日志、不阻断启动 —— 否则用户会"因为备份失败而完全用不了"。
 */
export function backupDatabase(
  raw: Database.Database,
  dataDir: string,
  schemaVersion: string,
  keep: number,
  log: (msg: string) => void = () => {}
): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(dataDir, `${BACKUP_PREFIX}${schemaVersion}-${stamp}`)

  try {
    // 先做一次 WAL 检查点，减少需要重放的日志量（失败不致命）
    try {
      raw.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* 不是 WAL 模式或忙时可忽略 */
    }
    // 用参数绑定传路径，避免路径里的引号破坏 SQL
    raw.prepare('VACUUM INTO ?').run(dest)
    log(`db: backup created ${dest}`)
  } catch (err) {
    log(`db: backup FAILED (continuing): ${(err as Error).message}`)
    return null
  }

  pruneBackups(dataDir, keep, log)
  return dest
}

/** 清理旧备份，保留最近 keep 份。 */
export function pruneBackups(
  dataDir: string,
  keep: number,
  log: (msg: string) => void = () => {}
): string[] {
  const removed: string[] = []
  try {
    // 按**文件名**倒序，而不是 mtime：
    // 备份名内嵌 ISO 时间戳（sfvm.db.bak-<版本>-<时间>），字典序即时间序，结果确定；
    // 而 mtime 在同一毫秒内会并列（导致保留的不是最新几份），
    // 且文件被复制/同步后 mtime 会被改写。
    const backups = readdirSync(dataDir)
      .filter((n) => n.startsWith(BACKUP_PREFIX))
      .sort((a, b) => b.localeCompare(a))

    for (const name of backups.slice(keep)) {
      unlinkSync(join(dataDir, name))
      removed.push(name)
      log(`db: pruned old backup ${name}`)
    }
  } catch (err) {
    log(`db: prune backups failed: ${(err as Error).message}`)
  }
  return removed
}
