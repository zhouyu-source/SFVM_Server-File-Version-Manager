/**
 * 本地产物的**轻量探测**（B11 / T11.1~T11.2 的 IO 层）。
 *
 * 与 `hashLocalArtifact()` 的区别只有一条：**不读文件内容**。
 * 因此它可以在详情页每次打开时都跑一遍（目录遍历，几十毫秒），
 * 而哈希只能在上传前跑一次。
 *
 * ## 为什么复用 `collectLocalFiles()` 而不是自己 readdir
 *
 * 那一个函数里定死了整个项目对"本地产物"的语义：`local_exclude` 怎么匹配、
 * 符号链接跳过、UTF-8 字节序遍历、文件数上限。徽标上显示的"1234 个文件"
 * 与发布时上传的文件数**必须是同一个集合算出来的** —— 否则用户会看到
 * "徽标说 1200 个、确认弹窗说 1180 个"，然后开始怀疑哪一个是错的。
 *
 * ## 与 precheck 的 `artifactSummary` 同规则
 *
 * "最近一次变动"取 **路径自身 mtime 与全部文件 mtime 的较新者**。
 * 只取目录自身 mtime 会漏掉"就地重写文件"（覆盖写不改父目录 mtime），
 * 于是刚构建完的产物可能仍然显示"3 天前"。规则写在 `infra/local-artifact.ts`，
 * 两处共用。
 */
import { promises as fsp } from 'node:fs'
import { collectLocalFiles } from './hash'
import {
  describeAge,
  describeKindMismatch,
  describeNameMismatch,
  fileNameAlignmentOf,
  isArtifactStale,
  newestMtimeOf
} from '../infra/local-artifact'
import type { LocalArtifactInfo } from '../../shared/contracts/workspace'

export interface StatLocalArtifactInput {
  localPath: string | null
  targetKind: 'dir' | 'file'
  /**
   * 目标的服务器端路径（B17）。
   *
   * 探测本身用不到它，但"本地产物名与服务器端文件名是否一致"这件事必须在
   * **详情页**就说出来（而不是等用户点发布）—— 而详情页只有这个通道。
   * 不传（如旧调用方）时不做这项判断，其余行为不变。
   */
  remotePath?: string | null
  exclude?: readonly string[] | null
  now?: Date
  /** 文件数上限（默认沿用 hash 那套 20 万）；超过则只报"太多"，不报具体数 */
  maxFiles?: number
}

const EMPTY = (path: string | null): LocalArtifactInfo => ({
  path,
  exists: false,
  kind: null,
  fileCount: null,
  totalBytes: null,
  mtime: null,
  mtimeMs: null,
  possiblyStale: false,
  ageText: null,
  kindMismatch: null,
  nameMismatch: null
})

export async function statLocalArtifact(input: StatLocalArtifactInput): Promise<LocalArtifactInfo> {
  const raw = input.localPath?.trim() ?? ''
  if (!raw) return EMPTY(null)

  const now = (input.now ?? new Date()).getTime()

  /**
   * 文件名不一致的说明（B17 / T17.2）。
   *
   * 与路径存不存在无关（只看两个名字），所以放在 stat 之前算：路径还没构建出来时
   * 用户最可能正在改配置，这时告诉他"发上去会叫什么名"恰好有用。
   */
  const align = fileNameAlignmentOf({
    targetKind: input.targetKind,
    localPath: raw,
    remotePath: input.remotePath ?? null
  })
  const nameMismatchText = align ? describeNameMismatch(align) : null

  let st
  try {
    st = await fsp.stat(raw)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // 路径不存在是最常见的情况（用户还没构建），不是错误 —— 面板上给一句
    // "尚未配置/不存在"就行。权限之类的问题同样归为"读不到"，但 UI 文案会区分。
    if (code === 'ENOENT') return { ...EMPTY(raw), nameMismatch: nameMismatchText }
    return {
      ...EMPTY(raw),
      kindMismatch: `无法读取本地路径：${(err as Error).message}`,
      nameMismatch: nameMismatchText
    }
  }

  const localKind: 'dir' | 'file' | null = st.isDirectory()
    ? 'dir'
    : st.isFile()
      ? 'file'
      : null

  const kindMismatch = describeKindMismatch({ targetKind: input.targetKind, localKind })
  /**
   * 类型都不符时**不再提文件名**：那时候用户要做的第一件事是把路径换成文件
   * （`E_LOCAL_PATH_KIND` 会直接拦下发布），两条提示并排只会互相稀释。
   */
  const nameMismatch = kindMismatch ? null : nameMismatchText
  const rootMtimeMs = st.mtimeMs

  /* 文件型（或特殊类型）：不遍历，直接用自身信息 */
  if (localKind !== 'dir') {
    return {
      path: raw,
      exists: true,
      kind: localKind,
      fileCount: localKind === 'file' ? 1 : null,
      totalBytes: localKind === 'file' ? st.size : null,
      mtime: st.mtime.toISOString(),
      mtimeMs: rootMtimeMs,
      possiblyStale: isArtifactStale(rootMtimeMs, now),
      ageText: describeAge(rootMtimeMs, now),
      kindMismatch,
      nameMismatch
    }
  }

  /* 目录型：走一遍文件树（不读内容） */
  try {
    const collected = await collectLocalFiles({
      root: raw,
      exclude: input.exclude,
      ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles })
    })
    const totalBytes = collected.files.reduce((a, f) => a + f.size, 0)
    const mtimeMs = newestMtimeOf([rootMtimeMs, ...collected.files.map((f) => Date.parse(f.mtime))])
    const stale = isArtifactStale(mtimeMs, now)
    return {
      path: raw,
      exists: true,
      kind: 'dir',
      fileCount: collected.files.length,
      totalBytes,
      mtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
      mtimeMs,
      possiblyStale: stale,
      ageText: describeAge(mtimeMs, now),
      kindMismatch,
      nameMismatch
    }
  } catch (err) {
    // 文件数超限 / 目录太深：徽标不该因此变成错误。如实说"数不出来"，
    // 把"能不能发布"留给 precheck 与发布流程去判定（它们会给出准确的原因）。
    return {
      path: raw,
      exists: true,
      kind: 'dir',
      fileCount: null,
      totalBytes: null,
      mtime: st.mtime.toISOString(),
      mtimeMs: rootMtimeMs,
      possiblyStale: isArtifactStale(rootMtimeMs, now),
      ageText: describeAge(rootMtimeMs, now),
      kindMismatch: kindMismatch ?? `无法统计目录内容：${(err as Error).message}`,
      nameMismatch
    }
  }
}
