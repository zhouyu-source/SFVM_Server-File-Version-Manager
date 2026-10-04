/**
 * 连接状态辅助函数（B04 用到）。
 * UI 的"能否操作""徽标文案"都依赖它们，属于容易改错又不易察觉的地方。
 */
import { describe, expect, it } from 'vitest'
import {
  isOperable,
  describeStatus,
  type ConnectionStatus
} from '@shared/contracts/connection-state'

describe('isOperable（T04.9 离线态置灰的依据）', () => {
  it('只有 online 允许发起写操作', () => {
    expect(isOperable('online')).toBe(true)
  })

  it('其余状态一律不可操作', () => {
    const notOperable: ConnectionStatus[] = ['idle', 'connecting', 'reconnecting', 'offline']
    for (const s of notOperable) {
      expect(isOperable(s), s).toBe(false)
    }
  })
})

describe('describeStatus（T04.7 状态条文案）', () => {
  it('每种状态都有中文文案，没有遗漏', () => {
    const all: ConnectionStatus[] = ['idle', 'connecting', 'online', 'reconnecting', 'offline']
    for (const s of all) {
      const text = describeStatus(s)
      expect(text, s).toBeTruthy()
      expect(/[\u4e00-\u9fa5]/.test(text), `${s} -> ${text}`).toBe(true)
    }
  })

  it('关键状态文案符合预期', () => {
    expect(describeStatus('online')).toBe('在线')
    expect(describeStatus('offline')).toBe('离线')
    expect(describeStatus('reconnecting')).toBe('重连中')
    expect(describeStatus('idle')).toBe('未连接')
  })
})
