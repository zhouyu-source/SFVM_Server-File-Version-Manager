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
import type { MessageBoxData } from 'element-plus'

/**
 * 三档，按"后果的可预测性"递增：
 * - `none`：只动本地，服务器一个字节都不碰（删连接 / 删目标配置）。
 * - `files`：会删服务器上的文件，**且删什么是确定的**（保留策略 / 回滚 / 删归档）。
 * - `exec`：会在服务器上跑用户填写的命令 —— **后果由命令本身决定**，
 *  本工具无法保证它删了什么（B20 打开"允许执行自定义脚本"就属这一档）。
 */
export type RemoteEffect = 'none' | 'files' | 'exec'

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
  if (effect === 'exec') {
    // 这一档不能承诺任何事 —— 说"可能重启服务或删除数据"是描述**最常见**的两种脚本，
    // 而不是它的上限。真正的护栏是"脚本由你自己填写"。
    return detail
      ? `【对服务器的影响】会在服务器上执行你填写的命令 —— ${detail}`
      : '【对服务器的影响】会在服务器上执行你填写的命令，可能重启服务、删除文件或修改配置，后果由脚本内容决定。'
  }
  return detail
    ? `【对服务器的影响】会删除服务器上的文件 —— ${detail}`
    : '【对服务器的影响】会删除服务器上的文件，且本工具无法恢复它们。'
}

/**
 * `el-alert` 的 type（颜色也在传达严重程度）。
 *
 * 与 `remoteEffectLine()` 放在一起，是为了让"文案"和"颜色"永远同档升级 ——
 * 上一次加档时就差点只改了文案、漏了颜色。
 */
export function remoteEffectAlertType(effect: RemoteEffect): 'info' | 'warning' | 'error' {
  if (effect === 'none') return 'info'
  if (effect === 'exec') return 'warning'
  return 'error'
}

export interface DangerConfirmInput {
  title: string
  /** 会发生什么（本机的后果） */
  consequence: string
  remoteEffect: RemoteEffect
  /** `remoteEffect` 为 `'files'` / `'exec'` 时说明具体动什么 */
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
 * 打开确认框。要求输入名称时必须走 **prompt**，不能用 confirm ——
 *
 * Element Plus 的 `MessageBox` 只有 `boxType === 'prompt'` 才会渲染输入框、
 * 才会在点确认按钮时执行 `inputValidator`、resolve 的才是 `{ value, action }`；
 * `confirm` 预设只设 `showCancelButton`，传进去的 `inputPlaceholder` /
 * `inputValidator` 是**死选项**（输入框不出现、校验不执行），resolve 值恒为
 * 字符串 `'confirm'` —— 曾经拿它当用户输入送回，被服务端 `assertProdConfirmed`
 * 一眼识破（`'confirm' !== 目标名`），用户看到的就是"要输文字确认的框从没弹出来"。
 */
function openBox(
  input: DangerConfirmInput & { requireTypedName: string }
): Promise<MessageBoxData>
function openBox(input: DangerConfirmInput): Promise<unknown>
function openBox(input: DangerConfirmInput): Promise<unknown> {
  const options = {
    type: 'warning' as const,
    confirmButtonText: input.confirmText ?? '确认执行',
    cancelButtonText: input.cancelText ?? '取消',
    ...(input.requireTypedName
      ? {
          inputPlaceholder: `请输入 ${input.requireTypedName} 以确认`,
          // 与服务端 `assertProdConfirmed`（`typedName === target.name`）同口径：
          // 精确比较、不 trim —— 客户端放宽只会把"差一个空格"的输入送到服务端挨拒
          inputValidator: (v: string) => (v === input.requireTypedName ? true : '名称不一致')
        }
      : {})
  }
  return input.requireTypedName
    ? ElMessageBox.prompt(dangerBody(input), input.title, options)
    : ElMessageBox.confirm(dangerBody(input), input.title, options)
}

/**
 * 弹一个标准危险确认框。返回是否确认（取消一律返回 false，不抛错）。
 *
 * 不抛错的理由：所有调用点都是"取消就什么都不做"，让它们各写一段 try/catch
 * 只会把真正的失败处理淹掉。
 */
export async function confirmDanger(input: DangerConfirmInput): Promise<boolean> {
  try {
    await openBox(input)
    return true
  } catch {
    return false
  }
}

/**
 * 与 `confirmDanger` 同一个弹窗，但**把用户输入的那个名字带回来**（B21）。
 *
 * 为什么不能用 `confirmDanger` 然后"反正是生产环境，就把目标名传过去"：
 * 服务端那道校验（`services/pipeline.ts` 的 `assertProdConfirmed`）存在的意义
 * 就是"不轻信调用方"。渲染进程如果只是**推断**用户输对了、再把推断当事实送过去，
 * 那道校验就成了一句自我应验的话 —— 换句话说，它拦住的恰好只有"真的会去拦它的人"。
 *
 * 所以这里把输入值原样带出来，让"用户确实逐字打了目标名"这件事**可验证**。
 */
export async function confirmDangerWithName(
  input: DangerConfirmInput & { requireTypedName: string }
): Promise<{ ok: true; typed: string } | { ok: false; typed: null }> {
  try {
    const data = await openBox(input)
    return { ok: true, typed: data.value }
  } catch {
    return { ok: false, typed: null }
  }
}
