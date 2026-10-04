/**
 * B15 单测：设置与配置的 IPC 接线（T15.1 ~ T15.3）。
 *
 * ## 这一层要证明什么
 *
 * 服务层的逻辑在 `b15-settings.test.ts` / `b15-config-bundle.test.ts` 里已经验过。
 * 这里只盯 IPC 层自己会犯的错：
 * - 通道注册了但**入参形状不对**（比如直接 `registerHandler(ch, undefined, ...)`，
 *   真实运行时会因为 schema 为 `undefined` 而整个通道注册失败）；
 * - 文件对话框的**取消**被当成失败或当成空内容（用户点了取消，不该看到红色报错，
 *   也不该导入一份空配置）；
 * - 建议文件名拼错（用户会拿到 `sfvm-config-unknown.json` 这种没信息量的名字）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __invokeIpc, __resetIpcHandlers } from '../stubs/electron'
import { IPC_CHANNELS } from '@shared/channels'
import { ErrorCode } from '@shared/errors'
import type { IpcResult } from '@shared/ipc'
import type { ConfigImportResult, SettingsSnapshot } from '@shared/contracts/settings'
import { unregisterAllHandlers } from '@main/infra/ipc'
import { configFileName, registerSettingsHandlers } from '@main/ipc/settings'
import { createSettingsService } from '@main/services/settings'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

async function invokeOk<T>(channel: string, arg?: unknown): Promise<T> {
  const r = (await __invokeIpc(channel, arg)) as IpcResult<T>
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.code} ${r.message}`)
  return r.data
}

async function invokeErr(channel: string, arg?: unknown): Promise<string> {
  const r = (await __invokeIpc(channel, arg)) as IpcResult<unknown>
  if (r.ok) throw new Error('期望失败，实际成功')
  return String(r.code)
}

describe('B15 / 设置与配置的 IPC 接线', () => {
  let t: TestDb
  /** 保存对话框：默认返回"用户取消"（忘记注入的用例不该莫名拿到一个路径） */
  let saveResult: { path: string } | null = null
  let savedText: { suggestedName: string; text: string } | null = null
  let openResult: { path: string; text: string } | null = null

  function register(): void {
    const settings = createSettingsService({
      repo: t.repo,
      appVersion: '9.9.9-test',
      defaultDownloadDir: () => '/system/Downloads/sfvm-downloads',
      applyLogLevel: () => undefined
    })
    registerSettingsHandlers({
      settings,
      saveTextFile: async (input) => {
        savedText = input
        return saveResult
      },
      openTextFile: async () => openResult
    })
  }

  beforeEach(() => {
    __resetIpcHandlers()
    unregisterAllHandlers()
    t = makeTestDb()
    saveResult = null
    savedText = null
    openResult = null
    register()
  })

  afterEach(() => {
    unregisterAllHandlers()
    t.cleanup()
  })

  it('settings.get 返回快照（含有效下载目录与 issues）', async () => {
    const snap = await invokeOk<SettingsSnapshot>(IPC_CHANNELS.SETTINGS_GET)
    expect(snap.settings.transferConcurrency).toBe(4)
    expect(snap.effectiveDownloadDir).toBe('/system/Downloads/sfvm-downloads')
    expect(snap.issues).toEqual([])
  })

  it('settings.update 立刻生效并返回**改完之后**的快照', async () => {
    const snap = await invokeOk<SettingsSnapshot>(IPC_CHANNELS.SETTINGS_UPDATE, {
      transferConcurrency: 8,
      logLevel: 'warn'
    })
    expect(snap.settings.transferConcurrency).toBe(8)
    // 再读一次也是新值（不是只在返回值里新）
    const again = await invokeOk<SettingsSnapshot>(IPC_CHANNELS.SETTINGS_GET)
    expect(again.settings.logLevel).toBe('warn')
  })

  it('settings.update 入参非法 → E_PARAM（schema 校验在通道层就挡住）', async () => {
    expect(await invokeErr(IPC_CHANNELS.SETTINGS_UPDATE, { transferConcurrency: 99 })).toBe(
      ErrorCode.E_PARAM
    )
    // 多余字段会被 schema 剥掉（不是错误，但也不该写进去）
    const snap = await invokeOk<SettingsSnapshot>(IPC_CHANNELS.SETTINGS_UPDATE, {
      unknownKey: 'x'
    })
    expect(snap.settings).toBeDefined()
  })

  it('settings.export 返回 JSON 文本 + 建议文件名，且文本里没有凭据字段', async () => {
    seedBasic(t.repo)
    t.repo.connections.update(t.repo.connections.list()[0]!.id, {
      secretCipher: 'CIPHER-BLOB'
    })

    const r = await invokeOk<{ text: string; suggestedName: string }>(IPC_CHANNELS.SETTINGS_EXPORT)
    expect(r.suggestedName).toMatch(/^sfvm-config-\d{8}-\d{4}\.json$/)
    expect(r.text).not.toContain('CIPHER-BLOB')
    expect(r.text).not.toContain('secretCipher')
    expect(JSON.parse(r.text)).toMatchObject({ containsCredentials: false })
  })

  it('settings.exportToFile：把文本交给对话框实现，返回写入路径', async () => {
    saveResult = { path: '/home/u/sfvm-config.json' }
    const r = await invokeOk<{ path: string | null }>(IPC_CHANNELS.SETTINGS_EXPORT_TO_FILE)
    expect(r.path).toBe('/home/u/sfvm-config.json')
    expect(savedText).not.toBeNull()
    expect(savedText!.text).toContain('"containsCredentials": false')
  })

  it('settings.exportToFile：**用户取消 → path 为 null**（不是报错，也不是写了个空文件）', async () => {
    saveResult = null
    const r = await invokeOk<{ path: string | null }>(IPC_CHANNELS.SETTINGS_EXPORT_TO_FILE)
    expect(r).toEqual({ path: null })
  })

  it('settings.importFromFile：用户取消 → 返回 null（界面据此静默什么都不做）', async () => {
    openResult = null
    expect(await invokeOk<ConfigImportResult | null>(IPC_CHANNELS.SETTINGS_IMPORT_FROM_FILE)).toBeNull()
  })

  it('settings.importFromFile：选中文件 → 走与粘贴导入完全相同的逻辑', async () => {
    seedBasic(t.repo)
    const exported = await invokeOk<{ text: string }>(IPC_CHANNELS.SETTINGS_EXPORT)

    // 搬到"另一台机器"
    t.repo.targets.listAll().forEach((x) => t.repo.targets.remove(x.id))
    t.repo.environments.list().forEach((x) => t.repo.environments.remove(x.id))
    t.repo.connections.list().forEach((x) => t.repo.connections.remove(x.id))

    openResult = { path: '/tmp/cfg.json', text: exported.text }
    const r = await invokeOk<ConfigImportResult>(IPC_CHANNELS.SETTINGS_IMPORT_FROM_FILE)
    expect(r.connections.created).toBe(1)
    expect(r.environments.created).toBe(1)
    expect(r.targets.created).toBe(1)
  })

  it('settings.import：粘贴非法内容 → E_PARAM 且带原因', async () => {
    const r = (await __invokeIpc(IPC_CHANNELS.SETTINGS_IMPORT, { text: 'xxx' })) as IpcResult<unknown>
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(String(r.code)).toBe(ErrorCode.E_PARAM)
      expect(String(r.message)).toContain('JSON')
    }
  })

  it('settings.import：空文本被 schema 挡下（不会拿一份空配置去跑）', async () => {
    expect(await invokeErr(IPC_CHANNELS.SETTINGS_IMPORT, { text: '' })).toBe(ErrorCode.E_PARAM)
  })
})

describe('B15 / 导出文件名', () => {
  it('用导出时间生成带分钟的戳（同名导出能靠它区分先后）', () => {
    expect(configFileName('2026-10-01T18:36:00.000Z')).toMatch(/^sfvm-config-\d{8}-\d{4}\.json$/)
  })

  it('时间戳坏掉时给 unknown 而不是抛错（导出本身不该因为这个失败）', () => {
    expect(configFileName('not-a-date')).toBe('sfvm-config-unknown.json')
  })
})
