/**
 * T02.9 / T02.10 验收点：仓储层增删改查往返、级联与限制约束、
 * 排序正确、非终态筛选、JSON 设置的容错。
 */
import { describe, expect, it } from 'vitest'
import { makeTestDb, seedBasic } from '../helpers/db'
import { TERMINAL_RELEASE_STATUSES } from '@main/db/repositories'

describe('connections 仓储', () => {
  it('创建后可读回，字段往返一致', () => {
    const t = makeTestDb()
    try {
      const c = t.repo.connections.create({
        name: '生产-阿里云',
        host: '1.2.3.4',
        port: 2222,
        username: 'deploy',
        authType: 'privateKey',
        privateKeyPath: 'C:/keys/id_ed25519',
        autoConnect: true
      })
      expect(c.id).toBeTruthy()

      const got = t.repo.connections.get(c.id)!
      expect(got.name).toBe('生产-阿里云')
      expect(got.port).toBe(2222)
      expect(got.authType).toBe('privateKey')
      // 布尔以 INTEGER 存，读回应还原成 boolean
      expect(got.autoConnect).toBe(true)
      expect(got.keepaliveMs).toBe(15000) // 默认值
    } finally {
      t.cleanup()
    }
  })

  it('更新会刷新 updatedAt 且只改传入字段', () => {
    const t = makeTestDb()
    try {
      const c = t.repo.connections.create({
        name: 'a',
        host: 'h',
        port: 22,
        username: 'u',
        authType: 'password'
      })
      const before = t.repo.connections.get(c.id)!
      const after = t.repo.connections.update(c.id, { name: 'b' })!
      expect(after.name).toBe('b')
      expect(after.host).toBe('h') // 未传的字段保持不变
      expect(after.updatedAt >= before.updatedAt).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('listAutoConnect 只返回标记了自动登录的连接', () => {
    const t = makeTestDb()
    try {
      t.repo.connections.create({
        name: 'auto',
        host: 'h1',
        port: 22,
        username: 'u',
        authType: 'password',
        autoConnect: true
      })
      t.repo.connections.create({
        name: 'manual',
        host: 'h2',
        port: 22,
        username: 'u',
        authType: 'password',
        autoConnect: false
      })
      const list = t.repo.connections.listAutoConnect()
      expect(list.map((c) => c.name)).toEqual(['auto'])
    } finally {
      t.cleanup()
    }
  })

  it('countEnvironments 正确统计引用数（删除前校验用）', () => {
    const t = makeTestDb()
    try {
      const { conn } = seedBasic(t.repo)
      expect(t.repo.connections.countEnvironments(conn.id)).toBe(1)
    } finally {
      t.cleanup()
    }
  })
})

describe('known_hosts 仓储（TOFU）', () => {
  it('首次记录与再次更新同一 (host,port,keyType)', () => {
    const t = makeTestDb()
    try {
      t.repo.knownHosts.trust('10.0.0.1', 22, 'ssh-ed25519', 'SHA256:AAA')
      const first = t.repo.knownHosts.find('10.0.0.1', 22, 'ssh-ed25519')!
      expect(first.fingerprint).toBe('SHA256:AAA')

      // 同键更新而不是新增
      t.repo.knownHosts.trust('10.0.0.1', 22, 'ssh-ed25519', 'SHA256:BBB')
      expect(t.repo.knownHosts.list().length).toBe(1)
      expect(t.repo.knownHosts.find('10.0.0.1', 22, 'ssh-ed25519')!.fingerprint).toBe('SHA256:BBB')
    } finally {
      t.cleanup()
    }
  })

  it('同主机的不同算法各自保留一条', () => {
    const t = makeTestDb()
    try {
      t.repo.knownHosts.trust('h', 22, 'ssh-rsa', 'SHA256:R')
      t.repo.knownHosts.trust('h', 22, 'ssh-ed25519', 'SHA256:E')
      expect(t.repo.knownHosts.list().length).toBe(2)
    } finally {
      t.cleanup()
    }
  })
})

describe('environments / targets 约束', () => {
  it('环境名唯一', () => {
    const t = makeTestDb()
    try {
      const { conn } = seedBasic(t.repo)
      t.repo.environments.create({ name: '重复名', envType: 'test', connectionId: conn.id })
      expect(() =>
        t.repo.environments.create({ name: '重复名', envType: 'test', connectionId: conn.id })
      ).toThrow(/UNIQUE/i)
    } finally {
      t.cleanup()
    }
  })

  it('被环境引用的连接不能删除（RESTRICT）', () => {
    const t = makeTestDb()
    try {
      const { conn } = seedBasic(t.repo)
      expect(() => t.repo.connections.remove(conn.id)).toThrow(/FOREIGN KEY/i)
    } finally {
      t.cleanup()
    }
  })

  it('删除环境会级联删除目标（CASCADE）', () => {
    const t = makeTestDb()
    try {
      const { env, target } = seedBasic(t.repo)
      expect(t.repo.targets.get(target.id)).toBeTruthy()

      t.repo.environments.remove(env.id)

      expect(t.repo.targets.get(target.id)).toBeUndefined()
    } finally {
      t.cleanup()
    }
  })

  it('同环境内 remote_path 唯一，跨环境可重复', () => {
    const t = makeTestDb()
    try {
      const { conn, env } = seedBasic(t.repo, { remotePath: '/opt/a' })
      expect(() =>
        t.repo.targets.create({
          environmentId: env.id,
          name: 'dup',
          kind: 'dir',
          remotePath: '/opt/a'
        })
      ).toThrow(/UNIQUE/i)

      const env2 = t.repo.environments.create({
        name: '环境2',
        envType: 'prod',
        connectionId: conn.id
      })
      expect(() =>
        t.repo.targets.create({
          environmentId: env2.id,
          name: 'ok',
          kind: 'dir',
          remotePath: '/opt/a'
        })
      ).not.toThrow()
    } finally {
      t.cleanup()
    }
  })
})

describe('releases / release_items', () => {
  it('按目标查询按开始时间倒序', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const a = t.repo.releases.create({
        targetId: target.id,
        action: 'deploy',
        versionTag: 'v1',
        status: 'SUCCESS'
      })
      const b = t.repo.releases.create({
        targetId: target.id,
        action: 'deploy',
        versionTag: 'v2',
        status: 'SUCCESS'
      })
      // 手工把时间拉开，避免同毫秒导致排序不确定
      t.db.raw.prepare(`UPDATE releases SET started_at='2025-01-01T00:00:00Z' WHERE id=?`).run(a.id)
      t.db.raw.prepare(`UPDATE releases SET started_at='2025-06-01T00:00:00Z' WHERE id=?`).run(b.id)

      const list = t.repo.releases.listByTarget(target.id)
      expect(list.map((r) => r.versionTag)).toEqual(['v2', 'v1'])
    } finally {
      t.cleanup()
    }
  })

  it('finish 写入终态与结束时间', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const r = t.repo.releases.create({
        targetId: target.id,
        action: 'deploy',
        versionTag: 'v1',
        status: 'PENDING'
      })
      const done = t.repo.releases.finish(r.id, 'FAILED', '上传中断')!
      expect(done.status).toBe('FAILED')
      expect(done.errorMessage).toBe('上传中断')
      expect(done.finishedAt).toBeTruthy()
    } finally {
      t.cleanup()
    }
  })

  it('listUnfinished 只返回非终态记录（B14 残留扫描）', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      t.repo.releases.create({
        targetId: target.id,
        action: 'deploy',
        versionTag: 'done',
        status: 'SUCCESS'
      })
      t.repo.releases.create({
        targetId: target.id,
        action: 'deploy',
        versionTag: 'failed',
        status: 'FAILED'
      })
      t.repo.releases.create({
        targetId: target.id,
        action: 'deploy',
        versionTag: 'stuck',
        status: 'UPLOADING'
      })

      const unfinished = t.repo.releases.listUnfinished()
      expect(unfinished.map((r) => r.versionTag)).toEqual(['stuck'])
      expect(TERMINAL_RELEASE_STATUSES).toContain('SUCCESS')
    } finally {
      t.cleanup()
    }
  })

  it('release_items 批量写入并按 relPath 排序读回', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const r = t.repo.releases.create({
        targetId: target.id,
        action: 'deploy',
        versionTag: 'v1',
        status: 'SUCCESS'
      })
      const n = t.repo.releaseItems.addMany([
        { releaseId: r.id, relPath: 'b/x.js', hash: 'h2', size: 2 },
        { releaseId: r.id, relPath: 'a/y.js', hash: 'h1', size: 1 }
      ])
      expect(n).toBe(2)
      const items = t.repo.releaseItems.listByRelease(r.id)
      expect(items.map((i) => i.relPath)).toEqual(['a/y.js', 'b/x.js'])
    } finally {
      t.cleanup()
    }
  })

  it('同一 release 内 relPath 唯一', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const r = t.repo.releases.create({
        targetId: target.id,
        action: 'deploy',
        versionTag: 'v1',
        status: 'SUCCESS'
      })
      t.repo.releaseItems.addMany([{ releaseId: r.id, relPath: 'a.js', hash: 'h', size: 1 }])
      expect(() =>
        t.repo.releaseItems.addMany([{ releaseId: r.id, relPath: 'a.js', hash: 'h2', size: 2 }])
      ).toThrow(/UNIQUE/i)
    } finally {
      t.cleanup()
    }
  })

  it('删除 release 级联删除其 items', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const r = t.repo.releases.create({
        targetId: target.id,
        action: 'deploy',
        versionTag: 'v1',
        status: 'SUCCESS'
      })
      t.repo.releaseItems.addMany([{ releaseId: r.id, relPath: 'a.js', hash: 'h', size: 1 }])

      t.repo.releases.remove(r.id)

      expect(t.repo.releaseItems.listByRelease(r.id)).toEqual([])
    } finally {
      t.cleanup()
    }
  })
})

describe('archives', () => {
  it('同一目标内 versionTag 唯一，跨目标可重复', () => {
    const t = makeTestDb()
    try {
      const { env, target } = seedBasic(t.repo)
      const base = {
        storagePath: '/opt/svc/order.jar.versions/v1',
        payloadPath: '/opt/svc/order.jar.versions/v1/payload',
        kind: 'file',
        rootHash: 'h',
        totalBytes: 1,
        fileCount: 1
      }
      t.repo.archives.create({ ...base, targetId: target.id, versionTag: 'v1' })
      expect(() =>
        t.repo.archives.create({ ...base, targetId: target.id, versionTag: 'v1' })
      ).toThrow(/UNIQUE/i)

      const t2 = t.repo.targets.create({
        environmentId: env.id,
        name: '网关',
        kind: 'dir',
        remotePath: '/opt/gw'
      })
      expect(() =>
        t.repo.archives.create({ ...base, targetId: t2.id, versionTag: 'v1' })
      ).not.toThrow()
    } finally {
      t.cleanup()
    }
  })

  it('按归档时间倒序返回，且能按 tag 精确查找', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const base = {
        targetId: target.id,
        storagePath: '/p',
        payloadPath: '/p/payload',
        kind: 'file',
        rootHash: 'h',
        totalBytes: 1,
        fileCount: 1
      }
      const old = t.repo.archives.create({ ...base, versionTag: 'old' })
      const recent = t.repo.archives.create({ ...base, versionTag: 'recent' })
      t.db.raw
        .prepare(`UPDATE archives SET archived_at='2025-01-01T00:00:00Z' WHERE id=?`)
        .run(old.id)
      t.db.raw
        .prepare(`UPDATE archives SET archived_at='2025-06-01T00:00:00Z' WHERE id=?`)
        .run(recent.id)

      expect(t.repo.archives.listByTarget(target.id).map((a) => a.versionTag)).toEqual([
        'recent',
        'old'
      ])
      expect(t.repo.archives.findByTag(target.id, 'old')!.id).toBe(old.id)
      expect(t.repo.archives.get(recent.id)!.status).toBe('valid') // 默认值
    } finally {
      t.cleanup()
    }
  })

  it('removeMany 批量删除', () => {
    const t = makeTestDb()
    try {
      const { target } = seedBasic(t.repo)
      const base = {
        targetId: target.id,
        storagePath: '/p',
        payloadPath: '/p/payload',
        kind: 'file',
        rootHash: 'h',
        totalBytes: 1,
        fileCount: 1
      }
      const a = t.repo.archives.create({ ...base, versionTag: 'a' })
      const b = t.repo.archives.create({ ...base, versionTag: 'b' })
      t.repo.archives.removeMany([a.id, b.id])
      expect(t.repo.archives.listByTarget(target.id)).toEqual([])
    } finally {
      t.cleanup()
    }
  })
})

describe('app_settings / audit_logs', () => {
  it('设置读写与覆盖', () => {
    const t = makeTestDb()
    try {
      t.repo.settings.set('downloadDir', 'D:/dl')
      expect(t.repo.settings.getValue('downloadDir')).toBe('D:/dl')
      t.repo.settings.set('downloadDir', 'D:/dl2')
      expect(t.repo.settings.getValue('downloadDir')).toBe('D:/dl2')
      expect(t.repo.settings.list().length).toBe(1)
    } finally {
      t.cleanup()
    }
  })

  it('JSON 设置：缺失返回默认值，内容损坏也不抛错', () => {
    const t = makeTestDb()
    try {
      expect(t.repo.settings.getJson('missing', { a: 1 })).toEqual({ a: 1 })

      t.repo.settings.setJson('cfg', { mode: 'count', value: 10 })
      expect(t.repo.settings.getJson('cfg', {})).toEqual({ mode: 'count', value: 10 })

      t.repo.settings.set('broken', '{不是合法 JSON')
      expect(t.repo.settings.getJson('broken', { safe: true })).toEqual({ safe: true })
    } finally {
      t.cleanup()
    }
  })

  it('审计写入与按 ref 查询', () => {
    const t = makeTestDb()
    try {
      t.repo.audit.write({ level: 'info', scope: 'app', message: '启动' })
      t.repo.audit.write({
        level: 'warn',
        scope: 'deploy',
        refId: 'r1',
        message: '校验失败',
        detail: '{}'
      })

      expect(t.repo.audit.listRecent().length).toBe(2)
      const byRef = t.repo.audit.listByRef('r1')
      expect(byRef.length).toBe(1)
      expect(byRef[0].scope).toBe('deploy')
    } finally {
      t.cleanup()
    }
  })

  it('audit_logs 自增主键可以留空', () => {
    const t = makeTestDb()
    try {
      t.repo.audit.write({ level: 'error', scope: 'app', message: 'x' })
      const rows = t.repo.audit.listRecent()
      expect(typeof rows[0].id).toBe('number')
    } finally {
      t.cleanup()
    }
  })
})
