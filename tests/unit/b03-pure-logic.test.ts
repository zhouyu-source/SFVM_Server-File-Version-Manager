/**
 * T03.4 验收点：指纹归一化、TOFU 判定、mismatch 必须拒绝。
 * T03.5 验收点：退避序列 1/2/5/10s、上限、最多 5 次、发布中禁重连。
 * T03.7 验收点：能力探测的输出解析。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeFingerprint,
  formatFingerprint,
  verifyHostKey,
  describeVerdict,
  type TrustedFingerprint
} from '@shared/host-key'
import {
  BACKOFF_MS,
  MAX_RETRIES,
  backoffDelay,
  backoffSchedule,
  canRetry,
  shouldReconnect
} from '@main/infra/backoff'
import {
  parsePlatform,
  commandExists,
  hasRemoteHashTool,
  pickHashCommand,
  describeCapability
} from '@main/infra/capability'

describe('指纹归一化（T03.4）', () => {
  it('去掉 SHA256: 前缀与分隔符、统一小写', () => {
    expect(normalizeFingerprint('SHA256:AbC123')).toBe('abc123')
    expect(normalizeFingerprint('aa:bb:cc')).toBe('aabbcc')
    expect(normalizeFingerprint('AA BB CC')).toBe('aabbcc')
    expect(normalizeFingerprint('sha256:aA-bB')).toBe('aabb')
  })

  it('同一指纹的不同呈现方式归一化后相等（避免误报"指纹变了"）', () => {
    // ssh2 给 hex，ssh-keygen 显示 base64+前缀 —— 归一化后必须可比
    const hex = 'a1b2c3d4'
    const shown = 'SHA256:a1:b2:c3:d4'
    expect(normalizeFingerprint(hex)).toBe(normalizeFingerprint(shown))
  })

  it('formatFingerprint 带类型与算法前缀', () => {
    expect(formatFingerprint('aabbcc', 'ssh-ed25519')).toBe('ssh-ed25519 SHA256:aabbcc')
    expect(formatFingerprint('aabbcc')).toBe('SHA256:aabbcc')
  })
})

describe('TOFU 判定（T03.4）', () => {
  const trusted: TrustedFingerprint[] = [{ keyType: 'ssh-ed25519', fingerprint: 'AAA111' }]

  it('指纹一致 → match', () => {
    expect(verifyHostKey('aaa111', trusted, 'ssh-ed25519').status).toBe('match')
    // 大小写/前缀差异也应视为一致
    expect(verifyHostKey('SHA256:AAA111', trusted, 'ssh-ed25519').status).toBe('match')
  })

  it('同算法但指纹不同 → mismatch（必须拒绝连接）', () => {
    const v = verifyHostKey('BBB222', trusted, 'ssh-ed25519')
    expect(v.status).toBe('mismatch')
    if (v.status === 'mismatch') {
      expect(v.expected).toBe('AAA111')
      expect(v.actual).toBe('BBB222')
    }
  })

  it('服务器新增了另一种算法 → unknown（不该当成攻击）', () => {
    // 主机有 ed25519 记录，本次用的是 rsa：属于常见合理情况，交用户确认
    expect(verifyHostKey('CCC333', trusted, 'ssh-rsa').status).toBe('unknown')
  })

  it('完全没有记录 → unknown（首次连接）', () => {
    expect(verifyHostKey('DDD444', [], 'ssh-ed25519').status).toBe('unknown')
  })

  it('不指定 keyType 时做全量比较', () => {
    expect(verifyHostKey('AAA111', trusted).status).toBe('match')
    expect(verifyHostKey('XYZ', trusted).status).toBe('mismatch')
  })

  it('mismatch 的说明文案包含期望值与实际值', () => {
    const v = verifyHostKey('BBB', trusted, 'ssh-ed25519')
    const text = describeVerdict(v, '10.0.0.1')
    expect(text).toContain('不一致')
    expect(text).toContain('AAA111')
    expect(text).toContain('BBB')
  })
})

describe('退避与重连（T03.5）', () => {
  it('退避序列为 1s → 2s → 5s → 10s', () => {
    expect([...BACKOFF_MS]).toEqual([1000, 2000, 5000, 10000])
    expect(backoffSchedule(4)).toEqual([1000, 2000, 5000, 10000])
  })

  it('超过序列长度后固定在上限，不会无限增长', () => {
    expect(backoffDelay(4)).toBe(10000)
    expect(backoffDelay(99)).toBe(10000)
  })

  it('最多重试 5 次', () => {
    expect(MAX_RETRIES).toBe(5)
    expect(canRetry(4)).toBe(true)
    expect(canRetry(5)).toBe(false)
    expect(backoffSchedule()).toHaveLength(5)
  })

  it('发布任务执行期间禁止自动重连（方案书 §6.2）', () => {
    expect(shouldReconnect({ attempt: 0, busy: true, userInitiated: false })).toBe(false)
  })

  it('用户主动断开不重连', () => {
    expect(shouldReconnect({ attempt: 0, busy: false, userInitiated: true })).toBe(false)
  })

  it('空闲且未超次数时允许重连', () => {
    expect(shouldReconnect({ attempt: 0, busy: false, userInitiated: false })).toBe(true)
    expect(shouldReconnect({ attempt: 4, busy: false, userInitiated: false })).toBe(true)
    expect(shouldReconnect({ attempt: 5, busy: false, userInitiated: false })).toBe(false)
  })
})

describe('能力探测解析（T03.7）', () => {
  it('识别 Linux / macOS / Windows(类 Unix 环境)', () => {
    expect(parsePlatform('Linux\n')).toBe('linux')
    expect(parsePlatform('Darwin')).toBe('darwin')
    expect(parsePlatform('MINGW64_NT-10.0')).toBe('windows')
    expect(parsePlatform('CYGWIN_NT-10.0')).toBe('windows')
    expect(parsePlatform('')).toBe('unknown')
  })

  it('command -v 的失败输出不会被误判为"存在"', () => {
    expect(commandExists('')).toBe(false)
    expect(commandExists('bash: sha256sum: command not found')).toBe(false)
    expect(commandExists('未找到命令')).toBe(false)
  })

  it('command -v 的路径输出判为存在', () => {
    expect(commandExists('/usr/bin/sha256sum')).toBe(true)
    expect(commandExists('/usr/bin/shasum\n')).toBe(true)
    // 兼容登录横幅：取最后一行
    expect(commandExists('Welcome to server\n/usr/bin/df')).toBe(true)
  })

  it('有 sha256sum 优先用它，其次 shasum，都没有返回 null', () => {
    expect(pickHashCommand({ hasSha256sum: true, hasShasum: true })).toBe('sha256sum')
    expect(pickHashCommand({ hasSha256sum: false, hasShasum: true })).toBe('shasum -a 256')
    expect(pickHashCommand({ hasSha256sum: false, hasShasum: false })).toBeNull()
  })

  it('hasRemoteHashTool 判定是否需要降级为流式校验', () => {
    expect(hasRemoteHashTool({ hasSha256sum: true, hasShasum: false })).toBe(true)
    expect(hasRemoteHashTool({ hasSha256sum: false, hasShasum: true })).toBe(true)
    expect(hasRemoteHashTool({ hasSha256sum: false, hasShasum: false })).toBe(false)
  })

  it('describeCapability 在无哈希工具时明确提示降级', () => {
    const text = describeCapability({
      hasSha256sum: false,
      hasShasum: false,
      hasDf: true,
      platform: 'linux',
      homeDir: '/home/deploy'
    })
    expect(text).toContain('降级')
    expect(text).toContain('/home/deploy')
  })
})
