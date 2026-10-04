/**
 * B18：数据目录可配置。
 *
 * 这一批真正会出问题的都不是"功能不 work"，而是**把用户的台账指丢**：
 * 指针文件写坏 → 下次启动读不到目录；目标目录里已有台账 → 被覆盖；
 * 复制失败却把指针写过去 → 下次启动整个台账凭空消失。
 *
 * 所以下面单测的重点全在**失败路径**上；正常路径只是一句话的事。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupAbandonedDataDir,
  clearDataLocation,
  isAncestorOf,
  logDirOf,
  normalizeDir,
  pointerFilePath,
  readDataLocation,
  sameDir,
  writeDataLocation
} from '@main/infra/data-location'
import { createDataLocationService, type DataLocationPorts } from '@main/services/data-location'

const tempDirs: string[] = []

function makeTemp(prefix = 'sfvm-b18-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }
})

/* ------------------------------------------------------------ 纯函数 */

describe('data-location 纯函数', () => {
  it('normalizeDir 去掉首尾空白与结尾分隔符', () => {
    expect(normalizeDir('  D:\\a\\b\\  ')).toBe('D:\\a\\b')
    expect(normalizeDir('/opt/app/')).toBe('/opt/app')
  })

  it('sameDir 把 `D:\\a\\b\\` 与 `D:\\a\\b` 认作同一处', () => {
    expect(sameDir('D:\\a\\b', 'D:\\a\\b\\')).toBe(true)
    expect(sameDir('D:\\a\\b', 'D:\\a\\c')).toBe(false)
    if (process.platform === 'win32') {
      // Windows 路径大小写不敏感，直接 === 会误判成"改过了"
      expect(sameDir('D:\\A\\B', 'd:\\a\\b')).toBe(true)
    }
  })

  it('logDirOf 固定是数据目录下的 log', () => {
    expect(logDirOf('D:\\data')).toBe(join('D:\\data', 'log'))
  })
})

/* -------------------------------------------------- 指针文件的读 */

describe('指针文件读取（T18.1）', () => {
  it('没有指针文件 = 用默认目录，且不算问题', () => {
    const def = makeTemp()
    const r = readDataLocation(def)
    expect(r.dir).toBe(normalizeDir(def))
    expect(r.isDefault).toBe(true)
    expect(r.reason).toBe('')
  })

  it('指针指向存在的目录 → 用它，并标记为非默认', () => {
    const def = makeTemp()
    const custom = makeTemp()
    writeDataLocation(def, custom)
    const r = readDataLocation(def)
    expect(r.dir).toBe(normalizeDir(custom))
    expect(r.isDefault).toBe(false)
    expect(r.reason).toBe('')
  })

  it('原子写：落下指针文件且不留 .tmp 残骸', () => {
    const def = makeTemp()
    writeDataLocation(def, makeTemp())
    expect(existsSync(pointerFilePath(def))).toBe(true)
    expect(existsSync(`${pointerFilePath(def)}.tmp`)).toBe(false)
  })

  it('指针是坏 JSON → 回退默认 + 给出原因，**不抛错**', () => {
    const def = makeTemp()
    writeFileSync(pointerFilePath(def), '{ 这不是 json', 'utf8')
    const r = readDataLocation(def)
    expect(r.isDefault).toBe(true)
    expect(r.dir).toBe(normalizeDir(def))
    expect(r.reason).toContain('JSON')
  })

  it('指针里没有有效 dir → 回退默认 + 给出原因', () => {
    const def = makeTemp()
    writeFileSync(pointerFilePath(def), JSON.stringify({ dir: '   ' }), 'utf8')
    const r = readDataLocation(def)
    expect(r.isDefault).toBe(true)
    expect(r.reason).not.toBe('')
  })

  it('指针指向的目录不存在 → 回退默认，并且**说出是哪个目录**（不然用户无从下手）', () => {
    const def = makeTemp()
    const gone = join(makeTemp(), 'not-there')
    writeDataLocation(def, gone)
    const r = readDataLocation(def)
    expect(r.isDefault).toBe(true)
    expect(r.reason).toContain('not-there')
  })

  it('指针指向的就是默认目录本身 → 视作默认', () => {
    const def = makeTemp()
    writeDataLocation(def, def)
    const r = readDataLocation(def)
    expect(r.isDefault).toBe(true)
    expect(r.reason).toBe('')
  })

  it('clearDataLocation 幂等（没有文件时也不报错）', () => {
    const def = makeTemp()
    expect(() => clearDataLocation(def)).not.toThrow()
    writeDataLocation(def, makeTemp())
    clearDataLocation(def)
    expect(existsSync(pointerFilePath(def))).toBe(false)
  })
})

/* --------------------------------------------------------- 服务 */

interface Harness {
  service: ReturnType<typeof createDataLocationService>
  backupCalls: string[]
}

function makeHarness(opts: {
  defaultDir: string
  currentDir?: string
  failBackup?: string
}): Harness {
  const backupCalls: string[] = []
  const currentDir = opts.currentDir ?? opts.defaultDir
  const ports: DataLocationPorts = {
    defaultDir: () => opts.defaultDir,
    currentDir: () => currentDir,
    logFile: () => join(logDirOf(currentDir), 'main.log'),
    backupTo: async (dir) => {
      if (opts.failBackup) throw new Error(opts.failBackup)
      backupCalls.push(dir)
      mkdirSync(dir, { recursive: true })
      // 冒充一次成功的在线备份：写一个可辨认的文件
      writeFileSync(join(dir, 'sfvm.db'), 'FAKE-DB', 'utf8')
    },
    log: () => undefined
  }
  return { service: createDataLocationService(ports), backupCalls }
}

describe('数据目录状态（T18.2）', () => {
  it('默认状态：isDefault、日志目录 = <数据目录>/log、不需要重启', () => {
    const def = makeTemp()
    const s = makeHarness({ defaultDir: def }).service.get()
    expect(s.isDefault).toBe(true)
    expect(s.effectiveDir).toBe(normalizeDir(def))
    expect(s.configuredDir).toBe(normalizeDir(def))
    expect(s.logDir).toBe(logDirOf(def))
    expect(s.logFile).toBe(join(logDirOf(def), 'main.log'))
    expect(s.restartRequired).toBe(false)
    expect(s.available).toBe(true)
    expect(s.reason).toBe('')
  })

  it('已配置别的目录但还没重启 → restartRequired 为真，生效目录仍是旧的', () => {
    const def = makeTemp()
    const custom = makeTemp()
    writeDataLocation(def, custom)
    const s = makeHarness({ defaultDir: def }).service.get()
    expect(s.configuredDir).toBe(normalizeDir(custom))
    expect(s.effectiveDir).toBe(normalizeDir(def))
    expect(s.restartRequired).toBe(true)
  })

  it('自定义目录不可用 → available=false 且带原因，同时如实回退默认', () => {
    const def = makeTemp()
    writeDataLocation(def, join(makeTemp(), 'gone'))
    const s = makeHarness({ defaultDir: def }).service.get()
    expect(s.available).toBe(false)
    expect(s.reason).not.toBe('')
    expect(s.effectiveDir).toBe(normalizeDir(def))
  })
})

describe('改数据目录（T18.3）', () => {
  it('切到新目录：复制台账 + 写指针 + 要求重启', async () => {
    const def = makeTemp()
    const custom = makeTemp()
    const h = makeHarness({ defaultDir: def })

    const r = await h.service.set(custom)

    expect(r.ok).toBe(true)
    expect(r.restartRequired).toBe(true)
    expect(h.backupCalls).toEqual([normalizeDir(custom)])
    expect(existsSync(join(custom, 'sfvm.db'))).toBe(true)
    expect(readFileSync(join(custom, 'sfvm.db'), 'utf8')).toBe('FAKE-DB')
    expect(readDataLocation(def).dir).toBe(normalizeDir(custom))
    expect(r.state.configuredDir).toBe(normalizeDir(custom))
    expect(r.state.effectiveDir).toBe(normalizeDir(def))
  })

  it('目标目录里已有台账 → 先改名保留，绝不覆盖', async () => {
    const def = makeTemp()
    const custom = makeTemp()
    writeFileSync(join(custom, 'sfvm.db'), 'OLD-LEDGER', 'utf8')
    const h = makeHarness({ defaultDir: def })

    const r = await h.service.set(custom)

    expect(r.ok).toBe(true)
    expect(r.warnings.join('\n')).toContain('改名')
    const kept = readdirSync(custom).filter((n) => n.startsWith('sfvm.db.bak-before-move-'))
    expect(kept).toHaveLength(1)
    // 旧台账内容原样在备份里，新台账是刚复制过去的
    expect(readFileSync(join(custom, kept[0]!), 'utf8')).toBe('OLD-LEDGER')
    expect(readFileSync(join(custom, 'sfvm.db'), 'utf8')).toBe('FAKE-DB')
  })

  it('复制失败 → **不写指针**（宁可"这次没改成"，也不要"配置指过去、数据没过去"）', async () => {
    const def = makeTemp()
    const custom = makeTemp()
    const h = makeHarness({ defaultDir: def, failBackup: '磁盘空间不足' })

    const r = await h.service.set(custom)

    expect(r.ok).toBe(false)
    expect(r.reason).toContain('磁盘空间不足')
    expect(existsSync(pointerFilePath(def))).toBe(false)
    expect(readDataLocation(def).isDefault).toBe(true)
    expect(r.state.effectiveDir).toBe(normalizeDir(def))
    expect(r.state.restartRequired).toBe(false)
  })

  it('相对路径 → 拒绝，并说清该填什么', async () => {
    const def = makeTemp()
    const r = await makeHarness({ defaultDir: def }).service.set('some/relative/dir')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('绝对路径')
    expect(existsSync(pointerFilePath(def))).toBe(false)
  })

  it('填的是默认目录 → 等价于"恢复默认"：不复制数据、清掉指针', async () => {
    const def = makeTemp()
    const h = makeHarness({ defaultDir: def })

    const r = await h.service.set(def)

    expect(r.ok).toBe(true)
    expect(h.backupCalls).toEqual([])
    expect(r.restartRequired).toBe(false)
    expect(existsSync(pointerFilePath(def))).toBe(false)
  })

  it('填的是"当前生效目录"（已生效的自定义目录）→ 不重复复制，只提示', async () => {
    const def = makeTemp()
    const custom = makeTemp()
    writeDataLocation(def, custom)
    // 模拟"已经在用 custom 了"
    const h = makeHarness({ defaultDir: def, currentDir: custom })

    const r = await h.service.set(custom)

    expect(r.ok).toBe(true)
    expect(h.backupCalls).toEqual([])
    expect(r.warnings.join('\n')).toContain('已经是当前生效')
    expect(r.restartRequired).toBe(false)
    expect(readDataLocation(def).dir).toBe(normalizeDir(custom))
  })

  it('目标是"文件"而不是目录 → 拒绝（写探针文件会失败，不能当数据目录用）', async () => {
    const def = makeTemp()
    const filePath = join(makeTemp(), 'a-file-not-a-dir')
    writeFileSync(filePath, 'x', 'utf8')

    const r = await makeHarness({ defaultDir: def }).service.set(filePath)

    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不可写')
    expect(existsSync(pointerFilePath(def))).toBe(false)
  })

  it('旧日志目录里的 .log 会被一并带过去（其它文件不动）', async () => {
    const def = makeTemp()
    const custom = makeTemp()
    mkdirSync(logDirOf(def), { recursive: true })
    writeFileSync(join(logDirOf(def), 'main.log'), 'old log', 'utf8')
    writeFileSync(join(logDirOf(def), 'notes.txt'), 'nope', 'utf8')

    const r = await makeHarness({ defaultDir: def }).service.set(custom)

    expect(r.ok).toBe(true)
    expect(existsSync(join(logDirOf(custom), 'main.log'))).toBe(true)
    expect(existsSync(join(logDirOf(custom), 'notes.txt'))).toBe(false)
    expect(r.warnings.join('\n')).toContain('旧日志')
  })

  it('set(null) 恢复默认：写回"默认"，并把自定义目录登记为待清理', async () => {
    const def = makeTemp()
    const custom = makeTemp()
    const h = makeHarness({ defaultDir: def })
    await h.service.set(custom)
    expect(existsSync(pointerFilePath(def))).toBe(true)

    const r = await h.service.set(null)

    expect(r.ok).toBe(true)
    expect(r.state.isDefault).toBe(true)
    expect(r.state.configuredDir).toBe(normalizeDir(def))
    expect(r.state.effectiveDir).toBe(normalizeDir(def))
    /*
     * 指针文件这时**还在**，但它只承载"待清理清单" —— 指向默认目录本身
     * 在语义上等于"没配过"（`readDataLocation` 就是这么判的）。
     * 下一次启动清完 custom 之后，这个文件会被删掉，磁盘上不留残留。
     */
    const raw = JSON.parse(readFileSync(pointerFilePath(def), 'utf8')) as { cleanupDirs?: string[] }
    expect(raw.cleanupDirs).toEqual([normalizeDir(custom)])
    expect(readDataLocation(def).isDefault).toBe(true)
  })
})

/* -------------------------------------- 换目录后清掉原目录（T18.7） */

describe('换目录后原目录会被清掉（T18.7）', () => {
  it('换到新目录：原目录登记进 cleanupDirs，**此刻一个字节都不删**', async () => {
    const def = makeTemp()
    const custom = makeTemp()
    const h = makeHarness({ defaultDir: def })

    const r = await h.service.set(custom)

    expect(r.ok).toBe(true)
    expect(r.warnings.join('\n')).toContain('重启后会清掉原目录')
    expect(r.state.pendingCleanup).toEqual([normalizeDir(def)])

    const raw = JSON.parse(readFileSync(pointerFilePath(def), 'utf8')) as { cleanupDirs?: string[] }
    expect(raw.cleanupDirs).toEqual([normalizeDir(def)])
    // 原目录此刻必须原封不动：里面的库正被当前进程打开着，删了就是台账当场消失
    expect(existsSync(def)).toBe(true)
  })

  it('恢复默认：把台账**复制回**默认目录（不是只清指针），并登记清理自定义目录', async () => {
    const def = makeTemp()
    const custom = makeTemp()
    writeDataLocation(def, custom)
    // 模拟"已经在用 custom 了"
    const h = makeHarness({ defaultDir: def, currentDir: custom })

    const r = await h.service.set(null)

    expect(r.ok).toBe(true)
    /*
     * 这一条是本批次最重要的回归：以前 `set(null)` 只清指针、不搬数据，
     * 于是"换过去再换回来"会读到默认目录里那份**过期的旧库** ——
     * 用户看到的就是"台账丢了"。现在它和"换到别的目录"走同一条路。
     */
    expect(h.backupCalls).toEqual([normalizeDir(def)])
    expect(readFileSync(join(def, 'sfvm.db'), 'utf8')).toBe('FAKE-DB')
    expect(r.state.pendingCleanup).toEqual([normalizeDir(custom)])
    expect(r.state.restartRequired).toBe(true)
  })

  it('连着改两次（中间没重启）：上一个"配了还没生效"的目录也要登记，否则留下没人认领的副本', async () => {
    const def = makeTemp()
    const a = makeTemp()
    const b = makeTemp()
    const h = makeHarness({ defaultDir: def })

    await h.service.set(a)
    await h.service.set(b)

    // a 里已经有一份复制过去的台账，必须和 def 一起被登记
    expect(readDataLocation(def).cleanupDirs).toEqual([normalizeDir(def), normalizeDir(a)])
  })

  it('writeDataLocation 会把"目标目录自己"从待清理清单里剔掉', () => {
    const def = makeTemp()
    const a = makeTemp()
    writeDataLocation(def, a, [a])
    expect(readDataLocation(def).cleanupDirs).toEqual([])
  })
})

describe('cleanupAbandonedDataDir 的守卫（T18.7）', () => {
  const dbFileName = 'sfvm.db'

  /** 造一个"当过数据目录"的目录：有台账 + 有 log/main.log 才认领得到 */
  function usedAsDataDir(): string {
    const d = makeTemp()
    mkdirSync(join(d, 'log'), { recursive: true })
    writeFileSync(join(d, dbFileName), 'DB', 'utf8')
    writeFileSync(join(d, 'log', 'main.log'), 'LOG', 'utf8')
    return d
  }

  it('认领得到 → 台账与日志都删掉，空目录本身也一并删掉', () => {
    const old = usedAsDataDir()
    const current = makeTemp()

    const r = cleanupAbandonedDataDir(old, { currentDir: current, defaultDir: current, dbFileName })

    expect(r.gone).toBe(true)
    expect(r.reason).toBe('')
    expect(r.retry).toBe(false)
    expect(existsSync(old)).toBe(false)
  })

  it('目录里还有别的文件 → 只清本应用的，目录本身保留并说明原因', () => {
    const old = usedAsDataDir()
    writeFileSync(join(old, '用户自己的说明.txt'), 'x', 'utf8')
    const current = makeTemp()

    const r = cleanupAbandonedDataDir(old, { currentDir: current, defaultDir: current, dbFileName })

    expect(r.gone).toBe(false)
    expect(r.reason).toContain('非本应用')
    expect(existsSync(join(old, '用户自己的说明.txt'))).toBe(true)
    expect(existsSync(join(old, dbFileName))).toBe(false)
    expect(existsSync(join(old, 'log'))).toBe(false)
  })

  it('认领不到（没有本应用的数据文件）→ 一个字节都不动', () => {
    const other = makeTemp()
    writeFileSync(join(other, '别人的东西.txt'), 'x', 'utf8')
    const current = makeTemp()

    const r = cleanupAbandonedDataDir(other, { currentDir: current, defaultDir: current, dbFileName })

    expect(r.gone).toBe(false)
    expect(r.reason).toContain('没有本应用的数据文件')
    expect(existsSync(join(other, '别人的东西.txt'))).toBe(true)
  })

  it('光有个叫 log 的目录、里面没有 main.log → 不算认领（别人也可能有 log 目录）', () => {
    const other = makeTemp()
    mkdirSync(join(other, 'log'), { recursive: true })
    writeFileSync(join(other, 'log', 'other-app.log'), 'x', 'utf8')
    const current = makeTemp()

    const r = cleanupAbandonedDataDir(other, { currentDir: current, defaultDir: current, dbFileName })

    expect(r.reason).toContain('没有本应用的数据文件')
    expect(existsSync(join(other, 'log'))).toBe(true)
  })

  it('默认目录（userData）只清台账与日志，**目录与指针文件都留着**', () => {
    const def = usedAsDataDir()
    writeDataLocation(def, makeTemp())
    const current = makeTemp()

    const r = cleanupAbandonedDataDir(def, { currentDir: current, defaultDir: def, dbFileName })

    expect(r.gone).toBe(false)
    expect(r.reason).toContain('默认目录')
    expect(existsSync(join(def, dbFileName))).toBe(false)
    expect(existsSync(join(def, 'log'))).toBe(false)
    // 指针文件必须留着：删掉它，应用下次就找不到数据目录了
    expect(existsSync(pointerFilePath(def))).toBe(true)
  })

  it('要清的目录就是当前生效目录 → 跳过（删自己等于当场丢台账）', () => {
    const cur = usedAsDataDir()

    const r = cleanupAbandonedDataDir(cur, { currentDir: cur, defaultDir: makeTemp(), dbFileName })

    expect(r.gone).toBe(false)
    expect(r.reason).toContain('当前生效')
    expect(existsSync(join(cur, dbFileName))).toBe(true)
  })

  it('要清的是当前数据目录的**上级** → 跳过（`D:\\SFVM` 之于 `D:\\SFVM\\data`）', () => {
    const parent = makeTemp()
    const current = join(parent, 'data')
    mkdirSync(current, { recursive: true })
    mkdirSync(join(parent, 'log'), { recursive: true })
    writeFileSync(join(parent, dbFileName), 'DB', 'utf8')
    writeFileSync(join(parent, 'log', 'main.log'), 'LOG', 'utf8')

    const r = cleanupAbandonedDataDir(parent, { currentDir: current, defaultDir: makeTemp(), dbFileName })

    expect(r.gone).toBe(false)
    expect(r.reason).toContain('上级')
    expect(existsSync(current)).toBe(true)
    expect(existsSync(join(parent, dbFileName))).toBe(true)
  })

  it('目录本来就不在了 → 视作已经清理干净（不算失败）', () => {
    const gone = join(makeTemp(), 'not-there')

    const r = cleanupAbandonedDataDir(gone, {
      currentDir: makeTemp(),
      defaultDir: makeTemp(),
      dbFileName
    })

    expect(r.gone).toBe(true)
    expect(r.reason).toBe('')
  })

  it('isAncestorOf 只认真正的下级', () => {
    expect(isAncestorOf('D:\\a', 'D:\\a\\b')).toBe(true)
    expect(isAncestorOf('D:\\a', 'D:\\a')).toBe(false)
    // 前缀相同但不是下级：`D:\ab` 不在 `D:\a` 里面
    expect(isAncestorOf('D:\\a', 'D:\\ab')).toBe(false)
  })
})
