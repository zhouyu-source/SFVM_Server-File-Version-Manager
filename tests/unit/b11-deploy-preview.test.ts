/**
 * B11 / T11.3 发布预览（`DeployService.preview`）的单测。
 *
 * 这个函数是确认弹窗的唯一数据来源，三个"必须是同一个口径"的地方在这里钉住：
 * 1. 与本地产物的**文件集合**：走 `collectLocalFiles`，`local_exclude` 生效；
 * 2. 与**发布台账**：基准取"最近一次成功发布"的逐文件清单，失败记录不算；
 * 3. 与详情页徽标：`possiblyStale` 用同一个"最近一次变动"规则。
 *
 * 不需要任何远端替身 —— preview 的设计就是**纯本地**（离线也要能给差异），
 * 这里用真实临时目录 + 真实 SQLite 就能全覆盖。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createArchiveService } from '@main/services/archive'
import { createDeployService } from '@main/services/deploy'
import { ErrorCode } from '@shared/errors'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

const tempDirs: string[] = []

function makeLocalDir(files: Record<string, string>, mtimes?: Record<string, Date>): string {
  const root = mkdtempSync(join(tmpdir(), 'sfvm-b11pv-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
    const t = mtimes?.[rel]
    if (t) utimesSync(p, t, t)
  }
  return root
}

describe('DeployService.preview（T11.3 差异预览）', () => {
  let t: TestDb
  let service: ReturnType<typeof createDeployService>
  let localDir: string
  let targetId: string

  beforeEach(() => {
    t = makeTestDb()
    service = createDeployService({
      repo: t.repo,
      archive: createArchiveService({ repo: t.repo })
    })
    // 基础连接 / 环境 / 目标；`seedBasic` 默认造的是**文件型**目标
    // （/opt/svc/order.jar），这里要的是目录型 —— 显式指定，避免依赖默认值。
    targetId = seedBasic(t.repo, { kind: 'dir', remotePath: '/opt/app/dist' }).target.id
    localDir = makeLocalDir({ 'index.html': 'v1', 'assets/app.js': 'a1' })
    tempDirs.push(localDir)
    t.repo.targets.update(targetId, { localPath: localDir })
  })

  afterEach(() => {
    t.cleanup()
    for (const d of tempDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* 已删除 */
      }
    }
  })

  /** 写一条"成功发布"的台账 + 它的逐文件清单（模拟上一次发布）。 */
  function seedPreviousRelease(items: Array<{ relPath: string; hash: string; size: number }>): void {
    const rel = t.repo.releases.create({
      targetId,
      action: 'deploy',
      versionTag: '20260930-120000_abcdef0',
      status: 'SUCCESS',
      source: 'local',
      localPath: localDir,
      note: null,
      operator: null,
      rootHash: 'f'.repeat(64),
      totalBytes: items.reduce((a, i) => a + i.size, 0),
      fileCount: items.length,
      currentStep: '6'
    })
    t.repo.releaseItems.addMany(
      items.map((i) => ({ releaseId: rel.id, relPath: i.relPath, hash: i.hash, size: i.size, mtime: null }))
    )
  }

  it('未配置本地产物 → 明确报错并给出下一步（不是返回一堆 null）', async () => {
    t.repo.targets.update(targetId, { localPath: null })
    await expect(service.preview({ targetId })).rejects.toMatchObject({
      code: ErrorCode.E_LOCAL_PATH_MISSING
    })
  })

  it('首次发布（没有成功记录）→ 全部算新增，lastVersionTag 为 null', async () => {
    const p = await service.preview({ targetId })

    expect(p.diff.firstPublish).toBe(true)
    expect(p.diff.counts.added).toBe(2)
    expect(p.diff.counts.unchanged).toBe(0)
    expect(p.lastVersionTag).toBeNull()
    expect(p.artifact.fileCount).toBe(2)
    expect(p.artifact.rootHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('有上次成功发布 → 新增 / 修改 / 删除 / 未变四类分别给对', async () => {
    // 上次发布：keep（内容不变）、changed（内容将变）、gone（本地将删掉）
    seedPreviousRelease([
      { relPath: 'index.html', hash: await hashOf('v1'), size: 'v1'.length },
      { relPath: 'assets/app.js', hash: await hashOf('OLD'), size: 3 },
      { relPath: 'assets/gone.js', hash: await hashOf('bye'), size: 3 }
    ])
    // 本次本地：index.html 不变、assets/app.js 改了、assets/gone.js 没了、多了 new.css
    localDir = makeLocalDir({ 'index.html': 'v1', 'assets/app.js': 'NEW', 'new.css': 'x' })
    tempDirs.push(localDir)
    t.repo.targets.update(targetId, { localPath: localDir })

    const p = await service.preview({ targetId })

    expect(p.diff.firstPublish).toBe(false)
    expect(p.diff.previousVersionTag).toBe('20260930-120000_abcdef0')
    expect(p.lastVersionTag).toBe('20260930-120000_abcdef0')
    expect(p.diff.added).toEqual(['new.css'])
    expect(p.diff.modified).toEqual(['assets/app.js'])
    expect(p.diff.deleted).toEqual(['assets/gone.js'])
    expect(p.diff.unchangedCount).toBe(1)
  })

  it('基准取"最近一次**成功**发布"：最后一次是失败时不算基准', async () => {
    seedPreviousRelease([{ relPath: 'index.html', hash: 'h', size: 1 }])
    // 之后再失败一次 —— 它才是"最近一次发布"
    t.repo.releases.create({
      targetId,
      action: 'deploy',
      versionTag: '20260930-130000_ffffff0',
      status: 'FAILED',
      source: 'local',
      localPath: localDir,
      note: null,
      operator: null,
      rootHash: null,
      totalBytes: 0,
      fileCount: 0,
      currentStep: '3'
    })

    const p = await service.preview({ targetId })
    expect(p.diff.firstPublish, '失败的那次没有可用清单，不能拿它当基准').toBe(false)
    expect(p.diff.previousVersionTag).toBe('20260930-120000_abcdef0')
  })

  it('成功记录但清单是空的 → 退回"首次发布"口径（而不是"全部删除"）', async () => {
    seedPreviousRelease([]) // 有记录、没明细（例如上一次文件数超过持久化上限）
    const p = await service.preview({ targetId })
    expect(p.diff.firstPublish).toBe(true)
    expect(p.diff.counts.added).toBe(2)
    expect(p.diff.counts.deleted).toBe(0)
  })

  it('排除规则生效：被排除的文件不计入文件数，也不出现在差异里', async () => {
    t.repo.targets.update(targetId, { localExclude: JSON.stringify(['*.map']) })
    localDir = makeLocalDir({ 'index.html': 'v1', 'app.js.map': 'x'.repeat(100) })
    tempDirs.push(localDir)
    t.repo.targets.update(targetId, { localPath: localDir })

    const p = await service.preview({ targetId })
    expect(p.artifact.fileCount).toBe(1)
    expect(p.artifact.excludedCount).toBe(1)
    expect(p.diff.added).toEqual(['index.html'])
  })

  it('产物都是旧的 → possiblyStale=true（与详情页徽标同一规则）', async () => {
    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    localDir = makeLocalDir({ 'index.html': 'v1' }, { 'index.html': old })
    tempDirs.push(localDir)
    utimesSync(localDir, old, old)
    t.repo.targets.update(targetId, { localPath: localDir })

    const p = await service.preview({ targetId })
    expect(p.artifact.possiblyStale).toBe(true)
    expect(p.artifact.newestMtime).toBe(old.toISOString())
  })

  it('保留策略文案带上（弹窗里要提示"发完会自动清理"）', async () => {
    t.repo.targets.update(targetId, { retainPolicy: JSON.stringify({ mode: 'count', value: 5 }) })
    const p = await service.preview({ targetId })
    expect(p.retainPolicyText).toContain('5')

    t.repo.targets.update(targetId, { retainPolicy: null })
    const p2 = await service.preview({ targetId })
    expect(p2.retainPolicyText).toContain('不自动清理')
  })

  it('limit 生效：列表截断但计数准确', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 8; i++) files[`f${i}.txt`] = 'x'
    localDir = makeLocalDir(files)
    tempDirs.push(localDir)
    t.repo.targets.update(targetId, { localPath: localDir })

    const p = await service.preview({ targetId, limit: 3 })
    expect(p.diff.added).toHaveLength(3)
    expect(p.diff.counts.added).toBe(8)
    expect(p.diff.truncated).toBe(true)
  })
})

/** 复用发布用的同一套本地哈希（保证"清单里的 hash"与 preview 算出来的一致）。 */
async function hashOf(content: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(content).digest('hex')
}
