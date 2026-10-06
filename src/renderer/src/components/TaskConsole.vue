<script setup lang="ts">
/**
 * 底部任务控制台（T08.6，方案书 §9.1 的"任务控制台"区）。
 *
 * 两块形态：
 * - **收起条**（始终可见）：进行中任务的标题 + 进度条 + 百分比 + 取消按钮。
 *   发布这类长任务的最小可见信息就是它 —— 用户不需要展开也知道还要多久、能不能停。
 * - **展开面板**：任务列表（含失败任务）+ 选中任务的实时日志 + 失败详情与"复制诊断信息"。
 *
 * 设计取舍：
 * - 进度条用自绘的 div 而不是 `el-progress`：收起条只有 36px 高，
 *   `el-progress` 的内边距与文字位置在这里反而要反复覆盖，自绘 3 条 CSS 更可控。
 * - 日志自动滚到底部，但**只在用户已经在底部时**才自动滚 ——
 *   否则用户往上翻日志时会被不断拉回去（这是日志面板最招人烦的行为）。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Close,
  CopyDocument,
  Delete,
  RefreshRight,
  VideoPlay,
  Warning
} from '@element-plus/icons-vue'
import { jobStatusClass, useJobStore } from '../stores/job'
import { isTerminalStatus, jobStatusTagType } from '../../../shared/contracts/job'
import type { JobView } from '../../../shared/contracts/job'
import { formatDuration, formatPercent, formatTime } from '../utils/format'
import { writeClipboard } from '../utils/clipboard'

const store = useJobStore()
const logBox = ref<HTMLElement | null>(null)
/** 用户是否停在日志底部（决定要不要自动跟随） */
const stickToBottom = ref(true)

void store.init()

const selectedId = computed(() => store.selectedJobId)

/**
 * 把表格 slot 的 `row` 收窄回 `JobView`。
 *
 * Element Plus 的 `el-table` 槽位把行数据声明为 `DefaultRow = Record<PropertyKey, any>`，
 * 它**只是索引签名、没有任何具名属性**，因此无法赋值给带必需字段的 `JobView`
 * （索引签名不满足必需属性）。`row.xxx` 能用（`any`），一旦把这个值当整体传给
 * 带类型的 store 方法就会报错 —— 所以显式在边界上收窄一次，不要为此把 store
 * 的参数类型放宽成"最小形状"（那样既过不了检查，又白丢类型约束）。
 */
function toJobView(row: unknown): JobView {
  return row as JobView
}

/**
 * 表格当前行变化 → 切换查看的任务（模板里不能写类型标注）。
 *
 * ## 为什么要防一个 `null`
 *
 * 用户报上来的现象：**点开一个"执行中"的任务，详情显示一下就自己关掉了**。
 * 根因不在 store，而在 `el-table` 的当前行机制 ——
 * `node_modules/element-plus/.../table/src/store/current.mjs` 的 `updateCurrentRowData()`：
 *
 * ```js
 * if (oldCurrentRow && !data.includes(oldCurrentRow)) {
 *   if (rowKey) { setCurrentRowByKey(...) }   // 有 row-key：按 key 找回新对象
 *   else { currentRow = null; emit('current-change', null) }   // 没有：清空当前行
 * }
 * ```
 *
 * 而 store 更新任务时是**替换行对象**（`jobs[i] = { ...jobs[i], percent }`，见
 * `stores/job.ts` 的 `applyProgress` / `upsert`）。于是路径是：
 * 进度事件 → 行对象被换掉 → `data.includes(旧对象)` 为假 → 没有 `row-key`
 * → 清空当前行 → `current-change(null)` → `select(null)` → 详情回到"选择一个任务查看日志"。
 *
 * 执行中的任务**每秒**都有进度事件（脚本的启发式进度就是 1s 一次），所以是"点开一秒后就关"。
 *
 * 两道保险：
 * 1. 表格加 `row-key="jobId"` —— 让 el-table 自己去新数据里找回同一行（正常路径）；
 * 2. 收到 `null` 时，若 store 里选中的任务**还在**，就当没发生 ——
 *    选中项是 store 的状态，不该被表格内部的实现细节改掉。
 *
 * 顺带一个取舍：`clearFinished` 把"当前选中的那个任务"清掉时，表格会抛一次 `null`，
 * 而此刻 store 可能已经被 `fetchList` 换成了列表第一条 —— 于是详情显示的是第一条、
 * 高亮却没了。宁可这样，也不要"用户点开的东西自己消失"。
 */
function onCurrentChange(row: unknown): void {
  const id = (row as { jobId?: string } | null)?.jobId ?? null
  if (id === null && store.selectedJob) return
  selectJob(id)
}

function selectJob(jobId: string | null): void {
  store.select(jobId)
}

/* ------------------------------------------------------------ 日志跟随 */

function onLogScroll(): void {
  const el = logBox.value
  if (!el) return
  // 留 24px 容差：滚轮到底部时浏览器常有 1~2px 误差
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

watch(
  () => store.selectedLogs.length,
  async () => {
    if (!stickToBottom.value) return
    await nextTick()
    const el = logBox.value
    if (el) el.scrollTop = el.scrollHeight
  }
)

// 切换查看的任务时回到跟随状态（新任务的日志从底部开始看）
watch(selectedId, async () => {
  stickToBottom.value = true
  await nextTick()
  const el = logBox.value
  if (el) el.scrollTop = el.scrollHeight
})

/* -------------------------------------------------------------- 操作 */

async function cancelJob(jobId: string): Promise<void> {
  const ok = await store.cancel(jobId)
  if (ok) ElMessage.info('已请求取消，正在停止…')
  else ElMessage.warning(store.error || '该任务已结束，无法取消')
}

async function retryJob(jobId: string): Promise<void> {
  const job = await store.retry(jobId)
  if (job) ElMessage.success('已创建重试任务')
  else ElMessage.error(store.error || '重试失败')
}

async function runDemo(): Promise<void> {
  const job = await store.startDemo({ steps: 20, stepMs: 150 })
  if (job) ElMessage.success('已启动自检任务（可观察进度、日志与取消）')
  else ElMessage.error(store.error || '无法启动自检任务')
}

async function runFailingDemo(): Promise<void> {
  const job = await store.startDemo({ steps: 10, stepMs: 150, failAtStep: 5, title: '自检任务（故意失败）' })
  if (!job) ElMessage.error(store.error || '无法启动自检任务')
}

async function clearFinished(): Promise<void> {
  const removed = await store.clearFinished()
  if (removed > 0) ElMessage.success(`已清除 ${removed} 条已结束任务`)
}

/**
 * 复制诊断信息（T08.6）。
 *
 * 写入逻辑抽到了 `utils/clipboard.ts` —— B11 的发布失败视图也要复制，
 * 两处各写一份迟早出现"任务条能复制、发布面板不能"这种不一致。
 */
async function copyDiagnostics(): Promise<void> {
  if (!selectedId.value) return
  const text = store.diagnosticsText(selectedId.value)
  if (!text) {
    ElMessage.warning('没有可复制的诊断信息')
    return
  }
  const ok = await writeClipboard(text)
  if (ok) ElMessage.success('诊断信息已复制到剪贴板')
  else ElMessage.error('复制失败，请手动展开日志复制')
}

onUnmounted(() => {
  store.dispose()
})

/* ------------------------------------------------------------ 展示 */

const barPercent = computed(() => {
  const p = store.primaryJob
  return p ? formatPercent(p.percent) : '0%'
})

const runningCount = computed(() => store.jobs.filter((j) => !isTerminalStatus(j.status)).length)
</script>

<template>
  <div class="task-console">
    <!-- 展开面板 -->
    <section v-if="store.expanded" class="tc-panel">
      <header class="tc-panel-head">
        <strong>任务控制台</strong>
        <span class="tc-count">进行中 {{ runningCount }} · 已结束 {{ store.finishedCount }}</span>
        <span class="tc-spacer" />
        <el-button size="small" :icon="VideoPlay" @click="runDemo">跑一次自检</el-button>
        <el-button size="small" :icon="Warning" @click="runFailingDemo">
          自检（故意失败）
        </el-button>
        <el-button
          size="small"
          :icon="Delete"
          :disabled="store.finishedCount === 0"
          @click="clearFinished"
        >
          清除已结束
        </el-button>
        <el-button size="small" :icon="Close" @click="store.toggleExpanded()">收起</el-button>
      </header>

      <div class="tc-panel-body">
        <div class="tc-list">
          <el-table
            :data="store.jobs"
            row-key="jobId"
            size="small"
            height="196"
            highlight-current-row
            empty-text="暂无任务"
            @current-change="onCurrentChange"
          >
            <el-table-column label="任务" min-width="190">
              <template #default="{ row }">
                <div class="tc-title-line">
                  <span class="tc-title">{{ row.title }}</span>
                  <el-tag size="small" type="info" effect="plain">{{
                    store.typeText(toJobView(row))
                  }}</el-tag>
                </div>
                <div class="tc-id">{{ row.jobId.replace('job_', '').slice(0, 8) }}</div>
              </template>
            </el-table-column>

            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <span :class="['tc-status', jobStatusClass(row.status)]">
                  {{ store.statusText(toJobView(row)) }}
                </span>
              </template>
            </el-table-column>

            <el-table-column label="进度" width="170">
              <template #default="{ row }">
                <div class="tc-row-progress">
                  <div class="tc-progress">
                    <div class="tc-progress-inner" :style="{ width: formatPercent(row.percent) }" />
                  </div>
                  <span class="tc-row-percent">{{ store.progressText(toJobView(row)) }}</span>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="耗时" width="92">
              <template #default="{ row }">
                {{ formatDuration(row.startedAt, row.finishedAt) }}
              </template>
            </el-table-column>

            <el-table-column label="操作" width="132">
              <template #default="{ row }">
                <el-button
                  v-if="!isTerminalStatus(row.status)"
                  size="small"
                  :icon="Close"
                  :disabled="row.cancelRequested"
                  @click="cancelJob(row.jobId)"
                >
                  {{ row.cancelRequested ? '取消中' : '取消' }}
                </el-button>
                <el-button v-else size="small" :icon="RefreshRight" @click="retryJob(row.jobId)">
                  重试
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div class="tc-detail">
          <div class="tc-detail-head">
            <span class="tc-detail-title">
              {{ store.selectedJob ? store.selectedJob.title : '选择一个任务查看日志' }}
            </span>
            <el-tag
              v-if="store.selectedJob"
              size="small"
              :type="jobStatusTagType(store.selectedJob.status)"
            >
              {{ store.statusText(store.selectedJob) }}
            </el-tag>
            <span class="tc-spacer" />
            <el-button
              v-if="store.selectedJob?.error"
              size="small"
              type="primary"
              plain
              :icon="CopyDocument"
              @click="copyDiagnostics"
            >
              复制诊断信息
            </el-button>
          </div>

          <div v-if="store.selectedJob?.error" class="tc-error">
            <div class="tc-error-code">{{ store.selectedJob.error.code }}</div>
            <div class="tc-error-msg">{{ store.selectedJob.error.message }}</div>
            <div v-if="store.selectedJob.error.hint" class="tc-error-hint">
              建议：{{ store.selectedJob.error.hint }}
            </div>
          </div>

          <div ref="logBox" class="tc-logs" @scroll="onLogScroll">
            <div v-if="store.selectedLogs.length === 0" class="tc-empty">暂无日志</div>
            <div
              v-for="(line, i) in store.selectedLogs"
              :key="i"
              :class="['tc-log-line', `lv-${line.level}`]"
            >
              <span class="tc-log-time">{{ formatTime(line.at) }}</span>
              <span class="tc-log-text">{{ line.text }}</span>
            </div>
            <div v-if="store.selectedJob && store.selectedJob.droppedLogs > 0" class="tc-dropped">
              （已省略最早的 {{ store.selectedJob.droppedLogs }} 行日志）
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 收起条（始终可见） -->
    <div class="tc-bar">
      <button type="button" class="tc-toggle" @click="store.toggleExpanded()">
        <span class="tc-caret">{{ store.expanded ? '▾' : '▴' }}</span>
        任务控制台
        <span v-if="runningCount > 0" class="tc-badge">{{ runningCount }}</span>
      </button>

      <template v-if="store.primaryJob">
        <span :class="['tc-status', jobStatusClass(store.primaryJob.status)]">
          {{ store.statusText(store.primaryJob) }}
        </span>
        <span class="tc-percent">{{ barPercent }}</span>
        <div class="tc-progress tc-progress-bar">
          <div class="tc-progress-inner" :style="{ width: barPercent }" />
        </div>
        <span class="tc-msg">
          {{ store.primaryJob.title }} · {{ store.progressText(store.primaryJob) }}
        </span>
        <span class="tc-spacer" />
        <el-button
          size="small"
          :icon="Close"
          :disabled="store.primaryJob.cancelRequested"
          @click="cancelJob(store.primaryJob.jobId)"
        >
          {{ store.primaryJob.cancelRequested ? '取消中…' : '取消' }}
        </el-button>
      </template>

      <template v-else>
        <span class="tc-msg tc-muted">
          {{ store.hasFailure ? '有任务失败 —— 展开可查看日志与诊断信息' : '无运行中任务' }}
        </span>
        <span class="tc-spacer" />
        <span v-if="store.finishedCount > 0" class="tc-msg tc-muted">
          已结束 {{ store.finishedCount }} 个
        </span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.task-console {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--sfvm-border);
  background: #fff;
}

/* -------------------------------------------------------------- 收起条 */

.tc-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--sfvm-fg);
}

.tc-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  padding: 0 4px;
  height: 24px;
  font-size: 12px;
  color: var(--sfvm-fg);
  cursor: pointer;
  border-radius: 4px;
}

.tc-toggle:hover {
  background: var(--sfvm-bg);
}

.tc-caret {
  font-size: 10px;
  color: var(--sfvm-muted);
}

.tc-badge {
  min-width: 16px;
  height: 16px;
  line-height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--sfvm-brand);
  color: #fff;
  font-size: 11px;
  text-align: center;
}

.tc-spacer {
  flex: 1;
}

.tc-percent {
  font-variant-numeric: tabular-nums;
  color: var(--sfvm-fg);
  min-width: 34px;
}

.tc-msg {
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #606266;
}

.tc-muted {
  color: var(--sfvm-muted);
}

/* -------------------------------------------------------------- 进度条 */

.tc-progress {
  height: 6px;
  border-radius: 3px;
  background: #ebeef5;
  overflow: hidden;
  flex: none;
}

.tc-progress-bar {
  width: 160px;
}

.tc-progress-inner {
  height: 100%;
  background: var(--sfvm-brand);
  transition: width 0.2s ease;
}

/* -------------------------------------------------------------- 状态色 */

.tc-status.st-running {
  color: var(--sfvm-brand);
}
.tc-status.st-ok {
  color: #67c23a;
}
.tc-status.st-err {
  color: #f56c6c;
}
.tc-status.st-muted,
.tc-status.st-queued {
  color: var(--sfvm-muted);
}

/* -------------------------------------------------------- 展开面板 */

.tc-panel {
  border-bottom: 1px solid var(--sfvm-border);
  background: #fff;
}

.tc-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--sfvm-border);
  font-size: 12px;
}

.tc-panel-head strong {
  font-size: 13px;
}

.tc-count {
  color: var(--sfvm-muted);
}

.tc-panel-body {
  display: grid;
  grid-template-columns: minmax(420px, 1fr) minmax(320px, 1fr);
  height: 208px;
}

.tc-list {
  border-right: 1px solid var(--sfvm-border);
  min-width: 0;
}

.tc-title-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tc-title {
  font-weight: 500;
}

.tc-id {
  color: var(--sfvm-muted);
  font-size: 11px;
  font-family: Consolas, 'Courier New', monospace;
}

.tc-row-progress {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tc-row-progress .tc-progress {
  flex: 1;
}

.tc-row-percent {
  color: var(--sfvm-muted);
  font-size: 11px;
  white-space: nowrap;
}

/*
  右侧详情。
  `min-height: 0` 是**必须**的：它是 grid 项，自动最小尺寸默认等于内容高度，
  于是里面的日志框（`flex:1` + `overflow:auto`）永远拿不到一个受限的高度 ——
  超长内容不会在自己框里滚，而是把整个面板顶破。加上它日志才真的滚起来。
*/
.tc-detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.tc-detail-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--sfvm-border);
}

.tc-detail-title {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
  失败详情可能很长（错误说明 + 建议，或一整段服务端回执）。原来"有多高就多高"，
  于是它能把下面的日志区挤没、再把面板顶破。给它一个上限、超出的自己滚 ——
  详情优先，但不许吃掉整个详情区。
  另外 `overflow-wrap` 是给"一长串没有空格的路径 / 命令"留的，否则横向也会溢出。
*/
.tc-error {
  padding: 6px 10px;
  background: #fef0f0;
  border-bottom: 1px solid #fde2e2;
  font-size: 12px;
  max-height: 120px;
  overflow: auto;
  overflow-wrap: break-word;
}

.tc-error-code {
  color: #f56c6c;
  font-family: Consolas, 'Courier New', monospace;
}

.tc-error-msg {
  color: #303133;
  margin-top: 2px;
}

.tc-error-hint {
  color: #909399;
  margin-top: 2px;
}

.tc-logs {
  flex: 1;
  overflow: auto;
  padding: 6px 10px;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.5;
  background: #fafafa;
}

.tc-log-line {
  display: flex;
  gap: 6px;
  white-space: pre-wrap;
  word-break: break-all;
}

.tc-log-time {
  color: #c0c4cc;
  flex: none;
}

.tc-log-text {
  color: #303133;
}

.tc-log-line.lv-warn .tc-log-text {
  color: #e6a23c;
}
.tc-log-line.lv-error .tc-log-text {
  color: #f56c6c;
}
.tc-log-line.lv-debug .tc-log-text {
  color: #909399;
}

.tc-dropped {
  color: var(--sfvm-muted);
}

.tc-empty {
  color: var(--sfvm-muted);
}
</style>
