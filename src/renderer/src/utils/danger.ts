/**
 * 危险操作的确认文案（B15 / T15.6）。
 *
 * ## 为什么要把这句话统一起来
 *
 * 全应用有七八个"点了就回不去"的入口（删连接 / 删环境 / 删目标 / 删往期版本 /
 * 执行保留策略 / 回滚 / 清理远端锁 / 放弃未完成的操作）。它们最要紧的信息只有一个：
 * **这件事会不会动服务器上的文件**。
 *
 * 每个入口各写一句的后果实测出现过两种：
 * 1. 有的写了、有的没写 —— 用户在"删连接"那里学到"这个软件删东西只删本地"，
 *    然后在"执行保留策略"那里以为也不会动服务器（实际会真删归档目录）；
 * 2. 有人用 Markdown 的 `**加粗**` 写 MessageBox 文案 —— 而 `ElMessageBox`
 *    **不渲染 Markdown**，用户看到的是一堆字面量星号。
 *
 * 所以这里把格式固定下来：正文 = 后果 + 固定的"对服务器的影响"一行。
 */
import { ElMessageBox } from 'element-plus'

export type RemoteEffect = 'none' | 'files'

/**
 * "对服务器的影响"这句话的唯一来源。
 *
 * 措辞刻意直白（"不会删除或修改"而不是"不影响"）："影响"可以理解成
 * "会不会让服务重启""会不会有性能抖动"，而用户真正想知道的是**文件还在不在**。
 */
export function remoteEffectLine(effect: RemoteEffect, detail?: string): string {
  if (effect === 'none') {
    return '【对服务器的影响】不会删除或修改服务器上的任何文件。'
  }
  return detail
    ? `【对服务器的影响】会删除服务器上的文件 —— ${detail}`
    : '【对服务器的影响】会删除服务器上的文件，且本工具无法恢复它们。'
}

export interface DangerConfirmInput {
  title: string
  /** 会发生什么（本机的后果） */
  consequence: string
  remoteEffect: RemoteEffect
  /** `remoteEffect === 'files'` 时说明删什么 */
  remoteDetail?: string
  confirmText?: string
  cancelText?: string
  /** 生产环境按名称确认（传要输入的名称） */
  requireTypedName?: string
}

/** 组装弹窗正文（后果 + 服务器影响）。 */
export function dangerBody(input: DangerConfirmInput): string {
  return `${input.consequence}\n\n${remoteEffectLine(input.remoteEffect, input.remoteDetail)}`
}

/**
 * 弹一个标准危险确认框。返回是否确认（取消一律返回 false，不抛错）。
 *
 * 不抛错的理由：所有调用点都是"取消就什么都不做"，让它们各写一段 try/catch
 * 只会把真正的失败处理淹掉。
 */
export async function confirmDanger(input: DangerConfirmInput): Promise<boolean> {
  try {
    await ElMessageBox.confirm(dangerBody(input), input.title, {
      type: 'warning',
      confirmButtonText: input.confirmText ?? '确认执行',
      cancelButtonText: input.cancelText ?? '取消',
      // 生产环境按名称确认 —— 与 `DangerConfirm` 组件同一套分级策略，
      // 只是这里用的是 MessageBox 的输入框版本
      ...(input.requireTypedName
        ? {
            inputPlaceholder: `请输入 ${input.requireTypedName} 以确认`,
            inputValidator: (v: string) =>
              v === input.requireTypedName ? true : '名称不一致'
          }
        : {})
    })
    return true
  } catch {
    return false
  }
}
