/**
 * 目标体检（T05.7）。
 *
 * 方案书 §6.4 规定新建目标时执行一次体检，结果以**清单**呈现，
 * 让用户一眼看到"这个目标能不能用"：
 *   1. 连接可用
 *   2. 目标路径存在（不存在则询问"创建空目录 / 仅登记待首次发布"）
 *   3. 同级目录可写（用于创建 `<目标名>.versions`）
 *   4. 归档目录是否已存在（存在则提示可导入台账，由 B14 对账处理）
 *   5. 远端哈希能力（sha256sum / shasum）
 *
 * 设计：把"检查项"抽象成可注入的探针，纯逻辑负责组织结论与建议，
 * 这样单测可以覆盖各种组合（连不上、路径不存在、父目录不可写……），
 * 而不必真连服务器。
 */
import { AppError, ErrorCode } from '../infra/errors'
import { normalizeRemotePath } from '../infra/remote-path'
import { parentDirOf, resolveArchiveDir } from '../infra/archive-dir'
import type { ConnectionCapability } from '../infra/capability'

export type HealthLevel = 'ok' | 'warn' | 'error'

export interface HealthCheck {
  /** 检查项标识，UI 按此渲染固定顺序 */
  key: 'connection' | 'path' | 'parent-writable' | 'archive-dir' | 'hash-tool'
  /** 面向用户的项目名 */
  label: string
  level: HealthLevel
  /** 结论说明（中文） */
  detail: string
  /** 建议动作（可操作时才给） */
  suggestion?: string
  /** 附加数据，如既存版本数量 */
  data?: Record<string, unknown>
}

export interface HealthReport {
  /** 是否"可以保存目标"——只要没有 error 级问题即可 */
  ok: boolean
  checks: HealthCheck[]
  /** 目标路径不存在时，UI 需要据此询问用户 */
  needCreateChoice: boolean
  /** 归档目录下既存版本数量（>0 时提示可导入台账） */
  existingVersions: number
}

/**
 * 体检所需的远端事实。由调用方（IPC 层）通过真实连接采集，
 * 单测里用假实现替换。
 */
export interface HealthProbe {
  /** 连接是否可用；不可用时 capability 为 undefined */
  connectionOk: boolean
  /** 连接失败的中文原因 */
  connectionError?: string
  capability?: ConnectionCapability
  /** 目标路径是否存在（dir 型需要是目录，file 型需要是文件） */
  targetExists: boolean
  /** 目标路径是目录还是文件（存在时） */
  targetIsDirectory?: boolean
  /** 目标父目录是否可写 */
  parentWritable: boolean
  /** 归档目录是否已存在 */
  archiveDirExists: boolean
  /** 归档目录下已有的版本目录数量 */
  existingVersions: number
}

export interface HealthInput {
  remotePath: string
  kind: 'dir' | 'file'
  /** 自定义归档目录；不传则按规则推导 */
  archiveDir?: string | null
}

/**
 * 组装体检报告。纯函数：输入事实，输出结构化结论。
 */
export function buildHealthReport(input: HealthInput, probe: HealthProbe): HealthReport {
  const checks: HealthCheck[] = []
  const remotePath = normalizeRemotePath(input.remotePath)
  const archiveDir = resolveArchiveDir({ remotePath, archiveDir: input.archiveDir ?? null })

  /* 1. 连接可用 */
  if (!probe.connectionOk) {
    checks.push({
      key: 'connection',
      label: '连接可用',
      level: 'error',
      detail: probe.connectionError || '无法建立 SSH 连接',
      suggestion: '请先在「连接」页测试该连接，确认主机、凭据与网络可达。'
    })
    // 连接都不通，后面的检查没有意义 —— 直接返回，避免给出一堆误导性的失败项
    return { ok: false, checks, needCreateChoice: false, existingVersions: 0 }
  }
  checks.push({
    key: 'connection',
    label: '连接可用',
    level: 'ok',
    detail: 'SSH 连接正常'
  })

  /* 2. 目标路径存在性 */
  if (probe.targetExists) {
    const kindMatches =
      input.kind === 'dir' ? probe.targetIsDirectory === true : probe.targetIsDirectory === false
    if (kindMatches) {
      checks.push({
        key: 'path',
        label: '目标路径存在',
        level: 'ok',
        detail: `${remotePath}（${input.kind === 'dir' ? '目录' : '文件'}）`
      })
    } else {
      checks.push({
        key: 'path',
        label: '目标路径存在',
        level: 'error',
        detail:
          `路径存在但类型不符：期望${input.kind === 'dir' ? '目录' : '文件'}，` +
          `实际是${probe.targetIsDirectory ? '目录' : '文件'}。`,
        suggestion: '请修正路径，或在上方手动切换目标类型。'
      })
    }
  } else {
    checks.push({
      key: 'path',
      label: '目标路径存在',
      level: 'warn',
      detail: `${remotePath} 目前不存在`,
      suggestion:
        input.kind === 'dir'
          ? '可以现在创建空目录，或仅登记该目标等待首次发布。'
          : '文件型目标需要首次发布后才会出现，可仅登记等待首次发布。',
      data: { canCreate: input.kind === 'dir' }
    })
  }

  /* 3. 父目录可写（创建 <目标名>.versions 需要） */
  const parent = parentDirOf(remotePath)
  if (probe.parentWritable) {
    checks.push({
      key: 'parent-writable',
      label: '父目录可写',
      level: 'ok',
      detail: `${parent} 可写，能够创建往期版本目录`
    })
  } else {
    checks.push({
      key: 'parent-writable',
      label: '父目录可写',
      level: 'error',
      detail: `${parent} 不可写，无法创建 ${archiveDir}`,
      suggestion: '需要该父目录的写权限（用于创建 <目标名>.versions）。请联系运维授权后重试。'
    })
  }

  /* 4. 归档目录 */
  if (probe.archiveDirExists) {
    checks.push({
      key: 'archive-dir',
      label: '往期版本目录',
      level: 'ok',
      detail:
        probe.existingVersions > 0
          ? `已存在，发现 ${probe.existingVersions} 个既存版本`
          : '已存在（暂无版本）',
      suggestion:
        probe.existingVersions > 0
          ? `检测到 ${probe.existingVersions} 个既存版本，可执行「对账」导入台账。`
          : undefined,
      data: { existingVersions: probe.existingVersions, archiveDir }
    })
  } else {
    checks.push({
      key: 'archive-dir',
      label: '往期版本目录',
      level: 'ok',
      detail: `尚未创建，首次发布时自动创建 ${archiveDir}`,
      data: { archiveDir }
    })
  }

  /* 5. 远端哈希能力 */
  const cap = probe.capability
  if (cap?.hasSha256sum) {
    checks.push({
      key: 'hash-tool',
      label: '远端校验能力',
      level: 'ok',
      detail: '具备 sha256sum，可使用快速校验'
    })
  } else if (cap?.hasShasum) {
    checks.push({
      key: 'hash-tool',
      label: '远端校验能力',
      level: 'ok',
      detail: '具备 shasum，可使用快速校验'
    })
  } else if (cap) {
    checks.push({
      key: 'hash-tool',
      label: '远端校验能力',
      level: 'warn',
      detail: '远端没有 sha256sum / shasum',
      suggestion: '发布后的完整性校验会降级为 SFTP 流式读取，结果正确但大目录较慢。'
    })
  }

  const ok = checks.every((c) => c.level !== 'error')
  const pathCheck = checks.find((c) => c.key === 'path')
  const needCreateChoice = pathCheck?.level === 'warn' && input.kind === 'dir'

  return {
    ok,
    checks,
    needCreateChoice,
    existingVersions: probe.existingVersions
  }
}

/**
 * 把体检报告转成一句人话，用于日志与"复制诊断信息"。
 */
export function summarizeHealth(report: HealthReport): string {
  const bad = report.checks.filter((c) => c.level !== 'ok')
  if (bad.length === 0) return '体检全部通过'
  return bad.map((c) => `${c.label}：${c.detail}`).join('；')
}

/**
 * 体检不通过时抛 AppError，供调用方快速失败（也可只取报告自行展示）。
 */
export function assertHealthy(report: HealthReport): void {
  const firstError = report.checks.find((c) => c.level === 'error')
  if (!firstError) return
  throw new AppError(ErrorCode.E_PARAM, { check: firstError.key, detail: firstError.detail })
}
