/**
 * 发布前的**差异摘要**（B11 / T11.3 的纯逻辑内核）。
 *
 * 「这次发布会改动什么」是确认弹窗里用户唯一真正要判断的信息 ——
 * 只给"1200 个文件 / 45 MB"等于没说：用户关心的是**相对上一次发布变了什么**。
 *
 * ## 复用而不是另写一套比对
 *
 * 三类差异的形状与 B07 的远端校验完全一致（`diffByHashes`：missing / extra / mismatch），
 * 只是**语义换了个视角**：
 *
 * | VerifyDiff | 发布差异 | 含义 |
 * | --- | --- | --- |
 * | `extra` | 新增 | 本地有、上次发布没有 |
 * | `mismatch` | 修改 | 两边都有但哈希不同 |
 * | `missing` | 删除 | 上次发布有、本地没有 |
 * | `matchedCount` | 未变 | 逐字节一致 |
 *
 * 所以这里**不重新实现比对**，只做"视角转换 + 截断"。
 * 另写一套的代价是：两份实现迟早对"同一份内容"给出不同结论，而用户无法分辨谁对。
 */
import { diffByHashes } from './hash-core'
import type { ReleaseItem } from '../../shared/contracts/hash'
import type { PublishDiff } from '../../shared/contracts/deploy'

/** 每类差异最多列出多少条路径（条数统计永远准确，列表只截断）。 */
export const PUBLISH_DIFF_LIST_LIMIT = 200

/**
 * 算出发布差异。
 *
 * @param previous 上一次**成功**发布的逐文件清单；null = 首次发布
 * @param current  本次本地产物的逐文件清单
 */
export function computePublishDiff(input: {
  previous: readonly ReleaseItem[] | null
  current: readonly ReleaseItem[]
  previousVersionTag?: string | null
  limit?: number
}): PublishDiff {
  const limit = Math.max(1, input.limit ?? PUBLISH_DIFF_LIST_LIMIT)

  // 首次发布：没有可比的对象。把"全部都是新增"如实说出来，
  // 而不是给一个空差异（那会让用户以为"什么都没变"）。
  if (!input.previous) {
    return {
      added: input.current.slice(0, limit).map((i) => i.relPath),
      modified: [],
      deleted: [],
      unchangedCount: 0,
      counts: {
        added: input.current.length,
        modified: 0,
        deleted: 0,
        unchanged: 0
      },
      truncated: input.current.length > limit,
      firstPublish: true,
      previousVersionTag: null
    }
  }

  const actual = new Map(input.current.map((i) => [i.relPath, i.hash]))
  const d = diffByHashes(input.previous, actual)

  return {
    added: d.extra.slice(0, limit),
    modified: d.mismatch.slice(0, limit).map((m) => m.relPath),
    deleted: d.missing.slice(0, limit),
    unchangedCount: d.matchedCount,
    counts: {
      added: d.extra.length,
      modified: d.mismatch.length,
      deleted: d.missing.length,
      unchanged: d.matchedCount
    },
    truncated:
      d.extra.length > limit || d.mismatch.length > limit || d.missing.length > limit,
    firstPublish: false,
    previousVersionTag: input.previousVersionTag ?? null
  }
}

/** 差异是否"什么都没有变"（内容与上次发布逐字节一致）。 */
export function isNoopDiff(diff: PublishDiff): boolean {
  return !diff.firstPublish && diff.counts.added === 0 && diff.counts.modified === 0 && diff.counts.deleted === 0
}

/** 一句话摘要，供确认弹窗与日志复用。 */
export function describePublishDiff(diff: PublishDiff): string {
  if (diff.firstPublish) {
    return `首次发布：将上传 ${diff.counts.added} 个文件`
  }
  if (isNoopDiff(diff)) {
    return `内容与上一次发布完全一致（${diff.counts.unchanged} 个文件）`
  }
  const parts: string[] = []
  if (diff.counts.deleted) parts.push(`删除 ${diff.counts.deleted} 个`)
  if (diff.counts.modified) parts.push(`修改 ${diff.counts.modified} 个`)
  if (diff.counts.added) parts.push(`新增 ${diff.counts.added} 个`)
  parts.push(`未变 ${diff.counts.unchanged} 个`)
  return parts.join('、')
}
