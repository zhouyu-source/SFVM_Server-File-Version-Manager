/**
 * B01 阶段的基础通道契约。
 *
 * 放在 shared 是为了让渲染进程能复用同一份 schema 推导出的类型
 * （方案书 §4.3「一份契约两端共用」）。
 */
import { z } from 'zod'

/** app:ping —— 通路自检，不需要入参。 */
export const pingOutput = z.object({
  pong: z.literal(true),
  /** 主进程侧时间戳，用于确认是真实往返而非渲染进程本地伪造 */
  at: z.string()
})
export type PingOutput = z.infer<typeof pingOutput>

/**
 * app:info —— 渲染进程真正需要的运行环境信息。
 *
 * ## 为什么只剩一个字段（B18 收缩）
 *
 * 设置页「关于」区改成只展示「数据目录 / 日志目录」两行，版本号、Electron /
 * Chromium / Node、平台、运行模式都不再上界面 —— 于是那些字段成了没人读的
 * 契约字段。留着一个"谁都不消费"的字段，下次改它时不会有任何测试变红，
 * 也就没人知道能不能删；不如现在就把契约收成**界面真实需要的那一个**。
 *
 * 版本号没有丢：它仍在启动日志、导出文件（`configBundle.appVersion`）里，
 * 排障时不依赖这个通道。
 */
export const appInfoOutput = z.object({
  /** `process.platform`；快捷键表据此决定显示 `Ctrl` 还是 `⌘` */
  platform: z.string()
})
export type AppInfoOutput = z.infer<typeof appInfoOutput>

/* --------------------------------------------------------- 数据目录（B18） */

/**
 * 数据目录状态。
 *
 * 三个目录的关系要说清楚，否则界面很容易显示错：
 * - `defaultDir`：默认位置（`app.getPath('userData')`），**没配过时就是它**；
 * - `configuredDir`：用户配置的目标（留空 = 用默认），可能还没生效；
 * - `effectiveDir`：**本次进程真正在用**的那个（数据库就开在这里）。
 *
 * `configuredDir !== effectiveDir` 就说明"改动已保存、等重启生效"，
 * 界面必须把这件事说出来 —— 否则用户会以为设置没生效。
 */
export const dataLocationOutput = z.object({
  effectiveDir: z.string(),
  configuredDir: z.string(),
  defaultDir: z.string(),
  /** `configuredDir` 就是默认目录（等价于"没配过"） */
  isDefault: z.boolean(),
  /** **生效的那个目录**是否真的可用（不可用时已回退到默认，见 `reason`） */
  available: z.boolean(),
  /** 回退原因；空串表示一切正常 */
  reason: z.string(),
  /** 当前生效的日志目录（固定为 `<effectiveDir>/log`） */
  logDir: z.string(),
  /** 当前日志文件绝对路径 */
  logFile: z.string(),
  restartRequired: z.boolean(),
  /**
   * 重启后会被清理的旧数据目录（B18：换目录的目的就是不把文件留在原处）。
   *
   * 改动的那一刻删不掉（旧库正被本进程打开着），所以只登记、下次启动执行。
   * 界面把它显示出来，用户就知道"重启之后原目录会消失"，而不是以为留了份备份。
   */
  pendingCleanup: z.array(z.string())
})
export type DataLocationOutput = z.infer<typeof dataLocationOutput>

/** 设置数据目录；`null` 或空串 = 恢复默认目录。 */
export const setDataLocationInput = z.object({
  dir: z.string().nullable()
})
export type SetDataLocationInput = z.infer<typeof setDataLocationInput>

/**
 * 设置结果。
 *
 * 刻意**不抛 AppError**，而是像 `revealPath` / `openTerminal` 那样返回
 * `{ ok, reason }`：这些失败（目标目录里已有台账、目录建不出来、复制失败）
 * 都是**用户可自行处置**的，需要的是一句能照做的中文说明，不是一个错误码。
 */
export const setDataLocationOutput = z.object({
  ok: z.boolean(),
  /** `ok=false` 时的中文原因（必须非空：用户要知道下一步做什么） */
  reason: z.string(),
  /** 成功、但用户需要知道的事（例如"目标目录里原有的台账已改名保留"） */
  warnings: z.array(z.string()),
  restartRequired: z.boolean(),
  /** 保存后重新读一遍的完整状态，界面直接用它刷新，不必再发一次 get */
  state: dataLocationOutput
})
export type SetDataLocationOutput = z.infer<typeof setDataLocationOutput>
