/**
 * 工作环境与目标资源服务（T05.1 / T05.2 / T05.5）。
 *
 * 职责：环境的 CRUD、目标资源的 CRUD 与校验。
 *
 * 一条必须守住的语义（方案书 §6.4）：
 * **删除环境 = 级联删除本机配置与台账索引，但绝不删除服务器上的任何文件。**
 * 因此删除操作在这里只动数据库；远端文件的删除只发生在"往期版本删除"这种
 * 显式且二次确认的场景（B12）。这条语义要写进 UI 文案，不能只是口头约定。
 *
 * 本模块不直接建连：体检（T05.7）需要的远端能力由调用方注入，
 * 这样单测可以塞假实现，不必真连服务器。
 */
import { AppError, ErrorCode } from '../infra/errors'
import { logger } from '../infra/logger'
import { requireSafeRemotePath, UnsafePathError } from '../infra/remote-path'
import { inferTargetKind, resolveArchiveDir } from '../infra/archive-dir'
import { parseRetainPolicy, type RetainPolicy } from '../../shared/contracts/workspace'
import type { Repositories } from '../db/repositories'
import type { Environment as EnvRow, Target as TargetRow } from '../db/schema'

/* ------------------------------------------------------------------ 类型 */

export type EnvType = 'prod' | 'test' | 'custom'
export type TargetKind = 'dir' | 'file'

export interface EnvironmentView {
  id: string
  name: string
  envType: EnvType
  description: string | null
  connectionId: string
  color: string | null
  sortOrder: number
  /** 该环境下的目标数量（列表页展示用） */
  targetCount: number
  createdAt: string
  updatedAt: string
}

export interface TargetView {
  id: string
  environmentId: string
  name: string
  kind: TargetKind
  remotePath: string
  archiveDir: string
  /** archiveDir 是否为用户自定义 */
  archiveDirOverridden: boolean
  localPath: string | null
  /** 排除规则（已解析为数组） */
  localExclude: string[]
  hashAlgo: string
  verifyRemote: boolean
  /** 保留策略（已解析） */
  retainPolicy: RetainPolicy | null
  deployStrategy: 'rename' | 'copy'
  autoConnect: boolean
  lastDeployAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * 保留策略类型来自 shared 契约，这里只做**转发导出**。
 *
 * 原先这里另有一份同形状的 `interface RetainPolicy`（`B15` 顺手清掉）：
 * 两份定义在"字段完全一致"时不会报错，但哪天共享侧加了字段（比如"按体积保留"），
 * 这里的旧形状会继续编译通过，于是"表单存得下、清理时读不出"。
 */
export type { RetainPolicy }

export interface EnvironmentInput {
  name: string
  envType: EnvType
  connectionId: string
  description?: string | null
  color?: string | null
  sortOrder?: number
}

export interface TargetInput {
  environmentId: string
  name: string
  remotePath: string
  /** 不传则按 `.jar` 规则推断 */
  kind?: TargetKind
  archiveDir?: string | null
  localPath?: string | null
  localExclude?: string[]
  verifyRemote?: boolean
  retainPolicy?: RetainPolicy | null
  deployStrategy?: 'rename' | 'copy'
  autoConnect?: boolean
}

const ENV_COLORS: Record<EnvType, string> = {
  prod: '#f56c6c',
  test: '#409eff',
  custom: '#909399'
}

/* ------------------------------------------------------------------ 解析 */

function parseExclude(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ 服务 */

export interface WorkspaceServiceDeps {
  repo: Repositories
  /**
   * 新建目标时的默认保留策略（B15 / T15.2）。
   *
   * 做成函数而不是数值：设置可以在运行期改，取值必须发生在"新建目标"那一刻。
   *
   * 三种入参语义要分清：
   * - 传了具体策略 → 用它；
   * - **显式传 `null`** → 这个目标就是不清理（用户在表单里明确选的），**不要**覆盖成默认；
   * - 没传（`undefined`）→ 用这里的默认值。
   *
   * 把后两者混起来是个很容易犯的错：那样用户每次"特意关掉保留策略"都会被默认值改回去，
   * 而界面上看起来是保存成功了。
   */
  defaultRetainPolicy?: () => RetainPolicy | null
}

export function createWorkspaceService(deps: WorkspaceServiceDeps) {
  const { repo } = deps

  /* ------------------------------------------------------------ 环境 CRUD */

  function toEnvView(row: EnvRow): EnvironmentView {
    return {
      id: row.id,
      name: row.name,
      envType: row.envType as EnvType,
      description: row.description ?? null,
      connectionId: row.connectionId,
      color: row.color ?? null,
      sortOrder: row.sortOrder,
      targetCount: repo.targets.listByEnvironment(row.id).length,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  const environments = {
    list(): EnvironmentView[] {
      return repo.environments.list().map(toEnvView)
    },

    get(id: string): EnvironmentView {
      const row = repo.environments.get(id)
      if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { id })
      return toEnvView(row)
    },

    create(input: EnvironmentInput): EnvironmentView {
      assertEnvInput(input)

      // 名称唯一（方案书 §5.2 的 UNIQUE 约束），这里先查一次以给出中文提示
      // 而不是把 SQLite 的英文约束错误抛给用户
      if (repo.environments.findByName(input.name.trim())) {
        throw new AppError(ErrorCode.E_DUPLICATE_NAME, { name: input.name })
      }
      if (!repo.connections.get(input.connectionId)) {
        throw new AppError(ErrorCode.E_NOT_FOUND, { connectionId: input.connectionId })
      }

      const row = repo.environments.create({
        name: input.name.trim(),
        envType: input.envType,
        connectionId: input.connectionId,
        description: input.description ?? null,
        // 未指定颜色时按环境类型给默认色（生产红、测试蓝），方案书 §9.1
        color: input.color ?? ENV_COLORS[input.envType],
        sortOrder: input.sortOrder ?? 0
      })
      logger.info(`environment created: ${row.name} (${row.envType})`)
      return toEnvView(row)
    },

    update(id: string, patch: Partial<EnvironmentInput>): EnvironmentView {
      const existing = repo.environments.get(id)
      if (!existing) throw new AppError(ErrorCode.E_NOT_FOUND, { id })

      const next: Parameters<typeof repo.environments.update>[1] = {}
      if (patch.name !== undefined) {
        const name = patch.name.trim()
        if (!name) throw new AppError(ErrorCode.E_PARAM, { field: 'name' })
        const other = repo.environments.findByName(name)
        if (other && other.id !== id) throw new AppError(ErrorCode.E_DUPLICATE_NAME, { name })
        next.name = name
      }
      if (patch.envType !== undefined) next.envType = patch.envType
      if (patch.connectionId !== undefined) {
        if (!repo.connections.get(patch.connectionId)) {
          throw new AppError(ErrorCode.E_NOT_FOUND, { connectionId: patch.connectionId })
        }
        next.connectionId = patch.connectionId
      }
      if (patch.description !== undefined) next.description = patch.description
      if (patch.color !== undefined) next.color = patch.color
      if (patch.sortOrder !== undefined) next.sortOrder = patch.sortOrder

      const row = repo.environments.update(id, next)!
      return toEnvView(row)
    },

    /**
     * 删除环境（T05.2）。
     *
     * 级联删除其下的目标、发布记录与归档**索引**（数据库层面 CASCADE），
     * **绝不触碰服务器上的文件**。调用方（UI）必须把这句话明确写给用户。
     */
    remove(id: string): { removedTargets: number } {
      const env = repo.environments.get(id)
      if (!env) throw new AppError(ErrorCode.E_NOT_FOUND, { id })

      const targets = repo.targets.listByEnvironment(id)
      repo.environments.remove(id) // 外键 CASCADE 会带走 targets/releases/archives
      logger.info(
        `environment removed: ${env.name}; cascade deleted ${targets.length} target(s) ` +
          `(local records only - no remote files touched)`
      )
      return { removedTargets: targets.length }
    },

    /** 供 UI 在删除前提示"将影响什么"，避免用户误以为会删服务器文件。 */
    describeRemoval(id: string): { targetCount: number; warning: string } {
      const env = repo.environments.get(id)
      if (!env) throw new AppError(ErrorCode.E_NOT_FOUND, { id })
      const count = repo.targets.listByEnvironment(id).length
      return {
        targetCount: count,
        warning:
          `将删除环境「${env.name}」及其下 ${count} 个目标的**本机配置与台账记录**。\n` +
          '服务器上的文件与往期版本**不会被删除**，仍可用其他方式访问。'
      }
    }
  }

  /* ------------------------------------------------------------ 目标 CRUD */

  function toTargetView(row: TargetRow): TargetView {
    const inferred = resolveArchiveDir({
      remotePath: row.remotePath,
      archiveDir: null,
      kind: row.kind as TargetKind
    })
    return {
      id: row.id,
      environmentId: row.environmentId,
      name: row.name,
      kind: row.kind as TargetKind,
      remotePath: row.remotePath,
      archiveDir: row.archiveDir ?? inferred,
      archiveDirOverridden: Boolean(row.archiveDir),
      localPath: row.localPath ?? null,
      localExclude: parseExclude(row.localExclude),
      hashAlgo: row.hashAlgo,
      verifyRemote: row.verifyRemote,
      retainPolicy: parseRetainPolicy(row.retainPolicy),
      deployStrategy: row.deployStrategy as 'rename' | 'copy',
      autoConnect: row.autoConnect,
      lastDeployAt: row.lastDeployAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  const targets = {
    list(environmentId: string): TargetView[] {
      return repo.targets.listByEnvironment(environmentId).map(toTargetView)
    },

    listAll(): TargetView[] {
      return repo.targets.listAll().map(toTargetView)
    },

    get(id: string): TargetView {
      const row = repo.targets.get(id)
      if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { id })
      return toTargetView(row)
    },

    create(input: TargetInput): TargetView {
      if (!repo.environments.get(input.environmentId)) {
        throw new AppError(ErrorCode.E_NOT_FOUND, { environmentId: input.environmentId })
      }
      const remotePath = safePath(input.remotePath, 'remotePath')
      if (!input.name?.trim()) throw new AppError(ErrorCode.E_PARAM, { field: 'name' })

      // 同环境内 remote_path 唯一（方案书 §5.2）
      if (repo.targets.findByPath(input.environmentId, remotePath)) {
        throw new AppError(ErrorCode.E_DUPLICATE_NAME, { remotePath })
      }

      const archiveDir = input.archiveDir ? safePath(input.archiveDir, 'archiveDir') : null
      // 自定义归档目录若与目标相同会导致自嵌套，直接拒绝
      if (archiveDir && archiveDir === remotePath) {
        throw new AppError(ErrorCode.E_PATH_UNSAFE, {
          reason: 'archiveDir-same-as-target',
          message: '归档目录不能与目标路径相同'
        })
      }

      const kind = input.kind ?? inferTargetKind(remotePath)
      /**
       * 保留策略：只在调用方**没提这件事**时才套用默认值。
       * 显式 `null` 是"我不想要保留策略"，必须原样保存（见 deps 上的说明）。
       */
      const retainPolicy =
        input.retainPolicy !== undefined ? input.retainPolicy : (deps.defaultRetainPolicy?.() ?? null)
      const row = repo.targets.create({
        environmentId: input.environmentId,
        name: input.name.trim(),
        kind,
        remotePath,
        archiveDir,
        localPath: input.localPath ?? null,
        localExclude: JSON.stringify(input.localExclude ?? []),
        verifyRemote: input.verifyRemote ?? true,
        retainPolicy: retainPolicy ? JSON.stringify(retainPolicy) : null,
        deployStrategy: input.deployStrategy ?? 'rename',
        autoConnect: input.autoConnect ?? false
      })
      logger.info(`target created: ${row.name} -> ${row.remotePath} (${row.kind})`)
      return toTargetView(row)
    },

    update(id: string, patch: Partial<TargetInput>): TargetView {
      const existing = repo.targets.get(id)
      if (!existing) throw new AppError(ErrorCode.E_NOT_FOUND, { id })

      const next: Parameters<typeof repo.targets.update>[1] = {}

      if (patch.remotePath !== undefined) {
        const remotePath = safePath(patch.remotePath, 'remotePath')
        const other = repo.targets.findByPath(existing.environmentId, remotePath)
        if (other && other.id !== id) {
          throw new AppError(ErrorCode.E_DUPLICATE_NAME, { remotePath })
        }
        next.remotePath = remotePath
      }
      if (patch.name !== undefined) {
        if (!patch.name.trim()) throw new AppError(ErrorCode.E_PARAM, { field: 'name' })
        next.name = patch.name.trim()
      }
      if (patch.kind !== undefined) next.kind = patch.kind
      if (patch.archiveDir !== undefined) {
        next.archiveDir = patch.archiveDir ? safePath(patch.archiveDir, 'archiveDir') : null
      }
      if (patch.localPath !== undefined) next.localPath = patch.localPath
      if (patch.localExclude !== undefined) next.localExclude = JSON.stringify(patch.localExclude)
      if (patch.verifyRemote !== undefined) next.verifyRemote = patch.verifyRemote
      if (patch.retainPolicy !== undefined) {
        next.retainPolicy = patch.retainPolicy ? JSON.stringify(patch.retainPolicy) : null
      }
      if (patch.deployStrategy !== undefined) next.deployStrategy = patch.deployStrategy
      if (patch.autoConnect !== undefined) next.autoConnect = patch.autoConnect

      const row = repo.targets.update(id, next)!
      return toTargetView(row)
    },

    /**
     * 删除目标：只删本机配置与台账索引，**不动服务器文件**。
     * 架构层面由外键 CASCADE 带走 releases/archives 索引。
     */
    remove(id: string): { removedReleases: number; removedArchives: number } {
      const row = repo.targets.get(id)
      if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, { id })
      const releases = repo.releases.listByTarget(id, 100000).length
      const archives = repo.archives.listByTarget(id).length
      repo.targets.remove(id)
      logger.info(
        `target removed: ${row.name} (local records only; releases=${releases} archives=${archives})`
      )
      return { removedReleases: releases, removedArchives: archives }
    },

    /** 供 UI 展示归档目录推导结果（用户可覆盖）。 */
    previewArchiveDir(remotePath: string, archiveDir?: string | null): string {
      const p = safePath(remotePath, 'remotePath')
      return resolveArchiveDir({ remotePath: p, archiveDir: archiveDir ?? null })
    }
  }

  return { environments, targets }
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>

/* ---------------------------------------------------------------- 校验 */

function assertEnvInput(input: EnvironmentInput): void {
  const issues: string[] = []
  if (!input.name?.trim()) issues.push('name')
  if (!input.envType) issues.push('envType')
  if (!input.connectionId) issues.push('connectionId')
  if (issues.length > 0) throw new AppError(ErrorCode.E_PARAM, { issues })
}

/** 路径校验失败时转成带中文原因的 AppError，而不是抛底层错误。 */
function safePath(value: string, field: string): string {
  try {
    return requireSafeRemotePath(value)
  } catch (e) {
    if (e instanceof UnsafePathError) {
      throw new AppError(
        ErrorCode.E_PATH_UNSAFE,
        { field, reason: e.reason },
        { message: e.message }
      )
    }
    throw e
  }
}
