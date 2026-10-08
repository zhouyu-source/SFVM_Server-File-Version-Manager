-- P1-1：把 `archives.archived_at` 统一成 UTC ISO（`...Z` 后缀）。
--
-- 历史上同一列混存了两种格式：
--   正常归档   → 仓储默认 `ts()`，UTC，如 `2026-10-07T16:52:00.000Z`
--   对账补录   → manifest 里的 `toLocalIso()`，本地偏移，如 `2026-10-08T00:52:00+08:00`
-- 列上的排序（ORDER BY archived_at DESC）与统计（min/max）都是字符串比较，
-- 偏移格式在字典序上与真实时刻最多差 8 小时，跨 UTC 日界时序整体颠倒。
--
-- SQLite 的日期函数原生支持带 `[+-]HH:MM` / `Z` 时区后缀的输入，
-- `strftime('%Y-%m-%dT%H:%M:%f', ...)` 即换算成 UTC（毫秒精度与 toISOString 对齐）。
-- 刻意只动"带偏移且能解析"的行：解析失败的行原样保留 ——
-- 与 retention 的"坏行一律保留"约定一致，交给对账处理。
UPDATE `archives`
SET `archived_at` = strftime('%Y-%m-%dT%H:%M:%f', `archived_at`) || 'Z'
WHERE `archived_at` NOT LIKE '%Z'
  AND strftime('%Y-%m-%dT%H:%M:%f', `archived_at`) IS NOT NULL;
