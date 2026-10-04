/**
 * 数据库测试辅助：每个测试用例一个全新的临时库。
 *
 * 刻意不 mock better-sqlite3 —— 这几项验收点（WAL、外键是否真的生效、
 * 迁移是否真的建表）只有在真实 SQLite 上跑才有意义。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type OpenedDb } from '@main/db/client'
import { createRepositories, type Repositories } from '@main/db/repositories'

export interface TestDb {
  db: OpenedDb
  repo: Repositories
  dataDir: string
  cleanup: () => void
}

/**
 * 建一个已迁移的临时库。
 * migrationsFolder 指向仓库里已提交的迁移，保证"测的就是发布用的 SQL"。
 */
export function makeTestDb(): TestDb {
  const dataDir = mkdtempSync(join(tmpdir(), 'sfvm-db-'))
  const db = openDatabase({
    dataDir,
    migrationsFolder: join(process.cwd(), 'src', 'main', 'db', 'migrations'),
    schemaVersion: 'test'
  })
  return {
    db,
    repo: createRepositories(db.db),
    dataDir,
    cleanup: () => {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

/** 常用的建库前置数据：一条连接 + 一个环境 + 一个目标。 */
export function seedBasic(repo: Repositories, overrides?: { remotePath?: string; kind?: string }) {
  const conn = repo.connections.create({
    name: '测试机',
    host: '10.0.0.1',
    port: 22,
    username: 'deploy',
    authType: 'password'
  })
  const env = repo.environments.create({
    name: `测试环境-${Math.random().toString(36).slice(2, 8)}`,
    envType: 'test',
    connectionId: conn.id
  })
  const target = repo.targets.create({
    environmentId: env.id,
    name: '订单服务',
    kind: overrides?.kind ?? 'file',
    remotePath: overrides?.remotePath ?? '/opt/svc/order.jar'
  })
  return { conn, env, target }
}
