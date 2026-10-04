/**
 * 凭据加解密（T03.1 / T03.2）。
 *
 * 安全约束（方案书 §3.2 / §6.3）：
 * - 密码与私钥口令经 `safeStorage` 加密后落库，**明文只在主进程内短暂存在**
 * - 本模块的任何返回值**不允许经 IPC 送到渲染进程**；
 *   渲染进程只能得到"是否已保存"这种布尔信息
 * - 私钥本身只保存**文件路径**，不保存内容
 *
 * 关于 safeStorage 的可用性（T03.2）：
 * Windows 走 DPAPI、macOS 走 Keychain、Linux 需要 libsecret。
 * 不可用时**拒绝保存密码**，只允许会话内输入 —— 方案书明确要求
 * "拒绝写入明文"，因为以明文落盘会让用户误以为密码是安全的。
 */
import { safeStorage } from 'electron'
import { AppError, ErrorCode } from '../infra/errors'

/**
 * 测试注入点（仅供单测使用）。
 *
 * 为什么需要：T03.2 要求覆盖"本机无法安全保存密码"的降级路径，
 * 而 safeStorage 的可用性由操作系统决定，测试无法通过环境变量控制。
 * 与其去 mock electron 内部实现（脆弱且会漏导出），不如留一个显式的注入点：
 * 值为 undefined 时一律走真实 safeStorage 判断。
 */
let testAvailabilityOverride: boolean | undefined

/** @internal 仅测试调用 */
export function __testSetSafeStorageAvailable(value: boolean | undefined): void {
  testAvailabilityOverride = value
}

/** 真实的可用性判断（不含注入点）。 */
function realIsAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 统一的可用性判断：注入点优先。 */
function isAvailable(): boolean {
  if (testAvailabilityOverride !== undefined) return testAvailabilityOverride
  return realIsAvailable()
}

/** 明文凭据，只在主进程内部流转。 */
export interface SecretInput {
  /** 密码，或私钥口令 */
  secret?: string
}

export interface CredentialAvailability {
  available: boolean
  /** 底层实现名，用于 UI 说明与排障 */
  backend: string
}

/**
 * 探测凭据加密是否可用（T03.1）。
 * 启动时调用一次，结果决定 UI 是否允许"保存密码"。
 */
export function checkAvailability(): CredentialAvailability {
  return {
    available: isAvailable(),
    backend: backendName()
  }
}

function backendName(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows DPAPI'
    case 'darwin':
      return 'macOS Keychain'
    default:
      return 'Linux libsecret'
  }
}

/**
 * 加密凭据（T03.1）。
 *
 * @returns base64 字符串，直接存入 `connections.secret_cipher`
 * @throws AppError(E_NO_KEYCHAIN) 当加密不可用时 —— **绝不降级为明文**
 */
export function encryptSecret(plain: string): string {
  assertAvailable()
  if (!plain) return ''
  try {
    const buf = safeStorage.encryptString(plain)
    return buf.toString('base64')
  } catch (err) {
    // 加密失败也不允许退回明文
    throw new AppError(ErrorCode.E_NO_KEYCHAIN, { original: (err as Error).message })
  }
}

/**
 * 解密凭据（T03.1）。
 * 仅在主进程建连时调用；返回值不得跨 IPC。
 */
export function decryptSecret(cipher: string | null | undefined): string | undefined {
  if (!cipher) return undefined
  assertAvailable()
  try {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  } catch (err) {
    // 解密失败常见原因：换了机器/换了用户（DPAPI 与用户绑定），
    // 此时应当提示重新输入密码，而不是当成致命错误。
    throw new AppError(ErrorCode.E_CONN_AUTH, {
      original: (err as Error).message,
      reason: 'credential-decrypt-failed'
    })
  }
}

/**
 * 是否可以保存凭据（T03.2）。
 * UI 用它决定是否禁用"保存密码"并显示持久告警条。
 */
export function canStoreSecrets(): boolean {
  return checkAvailability().available
}

/** 供 UI 展示的不可用说明。 */
export function unavailableReason(): string {
  const { backend } = checkAvailability()
  return `本机无法安全保存密码：${backend} 不可用。应用不会以明文保存密码，请每次手动输入。`
}

function assertAvailable(): void {
  if (!isAvailable()) throw new AppError(ErrorCode.E_NO_KEYCHAIN, { backend: backendName() })
}

/**
 * 判断一条连接记录里是否**存有**凭据（不含明文）。
 * 渲染进程只能拿到这个布尔量。
 */
export function hasStoredSecret(secretCipher: string | null | undefined): boolean {
  return typeof secretCipher === 'string' && secretCipher.length > 0
}
