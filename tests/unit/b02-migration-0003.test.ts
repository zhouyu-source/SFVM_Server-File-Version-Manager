/**
 * 迁移 0003 回归测试：`archives.archived_at` 归一为 UTC（P1-1）。
 *
 * 历史上同一列混存两种格式（正常归档 UTC / 对账补录本地偏移），列上的排序与
 * min/max 是字符串比较，跨 UTC 日界会整体错序。迁移把"带偏移且能解析"的行
 * 归一成 `...Z`；解析失败的行**原样保留**（与 retention"坏行一律保留"的约定一致）。
 *
 * 测试方式：建一个已迁移的临时库 → 手工插入三种格式的行 → 执行迁移文件的
 * UPDATE 语句 → 断言结果。直接跑迁移文件里的 SQL，保证"测的就是要执行的"。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

const MIGRATION = join(
  process.cwd(),
  'src',
  'main',
  'db',
  'migrations',
  '0003_normalize_archived_at_utc.sql'
)

function runMigration(raw: TestDb['db']['raw']): void {
  // 去掉 `--` 注释行后整段执行（better-sqlite3 的 exec 支持多语句）
  const sql = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
  raw.exec(sql)
}

describe('迁移 0003：archived_at 归一为 UTC（P1-1 回归）', () => {
  let t: TestDb
  let targetId: string

  beforeEach(() => {
    t = makeTestDb()
    targetId = seedBasic(t.repo).target.id
  })

  afterEach(() => {
    t.cleanup()
  })

  /** 经仓储建行（满足各列约束），archivedAt 显式给定以模拟历史混存数据 */
  function seed(versionTag: string, archivedAt: string): void {
    t.repo.archives.create({
      targetId,
      versionTag,
      storagePath: `/a/${versionTag}`,
      payloadPath: `/a/${versionTag}/payload`,
      kind: 'dir',
      rootHash: `hash-${versionTag}`,
      totalBytes: 1,
      fileCount: 1,
      status: 'valid',
      archivedAt
    })
  }

  function tagsByTimeDesc(): string[] {
    return t.repo.archives.listByTarget(targetId, 10).map((r) => r.versionTag)
  }

  it('本地偏移行归一为 UTC（时刻不变）；UTC 行与解析失败行原样保留', () => {
    seed('v-offset', '2026-09-10T12:00:00+08:00') // == 04:00Z
    seed('v-utc', '2026-09-10T04:00:00.000Z')
    seed('v-broken', 'not-a-time')

    runMigration(t.db.raw)

    const byTag = new Map(
      t.repo.archives.listByTarget(targetId, 10).map((r) => [r.versionTag, r.archivedAt])
    )
    // 偏移 → UTC，**同一时刻**（字典序从此与真实时序一致）
    expect(byTag.get('v-offset')).toBe('2026-09-10T04:00:00.000Z')
    // UTC 行不受影响
    expect(byTag.get('v-utc')).toBe('2026-09-10T04:00:00.000Z')
    // 解析失败的行原样保留（交给对账，绝不在这里猜）
    expect(byTag.get('v-broken')).toBe('not-a-time')
  })

  it('归一后排序与真实时序一致（混存时代的跨日错序消失）', () => {
    // 构造修复前必反序的组合：
    //   utc 行    2026-10-07T23:00:00.000Z        → 真实时刻更**新**
    //   offset 行 2026-10-08T05:00:00+08:00       → 21:00Z，真实时刻更旧
    // 字符串序把 offset 行排在前面（日期段更大），真实时序却是反的。
    seed('older-instant', '2026-10-08T05:00:00+08:00') // == 2026-10-07T21:00:00Z
    seed('newer-instant', '2026-10-07T23:00:00.000Z')

    runMigration(t.db.raw)

    // listByTarget 按 archived_at DESC；归一后字典序 == 真实时序
    expect(tagsByTimeDesc()).toEqual(['newer-instant', 'older-instant'])
  })

  it('迁移幂等：对已归一的库再跑一遍不改变任何值', () => {
    seed('v1', '2026-09-10T12:00:00+08:00')
    runMigration(t.db.raw)
    const first = t.repo.archives.listByTarget(targetId, 10).map((r) => r.archivedAt)
    runMigration(t.db.raw)
    const second = t.repo.archives.listByTarget(targetId, 10).map((r) => r.archivedAt)
    expect(second).toEqual(first)
  })
})
