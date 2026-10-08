/**
 * T02.6 / T02.7 / T02.8 验收点：
 * - WAL 模式与**外键真的开启**（不开启的话 CASCADE/RESTRICT 全部失效）
 * - 启动自动迁移建出全部 9 张表；二次打开不重复执行
 * - 迁移前自动备份，且只保留最近 3 份
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  BACKUP_PREFIX,
  backupDatabase,
  hasUserTables,
  openDatabase,
  pruneBackups
} from '@main/db/client'
import { ALL_TABLES } from '@main/db/schema'
import { schemaVersionOf } from '@main/db'
import { makeTestDb } from '../helpers/db'

describe('openDatabase：PRAGMA 与迁移', () => {
  it('开启 WAL 模式', () => {
    const t = makeTestDb()
    try {
      const mode = t.db.raw.pragma('journal_mode', { simple: true })
      expect(String(mode).toLowerCase()).toBe('wal')
    } finally {
      t.cleanup()
    }
  })

  it('开启外键约束（否则 CASCADE 形同虚设）', () => {
    const t = makeTestDb()
    try {
      expect(t.db.raw.pragma('foreign_keys', { simple: true })).toBe(1)
    } finally {
      t.cleanup()
    }
  })

  it('迁移建出全部业务表', () => {
    const t = makeTestDb()
    try {
      const rows = t.db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
        name: string
      }[]
      const names = rows.map((r) => r.name)
      for (const table of ALL_TABLES) {
        expect(names, `缺表: ${table}`).toContain(table)
      }
    } finally {
      t.cleanup()
    }
  })

  it('外键约束真的会拦下非法引用', () => {
    const t = makeTestDb()
    try {
      // environments.connection_id 指向不存在的连接，且是 NOT NULL + RESTRICT
      expect(() =>
        t.db.raw
          .prepare(
            `INSERT INTO environments (id,name,env_type,connection_id,created_at,updated_at)
             VALUES ('x','坏环境','test','不存在的连接','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z')`
          )
          .run()
      ).toThrow(/FOREIGN KEY/i)
    } finally {
      t.cleanup()
    }
  })

  it('二次打开不重复迁移（迁移记录表已存在）', () => {
    const t = makeTestDb()
    const dataDir = t.dataDir
    t.db.close()

    const logs: string[] = []
    const again = openDatabase({
      dataDir,
      migrationsFolder: join(process.cwd(), 'src', 'main', 'db', 'migrations'),
      schemaVersion: 'test',
      onLog: (m) => logs.push(m)
    })
    try {
      expect(logs.some((l) => l.includes('skip migration'))).toBe(true)
    } finally {
      again.close()
    }
  })
})

describe('hasUserTables（决定是否值得备份）', () => {
  it('全新库（连 drizzle 迁移表都没有）判为无用户表', () => {
    const raw = new BetterSqlite3(':memory:')
    try {
      expect(hasUserTables(raw)).toBe(false)
    } finally {
      raw.close()
    }
  })

  it('只有 drizzle 迁移表时仍判为无用户表', () => {
    const raw = new BetterSqlite3(':memory:')
    try {
      raw.exec(`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY)`)
      expect(hasUserTables(raw)).toBe(false)
    } finally {
      raw.close()
    }
  })

  it('存在业务表时判为有用户表', () => {
    const raw = new BetterSqlite3(':memory:')
    try {
      raw.exec(`CREATE TABLE connections (id TEXT PRIMARY KEY)`)
      expect(hasUserTables(raw)).toBe(true)
    } finally {
      raw.close()
    }
  })

  it('SQLite 自动生成的 sqlite_ 表不会被误判为用户表', () => {
    const raw = new BetterSqlite3(':memory:')
    try {
      // SQLite 不允许手工 CREATE TABLE sqlite_xxx（保留前缀），
      // 但 ANALYZE 会自己生成 sqlite_stat1。用它来验证前缀过滤是可行的。
      raw.exec(`CREATE TABLE tmp_business (id TEXT PRIMARY KEY)`)
      raw.exec(`ANALYZE`)
      const names = (
        raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
      ).map((r) => r.name)
      // 前提成立：sqlite_stat1 确实存在
      expect(names).toContain('sqlite_stat1')
      // 只要有业务表就应为 true（sqlite_stat1 被忽略）
      expect(hasUserTables(raw)).toBe(true)
    } finally {
      raw.close()
    }
  })
})

describe('备份（T02.8）', () => {
  it('全新安装不产生备份（没有旧数据可备份）', () => {
    const t = makeTestDb()
    try {
      // 连接打开时 better-sqlite3 会立即创建库文件，所以不能靠"文件是否存在"判断，
      // 这里断言的是"没有生成备份"，也就是 hasUserTables 的判断生效了
      const backups = readdirSync(t.dataDir).filter((f) => f.startsWith(BACKUP_PREFIX))
      expect(backups).toEqual([])
    } finally {
      t.cleanup()
    }
  })

  it('备份是完整可用的单文件（VACUUM INTO，不含 -wal/-shm 附带文件）', () => {
    const t = makeTestDb()
    try {
      // 先写入一条真实数据，验证备份内容完整
      t.repo.connections.create({
        name: '备份前',
        host: 'h',
        port: 22,
        username: 'u',
        authType: 'password'
      })

      const dest = backupDatabase(t.db.raw, t.dataDir, 'v9', 3)
      expect(dest).toBeTruthy()
      expect(existsSync(dest!)).toBe(true)
      expect(dest!).toContain(BACKUP_PREFIX)
      expect(dest!).toContain('v9')

      // 关键：单文件，不产生 -wal / -shm 附带文件
      expect(existsSync(`${dest!}-wal`)).toBe(false)
      expect(existsSync(`${dest!}-shm`)).toBe(false)

      // 关键：备份里能读到刚才那条数据（证明 WAL 里的内容被包含）
      const restored = new BetterSqlite3(dest!, { readonly: true })
      try {
        const rows = restored.prepare(`SELECT name FROM connections`).all() as { name: string }[]
        expect(rows.map((r) => r.name)).toContain('备份前')
      } finally {
        restored.close()
      }
    } finally {
      t.cleanup()
    }
  })

  it('备份失败时返回 null 而不是抛错（不阻断启动）', () => {
    const t = makeTestDb()
    try {
      // 传一个不可能写入的路径：dataDir 下不存在的子目录
      const dest = backupDatabase(t.db.raw, join(t.dataDir, '不存在', '更深'), 'v9', 3)
      expect(dest).toBeNull()
    } finally {
      t.cleanup()
    }
  })

  it('只保留最近 N 份备份，多余的被清掉', () => {
    // 用独立目录，避免前一用例留下的备份干扰计数
    const dir = mkdtempSync(join(tmpdir(), 'sfvm-bak-'))
    try {
      // 造 6 份备份，保留 3 份
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(dir, `${BACKUP_PREFIX}v1-2025-01-0${i}T00-00-00-000Z`), 'x')
      }
      const removed = pruneBackups(dir, 3)
      const left = readdirSync(dir).filter((f) => f.startsWith(BACKUP_PREFIX))
      expect(left.length).toBe(3)
      expect(removed.length).toBe(3)
      // 保留的必须是最新的 3 份（文件名里 03/04/05）
      expect(left.sort()).toEqual([
        `${BACKUP_PREFIX}v1-2025-01-03T00-00-00-000Z`,
        `${BACKUP_PREFIX}v1-2025-01-04T00-00-00-000Z`,
        `${BACKUP_PREFIX}v1-2025-01-05T00-00-00-000Z`
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pruneBackups 在没有备份时是安全的空操作', () => {
    // 同样用独立目录
    const dir = mkdtempSync(join(tmpdir(), 'sfvm-bak-'))
    try {
      expect(pruneBackups(dir, 3)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('schemaVersionOf：从迁移目录推导（P2-17）', () => {
  it('取文件名里最大的序号', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfvm-schema-'))
    try {
      writeFileSync(join(dir, '0000_a.sql'), '')
      writeFileSync(join(dir, '0003_b.sql'), '')
      writeFileSync(join(dir, 'notes.txt'), '') // 非迁移文件不参与
      expect(schemaVersionOf(dir)).toBe('0003')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录读不出来时退回兜底常量（不抛错）', () => {
    expect(schemaVersionOf(join(tmpdir(), 'sfvm-schema-does-not-exist'))).toBe('0000')
  })
})
