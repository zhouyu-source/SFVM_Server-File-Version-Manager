/**
 * 数据库生命周期（T02.6 / T02.7 的接线部分）。
 *
 * 形式：显式 `openAppDatabase()` / `closeAppDatabase()` / `getRepositories()`，
 * 不用模块级自动连接 —— 单测与将来"导入导出"都需要可控的开关时机。
 *
 * 迁移目录解析要同时兼容开发与打包：
 * - 开发：`out/main/index.js` → ../../src/main/db/migrations
 * - 打包：migrations 由 electron-builder 的 `extraResources` 放到 `process.resourcesPath`
 *   —— `electron-builder.yml` 里那一段是**硬依赖**，删了产物就起不来
 *   （B16 出包时正是漏了它，复盘见 .tools/HANDOFF.md §1.13）
 *
 * 找不到迁移目录时**抛错**、不降级：没有迁移脚本，台账一定建不起来，
 * "带病继续"只会把故障推迟到第一次读表，表现是窗口永不出现、进程却留在任务管理器里。
 */
import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DB_FILENAME, openDatabase, type OpenedDb } from './client'
import { createRepositories, type Repositories } from './repositories'
import { logger } from '../infra/logger'
import { AppError, ErrorCode } from '../infra/errors'

let opened: OpenedDb | null = null
let repos: Repositories | null = null

/** 当前 schema 版本，用于备份文件命名（T02.8）。 */
export const SCHEMA_VERSION = '0000'

function resolveMigrationsFolder(): string {
  const candidates = [
    // 打包后（由 electron-builder.yml 的 extraResources 提供）—— 这才是**设计上的**位置
    join(process.resourcesPath ?? '', 'migrations'),
    // 下面两个是开发态兜底：产物里 `app.getAppPath()` 指向 app.asar（没有 src/），
    // 双击运行时 `process.cwd()` 又是 exe 所在目录，都靠不住，不能当成设计。
    join(app.getAppPath(), 'src', 'main', 'db', 'migrations'),
    join(process.cwd(), 'src', 'main', 'db', 'migrations')
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }

  // 绝不静默降级。以前这里只是 `logger.warn` 然后带着 undefined 继续开库，
  // 于是"迁移没跑"被伪装成"启动正常"：库是空的，日志里只有一条 warn，
  // 而真正的爆炸发生在几十行之后的第一次读表（`no such table`），
  // 排查时完全看不出根因在这里。现在把它变成一句能照做的错误。
  logger.error(`migrations folder not found, tried: ${candidates.join(' | ')}`)
  throw new AppError(
    ErrorCode.E_DB_MIGRATION,
    { candidates },
    {
      message: '数据库迁移脚本缺失，无法初始化台账',
      hint:
        '查找过以下位置：\n' +
        candidates.map((c) => `  · ${c}`).join('\n') +
        '\n若你是从安装包运行 SFVM 的，说明这个包不完整，请重新获取完整安装包。'
    }
  )
}

/**
 * 打开应用数据库。返回仓储集合；失败时抛异常由调用方决定如何提示。
 * 重复调用返回同一实例。
 *
 * `dataDir` 由接线层下传（B18：数据目录可配置，解析在 `infra/data-location.ts`）。
 * 不传时退回 `app.getPath('userData')`，主要是为了兼容既有的单测与临时脚本。
 */
export function openAppDatabase(dataDir?: string): Repositories {
  if (repos) return repos

  const resolvedDir = dataDir ?? app.getPath('userData')
  const folder = resolveMigrationsFolder()

  opened = openDatabase({
    dataDir: resolvedDir,
    // 一定有值：`resolveMigrationsFolder()` 找不到就抛错，不走"不迁移"的降级路径
    migrationsFolder: folder,
    backupKeep: 3,
    schemaVersion: SCHEMA_VERSION,
    onLog: (m) => logger.info(m)
  })

  repos = createRepositories(opened.db)
  logger.info(`db ready: ${opened.file}`)
  return repos
}

/** 当前打开的库文件；没开库时返回 null。 */
export function openedDbFile(): string | null {
  return opened?.file ?? null
}

/** 当前**生效的**数据目录（数据库所在目录）；没开库时返回 null。 */
export function openedDataDir(): string | null {
  return opened ? dirname(opened.file) : null
}

/**
 * 把当前台账**在线备份**到目标目录（B18：改数据目录时把数据带过去）。
 *
 * 用 SQLite 的在线备份 API（`better-sqlite3` 的 `db.backup`）而不是直接拷文件：
 * - 直接拷 `.db` 会漏掉 WAL 里还没落盘的事务（本库开着 WAL），拷出来可能是**旧的**；
 * - 拷贝期间应用还在跑，没有一致性保证；
 * - 在线备份由 SQLite 自己保证一致性，且**不需要关库** —— 这正是能选
 *   "复制数据 + 重启生效"（而不是"关库迁过去"）的原因：所有业务服务都在启动时
 *   捕获了数据库句柄，热切换必然留下一堆悬空引用。
 *
 * 目标文件已存在时**由调用方先改名保留**（见 `services/data-location.ts`），
 * 本函数只管往里写。
 */
export async function backupDatabaseTo(targetDir: string): Promise<string> {
  if (!opened) throw new Error('database not opened yet - call openAppDatabase() first')
  mkdirSync(targetDir, { recursive: true })
  const dest = join(targetDir, DB_FILENAME)
  await opened.raw.backup(dest)
  logger.info(`db backup -> ${dest}`)
  return dest
}

export function getRepositories(): Repositories {
  if (!repos) throw new Error('database not opened yet - call openAppDatabase() first')
  return repos
}

export function closeAppDatabase(): void {
  if (opened) {
    try {
      opened.close()
      logger.info('db closed')
    } catch (err) {
      logger.warn(`db close failed: ${(err as Error).message}`)
    }
  }
  opened = null
  repos = null
}
