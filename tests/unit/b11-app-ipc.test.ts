/**
 * B11 的"本机能力"IPC 单测：选本地产物（T11.1）、打开所在目录 / 在终端中打开（T11.7）。
 *
 * 这一批通道的共同点是**它们会碰本机文件系统与进程**，所以单测的重点是边界：
 * - 渲染进程**永远拿不到**"任意路径都能打开"的能力（对话框的 properties 卡死在类型上）；
 * - 路径不存在 / 类型不对时**必须给出理由**，不能返回 ok 让 UI 说"已打开"（点击没反应是最烦的那类 bug）；
 * - 终端候选的**回退链**：第一个起不来要试第二个，全都起不来要如实失败。
 *
 * `spawn` 是注入的：单测里绝不能真起终端（会在开发机上弹黑框），
 * 但"选哪个候选、怎么回退"这些逻辑仍是真实执行的。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAppHandlers } from '@main/ipc/app'
import { terminalCandidates } from '@main/infra/open-shell'
import { unregisterAllHandlers } from '@main/infra/ipc'
import { IPC_CHANNELS } from '@shared/channels'
import type { IpcResult } from '@shared/ipc'
import type { OpenShellResult } from '@shared/contracts/workspace'
import {
  __invokeIpc,
  __lastOpenDialogOptions,
  __resetIpcHandlers,
  __resetOpenDialog,
  __resetShell,
  __setOpenDialogResult,
  __setOpenPathError,
  __shellCalls
} from '../stubs/electron'

interface SpawnCall {
  command: string
  args: string[]
}

const spawnCalls: SpawnCall[] = []
/** 命中"起不来"的命令名（模拟**同步**抛 ENOENT —— 少数实现会这样） */
let spawnFailsFor = new Set<string>()
/** 命中"起不来"的命令名（模拟真实 `spawn` 的**异步** `'error'` 事件） */
let spawnErrorsFor = new Set<string>()

/**
 * 假 child：真实 `spawn` 成功返回的对象至少有 `unref`，而 L14 起我们还会
 * `on('error')` —— 替身必须跟着长，否则测不到"异步失败"这条路。
 */
class FakeChild {
  private readonly handlers = new Map<string, Array<(err: Error) => void>>()
  on(event: string, fn: (err: Error) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(fn)
    this.handlers.set(event, list)
    return this
  }
  unref(): void {
    /* 父进程不必等它 */
  }
  /**
   * 异步报错。用微任务触发（不是 `setTimeout`）：它确定性地早于 handler 里
   * `setImmediate` 那一跳，用例不会变成"谁先后到看运气"。
   */
  emitAsyncError(err: Error): void {
    queueMicrotask(() => {
      for (const fn of this.handlers.get('error') ?? []) fn(err)
    })
  }
}

function fakeSpawn(command: string, args: readonly string[]): FakeChild {
  if (spawnFailsFor.has(command)) {
    throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })
  }
  spawnCalls.push({ command, args: [...args] })
  const child = new FakeChild()
  if (spawnErrorsFor.has(command)) {
    child.emitAsyncError(Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }))
  }
  return child
}

const tempDirs: string[] = []

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sfvm-b11ipc-'))
  tempDirs.push(d)
  return d
}

function makeFile(name = 'order.jar'): string {
  const d = mkdtempSync(join(tmpdir(), 'sfvm-b11ipc-'))
  tempDirs.push(d)
  const p = join(d, name)
  writeFileSync(p, 'jar')
  return p
}

/** 调一个已注册的通道并解包信封（失败时抛出，便于断言错误码）。 */
async function invoke<T>(channel: string, arg?: unknown): Promise<T> {
  const r = (await __invokeIpc(channel, arg)) as IpcResult<T>
  if (!r.ok) throw new Error(`IPC 失败 ${r.code}: ${r.message}`)
  return r.data
}

// 注册**一次**：`registerHandler` 会在模块级记录已注册的通道，重复注册会抛错
// （这是它的保护机制 —— 主进程里同一个通道注册两次是 bug）。所以只在 beforeAll 注册。
beforeAll(() => {
  __resetIpcHandlers()
  unregisterAllHandlers()
  registerAppHandlers({ spawn: fakeSpawn as unknown as typeof import('node:child_process').spawn })
})

beforeEach(() => {
  __resetOpenDialog()
  __resetShell()
  spawnCalls.length = 0
  spawnFailsFor = new Set()
  spawnErrorsFor = new Set()
})

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/* --------------------------------------------------------------- 选产物 */

describe('app.pickArtifact（T11.1）', () => {
  it('目录型目标：对话框只给 openDirectory（让对话框本身替用户挡掉一半错误）', async () => {
    __setOpenDialogResult({ canceled: false, filePaths: ['D:\\build\\dist'] })
    const r = await invoke<{ path: string } | null>(IPC_CHANNELS.APP_PICK_ARTIFACT, {
      kind: 'dir'
    })

    expect(r).toEqual({ path: 'D:\\build\\dist' })
    const opts = __lastOpenDialogOptions() as { properties: string[]; title: string }
    expect(opts.properties).toEqual(['openDirectory'])
    expect(opts.title).toContain('目录')
  })

  it('文件型目标：只给 openFile，且带 defaultPath 便于回到上次的位置', async () => {
    __setOpenDialogResult({ canceled: false, filePaths: ['D:\\build\\order.jar'] })
    await invoke(IPC_CHANNELS.APP_PICK_ARTIFACT, { kind: 'file', current: 'D:\\build' })

    const opts = __lastOpenDialogOptions() as {
      properties: string[]
      defaultPath?: string
      title: string
    }
    expect(opts.properties).toEqual(['openFile'])
    expect(opts.defaultPath).toBe('D:\\build')
    expect(opts.title).toContain('文件')
  })

  it('用户取消 → 返回 null（不是空对象，也不是报错）', async () => {
    __setOpenDialogResult({ canceled: true, filePaths: [] })
    expect(await invoke(IPC_CHANNELS.APP_PICK_ARTIFACT, { kind: 'dir' })).toBeNull()
  })

  it('入参不合法（kind 不是 dir/file）→ 被 Zod 拦下', async () => {
    const r = (await __invokeIpc(IPC_CHANNELS.APP_PICK_ARTIFACT, {
      kind: 'anything'
    })) as IpcResult<unknown>
    expect(r.ok).toBe(false)
  })
})

/* ----------------------------------------------------------- 打开所在目录 */

describe('app.revealPath（T11.7）', () => {
  it('目录 → openPath 打开它；文件 → showItemInFolder 选中它', async () => {
    const dir = makeDir()
    const file = makeFile()

    const a = await invoke<OpenShellResult>(IPC_CHANNELS.APP_REVEAL_PATH, { path: dir })
    expect(a.ok).toBe(true)
    const b = await invoke<OpenShellResult>(IPC_CHANNELS.APP_REVEAL_PATH, { path: file })
    expect(b.ok).toBe(true)

    expect(__shellCalls()).toEqual([
      { fn: 'openPath', arg: dir },
      { fn: 'showItemInFolder', arg: file }
    ])
  })

  it('路径不存在 → ok:false + 理由（不能静默、更不能报 ok）', async () => {
    const r = await invoke<OpenShellResult>(IPC_CHANNELS.APP_REVEAL_PATH, {
      path: join(tmpdir(), 'sfvm-不存在-xyz')
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不存在')
    expect(__shellCalls()).toHaveLength(0)
  })

  it('shell.openPath 自己报错 → 原样带出理由（比如"没有关联程序"）', async () => {
    __setOpenPathError('找不到关联的应用')
    const r = await invoke<OpenShellResult>(IPC_CHANNELS.APP_REVEAL_PATH, { path: makeDir() })
    expect(r).toEqual({ ok: false, reason: '找不到关联的应用' })
  })
})

/* ------------------------------------------------------------- 在终端打开 */

describe('app.openTerminal（T11.7）', () => {
  it('目录 → 起终端，路径作为独立参数（不拼字符串）', async () => {
    const dir = makeDir()
    const r = await invoke<OpenShellResult>(IPC_CHANNELS.APP_OPEN_TERMINAL, { path: dir })

    expect(r.ok).toBe(true)
    expect(spawnCalls).toHaveLength(1)
    const call = spawnCalls[0]!
    expect(call.args).toContain(dir)
    // Windows 分支：cmd /c start cmd /k cd /d <path>
    if (process.platform === 'win32') {
      expect(call.command).toBe('cmd.exe')
      expect(call.args).toEqual(['/c', 'start', 'cmd.exe', '/k', 'cd', '/d', dir])
    }
  })

  it('文件型产物 → 明确拒绝（终端只能进目录）', async () => {
    const r = await invoke<OpenShellResult>(IPC_CHANNELS.APP_OPEN_TERMINAL, { path: makeFile() })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('只能')
    expect(spawnCalls).toHaveLength(0)
  })

  it('路径不存在 → 明确拒绝，不起任何进程', async () => {
    const r = await invoke<OpenShellResult>(IPC_CHANNELS.APP_OPEN_TERMINAL, {
      path: join(tmpdir(), 'sfvm-不存在-xyz')
    })
    expect(r.ok).toBe(false)
    expect(spawnCalls).toHaveLength(0)
  })

  it('第一个终端起不来 → 按候选回退（Linux 上才有多个候选）', async () => {
    if (process.platform !== 'linux') {
      // 非 Linux 只有一个候选：起不来就如实失败
      spawnFailsFor.add(process.platform === 'win32' ? 'cmd.exe' : 'open')
      const r = await invoke<OpenShellResult>(IPC_CHANNELS.APP_OPEN_TERMINAL, { path: makeDir() })
      expect(r.ok).toBe(false)
      return
    }
    spawnFailsFor.add('x-terminal-emulator')
    const r = await invoke<OpenShellResult>(IPC_CHANNELS.APP_OPEN_TERMINAL, { path: makeDir() })
    expect(r.ok).toBe(true)
    expect(spawnCalls[0]!.command).toBe('gnome-terminal')
  })

  /**
   * L14：真实 `spawn` 对"命令不存在"**不抛**，它是异步用 `'error'` 报的。
   * 旧实现既没挂监听、又无条件 `return {ok:true}` —— Linux 上候选终端全都不在时
   * 主进程会冒出未捕获异常，界面那边却显示"已打开"。
   */
  it('L14：spawn 异步报 ENOENT → 不崩、如实回退（不是无条件返回 ok）', async () => {
    if (process.platform === 'linux') {
      spawnErrorsFor.add('x-terminal-emulator')
      const r = await invoke<OpenShellResult>(IPC_CHANNELS.APP_OPEN_TERMINAL, { path: makeDir() })
      expect(r.ok).toBe(true)
      expect(spawnCalls.map((c) => c.command)).toContain('gnome-terminal')
      return
    }
    // 非 Linux 只有一个候选：异步失败必须如实变成 ok:false（而不是"点了没反应"）
    spawnErrorsFor.add(process.platform === 'win32' ? 'cmd.exe' : 'open')
    const r = await invoke<OpenShellResult>(IPC_CHANNELS.APP_OPEN_TERMINAL, { path: makeDir() })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('ENOENT')
  })

  it('L14：候选全部异步失败 → 带回最后一条原因（用户能照做）', async () => {
    const dir = makeDir()
    const all = terminalCandidates(process.platform, dir).map((c) => c.command)
    for (const c of all) spawnErrorsFor.add(c)
    const r = await invoke<OpenShellResult>(IPC_CHANNELS.APP_OPEN_TERMINAL, { path: dir })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('ENOENT')
    // 每个候选都被真的试过（回退链完整，不是第一个失败就收工）
    expect(spawnCalls.map((x) => x.command)).toEqual(all)
  })
})
