/**
 * 数据目录服务（B18：数据目录可配置）。
 *
 * ## 这个服务要回答的两个问题
 *
 * - `get()`：**现在**用哪个目录、**配的**是哪个、日志在哪 —— 界面拿它渲染「关于」；
 * - `set()`：把数据目录换到另一个地方，并把已有台账带过去。
 *
 * ## 为什么是"复制 + 重启生效"，不是"立刻切过去"
 *
 * 所有业务服务都在**接线时**一次性捕获了仓储对象（`index.ts` 的
 * `const repo = getRepositories()`，再分给连接 / 工作区 / 归档 / 发布……）。
 * 运行中把数据库关掉重开，那些引用就全悬空了 —— 表现为"换个目录之后所有页都报错"，
 * 而且**没有任何测试能覆盖到**（单测里每个服务都是独立构造的）。
 *
 * 所以这里只做**不碰当前库**的两件事：把台账在线备份到目标目录、写指针文件；
 * 真正切过去发生在下次启动（`index.ts` 在读日志/开库**之前**解析指针）。
 *
 * ## 三条不可放宽的安全约定
 *
 * 1. **目标目录里已有一份台账时先改名保留，绝不覆盖** —— 用户选的可能是他以前用过的
 *    目录，直接覆盖等于毁掉那份数据。改名（而不是删除）让"选错了"永远可逆。
 * 2. **失败时不写指针**：目录建不出来、台账复制失败、指针写不进去，一律返回
 *    `ok:false` + 中文原因，当前生效目录不变。宁可"这次没改成"，也不要
 *    "配置指过去了但数据没过去" —— 那在下次启动时表现为**整个台账凭空消失**。
 * 3. **失败原因必须能照做**：写"目标目录里已经有一份台账"没用，
 *    要写清楚用户下一步能做什么。
 *
 * ## 换过去之后，原目录要清掉（B18 追加要求）
 *
 * 用户的原话是"换目录的目的就是为了不把文件保存在原目录"。但**此刻删不掉** ——
 * 原目录里的 `sfvm.db` 正被当前进程打开着。所以这里只把旧目录记进指针文件的
 * `cleanupDirs`，由下次启动执行（`cleanupAbandonedDataDir()`，守卫见那里）。
 *
 * 由此带来一条**必须**一起修的东西：`set(null)`（恢复默认）以前只清指针、不搬数据，
 * 于是"换过去 → 再换回来"会读到一个**过期的默认库**，看着就像台账丢了。
 * 现在它与"换到别的目录"走同一条路：先复制，再登记清理。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { DataLocationOutput, SetDataLocationOutput } from '../../shared/contracts/app'
import { DB_FILENAME } from '../db/client'
import {
  clearDataLocation,
  logDirOf,
  normalizeDir,
  readDataLocation,
  sameDir,
  writeDataLocation
} from '../infra/data-location'

export interface DataLocationPorts {
  /** 默认数据目录（接线层给 `app.getPath('userData')`） */
  defaultDir: () => string
  /** 当前**生效**的数据目录（接线层给数据库文件所在目录） */
  currentDir: () => string
  /** 当前日志文件路径（接线层给 `logFilePath`） */
  logFile: () => string
  /** 把当前台账在线备份到目标目录（接线层给 `backupDatabaseTo`） */
  backupTo: (dir: string) => Promise<void>
  /** 诊断日志 */
  log: (msg: string) => void
}

export interface DataLocationService {
  get: () => DataLocationOutput
  set: (dir: string | null) => Promise<SetDataLocationOutput>
}

/** 时间戳片段：`yyyyMMddHHmmss`（本地时区，给人看的）。 */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** 挑一个还不存在的备份名（同一秒内改两次也不至于互相覆盖）。 */
function freeName(base: string): string {
  if (!existsSync(base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!existsSync(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

export function createDataLocationService(ports: DataLocationPorts): DataLocationService {
  const get = (): DataLocationOutput => {
    const defaultDir = normalizeDir(ports.defaultDir())
    const resolved = readDataLocation(defaultDir)
    const effectiveDir = normalizeDir(ports.currentDir())
    return {
      effectiveDir,
      configuredDir: resolved.dir,
      defaultDir,
      isDefault: resolved.isDefault,
      available: resolved.reason === '',
      reason: resolved.reason,
      logDir: logDirOf(effectiveDir),
      logFile: ports.logFile(),
      restartRequired: !sameDir(resolved.dir, effectiveDir),
      pendingCleanup: resolved.cleanupDirs
    }
  }

  const set = async (input: string | null): Promise<SetDataLocationOutput> => {
    const defaultDir = normalizeDir(ports.defaultDir())
    const currentDir = normalizeDir(ports.currentDir())
    // 空串 / null = 恢复默认目录。它**不是**特例：目标就是默认目录而已，
    // 后面的复制、登记待清理、写指针全都要照做 —— 以前只清指针，会让用户
    // 换回默认目录时读到一个过期的旧库，看着就像台账丢了。
    const target = input && input.trim() ? normalizeDir(input) : defaultDir
    const warnings: string[] = []

    /** 统一构造失败结果：**带上已产生的 warnings**，不要因为失败了就不说做过什么。 */
    const fail = (reason: string): SetDataLocationOutput => {
      const state = get()
      return { ok: false, reason, warnings, restartRequired: state.restartRequired, state }
    }

    /* ① 必须是绝对路径：相对路径在打包产物里会相对到一个毫无意义的位置 */
    if (!isAbsolute(target)) {
      return fail(`请选择绝对路径，当前填的是「${target}」`)
    }

    /* ② 目标就是当前生效目录：不复制，只把指针写成它（幂等） */
    const changing = !sameDir(target, currentDir)
    if (!changing) {
      warnings.push('该目录已经是当前生效的数据目录，未做任何复制')
    } else {
      /* ③ 建目录并**实际试写一次**：只读盘 / 权限位只靠 mkdir 是看不出来的 */
      try {
        mkdirSync(target, { recursive: true })
        const probe = join(target, '.sfvm-write-probe')
        writeFileSync(probe, 'ok', 'utf8')
        unlinkSync(probe)
      } catch (e) {
        return fail(`目标目录不可写：${target}（${(e as Error).message}）`)
      }

      /* ④ 目标里已有一份台账 → 先改名保留，绝不覆盖 */
      const dbFile = join(target, DB_FILENAME)
      if (existsSync(dbFile)) {
        try {
          const aside = freeName(`${dbFile}.bak-before-move-${stamp()}`)
          renameSync(dbFile, aside)
          for (const suffix of ['-wal', '-shm']) {
            if (existsSync(`${dbFile}${suffix}`)) renameSync(`${dbFile}${suffix}`, `${aside}${suffix}`)
          }
          warnings.push(
            `目标目录里原来就有一份台账，已改名为 ${basename(aside)} 保留（没有被覆盖）`
          )
        } catch (e) {
          return fail(`目标目录里已有一份台账，且无法把它改名保留：${(e as Error).message}`)
        }
      }

      /* ⑤ 在线备份台账：失败则整体不生效，当前库一点没动 */
      try {
        await ports.backupTo(target)
      } catch (e) {
        return fail(`台账复制失败：${(e as Error).message}。当前数据目录未改动，可以直接重试。`)
      }

      /* ⑥ 顺手把旧日志带过去（best-effort：日志丢了不算事故，但要告诉用户） */
      const fromLogDir = logDirOf(currentDir)
      const toLogDir = logDirOf(target)
      if (!sameDir(fromLogDir, toLogDir) && existsSync(fromLogDir)) {
        try {
          mkdirSync(toLogDir, { recursive: true })
          let copied = 0
          for (const name of readdirSync(fromLogDir)) {
            if (!name.endsWith('.log')) continue
            const dst = join(toLogDir, name)
            if (existsSync(dst)) continue
            copyFileSync(join(fromLogDir, name), dst)
            copied++
          }
          if (copied > 0) warnings.push(`已把旧日志 ${copied} 个文件一并复制到新目录`)
        } catch (e) {
          warnings.push(`旧日志未能一并复制（不影响台账）：${(e as Error).message}`)
        }
      }
    }

    /**
     * ⑦ 最后才写指针：这一步成功才代表"配置改了"。
     *
     * 连同"下次启动要清哪些旧目录"一起写（`cleanupDirs`），来源有三处：
     * - 本次换走的 `currentDir`；
     * - **上次配置过、但还没生效**的那个目录 —— 用户可能设完 A 又改成 B（中间没重启），
     *   而 A 里已经躺着我们复制过去的一份台账，不登记就成了没人认领的残留；
     * - 更早留下的未清项（从现有指针里带过来）。
     *
     * 指向默认目录且没有待清理项时改为**删掉**指针文件：这样"没配过"在磁盘上
     * 就是干干净净的，而不是留下一个写着默认路径的配置。
     */
    const prev = readDataLocation(defaultDir)
    const pending = [...prev.cleanupDirs, prev.dir, ...(changing ? [currentDir] : [])].filter(
      (d) => !sameDir(d, target)
    )
    try {
      if (sameDir(target, defaultDir) && pending.length === 0) {
        clearDataLocation(defaultDir)
      } else {
        writeDataLocation(defaultDir, target, pending)
      }
    } catch (e) {
      return fail(
        `台账已复制到 ${target}，但记录配置失败：${(e as Error).message}。` +
          '为免出现"配置指过去、数据没过去"，本次改动未生效，请重试。'
      )
    }

    if (changing) {
      warnings.push(
        sameDir(currentDir, defaultDir)
          ? '重启后会清掉原目录（应用默认目录）里的台账与日志（配置与缓存目录本身保留）'
          : `重启后会删除原数据目录 ${currentDir}`
      )
    }

    ports.log(`dataLocation: switched to ${target} (takes effect after restart)`)
    const state = get()
    return { ok: true, reason: '', warnings, restartRequired: state.restartRequired, state }
  }

  return { get, set }
}
