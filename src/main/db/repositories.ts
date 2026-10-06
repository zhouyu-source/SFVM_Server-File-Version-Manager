/**
 * 仓储层工厂（T02.9 / T02.10）。
 *
 * 形式选择：`createRepositories(db)` 返回一组仓储，而不是模块级单例。
 * 理由：单测可以直接塞一个临时库；不需要 mock 全局状态；
 * 将来多库（如导入导出）也不用改结构。
 *
 * 所有仓储只做数据读写，**不含业务规则**（业务在 services/，B03 起）。
 */
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { Db } from './client'
import { newId } from './id'
import {
  RELEASE_STATUSES as RELEASE_STATUSES_SRC,
  TERMINAL_RELEASE_STATUSES as TERMINAL_RELEASE_STATUSES_SRC
} from '../../shared/contracts/deploy'
import {
  appSettings,
  archives,
  auditLogs,
  connections,
  environments,
  knownHosts,
  pipelineSteps,
  pipelines,
  releaseItems,
  releases,
  scriptRuns,
  scriptStepRuns,
  targets,
  type NewArchive,
  type NewAuditLog,
  type NewConnection,
  type NewEnvironment,
  type NewPipeline,
  type NewPipelineStep,
  type NewRelease,
  type NewReleaseItem,
  type NewScriptRun,
  type NewScriptStepRun,
  type NewTarget
} from './schema'
import { DEFAULT_SCRIPT_RUN_LIST_LIMIT } from '../../shared/contracts/script'

/** 统一的更新时间戳（ISO-8601 UTC）。 */
function ts(): string {
  return new Date().toISOString()
}

/**
 * 发布记录的**终态**状态（方案书 §5.2 的 status 取值）。
 * 不在此列表中的即为"可能中断"，B14 的启动残留扫描依赖这个定义。
 * 用 `[...]` 展开成 string[]，供 notInArray 使用（它要求可变数组）。
 *
 * 定义本身已提到 `shared/contracts/deploy.ts`（B10）：主进程与渲染进程都要用
 * 同一份"哪些状态是终态"的判断（B13 要据此决定"这个版本还能不能回滚"），
 * 两处各写一份迟早错位。这里保留同名导出，避免调用方大批改动。
 */
export const TERMINAL_RELEASE_STATUSES: string[] = [...TERMINAL_RELEASE_STATUSES_SRC]

/** 发布流程的全部状态，供状态机校验（T10.1）使用。 */
export const RELEASE_STATUSES = RELEASE_STATUSES_SRC

/**
 * 往期版本列表的默认条数上限。
 *
 * 必须有上限：留着几千个历史版本的目录是真实存在的（每天发布 × 数年），
 * 而 UI 一次也就展示一屏。真正要全量时由调用方显式传 `limit`。
 */
export const DEFAULT_ARCHIVE_LIST_LIMIT = 1000

export function createRepositories(db: Db) {
  /* ----------------------------------------------------------- connections */

  const connectionsRepo = {
    list: () => db.select().from(connections).orderBy(connections.name).all(),

    get: (id: string) => db.select().from(connections).where(eq(connections.id, id)).get(),

    create: (input: Omit<NewConnection, 'id' | 'createdAt' | 'updatedAt'>) => {
      const row: NewConnection = { ...input, id: newId(), createdAt: ts(), updatedAt: ts() }
      db.insert(connections).values(row).run()
      return connectionsRepo.get(row.id)!
    },

    update: (id: string, patch: Partial<NewConnection>) => {
      db.update(connections)
        .set({ ...patch, updatedAt: ts() })
        .where(eq(connections.id, id))
        .run()
      return connectionsRepo.get(id)
    },

    remove: (id: string) => {
      db.delete(connections).where(eq(connections.id, id)).run()
    },

    /** 供自动登录使用（方案书 §7.3） */
    listAutoConnect: () =>
      db.select().from(connections).where(eq(connections.autoConnect, true)).all(),

    markConnected: (id: string) => {
      db.update(connections)
        .set({ lastConnectedAt: ts(), updatedAt: ts() })
        .where(eq(connections.id, id))
        .run()
    },

    /** 该连接是否被环境引用（删除前校验，方案书 §8.1） */
    countEnvironments: (id: string) => {
      const r = db
        .select({ c: sql<number>`count(*)` })
        .from(environments)
        .where(eq(environments.connectionId, id))
        .get()
      return r?.c ?? 0
    }
  }

  /* ----------------------------------------------------------- known_hosts */

  const knownHostsRepo = {
    list: () => db.select().from(knownHosts).all(),

    find: (host: string, port: number, keyType: string) =>
      db
        .select()
        .from(knownHosts)
        .where(
          and(eq(knownHosts.host, host), eq(knownHosts.port, port), eq(knownHosts.keyType, keyType))
        )
        .get(),

    /** 记录/更新某个 (host,port,keyType) 的指纹（TOFU） */
    trust: (host: string, port: number, keyType: string, fingerprint: string) => {
      const existing = knownHostsRepo.find(host, port, keyType)
      if (existing) {
        db.update(knownHosts)
          .set({ fingerprint, trustedAt: ts() })
          .where(eq(knownHosts.id, existing.id))
          .run()
        return knownHostsRepo.find(host, port, keyType)!
      }
      const row = { id: newId(), host, port, keyType, fingerprint, trustedAt: ts() }
      db.insert(knownHosts).values(row).run()
      return row
    },

    remove: (id: string) => {
      db.delete(knownHosts).where(eq(knownHosts.id, id)).run()
    }
  }

  /* ---------------------------------------------------------- environments */

  const environmentsRepo = {
    list: () =>
      db.select().from(environments).orderBy(environments.sortOrder, environments.name).all(),

    get: (id: string) => db.select().from(environments).where(eq(environments.id, id)).get(),

    findByName: (name: string) =>
      db.select().from(environments).where(eq(environments.name, name)).get(),

    create: (input: Omit<NewEnvironment, 'id' | 'createdAt' | 'updatedAt'>) => {
      const row: NewEnvironment = { ...input, id: newId(), createdAt: ts(), updatedAt: ts() }
      db.insert(environments).values(row).run()
      return environmentsRepo.get(row.id)!
    },

    update: (id: string, patch: Partial<NewEnvironment>) => {
      db.update(environments)
        .set({ ...patch, updatedAt: ts() })
        .where(eq(environments.id, id))
        .run()
      return environmentsRepo.get(id)
    },

    remove: (id: string) => {
      db.delete(environments).where(eq(environments.id, id)).run()
    }
  }

  /* --------------------------------------------------------------- targets */

  const targetsRepo = {
    listByEnvironment: (environmentId: string) =>
      db
        .select()
        .from(targets)
        .where(eq(targets.environmentId, environmentId))
        .orderBy(targets.name)
        .all(),

    listAll: () => db.select().from(targets).all(),

    get: (id: string) => db.select().from(targets).where(eq(targets.id, id)).get(),

    findByPath: (environmentId: string, remotePath: string) =>
      db
        .select()
        .from(targets)
        .where(and(eq(targets.environmentId, environmentId), eq(targets.remotePath, remotePath)))
        .get(),

    create: (input: Omit<NewTarget, 'id' | 'createdAt' | 'updatedAt'>) => {
      const row: NewTarget = { ...input, id: newId(), createdAt: ts(), updatedAt: ts() }
      db.insert(targets).values(row).run()
      return targetsRepo.get(row.id)!
    },

    update: (id: string, patch: Partial<NewTarget>) => {
      db.update(targets)
        .set({ ...patch, updatedAt: ts() })
        .where(eq(targets.id, id))
        .run()
      return targetsRepo.get(id)
    },

    remove: (id: string) => {
      db.delete(targets).where(eq(targets.id, id)).run()
    },

    markDeployed: (id: string) => {
      db.update(targets)
        .set({ lastDeployAt: ts(), updatedAt: ts() })
        .where(eq(targets.id, id))
        .run()
    }
  }

  /* -------------------------------------------------------------- releases */

  const releasesRepo = {
    get: (id: string) => db.select().from(releases).where(eq(releases.id, id)).get(),

    /** 台账列表：按开始时间倒序（方案书 idx_releases_target_time） */
    listByTarget: (targetId: string, limit = 100) =>
      db
        .select()
        .from(releases)
        .where(eq(releases.targetId, targetId))
        .orderBy(desc(releases.startedAt))
        .limit(limit)
        .all(),

    listRecent: (limit = 100) =>
      db.select().from(releases).orderBy(desc(releases.startedAt)).limit(limit).all(),

    /**
     * 建一条发布记录。
     *
     * `id` 可以显式指定（发布流程要它）：B10 的发布把 **任务 id、
     * 台账行 id、远端暂存目录后缀** 三者统一成同一个值 ——
     * 用户从"任务控制台"看到某个任务、从"发布历史"看见某条记录、
     * 在服务器上看见 `.sfvm-staging-<X>`，看到的是同一个 X，排障时不用来回对照，
     * B14 的对账也能按 id 直接找到该清理哪个暂存目录。
     * 不传则自动生成（其余调用方不需要关心三者一致）。
     */
    create: (input: Omit<NewRelease, 'id' | 'startedAt'> & { id?: string }) => {
      const row: NewRelease = { ...input, id: input.id ?? newId(), startedAt: ts() }
      db.insert(releases).values(row).run()
      return releasesRepo.get(row.id)!
    },

    update: (id: string, patch: Partial<NewRelease>) => {
      db.update(releases).set(patch).where(eq(releases.id, id)).run()
      return releasesRepo.get(id)
    },

    finish: (id: string, status: string, errorMessage?: string) => {
      db.update(releases)
        .set({ status, errorMessage: errorMessage ?? null, finishedAt: ts() })
        .where(eq(releases.id, id))
        .run()
      return releasesRepo.get(id)
    },

    remove: (id: string) => {
      db.delete(releases).where(eq(releases.id, id)).run()
    },

    /**
     * 非终态任务（B14 启动残留扫描用）。
     * 终态 = SUCCESS / FAILED / ROLLED_BACK；其余都算"可能中断"。
     */
    listUnfinished: () =>
      db
        .select()
        .from(releases)
        .where(notInArray(releases.status, TERMINAL_RELEASE_STATUSES))
        .orderBy(desc(releases.startedAt))
        .all(),

    /** 指定目标是否存在非终态任务（并发控制用，T10.11） */
    listUnfinishedByTarget: (targetId: string) =>
      db
        .select()
        .from(releases)
        .where(
          and(
            eq(releases.targetId, targetId),
            notInArray(releases.status, TERMINAL_RELEASE_STATUSES)
          )
        )
        .all(),

    listByStatus: (statuses: string[]) =>
      db
        .select()
        .from(releases)
        .where(inArray(releases.status, statuses))
        .orderBy(desc(releases.startedAt))
        .all()
  }

  /* --------------------------------------------------------- release_items */

  const releaseItemsRepo = {
    listByRelease: (releaseId: string) =>
      db
        .select()
        .from(releaseItems)
        .where(eq(releaseItems.releaseId, releaseId))
        .orderBy(releaseItems.relPath)
        .all(),

    addMany: (items: Omit<NewReleaseItem, 'id'>[]) => {
      if (items.length === 0) return 0
      const rows: NewReleaseItem[] = items.map((i) => ({ ...i, id: newId() }))
      // 大目录可能上万条，用事务包住避免逐条提交
      db.transaction((tx) => {
        for (const r of rows) tx.insert(releaseItems).values(r).run()
      })
      return rows.length
    },

    removeByRelease: (releaseId: string) => {
      db.delete(releaseItems).where(eq(releaseItems.releaseId, releaseId)).run()
    }
  }

  /* -------------------------------------------------------------- archives */

  const archivesRepo = {
    get: (id: string) => db.select().from(archives).where(eq(archives.id, id)).get(),

    findByTag: (targetId: string, versionTag: string) =>
      db
        .select()
        .from(archives)
        .where(and(eq(archives.targetId, targetId), eq(archives.versionTag, versionTag)))
        .get(),

    /** 往期版本列表：按归档时间倒序（方案书 idx_archives_target_time） */
    listByTarget: (targetId: string, limit = DEFAULT_ARCHIVE_LIST_LIMIT) =>
      db
        .select()
        .from(archives)
        .where(eq(archives.targetId, targetId))
        .orderBy(desc(archives.archivedAt))
        .limit(limit)
        .all(),

    /** 该目标的往期版本条数（保留策略与 UI 计数用，避免为了一个数字查出全部行） */
    countByTarget: (targetId: string) => {
      const r = db
        .select({ c: sql<number>`count(*)` })
        .from(archives)
        .where(eq(archives.targetId, targetId))
        .get()
      return r?.c ?? 0
    },

    /** 按状态筛选（B14 对账要一次捞出所有 missing/corrupt 的版本） */
    listByStatus: (status: string) =>
      db.select().from(archives).where(eq(archives.status, status)).all(),

    /**
     * 台账聚合（B12 / T12.6）：条数 / 总字节 / 时间跨度 / 状态分布。
     *
     * 用 SQL 聚合而不是"捞出全部行再在应用层算"：往期版本可能有几千条，
     * 而详情页每次打开都要这几个数字。返回**原始行**、不在这里拼成
     * `ArchiveSummary` —— 视图形状属于契约层的事，仓储只负责取数。
     */
    summaryByTarget: (
      targetId: string
    ): {
      count: number
      bytes: number
      oldest: string | null
      newest: string | null
      byStatus: Array<{ status: string; count: number }>
    } => {
      const agg = db
        .select({
          count: sql<number>`count(*)`,
          bytes: sql<number>`coalesce(sum(${archives.totalBytes}), 0)`,
          oldest: sql<string | null>`min(${archives.archivedAt})`,
          newest: sql<string | null>`max(${archives.archivedAt})`
        })
        .from(archives)
        .where(eq(archives.targetId, targetId))
        .get()

      const byStatus = db
        .select({ status: archives.status, count: sql<number>`count(*)` })
        .from(archives)
        .where(eq(archives.targetId, targetId))
        .groupBy(archives.status)
        .all()

      return {
        count: agg?.count ?? 0,
        bytes: agg?.bytes ?? 0,
        oldest: agg?.oldest ?? null,
        newest: agg?.newest ?? null,
        byStatus
      }
    },

    /**
     * 建一条归档记录。
     *
     * `archivedAt` 可以显式指定（B14 对账补录时**必须**如此）：它是"这个版本
     * 什么时候归档的"唯一可靠记录，来自远端 manifest。用"现在"会让
     * MT-06（删库后重建台账）的时间与重建前对不上，往期版本列表的排序也会整体乱掉。
     */
    create: (input: Omit<NewArchive, 'id' | 'archivedAt'> & { archivedAt?: string }) => {
      const row: NewArchive = { ...input, id: newId(), archivedAt: input.archivedAt ?? ts() }
      db.insert(archives).values(row).run()
      return archivesRepo.get(row.id)!
    },

    update: (id: string, patch: Partial<NewArchive>) => {
      db.update(archives).set(patch).where(eq(archives.id, id)).run()
      return archivesRepo.get(id)
    },

    setStatus: (id: string, status: string) => {
      db.update(archives).set({ status }).where(eq(archives.id, id)).run()
      return archivesRepo.get(id)
    },

    remove: (id: string) => {
      db.delete(archives).where(eq(archives.id, id)).run()
    },

    removeMany: (ids: string[]) => {
      if (ids.length === 0) return
      db.transaction((tx) => {
        for (const id of ids) tx.delete(archives).where(eq(archives.id, id)).run()
      })
    }
  }

  /* ------------------------------------------------------------ app_settings */

  const settingsRepo = {
    get: (key: string) => db.select().from(appSettings).where(eq(appSettings.key, key)).get(),

    getValue: (key: string): string | undefined =>
      db.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value,

    set: (key: string, value: string) => {
      const existing = settingsRepo.get(key)
      if (existing) {
        db.update(appSettings).set({ value, updatedAt: ts() }).where(eq(appSettings.key, key)).run()
      } else {
        db.insert(appSettings).values({ key, value, updatedAt: ts() }).run()
      }
    },

    /** 便捷读：JSON 解析失败返回默认值而不是抛错 */
    getJson: <T>(key: string, fallback: T): T => {
      const raw = settingsRepo.getValue(key)
      if (raw === undefined) return fallback
      try {
        return JSON.parse(raw) as T
      } catch {
        return fallback
      }
    },

    setJson: (key: string, value: unknown) => {
      settingsRepo.set(key, JSON.stringify(value))
    },

    list: () => db.select().from(appSettings).all(),

    remove: (key: string) => {
      db.delete(appSettings).where(eq(appSettings.key, key)).run()
    }
  }

  /* ------------------------------------------------------------- audit_logs */

  const auditRepo = {
    /** 写入审计。detail 约定为**已脱敏**的 JSON 字符串 */
    write: (input: Omit<NewAuditLog, 'id' | 'ts'>) => {
      db.insert(auditLogs)
        .values({ ...input, ts: ts() })
        .run()
    },

    listRecent: (limit = 200) =>
      db.select().from(auditLogs).orderBy(desc(auditLogs.ts)).limit(limit).all(),

    listByRef: (refId: string, limit = 200) =>
      db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.refId, refId))
        .orderBy(desc(auditLogs.ts))
        .limit(limit)
        .all(),

    clear: () => {
      db.delete(auditLogs).run()
    }
  }

  /* ----------------------------------------------------- 脚本运行记录（B20） */

  /**
   * 一次脚本运行。
   *
   * `startedAt` 可以显式指定（与 `archives.create` 同理）：将来若有"补录"或
   * 测试夹具需要固定时间，不至于又要改仓储。
   */
  const scriptRunsRepo = {
    get: (id: string) => db.select().from(scriptRuns).where(eq(scriptRuns.id, id)).get(),

    /** 某个目标的运行记录：按开始时间倒序（新的在前） */
    listByTarget: (targetId: string, limit = DEFAULT_SCRIPT_RUN_LIST_LIMIT) =>
      db
        .select()
        .from(scriptRuns)
        .where(eq(scriptRuns.targetId, targetId))
        .orderBy(desc(scriptRuns.startedAt))
        .limit(limit)
        .all(),

    /** 按任务查（任务台里点一个脚本任务，想知道它写了哪条运行记录） */
    listByJob: (jobId: string) =>
      db.select().from(scriptRuns).where(eq(scriptRuns.jobId, jobId)).all(),

    create: (input: Omit<NewScriptRun, 'id' | 'startedAt'> & { startedAt?: string }) => {
      const row: NewScriptRun = { ...input, id: newId(), startedAt: input.startedAt ?? ts() }
      db.insert(scriptRuns).values(row).run()
      return scriptRunsRepo.get(row.id)!
    },

    /** 落终态。`errorMessage` 传 null 表示清掉（重跑一条同 id 记录时不会发生，但保持对称） */
    finish: (id: string, status: string, errorMessage: string | null = null) => {
      db.update(scriptRuns)
        .set({ status, errorMessage, finishedAt: ts() })
        .where(eq(scriptRuns.id, id))
        .run()
      return scriptRunsRepo.get(id)
    },

    remove: (id: string) => {
      db.delete(scriptRuns).where(eq(scriptRuns.id, id)).run()
    }
  }

  const scriptStepRunsRepo = {
    get: (id: string) => db.select().from(scriptStepRuns).where(eq(scriptStepRuns.id, id)).get(),

    listByRun: (runId: string) =>
      db
        .select()
        .from(scriptStepRuns)
        .where(eq(scriptStepRuns.runId, runId))
        .orderBy(scriptStepRuns.seq)
        .all(),

    create: (input: Omit<NewScriptStepRun, 'id' | 'startedAt'> & { startedAt?: string }) => {
      const row: NewScriptStepRun = { ...input, id: newId(), startedAt: input.startedAt ?? ts() }
      db.insert(scriptStepRuns).values(row).run()
      return scriptStepRunsRepo.get(row.id)!
    },

    /**
     * 落一步的终态。
     *
     * 做成"一次给全"的 patch 而不是几个小方法：这些字段**必须一起确定**
     * （退出码、耗时、输出尾部、截断标志在同一时刻才知道），分成多次写会出现
     * "状态已是 failed 但还没有错误说明"的中间态被 UI 读到。
     */
    finish: (
      id: string,
      patch: {
        status: string
        exitCode: number | null
        durationMs: number | null
        outputPath: string | null
        outputBytes: number
        truncated: boolean
        outputTail: string | null
        errorMessage: string | null
      }
    ) => {
      db.update(scriptStepRuns)
        .set({ ...patch, finishedAt: ts() })
        .where(eq(scriptStepRuns.id, id))
        .run()
      return scriptStepRunsRepo.get(id)
    }
  }

  /* ------------------------------------------------------------ pipelines */

  const pipelinesRepo = {
    get: (id: string) => db.select().from(pipelines).where(eq(pipelines.id, id)).get(),

    /** 某个目标的全部流水线：按创建时间正序（同一批建的自然成组） */
    listByTarget: (targetId: string) =>
      db
        .select()
        .from(pipelines)
        .where(eq(pipelines.targetId, targetId))
        .orderBy(pipelines.createdAt, pipelines.name)
        .all(),

    /** 查重（同一目标下不允许同名）—— 保存前先问一句，好给出比"唯一约束冲突"好的提示 */
    findByName: (targetId: string, name: string) =>
      db
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.targetId, targetId), eq(pipelines.name, name)))
        .get(),

    create: (input: Omit<NewPipeline, 'id' | 'createdAt' | 'updatedAt'>) => {
      const stamp = ts()
      const row: NewPipeline = { ...input, id: newId(), createdAt: stamp, updatedAt: stamp }
      db.insert(pipelines).values(row).run()
      return pipelinesRepo.get(row.id)!
    },

    update: (id: string, patch: { name: string; description: string | null }) => {
      db.update(pipelines)
        .set({ ...patch, updatedAt: ts() })
        .where(eq(pipelines.id, id))
        .run()
      return pipelinesRepo.get(id)
    },

    remove: (id: string) => {
      db.delete(pipelines).where(eq(pipelines.id, id)).run()
    }
  }

  const pipelineStepsRepo = {
    listByPipeline: (pipelineId: string) =>
      db
        .select()
        .from(pipelineSteps)
        .where(eq(pipelineSteps.pipelineId, pipelineId))
        .orderBy(pipelineSteps.seq)
        .all(),

    /**
     * 整组替换一条流水线的步骤。
     *
     * **不做逐条 diff**：步骤要能上移/下移，而"移动"在逐条比对下会变成一串
     * update + 序号冲突（`UNIQUE(pipeline_id, seq)` 会在中途报错）。整组换掉
     * 就没有这个问题，代价只是步骤 id 会变 —— 而步骤 id 除了 `remove` 之外
     * 没有外部引用（运行记录用的是 `seq` 与快照，不是步骤 id）。
     *
     * 必须在一个事务里：先删后插之间的空档如果被别的读操作撞上，
     * 界面会看到「一条没有步骤的流水线」。
     */
    replaceAll: (
      pipelineId: string,
      steps: Array<Omit<NewPipelineStep, 'id' | 'pipelineId'>>
    ): void => {
      db.transaction((tx) => {
        tx.delete(pipelineSteps).where(eq(pipelineSteps.pipelineId, pipelineId)).run()
        for (const s of steps) {
          tx.insert(pipelineSteps).values({ ...s, id: newId(), pipelineId }).run()
        }
      })
    }
  }

  return {
    connections: connectionsRepo,
    knownHosts: knownHostsRepo,
    environments: environmentsRepo,
    targets: targetsRepo,
    releases: releasesRepo,
    releaseItems: releaseItemsRepo,
    archives: archivesRepo,
    settings: settingsRepo,
    audit: auditRepo,
    scriptRuns: scriptRunsRepo,
    scriptStepRuns: scriptStepRunsRepo,
    pipelines: pipelinesRepo,
    pipelineSteps: pipelineStepsRepo
  }
}

export type Repositories = ReturnType<typeof createRepositories>
