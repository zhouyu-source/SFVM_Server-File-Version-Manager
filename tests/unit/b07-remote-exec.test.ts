/**
 * B07 的 T08.1 / T08.2 子集验收点：非白名单命令被拒绝、注入样例全部被拦。
 *
 * 这一层是"命令注入在类型层面不成立"的保证，所以用例按**攻击面**组织：
 * 路径逃逸、引号截断、命令替换、分隔符注入。
 */
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_COMMANDS,
  UnsafeCommandError,
  assertCommandAllowed,
  buildCommandVCommand,
  buildHashCheckCommand,
  buildHomeCommand,
  buildUnameCommand,
  quoteRemotePath,
  quoteShellArg
} from '@main/infra/remote-exec'
import { ErrorCode } from '@main/infra/errors'

describe('quoteShellArg', () => {
  it('单引号包裹普通参数', () => {
    expect(quoteShellArg('/opt/app')).toBe("'/opt/app'")
    expect(quoteShellArg('')).toBe("''")
  })

  it('转义内部单引号（否则能截断参数）', () => {
    expect(quoteShellArg("it's")).toBe("'it'\\''s'")
  })

  it('中文与空格无需特殊处理', () => {
    expect(quoteShellArg('/opt/订单 服务')).toBe("'/opt/订单 服务'")
  })

  it('拒绝空字符与非字符串', () => {
    expect(() => quoteShellArg('a\0b')).toThrow(UnsafeCommandError)
    expect(() => quoteShellArg(42 as unknown as string)).toThrow(UnsafeCommandError)
  })
})

describe('quoteRemotePath', () => {
  it('合法路径先规范化再包裹', () => {
    expect(quoteRemotePath('/opt/app//dist/')).toBe("'/opt/app/dist'")
  })

  it('拒绝路径逃逸与换行注入', () => {
    for (const bad of [
      '/opt/../etc',
      '/etc\nrm -rf /',
      '/opt/app\r\nwhoami',
      'relative/path',
      '/',
      '',
      '/opt/app\0'
    ]) {
      expect(() => quoteRemotePath(bad), `应拒绝：${JSON.stringify(bad)}`).toThrow(
        UnsafeCommandError
      )
    }
  })

  it('拒绝的是 E_PATH_UNSAFE，便于上层区分', () => {
    try {
      quoteRemotePath('/opt/../etc')
      expect.unreachable()
    } catch (err) {
      expect((err as UnsafeCommandError).code).toBe(ErrorCode.E_PATH_UNSAFE)
    }
  })
})

describe('buildHashCheckCommand（T07.7）', () => {
  it('sha256sum 默认不加 --status，以便拿到逐文件结果', () => {
    const cmd = buildHashCheckCommand({
      tool: 'sha256sum',
      cwd: '/opt/app/payload',
      manifestPath: '/home/u/.sfvm-tmp/sfvm-abc.sha256'
    })
    expect(cmd).toBe("cd '/opt/app/payload' && sha256sum -c '/home/u/.sfvm-tmp/sfvm-abc.sha256'")
  })

  it('shasum 需要 -a 256 指定算法', () => {
    const cmd = buildHashCheckCommand({
      tool: 'shasum',
      cwd: '/opt/app/payload',
      manifestPath: '/home/u/.sfvm-tmp/sfvm-abc.sha256'
    })
    expect(cmd).toBe(
      "cd '/opt/app/payload' && shasum -a 256 -c '/home/u/.sfvm-tmp/sfvm-abc.sha256'"
    )
  })

  it('可选 --status 只用于"只要退出码"的场景', () => {
    const cmd = buildHashCheckCommand({
      tool: 'sha256sum',
      cwd: '/opt/app/payload',
      manifestPath: '/home/u/m.sha256',
      status: true
    })
    expect(cmd).toBe("cd '/opt/app/payload' && sha256sum -c --status '/home/u/m.sha256'")
  })

  it('路径里的单引号被转义，无法截断命令', () => {
    const cmd = buildHashCheckCommand({
      tool: 'sha256sum',
      cwd: "/opt/it's here/payload",
      manifestPath: '/home/u/m.sha256'
    })
    expect(cmd.startsWith(`cd '/opt/it'\\''s here/payload' && sha256sum -c `)).toBe(true)
    expect(() => assertCommandAllowed(cmd)).not.toThrow()
  })
})

describe('其他白名单模板', () => {
  it('uname / printf 家目录', () => {
    expect(buildUnameCommand()).toBe('uname -s')
    expect(buildHomeCommand()).toBe('printf %s "$HOME"')
  })

  it('command -v 只接受白名单内的命令', () => {
    expect(buildCommandVCommand('sha256sum')).toBe('command -v sha256sum')
    expect(() => buildCommandVCommand('rm' as never)).toThrow(UnsafeCommandError)
  })
})

describe('assertCommandAllowed（出口自检）', () => {
  it('放行本文件生成的所有命令', () => {
    const cmds = [
      buildUnameCommand(),
      buildHomeCommand(),
      buildCommandVCommand('shasum'),
      buildHashCheckCommand({ tool: 'sha256sum', cwd: '/opt/a', manifestPath: '/opt/b' })
    ]
    for (const c of cmds) expect(() => assertCommandAllowed(c)).not.toThrow()
  })

  it('拒绝非白名单程序开头的命令段', () => {
    for (const bad of [
      'rm -rf /',
      'echo hi',
      'sha256sum -c x; rm -rf /',
      "cd '/opt' && cat /etc/passwd",
      '/bin/sh -c "id"'
    ]) {
      expect(() => assertCommandAllowed(bad), `应拒绝：${bad}`).toThrow(UnsafeCommandError)
    }
  })

  it('拒绝命令替换', () => {
    expect(() => assertCommandAllowed('sha256sum -c `whoami`')).toThrow(UnsafeCommandError)
    expect(() => assertCommandAllowed('sha256sum -c $(id)')).toThrow(UnsafeCommandError)
  })

  it('拒绝空命令与含空字符的命令', () => {
    expect(() => assertCommandAllowed('')).toThrow(UnsafeCommandError)
    expect(() => assertCommandAllowed('   ')).toThrow(UnsafeCommandError)
    expect(() => assertCommandAllowed('uname\0-s')).toThrow(UnsafeCommandError)
  })

  it('白名单里没有文件操作命令（文件操作必须走 SFTP）', () => {
    for (const forbidden of ['rm', 'mv', 'cp', 'cat', 'dd', 'sh', 'bash', 'python3', 'curl']) {
      expect(ALLOWED_COMMANDS as readonly string[]).not.toContain(forbidden)
    }
  })
})
