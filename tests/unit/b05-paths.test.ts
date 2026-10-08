/**
 * T05.3 / T05.4 验收点：路径安全校验覆盖方案书 §10.4 的全部用例；
 * 归档目录推导覆盖四种情形。
 */
import { describe, expect, it } from 'vitest'
import {
  assertSafeRemotePath,
  normalizeRemotePath,
  requireSafeRemotePath,
  isPathUnder,
  UnsafePathError,
  MAX_REMOTE_PATH_LENGTH
} from '@main/infra/remote-path'
import {
  resolveArchiveDir,
  inferTargetKind,
  parentDirOf,
  posixBasename
} from '@main/infra/archive-dir'

describe('assertSafeRemotePath（T05.3）', () => {
  it('接受常规绝对路径并规范化', () => {
    const r = assertSafeRemotePath('/opt/app/dist')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.normalized).toBe('/opt/app/dist')
  })

  it('折叠重复斜杠、去掉末尾斜杠', () => {
    expect(normalizeRemotePath('/opt//app///dist/')).toBe('/opt/app/dist')
    expect(normalizeRemotePath('/opt/app/')).toBe('/opt/app')
  })

  it('保留中文与点号等合法字符（方案书 §11 最后一行）', () => {
    const r = assertSafeRemotePath('/opt/服务/订单服务-v1.2.3/dist')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.normalized).toBe('/opt/服务/订单服务-v1.2.3/dist')
  })

  it('拒绝相对路径', () => {
    const r = assertSafeRemotePath('opt/app')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-absolute')
  })

  it('拒绝根目录', () => {
    for (const p of ['/', '///', '/./']) {
      const r = assertSafeRemotePath(p)
      expect(r.ok, p).toBe(false)
    }
  })

  it('拒绝任何包含 .. 的路径（含变形）', () => {
    for (const p of [
      '/opt/../etc',
      '/../etc/passwd',
      '/opt/app/..',
      '/opt/app/../../etc',
      '/opt/..hidden' // 这个其实合法（..hidden 不是 .. 段）
    ]) {
      const r = assertSafeRemotePath(p)
      if (p === '/opt/..hidden') {
        expect(r.ok, p).toBe(true) // 只有恰好等于 .. 的段才拦
      } else {
        expect(r.ok, p).toBe(false)
        if (!r.ok) expect(r.reason).toBe('has-parent-segment')
      }
    }
  })

  it('拒绝空字符 NUL', () => {
    const r = assertSafeRemotePath('/opt/app\u0000dist')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('has-null')
  })

  it('拒绝换行与回车（命令注入的经典载体）', () => {
    for (const p of ['/opt/app\nrm -rf /', '/opt/app\rX', '/opt/a\nb']) {
      const r = assertSafeRemotePath(p)
      expect(r.ok, JSON.stringify(p)).toBe(false)
      if (!r.ok) expect(r.reason).toBe('has-newline')
    }
  })

  it('拒绝其他控制字符', () => {
    const r = assertSafeRemotePath('/opt/app\u0007dist')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('has-control-char')
  })

  it('拒绝超长路径（> 4096）', () => {
    const long = '/' + 'a'.repeat(MAX_REMOTE_PATH_LENGTH)
    const r = assertSafeRemotePath(long)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('too-long')
  })

  it('拒绝空值与非字符串', () => {
    for (const v of ['', null, undefined, 123, {}, []]) {
      const r = assertSafeRemotePath(v)
      expect(r.ok, String(v)).toBe(false)
    }
  })

  it('拒绝 . 段', () => {
    const r = assertSafeRemotePath('/opt/./app')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('has-dot-segment')
  })

  it('失败原因都有中文文案', () => {
    const cases = ['', 'rel', '/', '/a/../b', '/a\u0000b', '/a\nb', '/' + 'x'.repeat(5000)]
    for (const c of cases) {
      const r = assertSafeRemotePath(c)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(/[\u4e00-\u9fa5]/.test(r.message), c).toBe(true)
      }
    }
  })
})

describe('requireSafeRemotePath', () => {
  it('合法时返回规范化路径', () => {
    expect(requireSafeRemotePath('/opt//app/')).toBe('/opt/app')
  })

  it('非法时抛 UnsafePathError 并带原因', () => {
    try {
      requireSafeRemotePath('/opt/../etc')
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(UnsafePathError)
      expect((e as UnsafePathError).reason).toBe('has-parent-segment')
    }
  })
})

describe('isPathUnder（不越界检查）', () => {
  it('子路径判为真', () => {
    expect(isPathUnder('/opt/app/dist', '/opt/app')).toBe(true)
    expect(isPathUnder('/opt/app', '/opt/app')).toBe(true)
  })

  it('前缀相近但不同目录判为假（避免 /opt/app2 被当成 /opt/app 的子路径）', () => {
    expect(isPathUnder('/opt/app2', '/opt/app')).toBe(false)
    expect(isPathUnder('/opt/application', '/opt/app')).toBe(false)
  })

  it('上级目录判为假', () => {
    expect(isPathUnder('/opt', '/opt/app')).toBe(false)
  })
})

describe('resolveArchiveDir（T05.4）', () => {
  it('目录型目标：同父目录 + <basename>.versions', () => {
    expect(resolveArchiveDir({ remotePath: '/opt/app/dist' })).toBe('/opt/app/dist.versions')
  })

  it('文件型目标（jar）：/opt/svc/order.jar.versions', () => {
    expect(resolveArchiveDir({ remotePath: '/opt/svc/order.jar' })).toBe(
      '/opt/svc/order.jar.versions'
    )
  })

  it('自定义 archiveDir 优先', () => {
    expect(
      resolveArchiveDir({ remotePath: '/opt/app/dist', archiveDir: '/data/versions/dist' })
    ).toBe('/data/versions/dist')
  })

  it('传入的路径带末尾斜杠也能正确推导', () => {
    expect(resolveArchiveDir({ remotePath: '/opt/app/dist/' })).toBe('/opt/app/dist.versions')
  })

  it('位于根目录下的目标不会产生 // 前缀', () => {
    expect(resolveArchiveDir({ remotePath: '/dist' })).toBe('/dist.versions')
  })

  it('保留中文目录名', () => {
    expect(resolveArchiveDir({ remotePath: '/opt/服务/订单' })).toBe('/opt/服务/订单.versions')
  })
})

describe('inferTargetKind', () => {
  it('.jar 判为文件', () => {
    expect(inferTargetKind('/opt/svc/order.jar')).toBe('file')
    expect(inferTargetKind('/opt/svc/ORDER.JAR')).toBe('file')
  })

  it('其余判为目录', () => {
    expect(inferTargetKind('/opt/app/dist')).toBe('dir')
    expect(inferTargetKind('/opt/app/jar')).toBe('dir')
  })
})

describe('parentDirOf / posixBasename', () => {
  it('取父目录', () => {
    expect(parentDirOf('/opt/app/dist')).toBe('/opt/app')
    expect(parentDirOf('/dist')).toBe('/')
  })

  it('取基名', () => {
    expect(posixBasename('/opt/app/dist')).toBe('dist')
    expect(posixBasename('/dist')).toBe('dist')
  })

  /**
   * P1-3 回归：自定义 archiveDir 之前只做 normalizeRemotePath（折叠斜杠），
   * 相对路径 / `..` / 换行都能原样通过 —— 归档会写到工作区外的任意位置。
   * 现在必须先过 `requireSafeRemotePath`。
   */
  it('自定义 archiveDir 必须是安全的绝对路径，否则拒绝', () => {
    expect(() =>
      resolveArchiveDir({ remotePath: '/opt/app/dist', archiveDir: 'rel/versions' })
    ).toThrow(UnsafePathError)
    expect(() =>
      resolveArchiveDir({ remotePath: '/opt/app/dist', archiveDir: '/opt/../etc/versions' })
    ).toThrow(UnsafePathError)
    expect(() =>
      resolveArchiveDir({ remotePath: '/opt/app/dist', archiveDir: '/opt/a\nb' })
    ).toThrow(UnsafePathError)
    // 合法的绝对路径照常；空白值仍走推导
    expect(resolveArchiveDir({ remotePath: '/opt/app/dist', archiveDir: '/data/versions' })).toBe(
      '/data/versions'
    )
    expect(resolveArchiveDir({ remotePath: '/opt/app/dist', archiveDir: '   ' })).toBe(
      '/opt/app/dist.versions'
    )
  })
})
