/**
 * B10 纯逻辑单测（T10.2 / T10.8 / T10.11 的可测内核）。
 *
 * 这些边界在真机上很难甚至无法构造（"磁盘刚好差 1 字节"、"锁刚好 30 分钟"、
 * "父目录与目标跨设备"），但每一条都对应一个会改坏生产服务器的错误决策。
 */
import { describe, expect, it } from 'vitest'
import { DEPLOY_SPACE_FACTOR, LOCK_STALE_MS, requiredBytesFor } from '@shared/contracts/deploy'
import {
  buildLockPayload,
  checkSpace,
  classifyResidue,
  decideSwapStrategy,
  describeResidue,
  detectMountPoint,
  isAutoCleanable,
  isLockStale,
  isStagingOf,
  isSwapUnsupportedError,
  lockPathOf,
  parseLockPayload,
  stagingManifestOf,
  stagingPayloadOf,
  stagingRootOf,
  swapSourceOf
} from '@main/infra/deploy-plan'

describe('发布路径推导', () => {
  it('暂存根与目标同父目录（这是"换版可以原子 rename"的前提）', () => {
    expect(stagingRootOf('/opt/web/dist', 'R1')).toBe('/opt/web/.sfvm-staging-R1')
    expect(stagingPayloadOf('/opt/web/dist', 'R1')).toBe('/opt/web/.sfvm-staging-R1/payload')
    expect(stagingManifestOf('/opt/web/dist', 'R1')).toBe('/opt/web/.sfvm-staging-R1/files.sha256')
  })

  it('文件型目标的暂存根也在父目录（不是文件自身拼后缀）', () => {
    expect(stagingRootOf('/opt/svc/order.jar', 'R2')).toBe('/opt/svc/.sfvm-staging-R2')
  })

  it('锁文件与暂存放同一个父目录', () => {
    expect(lockPathOf('/opt/web/dist')).toBe('/opt/web/.sfvm.lock')
    expect(lockPathOf('/opt/svc/order.jar')).toBe('/opt/svc/.sfvm.lock')
  })

  it('换版源：目录型是整个 payload，文件型是 payload/<basename>', () => {
    expect(swapSourceOf('/opt/web/dist', 'R1', 'dir')).toBe('/opt/web/.sfvm-staging-R1/payload')
    // 文件型多一层 payload/<basename> —— 与归档布局对称，见 deploy-plan 文件头
    expect(swapSourceOf('/opt/svc/order.jar', 'R1', 'file')).toBe(
      '/opt/svc/.sfvm-staging-R1/payload/order.jar'
    )
  })

  it('路径里的重复斜杠被归一化后再拼（否则远端会出现 //）', () => {
    expect(stagingRootOf('/opt/web//dist/', 'R1')).toBe('/opt/web/.sfvm-staging-R1')
  })
})

describe('远端锁（T10.11）', () => {
  const now = new Date('2026-09-30T12:00:00.000Z')

  it('往返：写出来能读回去', () => {
    const text = buildLockPayload({
      releaseId: 'R-abc',
      hostname: 'ci-01',
      pid: 4321,
      now
    })
    const info = parseLockPayload(text, now)
    expect(info).toMatchObject({ releaseId: 'R-abc', hostname: 'ci-01', pid: 4321, stale: false })
  })

  it('坏 JSON / 缺字段 / 空值 → null（不是抛错，调用方据此给"读不懂"的提示）', () => {
    expect(parseLockPayload('{ not json', now)).toBeNull()
    expect(parseLockPayload('{"releaseId":"x"}', now)).toBeNull()
    expect(parseLockPayload('', now)).toBeNull()
    expect(parseLockPayload(null, now)).toBeNull()
    expect(parseLockPayload('[]', now)).toBeNull()
    // pid 必须是整数，"abc" 不认
    expect(parseLockPayload('{"releaseId":"x","hostname":"h","pid":"1","ts":"t"}', now)).toBeNull()
  })

  it('陈旧判定：刚好 30 分钟不算陈旧，多 1ms 才算', () => {
    const exactly = new Date(now.getTime() - LOCK_STALE_MS).toISOString()
    const over = new Date(now.getTime() - LOCK_STALE_MS - 1).toISOString()
    expect(isLockStale(exactly, now)).toBe(false)
    expect(isLockStale(over, now)).toBe(true)
    expect(isLockStale(now.toISOString(), now)).toBe(false)
  })

  it('ts 解析不出来时当作陈旧（否则用户会永久卡在"有发布进行中"）', () => {
    expect(isLockStale('不是时间', now)).toBe(true)
    const info = parseLockPayload(
      '{"releaseId":"x","hostname":"h","pid":1,"ts":"不是时间"}',
      now
    )
    expect(info?.stale).toBe(true)
  })
})

describe('磁盘余量（T10.2 的 ≥ 产物 × 2.2）', () => {
  it('系数是 2.2（暂存 1× + 归档 1× + 元数据 0.2×），且用整数运算避免浮点误差', () => {
    expect(DEPLOY_SPACE_FACTOR).toBe(2.2)
    expect(requiredBytesFor({ totalBytes: 100 })).toBe(220)
    // 向上取整：宁可多要求 1 字节，也不要因为小数截断而在"刚好不够"时放行
    expect(requiredBytesFor({ totalBytes: 101 })).toBe(223)
    // 这条是回归：`100 * 2.2 === 220.00000000000003`，写成 totalBytes * 2.2 会得到 221
    expect(requiredBytesFor({ totalBytes: 100 })).not.toBe(221)
    expect(requiredBytesFor({ totalBytes: 0 })).toBe(0)
    expect(requiredBytesFor({ totalBytes: -5 })).toBe(0)
  })

  it('恰好相等算够', () => {
    expect(checkSpace({ requiredBytes: 220, availableBytes: 220 })).toMatchObject({ ok: true })
  })

  it('差 1 字节算不够', () => {
    expect(checkSpace({ requiredBytes: 220, availableBytes: 219 })).toMatchObject({
      ok: false,
      unknown: false
    })
  })

  it('探测失败（null）→ 放行但标记 unknown（首次发布时目标还不存在，df 会失败）', () => {
    const r = checkSpace({ requiredBytes: 220, availableBytes: null })
    expect(r.ok).toBe(true)
    expect(r.unknown).toBe(true)
  })
})

describe('挂载点 / 跨设备识别（T10.8 的前置）', () => {
  it('df 的 Mounted-on 等于目标路径 ⇒ 目标本身是挂载点', () => {
    const r = detectMountPoint({
      remotePath: '/opt/web/dist',
      targetDf: { filesystem: '/dev/vdb1', mountPoint: '/opt/web/dist' },
      parentDf: { filesystem: '/dev/vda1', mountPoint: '/' }
    })
    expect(r.isMountPoint).toBe(true)
    expect(r.crossDevice).toBe(true)
    expect(r.reason).toContain('挂载点')
  })

  it('同一文件系统上的普通目录 ⇒ 都不是', () => {
    const r = detectMountPoint({
      remotePath: '/opt/web/dist',
      targetDf: { filesystem: '/dev/vda1', mountPoint: '/' },
      parentDf: { filesystem: '/dev/vda1', mountPoint: '/' }
    })
    expect(r).toMatchObject({ isMountPoint: false, crossDevice: false })
  })

  it('父目录与目标不同设备（目标不是挂载点）⇒ 仍报跨设备', () => {
    const r = detectMountPoint({
      remotePath: '/opt/web/dist',
      targetDf: { filesystem: '/dev/vdb1', mountPoint: '/opt' },
      parentDf: { filesystem: '/dev/vda1', mountPoint: '/' }
    })
    expect(r).toMatchObject({ isMountPoint: false, crossDevice: true })
    expect(r.reason).toContain('/dev/vdb1')
  })

  it('df 探测失败（null）⇒ 不误报（首次发布时目标不存在）', () => {
    expect(
      detectMountPoint({ remotePath: '/opt/web/dist', targetDf: null, parentDf: null })
    ).toMatchObject({ isMountPoint: false, crossDevice: false })
  })
})

describe('换版策略决策（T10.8）', () => {
  it('配置为 copy ⇒ 直接用 copy，不算"回退"', () => {
    expect(decideSwapStrategy({ configured: 'copy' })).toEqual({ strategy: 'copy' })
  })

  it('配置为 rename 且一切正常 ⇒ rename', () => {
    expect(decideSwapStrategy({ configured: 'rename' })).toEqual({ strategy: 'rename' })
    expect(
      decideSwapStrategy({
        configured: 'rename',
        preflight: { isMountPoint: false, crossDevice: false }
      })
    ).toEqual({ strategy: 'rename' })
  })

  it('阶段 0 已探明是挂载点 ⇒ 直接 copy，并说明原因', () => {
    const d = decideSwapStrategy({
      configured: 'rename',
      preflight: { isMountPoint: true, crossDevice: true, reason: '/opt/web/dist 本身是挂载点' }
    })
    expect(d.strategy).toBe('copy')
    expect(d.fallbackReason).toContain('挂载点')
  })

  it('rename 报 EXDEV（code 18）⇒ 回退 copy', () => {
    const err = Object.assign(new Error('failure'), { code: 18 })
    expect(isSwapUnsupportedError(err)).toBe(true)
    expect(decideSwapStrategy({ configured: 'rename', renameError: err }).strategy).toBe('copy')
  })

  it('rename 报 EBUSY（有的 OpenSSH 只把它放进 message）⇒ 回退 copy', () => {
    const err = new Error('rename: Device or resource busy')
    expect(isSwapUnsupportedError(err)).toBe(true)
    expect(decideSwapStrategy({ configured: 'rename', renameError: err }).strategy).toBe('copy')
  })

  it('rename 报权限错误 ⇒ **不**回退（copy 也会失败，硬回退会掩盖真实原因）', () => {
    const err = new Error('Permission denied')
    expect(isSwapUnsupportedError(err)).toBe(false)
    expect(decideSwapStrategy({ configured: 'rename', renameError: err })).toEqual({
      strategy: 'rename'
    })
  })

  it('null / undefined 错误对象不误判', () => {
    expect(isSwapUnsupportedError(null)).toBe(false)
    expect(isSwapUnsupportedError(undefined)).toBe(false)
    expect(isSwapUnsupportedError({})).toBe(false)
  })

  it('preflight 说挂载点，即使配置是 rename 也不去试 rename（避免必然失败的一次调用）', () => {
    const d = decideSwapStrategy({
      configured: 'rename',
      preflight: { isMountPoint: true, crossDevice: false, reason: '挂载点' }
    })
    expect(d.strategy).toBe('copy')
  })
})

describe('残留识别（T10.11 / §6.8）', () => {
  const base = { parentDir: '/opt/web', targetBase: 'dist' }

  it('识别暂存目录与 .part 两类残留，并给出绝对路径', () => {
    const list = classifyResidue({
      ...base,
      entries: [
        { name: '.sfvm-staging-abc', isDirectory: true },
        { name: 'order.jar.part', isDirectory: false },
        { name: 'dist', isDirectory: true },
        { name: 'dist.versions', isDirectory: true }
      ]
    })
    expect(list.map((r) => r.kind)).toEqual(['staging', 'partial'])
    expect(list.map((r) => r.path)).toEqual([
      '/opt/web/.sfvm-staging-abc',
      '/opt/web/order.jar.part'
    ])
    // 目标自身与往期版本目录都不能被当成残留
    expect(list.some((r) => r.name === 'dist')).toBe(false)
    expect(list.some((r) => r.name === 'dist.versions')).toBe(false)
  })

  it('只有自己能证明来源的暂存目录才允许自动清理；.part 不自动删', () => {
    const list = classifyResidue({
      ...base,
      entries: [
        { name: '.sfvm-staging-abc', isDirectory: true },
        { name: 'order.jar.part', isDirectory: false }
      ]
    })
    expect(list.filter(isAutoCleanable).map((r) => r.name)).toEqual(['.sfvm-staging-abc'])
  })

  it('什么都没有时返回空数组（不能把整个父目录当残留）', () => {
    expect(
      classifyResidue({ ...base, entries: [{ name: 'other', isDirectory: false }] })
    ).toEqual([])
  })

  it('每类残留都有中文说明（UI 直接渲染）', () => {
    expect(describeResidue('staging')).toContain('暂存')
    expect(describeResidue('partial')).toContain('.part')
  })

  it('isStagingOf 只认本次发布的那个目录（清理前确认"删的是自己建的"）', () => {
    expect(isStagingOf('.sfvm-staging-R1', 'R1')).toBe(true)
    expect(isStagingOf('.sfvm-staging-R2', 'R1')).toBe(false)
    expect(isStagingOf('R1', 'R1')).toBe(false)
  })
})
