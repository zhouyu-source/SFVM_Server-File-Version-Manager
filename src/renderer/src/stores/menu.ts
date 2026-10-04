/**
 * 菜单命令的"待处理"信箱（B15 / T15.7）。
 *
 * ## 为什么不能直接调组件方法
 *
 * 菜单命令是主进程推下来的（快捷键由原生菜单注册，渲染进程收不到按键），
 * 而"新建连接要打开哪个抽屉"只有 `ConnectionsView` 自己知道。
 * 事件是从上往下推的、组件实例是树形的 —— 硬要连起来就得给 RouterView 挂 ref
 * 再逐个 `expose()` 方法，每加一个命令就要改两处。
 *
 * 于是改成"信箱"：App 收到命令 → 跳到对应页面 → 把命令放进信箱；
 * 页面挂载时问一句"有给我的信吗"。新增命令只需要动这两端，不涉及组件引用。
 *
 * ## 为什么必须"取走"（consume）而不是读一下就留着
 *
 * 留着的话，用户下次**手工**切到连接页时会莫名其妙地弹出一个新建表单 ——
 * 因为那条命令还躺在信箱里。所以消费即清空。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MenuCommand } from '../../../shared/contracts/menu'

export const useMenuStore = defineStore('menu', () => {
  const pending = ref<MenuCommand | null>(null)

  function setPending(command: MenuCommand): void {
    pending.value = command
  }

  /** 若信箱里正是这条命令则取走并返回 true（取走 = 清空）。 */
  function consume(command: MenuCommand): boolean {
    if (pending.value !== command) return false
    pending.value = null
    return true
  }

  return { pending, setPending, consume }
})
