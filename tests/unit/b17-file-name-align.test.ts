/**
 * B17 / T17.1 ~ T17.3：文件型目标「本地产物名 ≠ 服务器端文件名」的处理。
 *
 * ## 这个 bug 的原貌（为什么值得单独一个批次）
 *
 * 文件型目标换版要 rename 的是 `payload/<服务器端文件名>` 这**一个文件**
 * （名字取自目标的 `remotePath`），而上传落盘用的是**本地产物的文件名**。
 * 两者不一致时：阶段 3 的远端校验两边都用本地名、**反而通过**，
 * 到阶段 5 才报"找不到 payload/order.jar" → 发布失败，且失败点离病因很远。
 *
 * 修法是阶段 1 就把清单的 `relPath` 对齐到服务器端文件名（`alignArtifactItems`），
 * 于是上传即按配置名落盘。这个文件同时钉住三件事：
 *
 * 1. 纯函数边界（同名 / 异名 / 目录型 / 大小写 / 退化输入）；
 * 2. **发布真的能跑通**，且服务器上得到的是配置里的文件名；
 * 3. 两条口径连带项：台账逐文件清单 + 归档 manifest 都用服务器端文件名
 *    （否则归档"刚写完就被判 corrupt"，以及改文件名会让差异摘要伪造成
 *    "删一个、加一个"）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDeployService } from '@main/services/deploy'
import { createArchiveService } from '@main/services/archive'
import { statLocalArtifact } from '@main/services/local-artifact'
import { alignArtifactItems } from '@main/infra/deploy-plan'
import { describeNameMismatch, fileNameAlignmentOf } from '@main/infra/local-artifact'
import { computeRootHash } from '@main/infra/hash-core'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'
import { CLOCK, FakeRemote, makeCtx, makeLocalDir, makeLocalFile } from '../helpers/fake-remote'

const REMOTE = '/opt/svc/order.jar'

describe('B17 文件型目标的文件名对齐', () => {
  /* ================================================== 纯逻辑：判定不一致 */

  describe('fileNameAlignmentOf（只判"不一致"，不判能不能发）', () => {
    it('文件型目标、名字不同 → 给出两个名字', () => {
      const r = fileNameAlignmentOf({
        targetKind: 'file',
        localPath: 'D:\\build\\order-v2.jar',
        remotePath: REMOTE
      })
      expect(r).toEqual({ localName: 'order-v2.jar', remoteName: 'order.jar' })
    })

    it('名字相同 → null（界面不该多说一句话）', () => {
      expect(
        fileNameAlignmentOf({ targetKind: 'file', localPath: '/tmp/order.jar', remotePath: REMOTE })
      ).toBeNull()
    })

    it('大小写不同算**不一致**：Windows 本机不敏感，但服务器（Linux）敏感', () => {
      const r = fileNameAlignmentOf({
        targetKind: 'file',
        localPath: '/tmp/Order.jar',
        remotePath: REMOTE
      })
      expect(r?.localName).toBe('Order.jar')
    })

    it('目录型目标恒为 null（目标目录名与产物内部文件名无关）', () => {
      expect(
        fileNameAlignmentOf({
          targetKind: 'dir',
          localPath: '/tmp/dist-v2',
          remotePath: '/opt/web/dist'
        })
      ).toBeNull()
    })

    it('任一侧为空 → null（由"未配置本地产物"那一项负责，不在这里报重复的提示）', () => {
      expect(fileNameAlignmentOf({ targetKind: 'file', localPath: null, remotePath: REMOTE })).toBeNull()
      expect(fileNameAlignmentOf({ targetKind: 'file', localPath: '/tmp/a.jar', remotePath: '  ' })).toBeNull()
    })

    it('浏览器路径里的 / 与 Windows 的反斜杠都能取到文件名', () => {
      const a = fileNameAlignmentOf({
        targetKind: 'file',
        localPath: 'D:/build/order-v2.jar',
        remotePath: REMOTE
      })
      expect(a?.localName).toBe('order-v2.jar')
    })

    it('说明文案里必须同时出现两个名字（用户要能对上号）', () => {
      const text = describeNameMismatch({ localName: 'order-v2.jar', remoteName: 'order.jar' })
      expect(text).toContain('order-v2.jar')
      expect(text).toContain('order.jar')
    })
  })

  /* ================================================== 纯逻辑：清单对齐 */

  describe('alignArtifactItems', () => {
    const file = (relPath: string, hash: string) => [{ relPath, hash }]

    it('文件型异名：relPath 换成服务器端文件名，指纹按新 relPath 重算', () => {
      const r = alignArtifactItems({
        kind: 'file',
        remotePath: REMOTE,
        items: file('order-v2.jar', 'h1'),
        rootHash: computeRootHash(file('order-v2.jar', 'h1'))
      })
      expect(r.items.map((i) => i.relPath)).toEqual(['order.jar'])
      expect(r.renamedFrom).toBe('order-v2.jar')
      // 指纹必须与"按对齐后的清单重新算"完全一致 —— 台账与归档 manifest 靠它互相印证
      expect(r.rootHash).toBe(computeRootHash(file('order.jar', 'h1')))
    })

    it('文件型同名：原样返回（不改内容、指纹不变）', () => {
      const hash = computeRootHash(file('order.jar', 'h1'))
      const r = alignArtifactItems({
        kind: 'file',
        remotePath: REMOTE,
        items: file('order.jar', 'h1'),
        rootHash: hash
      })
      expect(r.items).toEqual(file('order.jar', 'h1'))
      expect(r.rootHash).toBe(hash)
      expect(r.renamedFrom).toBeNull()
    })

    it('目录型：原样返回（目标目录名不影响产物内部的相对路径）', () => {
      const items = [...file('index.html', 'a'), ...file('assets/a.js', 'b')]
      const hash = computeRootHash(items)
      const r = alignArtifactItems({
        kind: 'dir',
        remotePath: '/opt/web/dist-v9',
        items,
        rootHash: hash
      })
      expect(r.items).toEqual(items)
      expect(r.rootHash).toBe(hash)
      expect(r.renamedFrom).toBeNull()
      // 返回的是**新数组**：调用方改了它不该影响传进来的那份
      r.items[0].relPath = 'mutated'
      expect(items[0].relPath).toBe('index.html')
    })

    it('远端路径取不出文件名 → 显式报错（台账可能被手工改过，不静默拼出一个目录路径）', () => {
      expect(() =>
        alignArtifactItems({
          kind: 'file',
          remotePath: '/',
          items: file('a.jar', 'h1'),
          rootHash: 'r'
        })
      ).toThrowError(/没有文件名/)
    })

    it('文件型目标却有多条清单 → 报错（改名会造成重名条目，宁可不写）', () => {
      const items = [...file('a.jar', 'h1'), ...file('b.jar', 'h2')]
      expect(() =>
        alignArtifactItems({
          kind: 'file',
          remotePath: REMOTE,
          items,
          rootHash: computeRootHash(items)
        })
      ).toThrowError(/只对应一个文件/)
    })
  })

  /* ================================================== 详情页提示（本地通道） */

  describe('LocalArtifactInfo.nameMismatch', () => {
    const dirs: string[] = []
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    })

    it('文件型目标名字不一致 → 给出说明；一致 → null', async () => {
      const p = makeLocalFile('order-v2.jar', 'x')
      dirs.push(dirname(p))

      const bad = await statLocalArtifact({ localPath: p, targetKind: 'file', remotePath: REMOTE })
      expect(bad.nameMismatch).toContain('order.jar')
      expect(bad.exists).toBe(true)

      const good = await statLocalArtifact({
        localPath: p,
        targetKind: 'file',
        remotePath: '/opt/svc/order-v2.jar'
      })
      expect(good.nameMismatch).toBeNull()
    })

    it('类型都不符时不再提文件名（先把路径换成文件才是他要做的事）', async () => {
      const dir = makeLocalDir({ 'a.txt': '1' })
      dirs.push(dir)
      const info = await statLocalArtifact({
        localPath: dir,
        targetKind: 'file',
        remotePath: REMOTE
      })
      expect(info.kindMismatch).toBeTruthy()
      expect(info.nameMismatch).toBeNull()
    })

    it('目录型目标恒为 null', async () => {
      const dir = makeLocalDir({ 'a.txt': '1' })
      dirs.push(dir)
      const info = await statLocalArtifact({
        localPath: dir,
        targetKind: 'dir',
        remotePath: '/opt/web/dist'
      })
      expect(info.nameMismatch).toBeNull()
    })
  })

  /* ================================================== 发布主流程（真跑） */

  describe('发布主流程', () => {
    let t: TestDb
    let fake: FakeRemote
    let archive: ReturnType<typeof createArchiveService>
    let service: ReturnType<typeof createDeployService>
    let targetId: string
    const tempDirs: string[] = []

    beforeEach(() => {
      t = makeTestDb()
      fake = new FakeRemote()
      archive = createArchiveService({ repo: t.repo, now: () => CLOCK })
      service = createDeployService({
        repo: t.repo,
        archive,
        now: () => CLOCK,
        newReleaseId: (() => {
          let n = 0
          return () => `rel-${++n}`
        })(),
        transferRetryDelay: () => 1
      })
      targetId = seedBasic(t.repo).target.id
    })

    afterEach(() => {
      t.cleanup()
      for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
    })

    /** 把那条文件型目标的本地产物换成指定文件名/内容。 */
    function seedLocal(localName: string, content: string): string {
      const p = makeLocalFile(localName, content)
      tempDirs.push(dirname(p))
      t.repo.targets.update(targetId, { kind: 'file', localPath: p })
      return p
    }

    function releaseRow(releaseId: string) {
      return t.repo.releases.listByTarget(targetId, 10).find((r) => r.id === releaseId)!
    }

    it('本地产物 order-v2.jar → 服务器上落地为配置的 order.jar，台账与归档都是这个名字', async () => {
      seedLocal('order-v2.jar', 'jar-2')
      fake.putFile(REMOTE, 'jar-1') // 现网是旧版本

      const { ctx, text } = makeCtx()
      const out = await service.run({ targetId, ports: fake.ports(), ctx })

      expect(out.ok).toBe(true)
      expect(out.status).toBe('SUCCESS')

      // 1) 服务器上的文件名 = 配置里的名字，内容是本地那份
      expect(fake.text(REMOTE)).toBe('jar-2')
      // 2) 暂存与锁都清干净（说明换版那一步真的搬动了 payload/order.jar）
      expect(fake.ls('/opt/svc')).not.toContain('.sfvm-staging-rel-1')

      // 3) 台账的逐文件清单用**服务器端文件名**
      const items = t.repo.releaseItems.listByRelease(out.releaseId)
      expect(items.map((i) => i.relPath)).toEqual(['order.jar'])
      // 台账的聚合指纹与这份清单同口径，且版本号里带的就是它的前 7 位
      const row = releaseRow(out.releaseId)
      expect(row.rootHash).toBe(
        computeRootHash(items.map((i) => ({ relPath: i.relPath, hash: i.hash })))
      )
      expect(row.versionTag!.endsWith(row.rootHash!.slice(0, 7))).toBe(true)

      // 4) 旧版本进了归档，且**归档清单的文件名也是服务器端文件名**
      const archived = t.repo.archives.listByTarget(targetId)
      expect(archived).toHaveLength(1)
      expect(fake.text(`${archived[0].payloadPath}/order.jar`)).toBe('jar-1')

      // 5) 归档自校验必须过 —— 这一条是"归档 manifest 用错名字"的回归：
      //    清单写 order-v2.jar、磁盘上是 order.jar 的话，这里会立刻 corrupt
      const verified = await archive.verifyArchive({
        archiveId: archived[0].id,
        ports: fake.archivePorts()
      })
      expect(verified.status).toBe('valid')
      expect(verified.ok).toBe(true)

      // 6) 提醒
      expect(text()).toContain('order-v2.jar')
      expect(text()).toContain('将以 order.jar 上传')
    })

    it('首次发布 + 名字不一致：目标被创建，没有可归档的旧版本，也不留残留', async () => {
      seedLocal('order-v2.jar', 'first')

      const { ctx, text } = makeCtx()
      const out = await service.run({ targetId, ports: fake.ports(), ctx })

      expect(out.ok).toBe(true)
      expect(out.archivedVersionTag).toBeUndefined()
      expect(fake.text(REMOTE)).toBe('first')
      expect(text()).toContain('首次发布')
      expect(t.repo.archives.listByTarget(targetId)).toHaveLength(0)
    })

    it('改本地产物文件名后再次发布：差异摘要是"修改 1 个"，不是"删除 1 个 + 新增 1 个"', async () => {
      seedLocal('order.jar', 'jar-1')
      const first = await service.run({ targetId, ports: fake.ports(), ctx: makeCtx().ctx })
      expect(first.ok).toBe(true)

      // 第二次：换成构建产物常见的带版本号文件名，内容也变了
      seedLocal('order-v2.jar', 'jar-2')
      const preview = await service.preview({ targetId })

      expect(preview.diff.counts.modified).toBe(1)
      expect(preview.diff.counts.added).toBe(0)
      expect(preview.diff.counts.deleted).toBe(0)
      // 弹窗上的指纹要与发布后写进台账的那一份一致
      const second = await service.run({ targetId, ports: fake.ports(), ctx: makeCtx().ctx })
      expect(second.ok).toBe(true)
      expect(releaseRow(second.releaseId).rootHash).toBe(preview.artifact.rootHash)
      expect(fake.text(REMOTE)).toBe('jar-2')
    })

    it('前置校验：名字不一致只给 warn（不阻断发布），一致时没有这一项', async () => {
      seedLocal('order-v2.jar', 'jar-2')

      const report = await service.precheck({ targetId, ports: fake.ports() })
      const item = report.items.find((i) => i.key === 'file-name')
      expect(item?.level).toBe('warn')
      expect(item?.detail).toContain('order.jar')
      expect(report.items.some((i) => i.level === 'error')).toBe(false)
      expect(report.ok).toBe(true)

      // 名字一致时这一项整条都不出现（不给用户制造无用的提示）
      seedLocal('order.jar', 'jar-2')
      const clean = await service.precheck({ targetId, ports: fake.ports() })
      expect(clean.items.some((i) => i.key === 'file-name')).toBe(false)
    })
  })
})
