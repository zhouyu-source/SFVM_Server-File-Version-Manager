/**
 * B20 / T20.2 本机执行底座的**纯逻辑**（可穷举校对）。
 *
 * 这一层的价值恰恰在"不用起进程就能断言 Windows 上到底会执行什么"：
 * 命令行长什么样、环境变量删了什么、多字节字符会不会被切坏、杀进程树用的是哪条命令。
 * 真起进程的那部分在 `b20-script.test.ts` 里（且按解释器可用性跳过）。
 *
 * 断言里刻意写死几个"历史坑"：
 * - PowerShell 必须走 **UTF-16LE** 的 base64（传 UTF-8 不报错，只是行为全错）；
 * - 候选解释器里**不能有 cmd.exe**（用户明确要求：只用 PowerShell 或 Git Bash）；
 * - 子进程环境里必须**删掉** `ELECTRON_RUN_AS_NODE`（本机环境真的预置了它，
 *   不删的话 Electron 系可执行文件会退化成纯 Node）。
 */
import { describe, expect, it } from 'vitest'
import {
  POWERSHELL_PREAMBLE,
  SHELL_EXE_CANDIDATES,
  buildChildEnv,
  buildKillTreeCommand,
  buildLocalCommand,
  createChunkDecoder,
  defaultShellForPlatform,
  encodePowerShellCommand,
  isAbsoluteCandidate,
  isLocalShell,
  normalizeShellPath,
  splitOutputLines,
  withPowerShellPreamble
} from '@main/infra/local-exec'
import { LOCAL_SHELLS } from '@shared/contracts/script'

/* ------------------------------------------------------------ 解释器选择 */

describe('B20 解释器选择', () => {
  it('平台默认：Windows 用 PowerShell，其余用 Git Bash 那条路', () => {
    expect(defaultShellForPlatform('win32')).toBe('powershell')
    expect(defaultShellForPlatform('linux')).toBe('gitbash')
    expect(defaultShellForPlatform('darwin')).toBe('gitbash')
  })

  it('候选里**没有** cmd.exe —— 只给 PowerShell 与 Git Bash', () => {
    const all = LOCAL_SHELLS.flatMap((s) => [...SHELL_EXE_CANDIDATES[s]])
    expect(all.some((c) => /cmd(\.exe)?$/i.test(c))).toBe(false)
    expect(all.some((c) => /command\.com/i.test(c))).toBe(false)
    // 反向确认：批处理的老壳（cmd）连"可选项"都不是
    expect(LOCAL_SHELLS).toEqual(['powershell', 'gitbash'])
  })

  it('isLocalShell 只认两个合法取值，cmd 不是其中之一', () => {
    expect(isLocalShell('powershell')).toBe(true)
    expect(isLocalShell('gitbash')).toBe(true)
    expect(isLocalShell('cmd')).toBe(false)
    expect(isLocalShell('bash')).toBe(false)
    expect(isLocalShell(null)).toBe(false)
    expect(isLocalShell(undefined)).toBe(false)
    expect(isLocalShell(1)).toBe(false)
  })

  it('absolute 判定：盘符 / UNC / POSIX 路径算绝对，裸名字不算', () => {
    expect(isAbsoluteCandidate('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(true)
    expect(isAbsoluteCandidate('c:/git/bash.exe')).toBe(true)
    expect(isAbsoluteCandidate('\\\\srv\\share\\bash.exe')).toBe(true)
    expect(isAbsoluteCandidate('/usr/bin/bash')).toBe(true)
    expect(isAbsoluteCandidate('bash')).toBe(false)
    expect(isAbsoluteCandidate('pwsh')).toBe(false)
  })

  it('normalizeShellPath 去空白与误带的引号（资源管理器复制路径会带引号）', () => {
    expect(normalizeShellPath('  C:\\Git\\bash.exe  ')).toBe('C:\\Git\\bash.exe')
    expect(normalizeShellPath('"C:\\Program Files\\Git\\bin\\bash.exe"')).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe'
    )
    expect(normalizeShellPath("'C:\\Git\\bash.exe'")).toBe('C:\\Git\\bash.exe')
    // 只去"成对"的引号：路径里合法的单引号不该被动
    expect(normalizeShellPath("it's")).toBe("it's")
  })
})

/* ---------------------------------------------------------------- 命令行 */

describe('B20 命令行构造', () => {
  it('PowerShell 走 -EncodedCommand，且载荷是 UTF-16LE 的 base64', () => {
    const script = 'Write-Output "你好"\nGet-Date'
    const { command, args } = buildLocalCommand({
      shell: 'powershell',
      exePath: 'C:\\ps\\pwsh.exe',
      script
    })

    expect(command).toBe('C:\\ps\\pwsh.exe')
    expect(args.slice(0, 5)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass'
    ])
    expect(args[5]).toBe('-EncodedCommand')

    const encoded = args[6]!
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
    // ① 用户脚本原样在载荷**结尾**（前面垫了前导语句，见下一条）
    expect(decoded.endsWith(script)).toBe(true)
    // ② 同时钉住"不是 UTF-8"：按 UTF-8 解会得到乱码
    expect(Buffer.from(encoded, 'base64').toString('utf8')).not.toBe(decoded)
    expect(encoded).not.toContain('Write-Output')
  })

  /**
   * 前导语句是**真机 E2E 抓出来的**，不是可选的装饰：
   * - 不设 `[Console]::OutputEncoding` 的话，PowerShell 往管道写中文用的是控制台
   *   代码页（简中 Windows 是 GBK），我们按 UTF-8 解码 → `b20-???-ok`；
   * - 不关 `$ProgressPreference` 的话，进度流会在 stderr 上变成一大坨 CLIXML。
   * 两句都在载荷**开头**，所以这里断言"顺序 + 内容"，防止有人顺手删掉。
   */
  it('PowerShell 载荷前面垫了编码与进度流的前导语句', () => {
    const script = 'Write-Output "x"'
    const { args } = buildLocalCommand({
      shell: 'powershell',
      exePath: 'pwsh',
      script
    })
    const decoded = Buffer.from(args[6]!, 'base64').toString('utf16le')

    expect(decoded.startsWith(POWERSHELL_PREAMBLE)).toBe(true)
    expect(decoded).toBe(withPowerShellPreamble(script))
    expect(decoded).toContain('[Console]::OutputEncoding')
    expect(decoded).toContain('UTF8')
    expect(decoded).toContain('$ProgressPreference')
    // 用户脚本在最后：前导语句不能把用户脚本挤掉
    expect(decoded.split('\n').slice(-1)[0]).toBe(script)
    // 包在 try 里 → 没有控制台也不会炸掉整个脚本
    expect(POWERSHELL_PREAMBLE).toMatch(/^try \{/)
  })

  it('Git Bash 的载荷**不**垫前导语句（它本来就是 UTF-8）', () => {
    const { args } = buildLocalCommand({
      shell: 'gitbash',
      exePath: 'bash',
      script: 'echo hi'
    })
    expect(args[2]).toBe('echo hi')
    expect(args[2]).not.toContain('ProgressPreference')
  })

  it('PowerShell 的编码函数与内联实现同源', () => {
    expect(encodePowerShellCommand('abc')).toBe(
      Buffer.from('abc', 'utf16le').toString('base64')
    )
    // BOM 不能被带进来（PowerShell 会把 BOM 当成命令的一部分）
    expect(Buffer.from(encodePowerShellCommand('abc'), 'base64')[0]).toBe(0x61)
  })

  it('Git Bash 用 -l -c，整段脚本是**一个** argv（不经过任何 shell 插值）', () => {
    const script = 'echo "a b"\necho $HOME'
    const { command, args } = buildLocalCommand({
      shell: 'gitbash',
      exePath: 'C:\\Git\\bin\\bash.exe',
      script
    })

    expect(command).toBe('C:\\Git\\bin\\bash.exe')
    expect(args).toEqual(['-l', '-c', script])
    // 关键：脚本没有被拆成多个参数，所以引号与空格原样保留
    expect(args.length).toBe(3)
  })
})

/* -------------------------------------------------------------- 子环境 */

describe('B20 子进程环境', () => {
  it('删掉 ELECTRON_RUN_AS_NODE（本机环境确实预置了它）', () => {
    const env = buildChildEnv('powershell', {
      PATH: '/x',
      ELECTRON_RUN_AS_NODE: '1'
    } as NodeJS.ProcessEnv)

    expect('ELECTRON_RUN_AS_NODE' in env).toBe(false)
    expect(env.PATH).toBe('/x')
  })

  it('不修改调用方传进来的对象（不然会污染整个主进程的 process.env）', () => {
    const base = { ELECTRON_RUN_AS_NODE: '1' } as NodeJS.ProcessEnv
    buildChildEnv('powershell', base)
    expect(base.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('Git Bash 额外设 CHERE_INVOKING=1（否则 /etc/profile 会 cd $HOME）', () => {
    const git = buildChildEnv('gitbash', {} as NodeJS.ProcessEnv)
    expect(git.CHERE_INVOKING).toBe('1')
    // PowerShell 不需要它，别顺手加
    const ps = buildChildEnv('powershell', {} as NodeJS.ProcessEnv)
    expect(ps.CHERE_INVOKING).toBeUndefined()
  })
})

/* -------------------------------------------------------------- 输出切分 */

describe('B20 输出按行切分', () => {
  it('跨块的半行会留到下一块（不会把一行切成两条日志）', () => {
    const a = splitOutputLines('', '第一行\n第二')
    expect(a.lines).toEqual(['第一行'])
    expect(a.pending).toBe('第二')

    const b = splitOutputLines(a.pending, '行\n')
    expect(b.lines).toEqual(['第二行'])
    expect(b.pending).toBe('')
  })

  it('只有 \\n 是分隔符：\\r 是"行尾要去掉的字符"（CRLF 与 PowerShell 重绘）', () => {
    const r = splitOutputLines('', 'a\r\nb\nc\r')
    expect(r.lines).toEqual(['a', 'b'])
    // 结尾的 \r 是半行的一部分，收尾时（脚本层 flush）才处理
    expect(r.pending).toBe('c\r')
    // 行中间的孤立 \r（进度重绘）保留 —— 它不是换行
    const mid = splitOutputLines('', 'x\ry\n')
    expect(mid.lines).toEqual(['x\ry'])
  })
})

describe('B20 增量解码（中文不乱码）', () => {
  it('多字节字符被切在块中间时能拼回来，而直接 toString 会乱', () => {
    const buf = Buffer.from('中文', 'utf8') // e4 b8 ad e6 96 87
    const head = buf.subarray(0, 2)
    const tail = buf.subarray(2)

    // 先确认这个切法真的会切坏（否则这条测试是假绿）
    expect(head.toString('utf8')).not.toBe('中')

    const d = createChunkDecoder()
    expect(d.push(head)).toBe('')
    expect(d.push(tail)).toBe('中文')
    expect(d.end()).toBe('')
  })

  it('end() 交出压着的尾巴：完整字节能解出来，残缺字节变成替换字符（而不是被静默丢掉）', () => {
    const buf = Buffer.from('尾部', 'utf8')
    // ① 给全：push 就能拿到，end() 为空
    const full = createChunkDecoder()
    expect(full.push(buf)).toBe('尾部')
    expect(full.end()).toBe('')

    // ② 少给最后一个字节：'尾' 完整 → 立刻返回；'部' 残缺 → 压在解码器里，
    //    end() 交出它。此时**只能**给替换字符（U+FFFD）—— 那几个字节确实凑不出
    //    一个合法字符。这一点是有意的：显示"这里被截断了"比静默丢掉半个字好。
    const cut = createChunkDecoder()
    expect(cut.push(buf.subarray(0, buf.length - 1))).toBe('尾')
    expect(cut.end()).toBe('\ufffd')
  })

  it('两个流各自独立解码，互不吃对方的半个字符', () => {
    const out = createChunkDecoder()
    const err = createChunkDecoder()
    const a = Buffer.from('好', 'utf8')
    expect(out.push(a.subarray(0, 1))).toBe('')
    // stderr 这时插一脚：它不该影响 stdout 的半个字符
    expect(err.push(Buffer.from('ok\n', 'utf8'))).toBe('ok\n')
    expect(out.push(a.subarray(1))).toBe('好')
  })
})

/* ---------------------------------------------------------- 进程树结束 */

describe('B20 结束进程树', () => {
  it('Windows 用 taskkill /T /F（只杀直接子进程会留下孤儿占端口）', () => {
    expect(buildKillTreeCommand('win32', 4321)).toEqual({
      command: 'taskkill',
      args: ['/PID', '4321', '/T', '/F']
    })
  })

  it('POSIX 杀**进程组**（负号 pid）—— 所以 spawn 必须 detached', () => {
    expect(buildKillTreeCommand('linux', 4321)).toEqual({
      command: 'kill',
      args: ['-TERM', '-4321']
    })
    expect(buildKillTreeCommand('darwin', 7)).toEqual({
      command: 'kill',
      args: ['-TERM', '-7']
    })
  })
})
