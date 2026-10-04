/**
 * 剪贴板写入（B08 建立，B11 复用）。
 *
 * 为什么要有兜底：Electron 的渲染进程在某些环境下 `navigator.clipboard` 不可用
 * （非安全上下文 / 权限策略），而"复制按钮点了没反应"是本项目最烦人的一类问题 ——
 * 用户无法自证，只能怀疑自己。所以先试新 API，失败退回 `execCommand('copy')`。
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
