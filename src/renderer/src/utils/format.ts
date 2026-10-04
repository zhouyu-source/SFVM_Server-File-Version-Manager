/**
 * 展示层格式化（B08）。
 *
 * 为什么集中一处：任务条、任务列表、诊断信息都要把"字节数 / 时间 / 耗时"
 * 变成人能读的字符串。各写各的迟早会出现"同一份数据两处显示不一致"，
 * 而且这类小函数最容易在边界上出错（0、未知、跨天）。
 */

/** 字节数 → 人类可读。未知（undefined）显示 '-'，而不是 0 B。 */
export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '-'
  if (bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

/** "31/46 MB" 这种进度文案；两端都未知时返回 '-'。 */
export function formatByteProgress(done?: number | null, total?: number | null): string {
  if (done === undefined || done === null) return formatBytes(total)
  if (total === undefined || total === null) return formatBytes(done)
  return `${formatBytes(done)} / ${formatBytes(total)}`
}

/** 百分比 → 整数文案（进度条不显示小数，避免宽度抖动）。 */
export function formatPercent(percent?: number | null): string {
  if (percent === undefined || percent === null || !Number.isFinite(percent)) return '0%'
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`
}

/** ISO 字符串 → 本地时间 HH:mm:ss；解析失败原样返回，不要显示 "Invalid Date"。 */
export function formatTime(iso?: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * ISO 字符串 → 本地时间 YYYY-MM-DD HH:mm:ss。
 *
 * 用于**跨天的历史台账**（归档时间、最近发布、最近连接）；当下几分钟内的时刻
 * （任务日志、进度）用 formatTime 即可，带日期反而是噪音。
 *
 * 必须解析后按本地时区渲染，不能对原串做 slice：台账里存的是 UTC（`…Z`，
 * ts() 写入）或带偏移的串（对账补录的远端清单），直接展示原文会把
 * UTC 挂钟当成用户本地的钟 —— 东八区看到的就差 8 小时。
 */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/** 起止时间 → "1.2 秒" / "3 分 05 秒"；缺失任何一端返回 '-'。 */
export function formatDuration(startIso?: string | null, endIso?: string | null): string {
  if (!startIso) return '-'
  const start = new Date(startIso).getTime()
  const end = endIso ? new Date(endIso).getTime() : Date.now()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '-'
  const ms = end - start
  if (ms < 1000) return `${ms} 毫秒`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
}
