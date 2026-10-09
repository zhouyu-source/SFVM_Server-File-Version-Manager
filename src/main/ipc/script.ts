/**
 * 自定义脚本的 IPC 接线（B20 / T20.7；B21 起只保留**只读**通道）。
 *
 * ## 为什么没有"直接跑一条脚本"的通道了
 *
 * B20 曾暴露 `scripts.runStep` —— 一条"填一段脚本、点执行"的入口。B21 把脚本执行
 * 收进了「自动化流水线」（流水线的每一步就是一条脚本，发布步骤也在其中），独立的
 * 脚本面板也从界面上撤掉了：`SCRIPTS_RUN_STEP` 在渲染层**再没有任何调用方**，
 * 成了一条没人走、却仍然能被 IPC 直接调到的**写**通道。
 *
 * 留着它是有代价的（M15）：生产环境"逐字输入目标名"这条守卫只在流水线链上做了
 * 服务端校验（`assertProdConfirmed`），单条脚本通道一个都没有 —— 一旦谁把它接回 UI
 * 或直接调 IPC，这道防线就只剩前端那一道。既然产品方向是"脚本只从流水线走"，
 * 正确的处置是**删掉这条通道**，而不是给一条废弃通道补校验。
 *
 * 因此本文件现在只剩**纯读**能力：能力探测、运行记录列表、运行详情。
 * 所有写操作（含脚本执行）统一走 `ipc/pipeline.ts`。
 */
import { registerHandler } from '../infra/ipc'
import { IPC_CHANNELS } from '../../shared/channels'
import {
  DEFAULT_SCRIPT_RUN_LIST_LIMIT,
  scriptRunDetailInputSchema,
  scriptRunListInputSchema
} from '../../shared/contracts/script'
import type { ScriptService } from '../services/script'

export interface ScriptIpcDeps {
  scripts: ScriptService
}

export function registerScriptHandlers(deps: ScriptIpcDeps): void {
  const { scripts } = deps

  /* ------------------------------------------------------------ 能力探测 */

  registerHandler(IPC_CHANNELS.SCRIPTS_CAPABILITIES, null, () => scripts.capabilities())

  /* ------------------------------------------------------------ 运行记录 */

  registerHandler(IPC_CHANNELS.SCRIPTS_RUNS, scriptRunListInputSchema, ({ targetId, limit }) =>
    scripts.list(targetId, limit ?? DEFAULT_SCRIPT_RUN_LIST_LIMIT)
  )

  registerHandler(IPC_CHANNELS.SCRIPTS_RUN_DETAIL, scriptRunDetailInputSchema, ({ runId }) =>
    scripts.detail(runId)
  )
}
