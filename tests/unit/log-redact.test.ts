/**
 * T01.2 验收点：传入含密码的对象，脱敏后不得出现明文。
 */
import { describe, expect, it } from 'vitest'
import { redact, scrubText, isSecretKey, REDACTED } from '@main/infra/log-redact'

describe('isSecretKey', () => {
  it('识别常见敏感键名与变体', () => {
    for (const k of [
      'password',
      'Password',
      'PASSWORD',
      'passphrase',
      'secret',
      'secret_cipher',
      'apiKey',
      'api_key',
      'token',
      'privateKey',
      'authorization'
    ]) {
      expect(isSecretKey(k), k).toBe(true)
    }
  })

  it('不误伤普通键名', () => {
    for (const k of ['host', 'port', 'username', 'name', 'note', 'remotePath', 'keyType']) {
      expect(isSecretKey(k), k).toBe(false)
    }
  })
})

describe('redact', () => {
  it('把敏感字段替换为 ***，且不泄露长度', () => {
    const input = {
      host: '10.0.0.1',
      port: 22,
      username: 'deploy',
      password: 'hunter2-super-secret'
    }
    const out = redact(input) as Record<string, unknown>

    expect(out.host).toBe('10.0.0.1')
    expect(out.port).toBe(22)
    expect(out.username).toBe('deploy')
    expect(out.password).toBe(REDACTED)

    // 关键：序列化后不得包含明文，也不得包含长度信息
    const json = JSON.stringify(out)
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('super')
    expect(json).not.toContain(String('hunter2-super-secret'.length))
  })

  it('递归处理嵌套对象与数组', () => {
    const input = {
      connection: {
        name: '生产',
        auth: { type: 'password', password: 'p@ss' }
      },
      tunnels: [{ token: 'abc123' }, { host: 'x', passphrase: 'pp' }]
    }
    const json = JSON.stringify(redact(input))
    expect(json).not.toContain('p@ss')
    expect(json).not.toContain('abc123')
    expect(json).not.toContain('"pp"')
    expect(json).toContain('生产')
  })

  it('处理循环引用不抛异常', () => {
    const a: Record<string, unknown> = { name: 'a', password: 'x' }
    a.self = a
    expect(() => redact(a)).not.toThrow()
    const out = redact(a) as Record<string, unknown>
    expect(out.password).toBe(REDACTED)
    expect(out.self).toBe('[circular]')
  })

  it('Error 实例既不丢信息也不漏密码', () => {
    // 现实形态：库/上层把凭据拼进了错误消息（带键，可识别）
    const err = Object.assign(new Error('ssh auth failed: password=hunter2 host=10.0.0.1'), {
      password: 'hunter2'
    })
    const json = JSON.stringify(redact(err))
    expect(json).toContain('auth failed')
    expect(json).toContain('10.0.0.1')
    expect(json).not.toContain('hunter2')
  })

  it('已知限制：自由文本里的裸密码无法可靠脱敏（记录在案）', () => {
    // 这不是"可以接受"，而是刻意记录：正则抓不住任意自由文本里的裸串。
    // 因此约定是 —— 任何凭据都必须以**结构化字段**形式传给 logger，
    // 不要拼进自由文本；拼进去的只能靠 scrubText 覆盖已知形态。
    const err = new Error('auth failed for hunter2')
    const json = JSON.stringify(redact(err))
    expect(json).toContain('hunter2') // 如实反映当前能力边界
  })

  it('超深结构被截断而不是无限递归', () => {
    let node: Record<string, unknown> = { password: 'deep' }
    for (let i = 0; i < 30; i++) node = { child: node }
    const json = JSON.stringify(redact(node))
    expect(json).toContain('depth-limit')
    expect(json).not.toContain('deep')
  })

  it('Buffer 只记长度不记内容', () => {
    const out = redact({ data: Buffer.from('secret-bytes') }) as Record<string, unknown>
    expect(String(out.data)).toContain('Buffer')
    expect(JSON.stringify(out)).not.toContain('secret-bytes')
  })
})

describe('scrubText（第二道防线）', () => {
  it('替换拼进消息文本的密码', () => {
    const s = scrubText('connecting host=1.2.3.4 password=hunter2 port=22')
    expect(s).not.toContain('hunter2')
    expect(s).toContain('password=***')
  })

  it('替换 JSON 形态的密文', () => {
    const s = scrubText('{"username":"a","password":"p@ssw0rd","host":"h"}')
    expect(s).not.toContain('p@ssw0rd')
  })

  it('替换 URL 中的凭据', () => {
    const s = scrubText('sftp://deploy:s3cr3t@example.com/path')
    expect(s).not.toContain('s3cr3t')
    expect(s).toContain('deploy:***@example.com')
  })

  it('不影响普通文本', () => {
    const s = 'published /opt/app/dist to 10.0.0.1 in 12s'
    expect(scrubText(s)).toBe(s)
  })

  it('只有用户名、没有密码时不误伤', () => {
    const s = 'http://onlyuser@host/p'
    expect(scrubText(s)).toBe(s)
  })

  it('同一条文本里多个 URL 都处理，且用户名保留', () => {
    const s = scrubText('a https://u1:p1@h1/x b sftp://u2:p2@h2/y')
    expect(s).not.toContain('p1')
    expect(s).not.toContain('p2')
    expect(s).toContain('u1:***@h1')
    expect(s).toContain('u2:***@h2')
  })

  /**
   * 性能回归（B20 加）。
   *
   * 这个函数在**每一次脚本输出**上跑，而单步输出上限是 8MB —— 一次 `mvn package`
   * 的日志足够把主进程冻住。原来的 URL 正则用贪婪 `\w+`，在没有匹配的长 token
   * （编译日志 / base64 / 压缩过的 JS 都是没有空格的连续串）上会逐个回退，
   * 复杂度 O(n²)：实测 10K 字符 65ms、100K 字符 **6.4 秒**。
   *
   * 阈值给得很松（200K 字符 < 2 秒）。修好之后这里是 ~30ms，
   * 而"退化回二次"会直接变成 ~25 秒，所以它拦得住回归，又不会在慢机器上误报。
   */
  it('长文本上是线性的（贪婪量词退化成 O(n²) 会让这里超时）', () => {
    const n = 200_000
    const plain = 'x'.repeat(n)
    const t0 = Date.now()
    scrubText(plain)
    const plainMs = Date.now() - t0

    const urls = 'sftp://u:p@h/'.repeat(Math.ceil(n / 14)).slice(0, n)
    const t1 = Date.now()
    scrubText(urls)
    const urlMs = Date.now() - t1

    expect(plainMs, `20 万字符的纯 token 用了 ${plainMs}ms`).toBeLessThan(2000)
    expect(urlMs, `20 万字符的重复凭据 URL 用了 ${urlMs}ms`).toBeLessThan(2000)
  })
})
