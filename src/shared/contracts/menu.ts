/**
 * 菜单命令契约（B15 / T15.7）。
 *
 * 主进程点菜单 → 推一条命令给渲染进程 → 界面照做。
 *
 * 只放"命令 id"这一层，不放"谁处理"：命令的**执行**在渲染进程
 * （它才知道当前在哪一页、抽屉开没开）。主进程只是转发。
 */
import { z } from 'zod'

export const MENU_COMMANDS = ['new-connection', 'refresh', 'settings'] as const

export const menuCommandSchema = z.enum(MENU_COMMANDS)
export type MenuCommand = z.infer<typeof menuCommandSchema>

/**
 * 菜单项的 id —— 比"要推给渲染进程的命令"多两项。
 *
 * `open-logs` / `open-data` 完全在主进程里完成（打开目录），**不推**给渲染进程；
 * 但它们同样是菜单项，也要出现在设置页的快捷键列表里。所以：
 * - `MenuCommand` = 需要渲染进程配合的命令（会经 IPC 推下去）；
 * - `MenuActionId` = 全部菜单项（菜单模板与快捷键表共用）。
 *
 * 分开写而不是合成一个联合：合成之后 `send()` 的入参就成了 `MenuActionId`，
 * 于是"推一个渲染进程根本不认识的 open-logs 下去"在类型上变成合法的。
 */
export const MENU_ACTION_IDS = [...MENU_COMMANDS, 'open-logs', 'open-data'] as const
export type MenuActionId = (typeof MENU_ACTION_IDS)[number]

/** 主进程 → 渲染进程的命令推送载荷。 */
export interface MenuCommandPayload {
  command: MenuCommand
}
