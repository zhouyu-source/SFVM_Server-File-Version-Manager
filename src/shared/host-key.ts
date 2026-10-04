/**
 * 主机指纹的归一化与比对（T03.4 的纯逻辑部分）。
 *
 * 放在 shared 而不是 main：主进程用它判定 TOFU，渲染进程用它**展示**指纹，
 * 两边必须用同一套归一化规则（否则界面显示的与后端比较的可能不是一回事）。
 * 放在 main 会让渲染进程把主进程模块拖进 bundle —— 这是要避免的。
 *
 * 为什么需要归一化：同一个密钥在生态里有多种呈现方式
 * - ssh2 的 hostVerifier 回调给的是**公钥 blob**，我们算出的指纹是 base64
 * - `ssh-keygen -l -f` 显示的是 base64（如 `SHA256:aB3x...`）
 * - 有些工具显示 hex 并带冒号分隔
 * 不归一化就会出现"明明指纹一样却被判定为变了"，把用户挡在门外。
 */

export interface TrustedFingerprint {
  keyType: string
  fingerprint: string
}

export type HostKeyVerdict =
  /** 已信任且一致 */
  | { status: 'match' }
  /** 首次见到这个 (host,port,keyType)，需要用户确认（TOFU） */
  | { status: 'unknown' }
  /** 已知该主机但指纹变了 —— 必须拒绝 */
  | { status: 'mismatch'; expected: string; actual: string }

/** 归一化：去掉 `SHA256:` / `MD5:` 前缀与分隔符，统一小写。 */
export function normalizeFingerprint(raw: string): string {
  return raw
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/^MD5:/i, '')
    .replace(/[:\s-]/g, '')
    .toLowerCase()
}

/** 展示用格式：统一成 `<类型> SHA256:<值>`。 */
export function formatFingerprint(raw: string, keyType?: string): string {
  const normalized = normalizeFingerprint(raw)
  const prefix = keyType ? `${keyType} ` : ''
  return `${prefix}SHA256:${normalized}`
}

/**
 * 比对指纹。
 *
 * @param actual   本次连接实际拿到的
 * @param trusted  已知信任的指纹列表（同一主机可能有多种 keyType）
 * @param keyType  本次使用的密钥类型
 */
export function verifyHostKey(
  actual: string,
  trusted: TrustedFingerprint[],
  keyType?: string
): HostKeyVerdict {
  const a = normalizeFingerprint(actual)
  const sameType = keyType ? trusted.filter((t) => t.keyType === keyType) : trusted

  if (sameType.length > 0) {
    const hit = sameType.find((t) => normalizeFingerprint(t.fingerprint) === a)
    if (hit) return { status: 'match' }
    // 该主机该算法已有记录但不一致 —— 明确的 mismatch，必须拒绝连接
    return { status: 'mismatch', expected: sameType[0].fingerprint, actual }
  }

  // 该 keyType 没记录，但主机上有其他算法的记录：
  // 这属于"服务器新增了一种密钥算法"，是常见且合理的情况，
  // 不应判定为攻击，交给用户确认（unknown），而不是 mismatch。
  return { status: 'unknown' }
}

/** 供 UI 展示的判定说明。 */
export function describeVerdict(v: HostKeyVerdict, host: string): string {
  switch (v.status) {
    case 'match':
      return `已确认 ${host} 的主机密钥`
    case 'unknown':
      return `首次连接 ${host}，请核对指纹后决定是否信任`
    case 'mismatch':
      return (
        `${host} 的主机密钥与上次记录不一致！\n` +
        `期望：${v.expected}\n实际：${v.actual}\n` +
        '这可能意味着服务器重装，也可能是中间人攻击。确认无误前请勿继续。'
      )
  }
}
