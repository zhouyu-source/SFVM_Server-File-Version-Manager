/**
 * B12 真机回归：浅父目录下的发布残留必须能清掉。
 *
 * ## 背景（2026-10-01 用户实测 + 真机复现）
 *
 * 目标路径在浅父目录下（如 `/tmp/dist`）时，发布暂存目录是 `/tmp/.sfvm-staging-<id>`
 * （只有 2 层），被 `remote-fs.rmrf` 的"层级过浅"守卫（≥3 层）拒绝：
 * 1. 发布收尾的暂存清理失败（只记警告）→ 残留留在父目录；
 * 2. 下一次发布前置校验认出"远端残留"→ 用户点清理 → `cleanResidue` 撞上同一守卫
 *    → 报"远端路径不合法" → **残留永远删不掉**。
 *
 * 修复：`rmrf` 的层级守卫对**本工具自建**的条目（`.sfvm-staging-` 前缀，名字即来源证明）
 * 放行；守卫的单测在 `tests/unit/b12-rmrf-guard.test.ts`，这里验证**整条发布链路**。
 *
 * 两种形态各发一次：
 * - 浅路径（父目录 = /tmp）：发布后**不应**有残留；即便有，`cleanResidue` 必须成功；
 * - 常规路径：对照组（本就不该有残留）。
 */
import { existsSync, mkdtempSync, readFileSync as readKey, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SshConnectionPool } from '@main/services/ssh-client'
import { createRemoteFs } from '@main/services/remote-fs'
import { createArchiveService } from '@main/services/archive'
import {
  createDeployService,
  createSftpDeployPorts,
  type DeployContext,
  type DeployPorts,
  type DeployProgressInput,
  type DeploySftpLike
} from '@main/services/deploy'
import { classifyResidue, isAutoCleanable } from '@main/infra/deploy-plan'

import type { Repositories } from '@main/db/repositories'
import { makeTestDb, type TestDb } from '../helpers/db'

const HOST = process.env['SFVM_IT_HOST']
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER']
const KEY_PATH = process.env['SFVM_IT_KEY']
const enabled = Boolean(HOST && USER && KEY_PATH && existsSync(KEY_PATH ?? ''))
const describeIf = enabled ? describe : describe.skip

const rand = (): string => Math.random().toString(36).slice(2, 10)

/** 远端临时根（测试自建，afterAll 会连根删掉 —— 注意它只有 2 层） */
const REMOTE_ROOT_PARENT = '/tmp/sfvm-b12p'

let t: TestDb
let repo: Repositories
let pool: SshConnectionPool
let connId = ''

const dirs: string[] = []
function localArtifact(content: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sfvm-b12p-'))
  dirs.push(root)
  for (const [rel, c] of Object.entries(content)) {
    const p = join(root, rel)
    mkdirSync(join(root, rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''), { recursive: true })
    writeFileSync(p, c)
  }
  return root
}

function makeCtx() {
  const logs: string[] = []
  const ac = new AbortController()
  const ctx: DeployContext = {
    signal: ac.signal,
    progress: (_p: DeployProgressInput) => undefined,
    log: (text: string, level?: string) => logs.push(`${level ?? 'info'}\t${text}`)
  }
  return { ctx, logs }
}

async function publish(targetId: string, releaseId: string): Promise<{ ok: boolean; logs: string[] }> {
  const { ctx, logs } = makeCtx()
  const sftp = (await pool.sftp(connId)) as unknown as DeploySftpLike
  const capability = pool.capabilityOf(connId)!
  const ports: DeployPorts = createSftpDeployPorts({
    sftp,
    capability,
    tmpDir: `${capability.homeDir}/.sfvm-tmp`,
    exec: (cmd) => pool.exec(connId, cmd),
    hostname: 'probe'
  })
  const svc = createDeployService({ repo, archive: createArchiveService({ repo }) })
  const out = await svc.run({ targetId, ports, ctx, releaseId, note: null })
  return { ok: out.ok, logs }
}

/**
 * 递归删远端目录，**绕开** `remote-fs.rmrf` 的守卫。
 *
 * 守卫要求"至少 3 层"是为了防止误删生产路径，而 `/tmp/sfvm-b12p` 这个测试用的
 * 临时根只有 2 层 —— 它本来就该被删掉，只是不该通过守卫那条路删。
 * 测试自己建的东西自己负责清干净（项目约定：跑完 `/tmp` 下 `sfvm-*` 必须为零）。
 */
async function rmRemoteRecursive(sftp: Awaited<ReturnType<typeof pool.sftp>>, path: string): Promise<void> {
  const isDir = (): Promise<boolean> =>
    new Promise((resolve) => {
      sftp.stat(path, (err, st) => resolve(!err && Boolean(st && st.isDirectory())))
    })
  const children = (): Promise<string[]> =>
    new Promise((resolve) => {
      sftp.readdir(path, (err, list) =>
        resolve(err || !list ? [] : list.map((e) => e.filename).filter((n) => n !== '.' && n !== '..'))
      )
    })
  const unlink = (p: string): Promise<void> =>
    new Promise((resolve) => sftp.unlink(p, () => resolve()))
  const rmdir = (p: string): Promise<void> => new Promise((resolve) => sftp.rmdir(p, () => resolve()))

  if (!(await isDir())) {
    await unlink(path)
    return
  }
  for (const name of await children()) {
    await rmRemoteRecursive(sftp, `${path}/${name}`)
  }
  await rmdir(path)
}

async function listDir(path: string): Promise<string[]> {
  const sftp = await pool.sftp(connId)
  const fs = createRemoteFs(sftp as never)
  try {
    const list = await fs.readdir(path)
    return list.map((e) => `${e.name}${e.isDirectory ? '/' : ''}`).sort()
  } catch {
    return []
  }
}

beforeAll(async () => {
  t = makeTestDb()
  repo = t.repo
  pool = new SshConnectionPool()
  const conn = repo.connections.create({
    name: 'probe',
    host: HOST!,
    port: PORT,
    username: USER!,
    authType: 'privateKey',
    privateKeyPath: KEY_PATH!
  })
  connId = conn.id
  const keyBlob = readKey(KEY_PATH!)
  const { fingerprintOf } = await import('@main/services/ssh-client')
  const fp = fingerprintOf(keyBlob)
  repo.knownHosts.trust(HOST!, PORT, fp.keyType, fp.fingerprint)
  await pool.connect({
    connectionId: connId,
    host: HOST!,
    port: PORT,
    username: USER!,
    authType: 'privateKey',
    privateKey: keyBlob,
    hostKeyPolicy: 'accept-any'
  })
}, 120000)

afterAll(async () => {
  // 远端也要清到根：只删 `<根>/<随机>` 会让 `/tmp/sfvm-b12p` 本身留下来，
  // 下次 `node .tools/verify/check-residue.cjs` 就会报 RESIDUE: found
  try {
    await rmRemoteRecursive(await pool.sftp(connId), REMOTE_ROOT_PARENT)
  } catch {
    /* 清理失败不影响测试结果，但会被 check-residue 抓到 */
  }
  pool.disconnectAll?.()
  t.cleanup()
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describeIf('残留探针', () => {
  for (const scenario of [
    { name: '浅路径（父目录 = /tmp）', remotePath: `/tmp/dist-${rand()}`, parent: '/tmp' },
    { name: '常规路径', remotePath: `${REMOTE_ROOT_PARENT}/${rand()}/web/dist`, parent: '' }
  ]) {
    it(`${scenario.name}：发布 → 列目录 → 清理残留`, async () => {
      const parent = scenario.parent || scenario.remotePath.slice(0, scenario.remotePath.lastIndexOf('/'))
      const env = repo.environments.create({ name: `probe-${rand()}`, envType: 'test', connectionId: connId })
      const local = localArtifact({ 'index.html': 'v1' })
      const target = repo.targets.create({
        environmentId: env.id,
        name: 'probe',
        kind: 'dir',
        remotePath: scenario.remotePath,
        localPath: local
      })

      const r = await publish(target.id, `rel-${rand()}`)
      console.log(`\n===== ${scenario.name} =====`)
      console.log('发布结果 ok =', r.ok)
      console.log('日志：\n' + r.logs.join('\n'))

      const entries = await listDir(parent)
      const residue = classifyResidue({
        parentDir: parent,
        targetBase: scenario.remotePath.split('/').pop()!,
        entries: entries.map((n) => ({ name: n.replace(/\/$/, ''), isDirectory: n.endsWith('/') }))
      })
      console.log('父目录内容：', JSON.stringify(entries))
      console.log('识别出的残留：', JSON.stringify(residue))

      /**
       * 兜底断言：万一将来又冒出残留，它**必须**是"可自动清理"的。
       *
       * 曾经的故障正是反过来的 —— 残留被识别出来了，但 `cleanResidue` 走 `rmrf`
       * 时被"层级过浅"守卫拒绝，于是界面提示清理、点了却永远失败。
       * 识别出却清不掉，比没识别出来更糟（用户会反复重试）。
       */
      for (const item of residue) {
        expect(
          isAutoCleanable(item),
          `残留 ${item.path} 被识别出来却不可自动清理（会变成"点了清理也清不掉"）`
        ).toBe(true)
      }

      // 第二次发布前先试清理（模拟用户点"清理残留"）
      if (residue.length > 0) {
        const sftp = (await pool.sftp(connId)) as unknown as DeploySftpLike
        const capability = pool.capabilityOf(connId)!
        const ports = createSftpDeployPorts({
          sftp,
          capability,
          tmpDir: `${capability.homeDir}/.sfvm-tmp`,
          exec: (cmd) => pool.exec(connId, cmd),
          hostname: 'probe'
        })
        const svc = createDeployService({ repo, archive: createArchiveService({ repo }) })
        const cleaned = await svc.cleanResidue({
          targetId: target.id,
          paths: residue.map((x) => x.path),
          fs: ports.fs
        })
        console.log('cleanResidue removed =', JSON.stringify(cleaned.removed))
        console.log('cleanResidue failed  =', JSON.stringify(cleaned.failed, null, 2))
        expect(cleaned.failed, `清理应当成功，实际失败：${JSON.stringify(cleaned.failed)}`).toEqual([])
      }

      // 收尾
      const sftp2 = await pool.sftp(connId)
      const fs2 = createRemoteFs(sftp2 as never)
      await fs2.rmrf(parent).catch(() => undefined)
    }, 180000)
  }
})
