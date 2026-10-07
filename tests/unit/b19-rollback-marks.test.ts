/**
 * B19 单测：回滚在「往期版本」列表里的标记。
 *
 * ## 这一层要证明的东西
 *
 * 用户回滚之后，界面上只变了两个数字（当前版本号 + 多了一条往期版本），
 * 但"回滚发生过"这件事在列表里完全看不出来。标记是**派生**的 ——
 * 判定全部来自 `releases` 里已有的行，不新增列、不写新数据。
 *
 * 派生逻辑最容易犯的错是"看起来标上了，其实是巧合"：归档版本号与台账版本号
 * 恰好相等、失败的回滚把来源冒认成当前线上版本、第二次回滚之后上一版该不该
 * 继续显示"当前线上"。所以这里用**真实 SQLite** 把两次回滚的完整台账造出来，
 * 断言的就是列表最终呈现的内容。
 *
 * ## 为什么分两层测
 *
 * `buildRollbackMarks` 是纯函数，边界组合（失败回滚、二次回滚、版本号对不上）
 * 用它在内存里穷举最省事；`archive.list()` 那层只补一件事 ——
 * 标记确实被带进了 IPC 会发出去的那份 `ArchiveView[]`，而不是算完就丢。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildRollbackMarks, createArchiveService } from '@main/services/archive'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

/* ------------------------------------------------------------------ 夹具 */

const V1 = '20260101-100000_aaaaaaa'
const V2 = '20260102-030405_bbbbbbb'
const V0 = '20251201-100000_ccccccc'

const T_RB1 = '2026-01-02T03:04:05.000Z'
const T_RB2 = '2026-01-03T06:07:08.000Z'

function archiveRow(id: string, versionTag: string, releaseId: string | null = null) {
  return { id, versionTag, releaseId }
}

interface ReleaseRowInput {
  id: string
  action: string
  versionTag: string
  status: string
  archiveId?: string | null
  startedAt?: string
  finishedAt?: string | null
}

function releaseRow(r: ReleaseRowInput) {
  return {
    archiveId: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    ...r
  }
}

/* ------------------------------------------------------- 纯函数：判据组合 */

describe('buildRollbackMarks（B19 回滚标记的判据）', () => {
  it('台账里没有回滚时，一行都不该被标记', () => {
    const marks = buildRollbackMarks({
      archives: [archiveRow('a1', V1), archiveRow('a2', V2)],
      releases: [
        releaseRow({ id: 'r1', action: 'deploy', versionTag: V1, status: 'SUCCESS' }),
        releaseRow({ id: 'r2', action: 'deploy', versionTag: V2, status: 'FAILED' })
      ]
    })
    expect(marks.get('a1')).toEqual({ rollback: null, supersededByRollbackAt: null })
    expect(marks.get('a2')).toEqual({ rollback: null, supersededByRollbackAt: null })
  })

  it('成功回滚：来源行标 source、回滚归档出来的那行标 archived', () => {
    const marks = buildRollbackMarks({
      archives: [archiveRow('a1', V1), archiveRow('a2', V2, 'rb1')],
      releases: [
        releaseRow({
          id: 'rb1',
          action: 'rollback',
          versionTag: V1,
          status: 'SUCCESS',
          archiveId: 'a1',
          finishedAt: T_RB1
        })
      ]
    })
    expect(marks.get('a1')).toEqual({
      rollback: { role: 'source', toVersionTag: V1, at: T_RB1 },
      supersededByRollbackAt: null
    })
    expect(marks.get('a2')).toEqual({
      rollback: { role: 'archived', toVersionTag: V1, at: T_RB1 },
      supersededByRollbackAt: null
    })
  })

  it('失败的回滚不能让来源版本冒充"当前线上版本"', () => {
    const marks = buildRollbackMarks({
      archives: [archiveRow('a1', V1)],
      releases: [
        releaseRow({
          id: 'rb1',
          action: 'rollback',
          versionTag: V1,
          status: 'FAILED',
          archiveId: 'a1',
          finishedAt: T_RB1
        })
      ]
    })
    expect(marks.get('a1')?.rollback).toBeNull()
  })

  it('失败的回滚如果留下了归档行（补偿没搬干净），仍然如实标成 archived', () => {
    const marks = buildRollbackMarks({
      archives: [archiveRow('a2', V2, 'rb1')],
      releases: [
        releaseRow({ id: 'rb1', action: 'rollback', versionTag: V1, status: 'FAILED', archiveId: 'a1' })
      ]
    })
    // 这一行真实存在过（否则不会出现在输入里），标出来没有风险；
    // `at` 回退到 startedAt（契约：没有完成时间就用开始时间，不能因为缺一个字段就不显示）
    expect(marks.get('a2')?.rollback).toEqual({
      role: 'archived',
      toVersionTag: V1,
      at: '2026-01-01T00:00:00.000Z'
    })
  })

  it('第二次回滚之后：上一版的来源标记消失，改成"已被回滚取代"', () => {
    const marks = buildRollbackMarks({
      // a1 = 第一次回滚的来源；a3 = 第二次回滚的来源
      archives: [archiveRow('a1', V1), archiveRow('a2', V2, 'rb1'), archiveRow('a3', V0)],
      releases: [
        // 第一次回滚的行：已被第二次回滚取代
        releaseRow({
          id: 'rb1',
          action: 'rollback',
          versionTag: V1,
          status: 'ROLLED_BACK',
          archiveId: 'a1',
          finishedAt: T_RB1
        }),
        releaseRow({
          id: 'rb2',
          action: 'rollback',
          versionTag: V0,
          status: 'SUCCESS',
          archiveId: 'a3',
          finishedAt: T_RB2
        })
      ]
    })
    expect(marks.get('a1')).toEqual({ rollback: null, supersededByRollbackAt: T_RB1 })
    expect(marks.get('a3')).toEqual({
      rollback: { role: 'source', toVersionTag: V0, at: T_RB2 },
      supersededByRollbackAt: null
    })
    // 那个"回滚归档"出来的行不受后续回滚影响
    expect(marks.get('a2')?.rollback?.role).toBe('archived')
    expect(marks.get('a2')?.supersededByRollbackAt).toBeNull()
  })

  it('被取代的判据是版本号相等，不是"看见 ROLLED_BACK 就算"', () => {
    const marks = buildRollbackMarks({
      archives: [archiveRow('a1', V1)],
      releases: [
        releaseRow({
          id: 'r1',
          action: 'deploy',
          versionTag: V2,
          status: 'ROLLED_BACK',
          finishedAt: T_RB1
        })
      ]
    })
    // 版本号对不上 → 这一行与那次被取代没有关系
    expect(marks.get('a1')?.supersededByRollbackAt).toBeNull()
  })

  it('回滚之后又发布成功：回滚标记整体退场（发布不会给上一条台账打 ROLLED_BACK，必须在这里判）', () => {
    const marks = buildRollbackMarks({
      archives: [archiveRow('a1', V1), archiveRow('a2', V2, 'rb1')],
      releases: [
        // 时间倒序：最新的成功操作是发布
        releaseRow({ id: 'd3', action: 'deploy', versionTag: V0, status: 'SUCCESS' }),
        releaseRow({
          id: 'rb1',
          action: 'rollback',
          versionTag: V1,
          status: 'SUCCESS',
          archiveId: 'a1',
          finishedAt: T_RB1
        })
      ]
    })
    // a1 曾是"回滚来源"（tooltip 说它就是当前的线上版本 —— 发布之后这是谎话），
    // a2 曾是"回滚归档" —— 回滚这一章翻篇了，标记一起退场
    expect(marks.get('a1')).toEqual({ rollback: null, supersededByRollbackAt: null })
    expect(marks.get('a2')).toEqual({ rollback: null, supersededByRollbackAt: null })
  })

  it('之后只有失败的发布：回滚标记照常显示（失败的发布不改变"线上是什么"）', () => {
    const marks = buildRollbackMarks({
      archives: [archiveRow('a1', V1)],
      releases: [
        releaseRow({ id: 'd3', action: 'deploy', versionTag: V0, status: 'FAILED' }),
        releaseRow({
          id: 'rb1',
          action: 'rollback',
          versionTag: V1,
          status: 'SUCCESS',
          archiveId: 'a1',
          finishedAt: T_RB1
        })
      ]
    })
    expect(marks.get('a1')?.rollback).toEqual({ role: 'source', toVersionTag: V1, at: T_RB1 })
  })
})

/* ------------------------------------------- 集成：list() 把标记带进 IPC */

describe('archive.list 的回滚标记（B19）', () => {
  let t: TestDb
  let targetId: string
  let service: ReturnType<typeof createArchiveService>

  beforeEach(() => {
    t = makeTestDb()
    service = createArchiveService({ repo: t.repo })
    targetId = seedBasic(t.repo).target.id
  })

  afterEach(() => {
    t.cleanup()
  })

  /** 造一行归档。`id` 由仓储生成（`archives.create` 不接受调用方传 id）。 */
  function addArchive(versionTag: string, releaseId: string | null = null): string {
    return t.repo.archives.create({
      targetId,
      versionTag,
      storagePath: `/opt/archives/dist/${versionTag}`,
      payloadPath: `/opt/archives/dist/${versionTag}/payload`,
      kind: 'dir',
      rootHash: 'a'.repeat(64),
      totalBytes: 100,
      fileCount: 2,
      releaseId,
      note: null
    }).id
  }

  function addRollback(id: string, toVersionTag: string, sourceArchiveId: string, status: string, at: string) {
    t.repo.releases.create({
      id,
      targetId,
      action: 'rollback',
      versionTag: toVersionTag,
      status,
      archiveId: sourceArchiveId,
      finishedAt: at
    })
  }

  it('list() 返回的每一行都带 rollback / supersededByRollbackAt 两个字段', () => {
    addArchive(V1)
    const rows = service.list(targetId)
    expect(rows).toHaveLength(1)
    // 字段必须存在：IPC 那侧按普通对象发出去，缺字段会让 UI 的 v-if 判成 undefined
    expect(rows[0]).toHaveProperty('rollback', null)
    expect(rows[0]).toHaveProperty('supersededByRollbackAt', null)
    // 既有字段一个不少
    expect(rows[0]).toMatchObject({
      versionTag: V1,
      kind: 'dir',
      totalBytes: 100,
      fileCount: 2,
      status: 'valid',
      shortHash: 'aaaaaaaa'
    })
  })

  it('两次回滚之后，列表能同时看出"回滚到的是哪一版"和"哪一版被取代了"', () => {
    const a1 = addArchive(V1)
    const a2 = addArchive(V2, 'rb1')
    const a3 = addArchive(V0)

    addRollback('rb1', V1, a1, 'ROLLED_BACK', T_RB1)
    addRollback('rb2', V0, a3, 'SUCCESS', T_RB2)

    const byId = new Map(service.list(targetId).map((r) => [r.id, r]))

    // 当前线上那一版：由第二次回滚恢复上去的
    expect(byId.get(a3)?.rollback).toEqual({ role: 'source', toVersionTag: V0, at: T_RB2 })
    // 第一次回滚归档出来的产物
    expect(byId.get(a2)?.rollback).toEqual({ role: 'archived', toVersionTag: V1, at: T_RB1 })
    // 曾经被回滚到线上、后来被第二次回滚换掉的那一版
    expect(byId.get(a1)?.supersededByRollbackAt).toBe(T_RB1)
    expect(byId.get(a1)?.rollback).toBeNull()
  })

  it('另一个目标的回滚不会串到本目标的行上', () => {
    addArchive(V1)
    const otherTargetId = seedBasic(t.repo, { remotePath: '/opt/other/dist' }).target.id

    const other = t.repo.archives.create({
      targetId: otherTargetId,
      versionTag: V1,
      storagePath: `/opt/archives/other/${V1}`,
      payloadPath: `/opt/archives/other/${V1}/payload`,
      kind: 'dir',
      rootHash: 'b'.repeat(64),
      totalBytes: 1,
      fileCount: 1
    })
    t.repo.releases.create({
      id: 'rb-other',
      targetId: otherTargetId,
      action: 'rollback',
      versionTag: V1,
      status: 'SUCCESS',
      archiveId: other.id,
      finishedAt: T_RB1
    })

    expect(service.list(targetId)[0].rollback).toBeNull()
    expect(service.list(otherTargetId)[0].rollback?.role).toBe('source')
  })
})
