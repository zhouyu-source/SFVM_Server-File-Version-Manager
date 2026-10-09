/**
 * M13 回归：`pruneOldLogs()` 必须把 `script-runs` 子目录也按保留期清掉。
 *
 * 缺陷回顾：脚本运行的完整输出写在 `<数据目录>/log/script-runs/<runId>/<seq>.log`
 * （单步上限 8 MB，一条 20 步的流水线一次能产出 20 个文件），而 `pruneOldLogs()`
 * 只扫 `logDir` 下**直接**以 `.log` 结尾的条目 —— 子目录扫不到，于是这套输出
 * 在过去只增不减。
 *
 * 测试方式：注入一个假日志实现（`getFile()` 指向临时目录），让 `initLogger()`
 * 在那上面跑一次清理，然后断言过期目录被删、未过期的留着。
 * 不做真实文件系统之外的事，也不依赖 electron-log。
 */
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  initLogger,
  LOG_RETENTION_DAYS,
  SCRIPT_RUNS_DIR_NAME,
  setLogImpl,
  type LogImpl
} from '@main/infra/logger'

/** 日志保留期的边界（毫秒）。 */
const RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000

let logDir = ''

/** 极简日志替身：只实现 `initLogger()` 会碰到的那些成员。 */
function makeFakeImpl(): LogImpl {
  const noop = (): void => undefined
  return {
    error: noop,
    warn: noop,
    info: noop,
    verbose: noop,
    debug: noop,
    silly: noop,
    transports: {
      file: {
        level: 'info',
        format: '',
        maxSize: 0,
        getFile: () => ({ path: join(logDir, 'main.log') })
      },
      console: { level: false, format: '' }
    },
    errorHandler: { startCatching: noop }
  }
}

/** 造一个目录并把它（连同内容）的 mtime 拨到指定天数之前。 */
function seedDir(name: string, ageDays: number): string {
  const dir = join(logDir, SCRIPT_RUNS_DIR_NAME, name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '1.log')
  writeFileSync(file, 'output')
  const when = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000
  // 目录与文件都要拨 —— 判据读的是目录 mtime，但拨文件更接近真实（长任务持续写）
  utimesSync(file, when, when)
  utimesSync(dir, when, when)
  return dir
}

describe('M13：日志清理覆盖 script-runs 输出目录', () => {
  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'sfvm-logprune-'))
    setLogImpl(makeFakeImpl())
  })

  afterEach(() => {
    setLogImpl(null)
    if (logDir) rmSync(logDir, { recursive: true, force: true })
  })

  it('过期的运行输出目录整棵删掉，保留期内的留着', () => {
    const stale = seedDir('run-old', LOG_RETENTION_DAYS + 1)
    const fresh = seedDir('run-new', 0)
    // 顺带钉住既有的 .log 清理仍在工作
    const staleLog = join(logDir, 'main.2020-01-01.log')
    writeFileSync(staleLog, 'x')
    utimesSync(staleLog, (Date.now() - RETENTION_MS - 86_400_000) / 1000, (Date.now() - RETENTION_MS - 86_400_000) / 1000)

    initLogger({ logDir })

    expect(existsSync(stale), '过期的运行输出目录应被删除').toBe(false)
    expect(existsSync(fresh), '保留期内的运行输出目录不该被删').toBe(true)
    expect(existsSync(staleLog), '过期的日志归档仍应被删除').toBe(false)
  })

  it('script-runs 目录不存在时不报错（清理照常返回）', () => {
    expect(existsSync(join(logDir, SCRIPT_RUNS_DIR_NAME))).toBe(false)
    expect(() => initLogger({ logDir })).not.toThrow()
  })
})
