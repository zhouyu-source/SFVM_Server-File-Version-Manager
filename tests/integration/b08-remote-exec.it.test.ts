/**
 * B08 集成测试：在**真实服务器**上验证远端命令白名单与参数转义（T08.1 / T08.2）。
 *
 * 为什么必须真机跑（而不是只靠单测）：
 * - `df -Pk` 的**输出格式**是"实现约定"而非语言规范。单测里我写的样例是我以为的格式；
 *   真机上可能多一列、可能表头不同、可能因 `POSIXLY_CORRECT` 改块大小。
 *   解析错了会导致两种相反的误判（误判空间不足 → 无谓阻止发布；误判充足 →
 *   传到一半炸并留下远端垃圾），所以必须拿真实 `df` 的输出验一次。
 * - `chmod` / `chown` 的**实际生效结果**只能通过 SFTP `stat` 回来确认
 *   （命令退出码为 0 不代表权限真的改了，例如只读挂载上会失败）。
 * - **参数转义必须在真 shell 上验**：单测只能证明"拼出来的字符串长这样"，
 *   证明不了"bash 真的把它当一个参数"。这里用带 `;` / 空格的**真实文件名**跑一遍。
 *
 * 安全边界：所有写操作都在 `<临时根>` = `/tmp/sfvm-b08/<随机>` 下，测试结束一律清理。
 * 默认**跳过**：需要显式提供凭据才执行。运行方式见文件末尾。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync as readKey } from 'node:fs'
import { SshConnectionPool } from '@main/services/ssh-client'
import { createRemoteFs, type SftpLike } from '@main/services/remote-fs'
import {
  ALLOWED_COMMANDS,
  assertCommandAllowed,
  buildChmodCommand,
  buildChownCommand,
  buildDfCommand,
  buildWriteProbeCommand,
  parseDfOutput,
  quoteShellArg
} from '@main/infra/remote-exec'
import type { SFTPWrapper } from 'ssh2'

const HOST = process.env['SFVM_IT_HOST']
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER']
const KEY_PATH = process.env['SFVM_IT_KEY']

const enabled = Boolean(HOST && USER && KEY_PATH && existsSync(KEY_PATH ?? ''))
const describeIf = enabled ? describe : describe.skip

describeIf('B08 远端命令真机集成', () => {
  const CONNECTION_ID = 'it-b08'

  let pool: SshConnectionPool
  let sftp: SFTPWrapper
  let remoteFs: ReturnType<typeof createRemoteFs>
  /** 当前登录用户的 uid；非 0 时 `chown` 必然 EPERM，相关断言降级为记录 */
  let loginUid = -1

  const PARENT_DIR = '/tmp/sfvm-b08'
  const tmpRoot = `${PARENT_DIR}/${Math.random().toString(36).slice(2, 10)}`

  beforeAll(async () => {
    pool = new SshConnectionPool()
    await pool.connect({
      connectionId: CONNECTION_ID,
      host: HOST as string,
      port: PORT,
      username: USER as string,
      authType: 'privateKey',
      privateKey: readKey(KEY_PATH as string),
      hostKeyPolicy: 'accept-any'
    })
    sftp = await pool.sftp(CONNECTION_ID)
    remoteFs = createRemoteFs(sftp as unknown as SftpLike)
    await remoteFs.mkdirp(tmpRoot)

    const st = await remoteFs.stat(tmpRoot)
    loginUid = st.uid ?? -1
  }, 60000)

  afterAll(async () => {
    try {
      if (remoteFs) {
        await remoteFs.rmrf(tmpRoot)
        await new Promise<void>((resolve) => {
          ;(sftp as unknown as { rmdir(p: string, cb: (e?: Error | null) => void): void }).rmdir(
            PARENT_DIR,
            () => resolve()
          )
        })
      }
    } catch (e) {
      console.warn(`清理 ${tmpRoot} 失败（需手工检查）：${(e as Error).message}`)
    }
    try {
      pool?.disconnectAll()
    } catch {
      /* 已断开 */
    }
  })

  /** 通过 SFTP 落一个小文本文件（远端 shell 里没有 `cat`/`tee`，只能走 SFTP）。 */
  async function putFile(path: string, content = 'sfvm-b08\n'): Promise<void> {
    const ws = sftp.createWriteStream(path)
    await new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve())
      ws.on('error', reject)
      ws.end(content)
    })
  }

  /** 取权限位的低 12 位（SFTP 的 mode 含文件类型位，如 0o100644）。 */
  const permBits = (mode: number | undefined): number => (mode ?? 0) & 0o7777

  /* ------------------------------------------------------------ 磁盘空间 */

  it('df -Pk 在真实文件系统上可解析，且三列自洽（T08.1）', async () => {
    const r = await pool.exec(CONNECTION_ID, buildDfCommand(tmpRoot))
    expect(r.code, `df 执行失败：${r.stderr}`).toBe(0)

    const info = parseDfOutput(r.stdout)
    expect(info, `未能解析真实 df 输出：\n${r.stdout}`).not.toBeNull()
    const df = info!

    // 真机上的原始输出必须真的是 6 列（我按 POSIX 格式解析的前提）
    const dataLine = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()!
    expect(dataLine.split(/\s+/).length).toBeGreaterThanOrEqual(6)

    expect(df.totalBytes).toBeGreaterThan(0)
    expect(df.availableBytes).toBeGreaterThanOrEqual(0)
    expect(df.availableBytes).toBeLessThanOrEqual(df.totalBytes)
    expect(df.mountPoint.startsWith('/')).toBe(true)
    // used + avail 必须等于 total（同一行三元组自洽；不等说明列取错了）
    expect(df.usedBytes + df.availableBytes).toBe(df.totalBytes)

    console.info(
      `[B08 集成] df ${df.filesystem} → ${df.mountPoint} ` +
        `可用 ${(df.availableBytes / 1024 / 1024 / 1024).toFixed(1)} GiB / ` +
        `总 ${(df.totalBytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
    )
  })

  it('df 对不存在的路径报错 → 解析返回 null（调用方必须当"探测失败"而非"空间为 0"）', async () => {
    const missing = `${tmpRoot}/definitely-missing-dir`
    const r = await pool.exec(CONNECTION_ID, buildDfCommand(missing))
    // GNU df 会退出码非 0 并把错误写到 stderr
    expect(r.code).not.toBe(0)
    expect(parseDfOutput(r.stdout)).toBeNull()
  })

  /* ------------------------------------------------------------ 写权限探针 */

  it('写权限探针用退出码表达结果（T08.1）', async () => {
    const writable = await pool.exec(CONNECTION_ID, buildWriteProbeCommand(tmpRoot))
    expect(writable.code).toBe(0)

    const missing = await pool.exec(
      CONNECTION_ID,
      buildWriteProbeCommand(`${tmpRoot}/definitely-missing-dir`)
    )
    expect(missing.code).not.toBe(0)
    // 探针命令刻意不输出任何东西（用退码而非 `&& echo yes`）
    expect(writable.stdout.trim()).toBe('')
  })

  /* ------------------------------------------------------------- chmod */

  it('chmod 真机往返：3 位、4 位特殊位、目录都生效（T08.1 / T08.2）', async () => {
    const file = `${tmpRoot}/mode.txt`
    await putFile(file)

    for (const mode of ['600', '754', '4755', '0644']) {
      const r = await pool.exec(CONNECTION_ID, buildChmodCommand({ mode, path: file }))
      expect(r.code, `chmod ${mode} 失败：${r.stderr}`).toBe(0)
      const st = await remoteFs.stat(file)
      // `4755` 与 `0644` 都要按 4 位解析，低 12 位必须完全一致
      expect(permBits(st.mode), `chmod ${mode} 未生效`).toBe(parseInt(mode, 8))
    }

    // 目录同样要能改（T10.9 会对目录做权限对齐）
    const dir = `${tmpRoot}/mode-dir`
    await remoteFs.mkdirp(dir)
    const rd = await pool.exec(CONNECTION_ID, buildChmodCommand({ mode: '750', path: dir }))
    expect(rd.code).toBe(0)
    expect(permBits((await remoteFs.stat(dir)).mode)).toBe(0o750)
  })

  /* ------------------------------------------------------------- chown */

  it('chown 真机往返：改为别的 uid/gid 再改回来（T08.1）', async () => {
    const file = `${tmpRoot}/owner.txt`
    await putFile(file)

    // 用 numeric id 65534（多数发行版是 nobody/nogroup）。
    // 即便该 id 没有对应的 /etc/passwd 条目，numeric chown 仍然生效。
    const r = await pool.exec(CONNECTION_ID, buildChownCommand({ uid: 65534, gid: 65534, path: file }))
    if (loginUid !== 0) {
      // 非 root 用户 chown 必然 EPERM —— 这是方案书 §8.3 允许失败的操作，
      // 此时只确认"命令被正确地拒绝了"，不做属主断言。
      expect(r.code).not.toBe(0)
      console.warn(`[B08 集成] 当前用户 uid=${loginUid} 非 root，跳过 chown 生效断言`)
      return
    }
    expect(r.code, `chown 失败：${r.stderr}`).toBe(0)
    const st = await remoteFs.stat(file)
    expect(st.uid).toBe(65534)
    expect(st.gid).toBe(65534)

    // 改回 root:root，确认是可往返的（不是"设了就回不去"）
    const back = await pool.exec(CONNECTION_ID, buildChownCommand({ uid: 0, gid: 0, path: file }))
    expect(back.code).toBe(0)
    const st2 = await remoteFs.stat(file)
    expect(st2.uid).toBe(0)
    expect(st2.gid).toBe(0)
  })

  /* -------------------------------------------------- 注入：真 shell 上验 */

  it('文件名里带 `;` 与空格时仍是**一个参数**，不会执行注入命令（T08.2）', async () => {
    // 这个文件名如果转义失效，shell 会把它切成 `chmod 600` + `touch pwned` 两条命令。
    const victim = `${tmpRoot}/p; touch pwned`
    const pwned = `${tmpRoot}/pwned`
    await putFile(victim)

    const r = await pool.exec(CONNECTION_ID, buildChmodCommand({ mode: '600', path: victim }))
    expect(r.code, `chmod 失败：${r.stderr}`).toBe(0)
    expect(permBits((await remoteFs.stat(victim)).mode)).toBe(0o600)

    // 关键断言：注入命令**没有**被执行
    expect(await remoteFs.exists(pwned)).toBe(false)
  })

  it("文件名里带单引号时仍正确转义（'\\'' 的真实效果）", async () => {
    const victim = `${tmpRoot}/it's here.txt`
    await putFile(victim)

    const cmd = buildChmodCommand({ mode: '640', path: victim })
    expect(cmd).toContain(`'\\''`)
    const r = await pool.exec(CONNECTION_ID, cmd)
    expect(r.code, `chmod 失败：${r.stderr}`).toBe(0)
    expect(permBits((await remoteFs.stat(victim)).mode)).toBe(0o640)
  })

  it('把合法命令与注入拼在一起时，出口自检在真实执行前就拦下（T08.1 收口）', async () => {
    const payload = `chmod 644 ${quoteShellArg(tmpRoot)} ; rm -rf ${quoteShellArg(tmpRoot)}`
    await expect(pool.exec(CONNECTION_ID, payload)).rejects.toThrow(/非白名单/)
    // 服务器上的东西一个都不能少
    expect(await remoteFs.exists(tmpRoot)).toBe(true)
  })

  it('非白名单程序一律被拒（`rm` / `cat` / `ls` / `sh`）', async () => {
    for (const bad of ['rm -rf /tmp', 'cat /etc/passwd', 'ls -la /', 'sh -c "echo hi"']) {
      await expect(pool.exec(CONNECTION_ID, bad)).rejects.toThrow(/非白名单/)
    }
    // 白名单里确实没有"文件操作"类命令（文件一律走 SFTP，方案书 §8.3）
    for (const forbidden of ['rm', 'mv', 'cp', 'cat', 'echo', 'tee', 'curl', 'sh', 'bash']) {
      expect(ALLOWED_COMMANDS as readonly string[]).not.toContain(forbidden)
    }
  })

  it('白名单模板生成的命令在真机上都能过自检并执行成功', async () => {
    const file = `${tmpRoot}/whitelist.txt`
    await putFile(file)
    const generated = [
      buildDfCommand(tmpRoot),
      buildChmodCommand({ mode: '644', path: file }),
      buildChownCommand({ uid: 0, gid: 0, path: file }),
      buildWriteProbeCommand(tmpRoot)
    ]
    for (const cmd of generated) {
      expect(() => assertCommandAllowed(cmd)).not.toThrow()
      const r = await pool.exec(CONNECTION_ID, cmd)
      // chown 在非 root 下会失败（允许失败），其余必须成功
      if (!cmd.startsWith('chown') || loginUid === 0) {
        expect(r.code, `\`${cmd}\` 执行失败：${r.stderr}`).toBe(0)
      }
    }
  })
})

/**
 * 运行方式（凭据通过环境变量传入，不写死在代码里）：
 *
 *   $env:SFVM_IT_HOST='192.0.2.10'
 *   $env:SFVM_IT_USER='root'
 *   $env:SFVM_IT_KEY='C:\path\to\your-key.pem'
 *   npx vitest run tests/integration/b08-remote-exec.it.test.ts
 *
 * 不提供这些变量时整个文件会被跳过（describe.skip），因此可以安全地留在仓库里。
 * chown 用例在非 root 账号下会自动降级为"确认被正确拒绝"。
 */
