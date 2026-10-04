/**
 * B11 / T11.7 "打开所在目录 / 在终端中打开"的单测。
 *
 * 这一层的核心不是功能而是**安全**：路径来自目标配置，最终会变成一条命令行。
 * 所以断言的重点是"路径**永远**作为一个独立参数传出去"，而不是拼进字符串 ——
 * 一个带 `&` 或 `"` 的路径如果在 Windows 上被拼进 `cd /d ...`，
 * 就等于给了用户（或将来某个上游）一条执行任意命令的路。
 */
import { describe, expect, it } from 'vitest'
import {
  buildTerminalInvocation,
  revealModeFor,
  terminalCandidates
} from '@main/infra/open-shell'

describe('buildTerminalInvocation', () => {
  it('Windows：cmd /c start cmd /k cd /d <path>，路径是**独立参数**', () => {
    const inv = buildTerminalInvocation('win32', 'D:\\build\\dist')
    expect(inv).toEqual({
      command: 'cmd.exe',
      args: ['/c', 'start', 'cmd.exe', '/k', 'cd', '/d', 'D:\\build\\dist']
    })
    // 关键：路径是数组里的**一个元素**（`cd` 与 `/d` 各自独立），
    // 由 Node 在 Windows 上按规则加引号后再交给 cmd —— 我们从不自己拼这条命令行。
    expect(inv!.args[inv!.args.length - 1]).toBe('D:\\build\\dist')
  })

  it('macOS：open -a Terminal <path>', () => {
    expect(buildTerminalInvocation('darwin', '/Users/me/dist')).toEqual({
      command: 'open',
      args: ['-a', 'Terminal', '/Users/me/dist']
    })
  })

  it('Linux：路径作为**位置参数**传给 sh，脚本里只引用 $1', () => {
    const inv = buildTerminalInvocation('linux', '/opt/app/dist')
    expect(inv!.command).toBe('x-terminal-emulator')
    expect(inv!.args).toEqual([
      '-e',
      'sh',
      '-c',
      'cd "$1" && exec "$SHELL"',
      'sh',
      '/opt/app/dist'
    ])
    // args[0..2] 是"-e sh -c"，args[3] 才是脚本本体（常量），路径在最后
    expect(inv!.args[2]).toBe('-c')
    expect(inv!.args[3]).toBe('cd "$1" && exec "$SHELL"')
    // 危险路径也只是"多一个参数"，不会被 shell 解释
    const evil = buildTerminalInvocation('linux', '/tmp/a; rm -rf ~')
    expect(evil!.args[evil!.args.length - 1]).toBe('/tmp/a; rm -rf ~')
    // 关键：`-c` 后面那段脚本**必须是常量**（不含路径）—— 否则 `;` 就成了命令分隔符
    expect(evil!.args[3]).toBe('cd "$1" && exec "$SHELL"')
    expect(evil!.args[3]).not.toContain('rm -rf')
  })

  it('Windows 上带特殊字符的路径仍只是"一个参数"', () => {
    const tricky = 'D:\\my build & stuff\\dist'
    const inv = buildTerminalInvocation('win32', tricky)
    expect(inv!.args).toContain(tricky)
    expect(inv!.args.filter((a) => a === tricky)).toHaveLength(1)
  })

  it('空路径 → null（宁可不打开，也不要弹一个落在别处的终端）', () => {
    expect(buildTerminalInvocation('win32', '   ')).toBeNull()
    expect(buildTerminalInvocation('linux', '')).toBeNull()
  })
})

describe('terminalCandidates', () => {
  it('Windows / macOS 只有一个候选', () => {
    expect(terminalCandidates('win32', 'D:\\x')).toHaveLength(1)
    expect(terminalCandidates('darwin', '/x')).toHaveLength(1)
  })

  it('Linux 给出多个候选用于回退（且都带 --working-directory 之类）', () => {
    const list = terminalCandidates('linux', '/opt/app')
    expect(list.length).toBeGreaterThan(2)
    expect(list[0]!.command).toBe('x-terminal-emulator')
    expect(list.map((c) => c.command)).toContain('gnome-terminal')
    expect(list.map((c) => c.command)).toContain('xterm')
    // 每一个候选都必须把路径当独立参数（不能有的用 sh 字符串拼）
    for (const c of list) expect(c.args).toContain('/opt/app')
  })

  it('空路径 → 没有候选（调用方会返回失败而不是乱起进程）', () => {
    expect(terminalCandidates('linux', '')).toEqual([])
  })
})

describe('revealModeFor', () => {
  it('目录 → 打开；文件 → 选中（直接打开 .jar 会被压缩软件抢走）', () => {
    expect(revealModeFor('dir')).toBe('open')
    expect(revealModeFor('file')).toBe('reveal')
    expect(revealModeFor(null)).toBeNull()
  })
})
