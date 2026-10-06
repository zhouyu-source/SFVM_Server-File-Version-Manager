/**
 * T03.1 / T03.2 / T03.8 验收点：
 * - 加解密往返一致，密文里不含明文
 * - 加密不可用时**拒绝保存密码**，绝不写明文、绝不降级
 * - 连接视图（唯一允许跨 IPC 的形态）**不含密文、也不含明文**
 * - secret 三态语义：不传=不变、''=清除、非空=设置
 * - 被环境引用的连接不能删除（E_IN_USE）、入参校验、TOFU 落库
 * - 私钥文件读不出来时报的是**私钥**（E_CONN_KEY_MISSING），不是"本地产物"
 *
 * Electron 由 tests/stubs/electron.ts 统一替身（见 vitest.config.ts 的 alias）；
 * "密钥链不可用"通过 credential 的测试注入点模拟。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { makeTestDb } from '../helpers/db'
import {
  encryptSecret,
  decryptSecret,
  hasStoredSecret,
  checkAvailability,
  canStoreSecrets,
  unavailableReason,
  __testSetSafeStorageAvailable
} from '@main/services/credential'
import { SshConnectionPool } from '@main/services/ssh-client'
import { createConnectionService } from '@main/services/connection'
import { AppError, ErrorCode } from '@main/infra/errors'

afterEach(() => {
  // 每个用例后恢复"可用"，避免相互影响
  __testSetSafeStorageAvailable(undefined)
})

describe('凭据加解密（T03.1）', () => {
  it('加解密往返一致，且密文里不含明文', () => {
    const cipher = encryptSecret('hunter2-super-secret')
    expect(cipher).not.toContain('hunter2')
    expect(decryptSecret(cipher)).toBe('hunter2-super-secret')
  })

  it('空值处理：空串不产生密文，解密空值返回 undefined', () => {
    expect(encryptSecret('')).toBe('')
    expect(decryptSecret('')).toBeUndefined()
    expect(decryptSecret(null)).toBeUndefined()
  })

  it('hasStoredSecret 只判断有无', () => {
    expect(hasStoredSecret(null)).toBe(false)
    expect(hasStoredSecret('')).toBe(false)
    expect(hasStoredSecret('x')).toBe(true)
  })

  it('密文无法解密时报认证类错误（提示重新输入，而不是崩溃）', () => {
    expect(() => decryptSecret('不是有效的密文')).toThrowError(AppError)
    try {
      decryptSecret('不是有效的密文')
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.E_CONN_AUTH)
    }
  })
})

describe('无密钥链时的降级（T03.2）', () => {
  it('加密不可用时 encryptSecret 抛 E_NO_KEYCHAIN，且绝不退回明文', () => {
    __testSetSafeStorageAvailable(false)
    let caught: unknown
    try {
      encryptSecret('hunter2')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).code).toBe(ErrorCode.E_NO_KEYCHAIN)
    // 文案必须是中文且说明"不会以明文保存"
    expect((caught as AppError).message).toContain('无法安全保存密码')
  })

  it('解密不可用时同样明确报错', () => {
    __testSetSafeStorageAvailable(false)
    expect(() => decryptSecret('anything')).toThrowError(AppError)
  })

  it('checkAvailability / canStoreSecrets / unavailableReason 一致反映状态', () => {
    __testSetSafeStorageAvailable(true)
    expect(checkAvailability().available).toBe(true)
    expect(canStoreSecrets()).toBe(true)

    __testSetSafeStorageAvailable(false)
    expect(checkAvailability().available).toBe(false)
    expect(canStoreSecrets()).toBe(false)
    expect(unavailableReason()).toContain('不会以明文保存')
  })
})

describe('ConnectionService（T03.8）', () => {
  function setup() {
    const t = makeTestDb()
    const pool = new SshConnectionPool()
    const svc = createConnectionService({ repo: t.repo, pool })
    return { t, pool, svc }
  }

  it('连接视图里没有密文、没有明文、也没有密文字段名', () => {
    const { t, svc } = setup()
    try {
      const view = svc.create({
        name: '测试机',
        host: '10.0.0.1',
        username: 'deploy',
        authType: 'password',
        secret: 'hunter2-super-secret'
      })

      // 这是唯一允许跨 IPC 的形态，必须通过这些检查
      const serialized = JSON.stringify(view)
      expect(serialized).not.toContain('hunter2')
      expect(serialized).not.toContain('secretCipher')
      expect(serialized).not.toContain('secret_cipher')
      expect(serialized).not.toContain('cipher-') // 测试替身的密文前缀

      expect(view.hasSecret).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('加密不可用时拒绝创建带密码的连接，库里不留记录（拒绝而非降级）', () => {
    const { t, svc } = setup()
    try {
      __testSetSafeStorageAvailable(false)
      expect(() =>
        svc.create({ name: 'x', host: 'h', username: 'u', authType: 'password', secret: 'pw' })
      ).toThrowError(/无法安全保存密码/)
      expect(svc.list()).toHaveLength(0)
    } finally {
      t.cleanup()
    }
  })

  it('不带密码也能创建（用于"每次手动输入"的场景）', () => {
    const { t, svc } = setup()
    try {
      __testSetSafeStorageAvailable(false)
      const view = svc.create({ name: 'x', host: 'h', username: 'u', authType: 'password' })
      expect(view.hasSecret).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it('secret 三态语义：不传=不变、空串=清除、非空=设置', () => {
    const { t, svc } = setup()
    try {
      const created = svc.create({
        name: 'x',
        host: 'h',
        username: 'u',
        authType: 'password',
        secret: 'first'
      })
      expect(created.hasSecret).toBe(true)

      const kept = svc.update(created.id, { name: 'renamed' })
      expect(kept.hasSecret).toBe(true)
      expect(kept.name).toBe('renamed')

      expect(svc.update(created.id, { secret: '' }).hasSecret).toBe(false)
      expect(svc.update(created.id, { secret: 'second' }).hasSecret).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('被环境引用的连接不能删除（E_IN_USE），解除引用后可删', () => {
    const { t, svc } = setup()
    try {
      const conn = svc.create({ name: 'c', host: 'h', username: 'u', authType: 'password' })
      const env = t.repo.environments.create({
        name: '生产',
        envType: 'prod',
        connectionId: conn.id
      })

      let caught: unknown
      try {
        svc.remove(conn.id)
      } catch (e) {
        caught = e
      }
      expect((caught as AppError).code).toBe(ErrorCode.E_IN_USE)

      t.repo.environments.remove(env.id)
      expect(() => svc.remove(conn.id)).not.toThrow()
      expect(svc.list()).toHaveLength(0)
    } finally {
      t.cleanup()
    }
  })

  it('入参校验：缺 name/host/username，或私钥认证缺路径 → E_PARAM', () => {
    const { t, svc } = setup()
    try {
      const base = { name: 'n', host: 'h', username: 'u', authType: 'password' as const }
      for (const bad of [
        { ...base, name: '' },
        { ...base, host: '' },
        { ...base, username: '' },
        { ...base, authType: 'privateKey' as const }
      ]) {
        let caught: unknown
        try {
          svc.create(bad)
        } catch (e) {
          caught = e
        }
        expect((caught as AppError).code, JSON.stringify(bad)).toBe(ErrorCode.E_PARAM)
      }
    } finally {
      t.cleanup()
    }
  })

  /**
   * 回归：**连接不能借用"发布"的错误文案**。
   *
   * 起因是用户实测报上来的：在「连接」页连测试服务器，弹的是
   * 「本地构建产物不存在 / 请确认本地产物路径，或先执行构建」——
   * 于是他跑去翻目标的发布配置，而真正要改的是这个连接配置里的**私钥路径**
   * （当时这里复用了 `E_LOCAL_PATH_MISSING`：那是"本地产物"专用的码与文案）。
   *
   * 所以这里除了"能报错"，还要钉住**报的是哪一件事**：文案里要有具体文件路径、
   * 要说"私钥"，且一个字都不能提"构建产物"。
   */
  it('私钥文件不存在时在建连前就报错，且文案说的是私钥（不是本地产物）', async () => {
    const { t, svc } = setup()
    try {
      const keyPath = 'D:/definitely/not/here/id_ed25519'
      const view = svc.create({
        name: 'k',
        host: 'h',
        username: 'u',
        authType: 'privateKey',
        privateKeyPath: keyPath
      })

      let caught: unknown
      try {
        await svc.connect(view.id)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(AppError)
      const err = caught as AppError
      expect(err.code).toBe(ErrorCode.E_CONN_KEY_MISSING)
      // 弹窗里只有这两行，所以"哪个文件"必须出现在 message 里
      expect(err.message).toContain(keyPath)
      expect(err.message).toContain('私钥')
      expect(`${err.message}\n${err.hint ?? ''}`).not.toContain('构建产物')
      // 具体原因留给"复制诊断信息"
      expect(err.detail).toMatchObject({ path: keyPath, code: 'ENOENT' })
    } finally {
      t.cleanup()
    }
  })

  it('表单里还没保存的草稿走同一条路：test({input}) 也报 E_CONN_KEY_MISSING，不是"未知错误"', async () => {
    const { t, svc } = setup()
    try {
      let caught: unknown
      try {
        await svc.test({
          input: {
            name: '草稿',
            host: 'h',
            username: 'u',
            authType: 'privateKey',
            privateKeyPath: 'D:/definitely/not/here/id_ed25519'
          }
        })
      } catch (e) {
        caught = e
      }
      // 以前这条是裸 readFileSync，抛出去会被 IPC 归一成 E_UNKNOWN（"发生未知错误"）
      expect(caught).toBeInstanceOf(AppError)
      expect((caught as AppError).code).toBe(ErrorCode.E_CONN_KEY_MISSING)
    } finally {
      t.cleanup()
    }
  })

  it('trustHostKey 写入 known_hosts 并更新连接上的指纹字段（TOFU 落库）', () => {
    const { t, svc } = setup()
    try {
      const conn = svc.create({ name: 'c', host: '10.0.0.1', username: 'u', authType: 'password' })
      svc.trustHostKey(conn.id, 'ssh-ed25519', 'SHA256:ABC')

      expect(svc.get(conn.id).hostKeyFingerprint).toBe('SHA256:ABC')
      expect(t.repo.knownHosts.find('10.0.0.1', 22, 'ssh-ed25519')?.fingerprint).toBe('SHA256:ABC')
    } finally {
      t.cleanup()
    }
  })

  it('get 不存在的 id 报 E_NOT_FOUND', () => {
    const { t, svc } = setup()
    try {
      let caught: unknown
      try {
        svc.get('nope')
      } catch (e) {
        caught = e
      }
      expect((caught as AppError).code).toBe(ErrorCode.E_NOT_FOUND)
    } finally {
      t.cleanup()
    }
  })

  it('credentialStatus 透出可用性与后端名，供 UI 决定是否禁用保存密码', () => {
    const { t, svc } = setup()
    try {
      expect(svc.credentialStatus().available).toBe(true)
      __testSetSafeStorageAvailable(false)
      const s = svc.credentialStatus()
      expect(s.available).toBe(false)
      expect(s.reason).toBeTruthy()
    } finally {
      t.cleanup()
    }
  })
})
