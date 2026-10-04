/**
 * 数据目录的位置解析（B18：数据目录可配置）。
 *
 * ## 为什么必须有一份"指针文件"
 *
 * 应用设置存在**数据库**里，而数据库就在**数据目录**里 —— 想读设置得先知道
 * 数据目录，想知道数据目录得先读设置。这是个死循环。
 *
 * 所以"用户把数据目录改到哪了"这件事**不能存在数据库里**，只能单独放一个小文件，
 * 且位置必须固定在**默认** userData 下（那是一定能找到的地方，且它自己不会被配置改掉）。
 * 本模块就是这份指针文件的读、写、清。
 *
 * ## 三条保守选择（都是刻意的）
 *
 * 1. **指针坏了不是致命错误**：读不出来就回退默认目录，把原因带出去让界面显示。
 *    用户机器上"配置被同步工具改坏 / 磁盘没挂上"都会走到这条路，此时**必须能启动** ——
 *    一个连设置页都打不开的应用，用户没有任何办法自救。
 * 2. **指针指向的目录不可用也是同理**（U 盘拔了、网络盘断了）：回退默认 + 带原因，
 *    而不是弹个框拒绝启动。
 * 3. **写指针是原子的**（`.tmp` → `rename`，同目录）：这个文件决定了下次启动读哪份台账，
 *    写到一半掉电造成"半截 JSON"就等于把用户的数据目录指丢了。
 *    与 `archive` / 发布清单的写法保持一致。
 * 4. **换目录之后旧目录要被清掉**（B18 追加要求：换目录的目的就是不把文件留在原处）。
 *    但不能在"换"的那一刻删 —— 旧库正被当前进程打开着。所以指针文件里多存一份
 *    `cleanupDirs`，下次启动再执行 `cleanupAbandonedDataDir()`；那里的守卫见该函数。
 *
 * 本模块刻意**不 import electron**：默认目录由调用方传入，单测可以直接给临时目录。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'

/** 指针文件名（放在**默认**数据目录下）。 */
export const DATA_LOCATION_FILENAME = 'data-location.json'

/** 日志目录名：数据目录下的 `log/`（B18 要求"日志目录自动跟随数据目录"）。 */
export const LOG_DIR_NAME = 'log'

/** 主进程日志文件名（electron-log 默认就是它）。 */
export const MAIN_LOG_FILENAME = 'main.log'

export interface DataLocationResolution {
  /** 实际要用的数据目录 */
  dir: string
  /** 是否用的默认目录（没配过、或配置不可用） */
  isDefault: boolean
  /** 配置过但不可用时的中文原因；空串表示一切正常 */
  reason: string
  /**
   * 上次改数据目录留下的、**待清理的旧目录**（B18 追加要求）。
   *
   * 为什么不在改的那一刻删：旧目录里的 `sfvm.db` 正被当前进程打开着，
   * Windows 上删不掉。所以只把"要清哪儿"记进指针文件，下次启动（新库已开、
   * 旧库没人占用）再执行 —— 正好落在"重启生效"这条既有语义上。
   */
  cleanupDirs: string[]
}

/** 指针文件路径。注意它永远落在**默认**目录下，不受配置影响。 */
export function pointerFilePath(defaultDir: string): string {
  return join(defaultDir, DATA_LOCATION_FILENAME)
}

/**
 * 归一化用户给的目录：去首尾空白、去结尾分隔符。
 *
 * 结尾分隔符必须去掉：`D:\SFVM\` 与 `D:\SFVM` 是同一个目录，留着它会让
 * "配置目录是否等于默认目录"这类比较全部失效（界面就会一直提示"需要重启"）。
 */
export function normalizeDir(input: string): string {
  return input.trim().replace(/[\\/]+$/, '')
}

/** 两个路径是否指同一个目录。Windows 上大小写不敏感，不能直接 `===`。 */
export function sameDir(a: string, b: string): boolean {
  const x = normalizeDir(a)
  const y = normalizeDir(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** 日志目录：`<数据目录>/log`。 */
export function logDirOf(dataDir: string): string {
  return join(normalizeDir(dataDir), LOG_DIR_NAME)
}

/** 日志文件：`<数据目录>/log/main.log`。 */
export function logFileOf(dataDir: string): string {
  return join(logDirOf(dataDir), MAIN_LOG_FILENAME)
}

/**
 * 解析"这次该用哪个数据目录"。
 *
 * 缺失（没配过）→ 默认，**静默**；配置存在但坏了 / 目录不可用 → 默认，**带原因**。
 * 这个"缺"与"坏"的区分沿用 B09 保留策略、B15 设置项的一致口径：
 * 前者是正常状态，后者必须让用户看见。
 */
export function readDataLocation(defaultDir: string): DataLocationResolution {
  const def = normalizeDir(defaultDir)
  const fallback = (cleanupDirs: string[]): DataLocationResolution => ({
    dir: def,
    isDefault: true,
    reason: '',
    cleanupDirs
  })
  const file = pointerFilePath(def)

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    // 没有指针文件 = 从来没改过数据目录，最正常的一种情况
    return fallback([])
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    // JSON 都坏了，里面的待清理清单也读不出来，只能放弃
    return { ...fallback([]), reason: `数据目录配置不是合法 JSON（${file}），本次使用默认目录` }
  }

  // 待清理清单与"这次用哪个目录"是**互相独立**的两件事：即使目录配坏了
  // （U 盘拔了、路径写错），上次的旧目录该清还是要清。
  const pending = parseCleanupDirs(parsed)
  const dir = normalizeDir(
    typeof (parsed as { dir?: unknown })?.dir === 'string' ? (parsed as { dir: string }).dir : ''
  )
  if (!dir) {
    return {
      ...fallback(pending),
      reason: `数据目录配置里没有有效路径（${file}），本次使用默认目录`
    }
  }
  if (sameDir(dir, def)) return fallback(pending)

  try {
    if (!statSync(dir).isDirectory()) {
      return { ...fallback(pending), reason: `自定义数据目录不是目录：${dir}，本次使用默认目录` }
    }
  } catch {
    return { ...fallback(pending), reason: `自定义数据目录不存在或不可访问：${dir}，本次使用默认目录` }
  }

  return { dir, isDefault: false, reason: '', cleanupDirs: pending }
}

/** 从指针文件里读出待清理目录；形状不对就当作没有（宁可少清，不能删错）。 */
function parseCleanupDirs(parsed: unknown): string[] {
  const list = (parsed as { cleanupDirs?: unknown } | null)?.cleanupDirs
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const d = normalizeDir(item)
    if (!d) continue
    if (out.some((x) => sameDir(x, d))) continue
    out.push(d)
  }
  return out
}

/**
 * 原子写入指针文件（`.tmp` → `rename`，同目录）。
 *
 * `cleanupDirs` 与 `dir` **同一次写**：分成两次写就会出现"目录换了但清单丢了"
 * （或反过来）的中间态，而这个文件恰好是崩溃恢复的唯一依据。
 */
export function writeDataLocation(
  defaultDir: string,
  dir: string,
  cleanupDirs: string[] = []
): void {
  const target = normalizeDir(dir)
  const file = pointerFilePath(defaultDir)
  mkdirSync(defaultDir, { recursive: true })

  const payload: { dir: string; updatedAt: string; cleanupDirs?: string[] } = {
    dir: target,
    updatedAt: new Date().toISOString()
  }
  const clean: string[] = []
  for (const item of cleanupDirs) {
    const d = normalizeDir(item)
    if (!d || sameDir(d, target)) continue
    if (clean.some((x) => sameDir(x, d))) continue
    clean.push(d)
  }
  if (clean.length > 0) payload.cleanupDirs = clean

  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 删除指针文件（"恢复默认目录"）。文件本来就不存在时不算错。 */
export function clearDataLocation(defaultDir: string): void {
  try {
    unlinkSync(pointerFilePath(defaultDir))
  } catch {
    /* 没有指针文件就是"已经是默认"，不需要报错 */
  }
}

/** `child` 是否在 `parent` 目录里面（用来挡住"把当前目录的上级删掉"）。 */
export function isAncestorOf(parent: string, child: string): boolean {
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const p = lower(normalizeDir(parent))
  const c = lower(normalizeDir(child))
  if (!p || !c || p === c) return false
  return c.startsWith(`${p}/`) || c.startsWith(`${p}\\`)
}

export interface CleanupResult {
  dir: string
  /** 目录本身已经不在了（删掉了，或本来就不存在） */
  gone: boolean
  /** 非空 = 有需要告诉用户的情况（会进主进程日志） */
  reason: string
  /** 是否留在待清理清单里，下次启动再试 */
  retry: boolean
}

/**
 * 清理"上一处数据目录"（B18：换目录的目的就是不把文件留在原处）。
 *
 * ## 先认领，再动手
 *
 * 这个函数会 `rm`，所以判据必须先证明"这个目录确实当过本应用的数据目录" ——
 * 目录里得有 `sfvm.db*`，或者一个有 `log/main.log` 的 `log/`。不满足就
 * **一个字节都不动**并说明原因：用户完全可能把那个路径后来改成了别的东西。
 *
 * ## 几条硬守卫（都不许放宽）
 *
 * 1. 绝不是当前生效目录 —— 删自己等于当场丢掉台账；
 * 2. 绝不能是当前目录的**上级**（`D:\SFVM` 是 `D:\SFVM\data` 的上级）；
 * 3. 文件系统根目录 / 用户主目录一律跳过；
 * 4. **默认目录（userData）只清本应用的数据文件**：指针文件与 Electron 自己的
 *    缓存都在那儿，整个删掉会让"应用找不到自己的配置"；
 * 5. 只删**认领到的**条目（`sfvm.db*`、`log/`），目录里还有别的东西就**保留目录本身**
 *    并说明 —— 宁可留下一个空壳，也不做"整个目录 rm -rf"这种不可逆的事。
 */
export function cleanupAbandonedDataDir(
  dir: string,
  opts: { currentDir: string; defaultDir: string; dbFileName: string }
): CleanupResult {
  const d = normalizeDir(dir)
  const skip = (reason: string): CleanupResult => ({ dir: d || dir, gone: false, reason, retry: false })

  if (!d) return skip('待清理目录是空路径')
  if (sameDir(d, opts.currentDir)) return skip('它就是当前生效的数据目录，已跳过')

  const isDefault = sameDir(d, opts.defaultDir)
  const root = normalizeDir(parse(d).root || '')
  if (root && sameDir(d, root)) return skip(`${d} 是文件系统根目录，已跳过`)
  if (sameDir(d, homedir())) return skip(`${d} 是用户主目录，已跳过`)
  if (isAncestorOf(d, opts.currentDir)) {
    return skip(`${d} 是当前数据目录的上级目录，已跳过`)
  }

  if (!existsSync(d)) return { dir: d, gone: true, reason: '', retry: false }

  let entries: string[]
  try {
    entries = readdirSync(d)
  } catch (e) {
    return { dir: d, gone: false, reason: `读不了目录内容：${(e as Error).message}`, retry: true }
  }

  // 认领：`sfvm.db*` 直接算；`log/` 要有 main.log 才算（别人也可能有个叫 log 的目录）
  const ours = entries.filter(
    (n) =>
      n.startsWith(opts.dbFileName) ||
      (n === LOG_DIR_NAME && existsSync(join(d, LOG_DIR_NAME, MAIN_LOG_FILENAME)))
  )
  if (ours.length === 0) {
    return {
      dir: d,
      gone: false,
      reason: `${d} 里没有本应用的数据文件，为安全起见未删除任何东西`,
      retry: false
    }
  }

  let failed = 0
  for (const name of ours) {
    try {
      rmSync(join(d, name), { recursive: true, force: true })
    } catch {
      failed++
    }
  }
  let left: string[]
  try {
    left = readdirSync(d)
  } catch {
    left = []
  }

  if (isDefault) {
    // 只清数据文件，目录本身必须留（指针文件 + Electron 缓存都在这儿）
    return {
      dir: d,
      gone: false,
      reason: `原目录是应用的默认目录，已清掉台账与日志${
        left.length > 0 ? `；目录里还有 ${left.length} 项其它内容（指针文件与 Electron 缓存），未改动` : ''
      }`,
      retry: false
    }
  }
  if (failed > 0) {
    return { dir: d, gone: false, reason: `有 ${failed} 项没能删除（可能仍被别的进程占用），下次启动会重试`, retry: true }
  }
  if (left.length > 0) {
    const sample = left.slice(0, 5).join('、')
    return {
      dir: d,
      gone: false,
      reason: `目录里还有 ${left.length} 项非本应用的内容，未删除目录本身：${sample}`,
      retry: false
    }
  }
  try {
    rmSync(d, { recursive: true, force: true })
  } catch (e) {
    return { dir: d, gone: false, reason: `目录已清空但删不掉：${(e as Error).message}`, retry: true }
  }
  return { dir: d, gone: true, reason: '', retry: false }
}
