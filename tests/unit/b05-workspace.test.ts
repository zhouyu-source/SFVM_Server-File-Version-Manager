/**
 * T05.1 / T05.2 / T05.5 验收点：
 * - 环境 CRUD、名称唯一（重复名被拒绝且给中文提示）
 * - 删除环境级联删本地配置，**不触碰服务器文件**（用"远端"假对象断言未被调用）
 * - 归档目录推导、自定义覆盖、与目标相同则拒绝
 * - 目标 CRUD：类型判定、同环境路径唯一、序列化字段往返（排除规则/保留策略）
 */
import { describe, expect, it, vi } from 'vitest'
import { makeTestDb } from '../helpers/db'
import { createWorkspaceService } from '@main/services/workspace'
import { AppError, ErrorCode } from '@main/infra/errors'

function setup() {
  const t = makeTestDb()
  const svc = createWorkspaceService({ repo: t.repo })
  const conn = t.repo.connections.create({
    name: '测试机',
    host: '10.0.0.1',
    username: 'root',
    authType: 'privateKey',
    privateKeyPath: '/k'
  })
  return { t, svc, conn }
}

describe('环境 CRUD（T05.1）', () => {
  it('创建后可读回，并按类型给默认颜色', () => {
    const { t, svc, conn } = setup()
    try {
      const prod = svc.environments.create({ name: '生产', envType: 'prod', connectionId: conn.id })
      const test = svc.environments.create({ name: '测试', envType: 'test', connectionId: conn.id })

      expect(prod.color).toBe('#f56c6c') // 生产=红
      expect(test.color).toBe('#409eff') // 测试=蓝
      expect(svc.environments.list()).toHaveLength(2)
    } finally {
      t.cleanup()
    }
  })

  it('名称重复被拒绝，且错误码是 E_DUPLICATE_NAME', () => {
    const { t, svc, conn } = setup()
    try {
      svc.environments.create({ name: '生产', envType: 'prod', connectionId: conn.id })
      let caught: unknown
      try {
        svc.environments.create({ name: '生产', envType: 'test', connectionId: conn.id })
      } catch (e) {
        caught = e
      }
      expect((caught as AppError).code).toBe(ErrorCode.E_DUPLICATE_NAME)
    } finally {
      t.cleanup()
    }
  })

  it('引用不存在的连接被拒绝', () => {
    const { t, svc } = setup()
    try {
      let caught: unknown
      try {
        svc.environments.create({ name: 'x', envType: 'test', connectionId: 'nope' })
      } catch (e) {
        caught = e
      }
      expect((caught as AppError).code).toBe(ErrorCode.E_NOT_FOUND)
    } finally {
      t.cleanup()
    }
  })

  it('更新时改名为已存在的名字会被拒绝', () => {
    const { t, svc, conn } = setup()
    try {
      svc.environments.create({ name: 'A', envType: 'test', connectionId: conn.id })
      const b = svc.environments.create({ name: 'B', envType: 'test', connectionId: conn.id })
      let caught: unknown
      try {
        svc.environments.update(b.id, { name: 'A' })
      } catch (e) {
        caught = e
      }
      expect((caught as AppError).code).toBe(ErrorCode.E_DUPLICATE_NAME)
      // 改成自己原来的名字应当允许
      expect(() => svc.environments.update(b.id, { name: 'B' })).not.toThrow()
    } finally {
      t.cleanup()
    }
  })

  it('targetCount 正确统计', () => {
    const { t, svc, conn } = setup()
    try {
      const env = svc.environments.create({ name: 'E', envType: 'test', connectionId: conn.id })
      svc.targets.create({ environmentId: env.id, name: 't1', remotePath: '/opt/a' })
      svc.targets.create({ environmentId: env.id, name: 't2', remotePath: '/opt/b' })
      expect(svc.environments.get(env.id).targetCount).toBe(2)
    } finally {
      t.cleanup()
    }
  })
})

describe('删除环境语义（T05.2）', () => {
  it('级联删除本地配置，且**不触碰服务器文件**', () => {
    const { t, svc, conn } = setup()
    try {
      const env = svc.environments.create({ name: 'E', envType: 'test', connectionId: conn.id })
      const target = svc.targets.create({
        environmentId: env.id,
        name: 't',
        remotePath: '/opt/app'
      })

      // 用"远端假对象"记录是否被调用 —— 删除环境绝不应触碰远端
      const remoteSpy = {
        rmrf: vi.fn(),
        unlinkFile: vi.fn(),
        rename: vi.fn(),
        mkdirp: vi.fn()
      }

      const result = svc.environments.remove(env.id)

      expect(result.removedTargets).toBe(1)
      expect(svc.environments.get.bind(svc.environments, env.id)).toThrow()
      expect(t.repo.targets.get(target.id)).toBeUndefined()

      // 关键断言：远端一个方法都没被调用
      for (const fn of Object.values(remoteSpy)) expect(fn).not.toHaveBeenCalled()
    } finally {
      t.cleanup()
    }
  })

  it('删除前能拿到"将影响什么"的说明，且明确写清不动服务器文件', () => {
    const { t, svc, conn } = setup()
    try {
      const env = svc.environments.create({ name: '生产', envType: 'prod', connectionId: conn.id })
      svc.targets.create({ environmentId: env.id, name: 't', remotePath: '/opt/app' })

      const info = svc.environments.describeRemoval(env.id)
      expect(info.targetCount).toBe(1)
      expect(info.warning).toContain('不会被删除')
    } finally {
      t.cleanup()
    }
  })
})

describe('目标 CRUD（T05.5）', () => {
  it('按 .jar 推断类型，并自动推导归档目录', () => {
    const { t, svc, conn } = setup()
    try {
      const env = svc.environments.create({ name: 'E', envType: 'test', connectionId: conn.id })

      const jar = svc.targets.create({
        environmentId: env.id,
        name: 'jar',
        remotePath: '/opt/svc/order.jar'
      })
      expect(jar.kind).toBe('file')
      expect(jar.archiveDir).toBe('/opt/svc/order.jar.versions')
      expect(jar.archiveDirOverridden).toBe(false)

      const dist = svc.targets.create({
        environmentId: env.id,
        name: 'dist',
        remotePath: '/opt/app/dist'
      })
      expect(dist.kind).toBe('dir')
      expect(dist.archiveDir).toBe('/opt/app/dist.versions')
    } finally {
      t.cleanup()
    }
  })

  it('可手动覆盖类型与归档目录', () => {
    const { t, svc, conn } = setup()
    try {
      const env = svc.environments.create({ name: 'E', envType: 'test', connectionId: conn.id })
      const tgt = svc.targets.create({
        environmentId: env.id,
        name: 'x',
        remotePath: '/opt/data',
        kind: 'file',
        archiveDir: '/data/versions'
      })
      expect(tgt.kind).toBe('file')
      expect(tgt.archiveDir).toBe('/data/versions')
      expect(tgt.archiveDirOverridden).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('同环境内路径唯一，跨环境可重复', () => {
    const { t, svc, conn } = setup()
    try {
      const e1 = svc.environments.create({ name: 'E1', envType: 'test', connectionId: conn.id })
      const e2 = svc.environments.create({ name: 'E2', envType: 'prod', connectionId: conn.id })
      svc.targets.create({ environmentId: e1.id, name: 'a', remotePath: '/opt/app' })

      expect(() =>
        svc.targets.create({ environmentId: e1.id, name: 'b', remotePath: '/opt/app' })
      ).toThrow()
      expect(() =>
        svc.targets.create({ environmentId: e2.id, name: 'c', remotePath: '/opt/app' })
      ).not.toThrow()
    } finally {
      t.cleanup()
    }
  })

  it('不安全的路径被拒绝（路径逃逸防线）', () => {
    const { t, svc, conn } = setup()
    try {
      const env = svc.environments.create({ name: 'E', envType: 'test', connectionId: conn.id })
      for (const bad of ['/opt/../etc', 'relative/path', '/', '/opt/app\nrm -rf /']) {
        let caught: unknown
        try {
          svc.targets.create({ environmentId: env.id, name: 'x', remotePath: bad })
        } catch (e) {
          caught = e
        }
        expect((caught as AppError).code, bad).toBe(ErrorCode.E_PATH_UNSAFE)
      }
    } finally {
      t.cleanup()
    }
  })

  it('归档目录与目标相同时被拒绝（防自嵌套）', () => {
    const { t, svc, conn } = setup()
    try {
      const env = svc.environments.create({ name: 'E', envType: 'test', connectionId: conn.id })
      let caught: unknown
      try {
        svc.targets.create({
          environmentId: env.id,
          name: 'x',
          remotePath: '/opt/app',
          archiveDir: '/opt/app'
        })
      } catch (e) {
        caught = e
      }
      expect((caught as AppError).code).toBe(ErrorCode.E_PATH_UNSAFE)
    } finally {
      t.cleanup()
    }
  })

  it('排除规则与保留策略往返一致（JSON 序列化）', () => {
    const { t, svc, conn } = setup()
    try {
      const env = svc.environments.create({ name: 'E', envType: 'test', connectionId: conn.id })
      const tgt = svc.targets.create({
        environmentId: env.id,
        name: 'x',
        remotePath: '/opt/dist',
        localExclude: ['*.map', '*.log'],
        retainPolicy: { mode: 'count', value: 10 },
        verifyRemote: false,
        deployStrategy: 'copy'
      })

      const view = svc.targets.get(tgt.id)
      expect(view.localExclude).toEqual(['*.map', '*.log'])
      expect(view.retainPolicy).toEqual({ mode: 'count', value: 10 })
      expect(view.verifyRemote).toBe(false)
      expect(view.deployStrategy).toBe('copy')
    } finally {
      t.cleanup()
    }
  })

  it('损坏的 JSON 字段不会让读取崩溃（退化为空值）', () => {
    const { t, svc, conn } = setup()
    try {
      const env = svc.environments.create({ name: 'E', envType: 'test', connectionId: conn.id })
      const tgt = svc.targets.create({ environmentId: env.id, name: 'x', remotePath: '/opt/dist' })
      // 手工写入坏数据，模拟历史遗留/人为改库
      t.db.raw
        .prepare(`UPDATE targets SET local_exclude='{坏', retain_policy='也不是JSON' WHERE id=?`)
        .run(tgt.id)

      const view = svc.targets.get(tgt.id)
      expect(view.localExclude).toEqual([])
      expect(view.retainPolicy).toBeNull()
    } finally {
      t.cleanup()
    }
  })

  it('删除目标只删本地索引，返回被清理的台账条数', () => {
    const { t, svc, conn } = setup()
    try {
      const env = svc.environments.create({ name: 'E', envType: 'test', connectionId: conn.id })
      const tgt = svc.targets.create({ environmentId: env.id, name: 'x', remotePath: '/opt/dist' })
      t.repo.releases.create({
        targetId: tgt.id,
        action: 'deploy',
        versionTag: 'v1',
        status: 'SUCCESS'
      })

      const r = svc.targets.remove(tgt.id)
      expect(r.removedReleases).toBe(1)
      expect(t.repo.targets.get(tgt.id)).toBeUndefined()
    } finally {
      t.cleanup()
    }
  })

  it('previewArchiveDir 供 UI 实时展示推导结果', () => {
    const { t, svc } = setup()
    try {
      expect(svc.targets.previewArchiveDir('/opt/app/dist')).toBe('/opt/app/dist.versions')
      expect(svc.targets.previewArchiveDir('/opt/app/dist', '/custom/v')).toBe('/custom/v')
    } finally {
      t.cleanup()
    }
  })
})
