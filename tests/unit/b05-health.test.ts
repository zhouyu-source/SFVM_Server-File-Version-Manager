/**
 * T05.7 验收点：体检返回五项结构化结果，且各种失败组合都有明确结论与建议。
 *
 * 这里全部用假事实（HealthProbe）驱动纯函数，不需要真连服务器 ——
 * 真机链路在 B05 结束时用真实服务器验证一次。
 */
import { describe, expect, it } from 'vitest'
import {
  buildHealthReport,
  summarizeHealth,
  assertHealthy,
  type HealthProbe
} from '@main/services/target-health'
import type { ConnectionCapability } from '@main/infra/capability'

const cap = (over: Partial<ConnectionCapability> = {}): ConnectionCapability => ({
  hasSha256sum: true,
  hasShasum: true,
  hasDf: true,
  platform: 'linux',
  homeDir: '/root',
  ...over
})

const base: HealthProbe = {
  connectionOk: true,
  capability: cap(),
  targetExists: true,
  targetIsDirectory: false,
  parentWritable: true,
  archiveDirExists: false,
  existingVersions: 0
}

const input = { remotePath: '/opt/svc/order.jar', kind: 'file' as const }

describe('体检：五项检查齐全', () => {
  it('全部正常时返回 5 项、ok=true', () => {
    const r = buildHealthReport(input, base)
    expect(r.ok).toBe(true)
    expect(r.checks.map((c) => c.key)).toEqual([
      'connection',
      'path',
      'parent-writable',
      'archive-dir',
      'hash-tool'
    ])
    expect(r.checks.every((c) => c.level === 'ok')).toBe(true)
  })
})

describe('体检：连接不可用', () => {
  it('只返回连接这一项并给出建议（不刷一堆误导性失败项）', () => {
    const r = buildHealthReport(input, {
      ...base,
      connectionOk: false,
      connectionError: '认证失败',
      capability: undefined
    })
    expect(r.ok).toBe(false)
    expect(r.checks).toHaveLength(1)
    expect(r.checks[0].key).toBe('connection')
    expect(r.checks[0].level).toBe('error')
    expect(r.checks[0].detail).toContain('认证失败')
    expect(r.checks[0].suggestion).toBeTruthy()
  })
})

describe('体检：目标路径', () => {
  it('不存在时（目录型）给出 warn 并要求用户选择', () => {
    const r = buildHealthReport(
      { remotePath: '/opt/app/dist', kind: 'dir' },
      { ...base, targetExists: false, targetIsDirectory: undefined }
    )
    expect(r.needCreateChoice).toBe(true)
    const path = r.checks.find((c) => c.key === 'path')!
    expect(path.level).toBe('warn')
    expect(path.data?.canCreate).toBe(true)
    // warn 不阻塞保存
    expect(r.ok).toBe(true)
  })

  it('不存在时（文件型）不提供"创建空目录"', () => {
    const r = buildHealthReport(input, {
      ...base,
      targetExists: false,
      targetIsDirectory: undefined
    })
    expect(r.needCreateChoice).toBe(false)
    const path = r.checks.find((c) => c.key === 'path')!
    expect(path.suggestion).toContain('首次发布')
  })

  it('存在但类型不符时报错', () => {
    const r = buildHealthReport(input, { ...base, targetIsDirectory: true })
    expect(r.ok).toBe(false)
    const path = r.checks.find((c) => c.key === 'path')!
    expect(path.level).toBe('error')
    expect(path.detail).toContain('类型不符')
  })
})

describe('体检：父目录不可写', () => {
  it('报错并说明需要什么权限', () => {
    const r = buildHealthReport(input, { ...base, parentWritable: false })
    expect(r.ok).toBe(false)
    const c = r.checks.find((x) => x.key === 'parent-writable')!
    expect(c.level).toBe('error')
    expect(c.detail).toContain('不可写')
    expect(c.suggestion).toContain('写权限')
  })
})

describe('体检：归档目录', () => {
  it('已存在且有既存版本时提示可对账导入', () => {
    const r = buildHealthReport(input, { ...base, archiveDirExists: true, existingVersions: 7 })
    const c = r.checks.find((x) => x.key === 'archive-dir')!
    expect(c.detail).toContain('7')
    expect(c.suggestion).toContain('对账')
    expect(r.existingVersions).toBe(7)
  })

  it('不存在时说明会自动创建，且给出推导出的路径', () => {
    const r = buildHealthReport(input, base)
    const c = r.checks.find((x) => x.key === 'archive-dir')!
    expect(c.detail).toContain('/opt/svc/order.jar.versions')
  })
})

describe('体检：哈希能力', () => {
  it('只有 sha256sum 时报 ok 并说明用快速校验', () => {
    const r = buildHealthReport(input, {
      ...base,
      capability: cap({ hasSha256sum: true, hasShasum: false })
    })
    const c = r.checks.find((x) => x.key === 'hash-tool')!
    expect(c.level).toBe('ok')
    expect(c.detail).toContain('sha256sum')
  })

  it('两者都没有时报 warn 并说明会降级（不是 error，不阻塞）', () => {
    const r = buildHealthReport(input, {
      ...base,
      capability: cap({ hasSha256sum: false, hasShasum: false })
    })
    const c = r.checks.find((x) => x.key === 'hash-tool')!
    expect(c.level).toBe('warn')
    expect(c.suggestion).toContain('降级')
    expect(r.ok).toBe(true)
  })
})

describe('summarizeHealth / assertHealthy', () => {
  it('全部通过时给出一句话', () => {
    expect(summarizeHealth(buildHealthReport(input, base))).toBe('体检全部通过')
  })

  it('有问题时汇总非 ok 项', () => {
    const s = summarizeHealth(buildHealthReport(input, { ...base, parentWritable: false }))
    expect(s).toContain('父目录可写')
  })

  it('assertHealthy 只在有 error 时抛错', () => {
    expect(() => assertHealthy(buildHealthReport(input, base))).not.toThrow()
    expect(() =>
      assertHealthy(buildHealthReport(input, { ...base, parentWritable: false }))
    ).toThrow()
    // 仅 warn 不抛
    expect(() =>
      assertHealthy(
        buildHealthReport(input, { ...base, targetExists: false, targetIsDirectory: undefined })
      )
    ).not.toThrow()
  })
})
