/**
 * 真机 E2E 的远端访问助手（B12 建立，B13 复用）。
 *
 * ## 为什么要单独一条连接
 *
 * 这些用例要断言的是**服务器上到底剩了什么**（目标路径的内容、归档目录、
 * 有没有半截残留）。让应用自己报告"我成功了"是循环论证 ——
 * 所以测试另开一条独立的 SSH 连接，直接读写磁盘。
 *
 * ## 为什么不用 `rm -rf` 之类的命令
 *
 * 与产品代码同一个理由（方案书 §6.5/§8.3）：**不依赖远端 shell**。
 * 这里所有操作都走 SFTP 原语（mkdir / readdir / unlink / rmdir / stat），
 * 于是在任何开了 SFTP 的机器上都能跑，不需要对方装了什么。
 */
import { Client, type SFTPWrapper } from 'ssh2'
import { readFileSync } from 'node:fs'

export interface RemoteConn {
  client: Client
  sftp: SFTPWrapper
}

export interface RemoteAuth {
  host: string
  port: number
  user: string
  keyPath: string
}

export async function connectRemote(auth: RemoteAuth): Promise<RemoteConn> {
  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.on('ready', resolve).on('error', reject)
    client.connect({
      host: auth.host,
      port: auth.port,
      username: auth.user,
      privateKey: readFileSync(auth.keyPath)
    })
  })
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
    client.sftp((e, s) => (e ? reject(e) : resolve(s)))
  )
  return { client, sftp }
}

/**
 * 逐级建目录。
 *
 * SFTP 的 `mkdir` **不是** `mkdirp`：父目录不存在时直接失败。所以失败就回到上一级
 * 再来一次（幂等：本级已存在也当成功 —— 我们只关心"最后它在"）。
 */
export async function sftpMkdirp(conn: RemoteConn, dir: string): Promise<void> {
  const attempt = (): Promise<boolean> =>
    new Promise((resolve) => conn.sftp.mkdir(dir, { mode: 0o755 }, (err) => resolve(!err)))
  if (await attempt()) return
  const parent = dir.slice(0, dir.lastIndexOf('/'))
  if (!parent || parent === dir) return
  await sftpMkdirp(conn, parent)
  await attempt()
}

export function writeRemoteText(conn: RemoteConn, path: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 'finish' 与 'close' 哪个先到都算写完（ssh2 的流在正常结束时两者都发，顺序不保证）
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const ws = conn.sftp.createWriteStream(path)
    ws.on('error', (e: Error) => {
      if (!settled) {
        settled = true
        reject(e)
      }
    })
    ws.on('finish', () => done())
    ws.on('close', () => done())
    ws.end(Buffer.from(text, 'utf8'))
  })
}

export function readRemoteText(conn: RemoteConn, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.sftp.readFile(path, (e, data) => (e ? reject(e) : resolve(data.toString('utf8'))))
  })
}

export function remoteExists(conn: RemoteConn, path: string): Promise<boolean> {
  return new Promise((resolve) => conn.sftp.stat(path, (e) => resolve(!e)))
}

export function remoteList(conn: RemoteConn, dir: string): Promise<string[]> {
  return new Promise((resolve) => {
    conn.sftp.readdir(dir, (e, list) => resolve(e ? [] : list.map((i) => i.filename).sort()))
  })
}

export function removeRemoteDir(conn: RemoteConn, dir: string): Promise<void> {
  return new Promise((resolve) => {
    conn.sftp.readdir(dir, (e, list) => {
      if (e) return resolve()
      if (list.length === 0) return conn.sftp.rmdir(dir, () => resolve())
      let pending = list.length
      for (const it of list) {
        const p = `${dir}/${it.filename}`
        const done = (): void => {
          if (--pending === 0) conn.sftp.rmdir(dir, () => resolve())
        }
        if (it.attrs.isDirectory()) void removeRemoteDir(conn, p).then(done)
        else conn.sftp.unlink(p, () => done())
      }
    })
  })
}

/**
 * 按 `{ 相对路径: 内容 }` 在远端铺出一棵目录树（先建父目录再写文件）。
 *
 * 造"一个历史版本"就是这么几步：建 `payload/<basename>/…`、写文件、
 * 最后补一份 `manifest.json`。B12 的下载用例与 B13 的回滚用例都要这个。
 */
export async function writeRemoteTree(
  conn: RemoteConn,
  root: string,
  files: Record<string, string>
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const idx = rel.lastIndexOf('/')
    if (idx > 0) await sftpMkdirp(conn, `${root}/${rel.slice(0, idx)}`)
    await writeRemoteText(conn, `${root}/${rel}`, content)
  }
}
