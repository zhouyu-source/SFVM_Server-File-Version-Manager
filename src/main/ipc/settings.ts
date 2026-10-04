/**
 * 设置与配置导入导出的 IPC（B15 / T15.1 ~ T15.3）。
 *
 * ## 文件对话框放在注入里，不在本文件 import electron
 *
 * `保存到文件` / `从文件导入` 需要系统对话框，而本文件从建立起就守着一条约束：
 * **不 import electron**（同 `ipc/archive.ts` 的理由 —— 一旦 import，整条链路就没法
 * 在单测里跑，因为单测环境里 `electron` 解析到的是 npm 包而不是运行时）。
 *
 * 所以对话框以 `saveTextFile` / `openTextFile` 两个函数注入，由主进程接线层给实现。
 * 单测传两个内存替身即可，测到的仍是真实逻辑（文件名怎么拼、取消怎么表示、参数校验）。
 */
import { registerHandler } from '../infra/ipc'
import { IPC_CHANNELS } from '../../shared/channels'
import {
  appSettingsPatchSchema,
  configImportInputSchema,
  type ConfigImportResult
} from '../../shared/contracts/settings'
import type { SettingsService } from '../services/settings'

export interface SettingsIpcDeps {
  settings: SettingsService
  /**
   * 让用户选一个位置并写入文本。返回写入的绝对路径；用户取消返回 null。
   *
   * 之所以在**主进程**写文件而不是把内容交给渲染进程去下载：
   * 渲染进程要触发下载得走 `a.download` / Blob，在 `file://` 下有兼容问题，
   * 而且"文件到底存哪了"这个信息会丢失（用户点完之后不知道去哪找）。
   * 主进程写则能直接把路径回显出来。
   */
  saveTextFile: (input: {
    suggestedName: string
    text: string
  }) => Promise<{ path: string } | null>
  /** 让用户选一个文本文件并读回来；取消返回 null。 */
  openTextFile: () => Promise<{ path: string; text: string } | null>
}

export function registerSettingsHandlers(deps: SettingsIpcDeps): void {
  const { settings, saveTextFile, openTextFile } = deps

  /** 读全量设置 + 默认下载目录（设置页一进来就调它） */
  registerHandler(IPC_CHANNELS.SETTINGS_GET, null, () => settings.snapshot())

  /**
   * 改设置。**返回改完之后的全量快照**（而不是只回 ok）。
   *
   * 因为有一项会被服务侧规整（比如日志级别在运行时被夹到合法值），
   * 让界面拿到"服务认为现在的值"比让界面自己猜要可靠 —— 也顺带解决了
   * "保存后要不要再拉一次"的问题。
   */
  registerHandler(IPC_CHANNELS.SETTINGS_UPDATE, appSettingsPatchSchema, (patch) =>
    settings.update(patch)
  )

  /**
   * 导出配置：返回 JSON 文本 + 建议文件名（不写文件）。
   *
   * 与下面的 `exportToFile` 分开，是因为"拿到文本"这件事本身有用：
   * 用户可以自己复制走，E2E 也能不碰系统对话框就验证内容（**不含凭据**那条硬要求）。
   */
  registerHandler(IPC_CHANNELS.SETTINGS_EXPORT, null, () => {
    const bundle = settings.exportBundle()
    return {
      text: JSON.stringify(bundle, null, 2),
      suggestedName: configFileName(bundle.exportedAt)
    }
  })

  /** 导出到文件（弹保存对话框）；返回写入路径，用户取消返回 `{ path: null }`。 */
  registerHandler(IPC_CHANNELS.SETTINGS_EXPORT_TO_FILE, null, async () => {
    const bundle = settings.exportBundle()
    const r = await saveTextFile({
      suggestedName: configFileName(bundle.exportedAt),
      text: JSON.stringify(bundle, null, 2)
    })
    return { path: r?.path ?? null }
  })

  /** 从文件导入：先读文本，再走与"粘贴导入"完全相同的解析与写入逻辑。 */
  registerHandler(IPC_CHANNELS.SETTINGS_IMPORT_FROM_FILE, null, async (): Promise<
    ConfigImportResult | null
  > => {
    const picked = await openTextFile()
    if (!picked) return null
    return settings.importBundle({ text: picked.text, applySettings: true })
  })

  /**
   * 从文本导入。
   *
   * `applySettings` 刻意可以由调用方关掉：用户可能只想把连接与环境搬过来，
   * 不想让别人的日志级别覆盖自己的设置。
   */
  registerHandler(IPC_CHANNELS.SETTINGS_IMPORT, configImportInputSchema, (input) =>
    settings.importBundle(input)
  )
}

/**
 * 建议文件名：`sfvm-config-20261001-1836.json`。
 *
 * 带时间戳是因为用户可能导出好几份（改设置前后各一份），同名的话系统会加 `(1)`，
 * 那个后缀看不出先后顺序，而时间戳一眼就能看出哪份更新。
 */
export function configFileName(exportedAt: string): string {
  const d = new Date(exportedAt)
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = Number.isNaN(d.getTime())
    ? 'unknown'
    : `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  return `sfvm-config-${stamp}.json`
}
