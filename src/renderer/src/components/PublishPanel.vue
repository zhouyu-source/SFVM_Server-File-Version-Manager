<script setup lang="ts">
/**
 * 发布面板（B11 / T11.3 确认弹窗 + T11.4 进度 + T11.5 失败视图 + T11.6 成功后刷新）。
 *
 * ## 数据来自哪里（刻意全部复用已有的东西）
 *
 * - **进度与日志**：`jobStore` 订阅的 B08 事件流。发布本来就是跑在 `JobService`
 *   里的任务，这里只是把同一份数据换了个更细的呈现 —— 所以"面板上的百分比"
 *   与"底部任务条的百分比"必然是同一个值，不存在两套进度互相打架的可能。
 * - **失败详情**：`job.error.detail.failure`（B10 的 `DeployFailure`，含分阶段补偿明细）。
 *   它之所以能到这儿，是因为 `ipc/deploy.ts` 在 `outcome.ok === false` 时**抛了错** ——
 *   否则任务会被记成"已完成"，UI 连"失败了"这个事实都拿不到。
 * - **差异摘要**：`deploy.preview`（纯本地，离线可用）。
 *
 * ## 为什么确认弹窗要跑两次请求
 *
 * `precheck`（连服务器，回答"能不能发"）与 `preview`（纯本地，回答"会变成什么"）
 * 并行发出：前者可能要几秒（建连 + df + 目录探测），后者是本地哈希。
 * 并行能把等待压到 max(两者)，而且**离线时 precheck 会失败、preview 仍能给出差异** ——
 * 用户至少能先看清这次改动，再去解决连接问题。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Close, CopyDocument, Promotion, RefreshRight, VideoPlay } from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { useJobStore } from '../stores/job'
import { writeClipboard } from '../utils/clipboard'
import {
  formatByteProgress,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatTime
} from '../utils/format'
import { isTerminalStatus } from '../../../shared/contracts/job'
import type { DeployFailure, DeployPrecheckReport, DeployPreview, PrecheckItem } from '../../../shared/contracts/deploy'
import type { TargetView } from '../../../shared/contracts/workspace'

const props = defineProps<{ target: TargetView }>()
const emit = defineEmits<{
  deployed: [{ jobId: string; versionTag: string | null }]
  saved: []
}>()

const jobStore = useJobStore()

/* ------------------------------------------------------------- 确认弹窗 */

const dialogOpen = ref(false)
const preparing = ref(false)
const starting = ref(false)
const note = ref('')
/** 前置校验报告；跑不通（离线等）时为 null —— 此时仍然允许用户在看清差异后重试 */
const precheck = ref<DeployPrecheckReport | null>(null)
const precheckError = ref('')
const preview = ref<DeployPreview | null>(null)
const previewError = ref('')
const confirmCleanResidue = ref(false)
const cleanStaleLock = ref(false)

/* --------------------------------------------------------- 当前任务状态 */

/**
 * 本目标上的发布任务（新的在前）。
 *
 * 只匹配 `type === 'deploy'`：归档、下载等其它任务也带 `targetId`，
 * 混进来会让"进度条"显示成别的任务在跑。
 */
const targetJobs = computed(() =>
  jobStore.jobs.filter((j) => j.type === 'deploy' && j.targetId === props.target.id)
)

const activeJob = computed(
  () => targetJobs.value.find((j) => !isTerminalStatus(j.status)) ?? null
)

/** 展示用的任务：优先进行中的，其次最近一次（好让用户看到刚跑完的结果）。 */
const displayJob = computed(() => activeJob.value ?? targetJobs.value[0] ?? null)

const progress = computed(() =>
  displayJob.value ? (jobStore.progressById[displayJob.value.jobId] ?? null) : null
)

const percent = computed(() => progress.value?.percent ?? displayJob.value?.percent ?? 0)

const stageText = computed(
  () => progress.value?.stage ?? displayJob.value?.stage ?? ''
)

const progressDetail = computed(() => {
  const p = progress.value
  if (!p) return ''
  // 当前文件名来自 `message`（上传阶段的消息就是"上传 3/10 assets/app.js"），
  // 不是单独一个字段 —— job store 的进度切片里只保留有意义的几个。
  if (p.totalBytes) {
    return `${formatByteProgress(p.bytes, p.totalBytes)}${p.message ? ` · ${p.message}` : ''}`
  }
  if (p.totalFiles) return `${p.files ?? 0}/${p.totalFiles} 个文件`
  return p.message ?? ''
})

/** B10 的失败明细（补偿动作在里面）。取不到就退回 job.error 的通用信息。 */
const failure = computed<DeployFailure | null>(() => {
  const detail = displayJob.value?.error?.detail as { failure?: DeployFailure } | undefined
  return detail?.failure ?? null
})

const failed = computed(() => displayJob.value?.status === 'failed')

const succeeded = computed(
  () => displayJob.value?.status === 'succeeded' && !activeJob.value
)

const offline = computed(() => precheckError.value !== '')

/* --------------------------------------------------------------- 动作 */

/** 点「发布」：并行取前置校验与差异预览，然后开确认弹窗。 */
async function openConfirm(): Promise<void> {
  dialogOpen.value = true
  preparing.value = true
  precheck.value = null
  precheckError.value = ''
  preview.value = null
  previewError.value = ''
  confirmCleanResidue.value = false
  cleanStaleLock.value = false
  note.value = ''

  await Promise.all([
    api.deploy
      .precheck(props.target.id)
      .then((r) => {
        precheck.value = r
        // 需要确认的项**默认不勾**：残留与锁都可能意味着"有别人在发布"，
        // 默认勾上等于替用户做了决定（方案书 §6.8 要的是"提示后由用户确认"）。
        confirmCleanResidue.value = !r.residue.length
      })
      .catch((e: unknown) => {
        precheckError.value = (e as IpcBusinessError).toUserText()
      }),
    api.deploy
      .preview(props.target.id)
      .then((r) => {
        preview.value = r
      })
      .catch((e: unknown) => {
        previewError.value = (e as IpcBusinessError).toUserText()
      })
  ])

  preparing.value = false
}

const precheckErrors = computed<PrecheckItem[]>(
  () => precheck.value?.items.filter((i) => i.level === 'error') ?? []
)

/**
 * 前置校验里有 error（或压根没跑通）时不允许直接发布。
 *
 * 例外：只有「残留」这一类错误时允许（用户在弹窗里勾了确认就地清理），
 * 这是方案书 §6.8 明确的设计。
 */
const blocked = computed(() => {
  if (offline.value) return true
  const errs = precheckErrors.value
  if (errs.length === 0) return false
  return errs.some((i) => i.key !== 'residue')
})

const needsConfirm = computed(() => Boolean(precheck.value?.needConfirm))

async function start(): Promise<void> {
  if (blocked.value) return
  if (precheck.value?.residue.length && !confirmCleanResidue.value) {
    ElMessage.warning('请先确认清理远端残留')
    return
  }
  starting.value = true
  try {
    const job = await api.deploy.start({
      targetId: props.target.id,
      note: note.value.trim() || null,
      confirmCleanResidue: confirmCleanResidue.value,
      cleanStaleLock: cleanStaleLock.value
    })
    dialogOpen.value = false
    jobStore.select(job.jobId)
    ElMessage.success('发布任务已启动，进度见下方或底部任务条')
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    starting.value = false
  }
}

async function cancel(): Promise<void> {
  const job = activeJob.value
  if (!job) return
  const ok = await jobStore.cancel(job.jobId)
  if (ok) ElMessage.info('已请求取消，正在收尾…')
}

/** T11.6：发布成功 → 通知父级刷新（当前版本卡片 + 往期版本列表 + 本地产物）。 */
const seenSucceeded = new Set<string>()
watch(
  () => displayJob.value && displayJob.value.status === 'succeeded' && !activeJob.value,
  (isDone) => {
    const job = displayJob.value
    if (!isDone || !job) return
    if (seenSucceeded.has(job.jobId)) return
    seenSucceeded.add(job.jobId)
    const detail = job.error?.detail as { versionTag?: string } | undefined
    emit('deployed', { jobId: job.jobId, versionTag: detail?.versionTag ?? null })
  },
  { immediate: true }
)

/** T11.5：复制诊断信息（任务 id + 错误码 + 完整日志，见 job store 的实现）。 */
async function copyDiagnostics(): Promise<void> {
  const job = displayJob.value
  if (!job) return
  const ok = await writeClipboard(jobStore.diagnosticsText(job.jobId))
  if (ok) ElMessage.success('诊断信息已复制到剪贴板')
  else ElMessage.error('复制失败，请手动展开底部任务控制台的日志')
}

async function retry(): Promise<void> {
  const job = displayJob.value
  if (!job) return
  const next = await jobStore.retry(job.jobId)
  if (next) ElMessage.info('已重新发起发布')
}

function diffClass(n: number): string {
  return n > 0 ? 'diff-has' : 'diff-none'
}
</script>

<template>
  <div class="publish">
    <!-- 主操作区 -->
    <div class="bar">
      <el-button
        type="primary"
        :icon="Promotion"
        :disabled="Boolean(activeJob)"
        :loading="preparing"
        data-test="publish-btn"
        @click="openConfirm"
      >
        {{ activeJob ? '发布中…' : '发布到服务器' }}
      </el-button>
      <el-button v-if="activeJob" data-test="cancel-btn" :icon="Close" @click="cancel">
        取消
      </el-button>

      <span class="bar-hint">
        <template v-if="target.lastDeployAt">
          上次发布 {{ formatDateTime(target.lastDeployAt) }}
        </template>
        <template v-else>从未发布过</template>
        <template v-if="!target.verifyRemote">· 发布后校验已关闭</template>
      </span>
    </div>

    <!-- T11.4：进度（与底部任务条同源） -->
    <div v-if="displayJob && (activeJob || failed || succeeded)" class="progress-box">
      <div class="progress-head">
        <span class="stage" data-test="publish-stage">{{ stageText || '准备中' }}</span>
        <span class="spacer" />
        <span class="percent" data-test="publish-percent">{{ formatPercent(percent) }}</span>
      </div>
      <el-progress
        :percentage="Math.round(percent)"
        :status="failed ? 'exception' : succeeded ? 'success' : undefined"
        :stroke-width="10"
        :show-text="false"
      />
      <div v-if="progressDetail" class="progress-detail" data-test="publish-detail">
        {{ progressDetail }}
      </div>
    </div>

    <!-- T11.5：失败视图 -->
    <el-alert
      v-if="failed"
      class="fail"
      type="error"
      show-icon
      :closable="false"
      :title="`发布失败：${failure?.stageText ?? ''}${failure ? `（阶段 ${failure.stage}）` : ''}`"
    >
      <div class="fail-body" data-test="publish-failure">
        <div class="fail-code">{{ displayJob?.error?.code }}</div>
        <div class="fail-msg">{{ displayJob?.error?.message }}</div>
        <div v-if="displayJob?.error?.hint" class="fail-hint">
          建议：{{ displayJob.error.hint }}
        </div>

        <!-- 补偿动作：哪些收尾成功了、哪些要人工处理 -->
        <template v-if="failure?.compensations.length">
          <div class="fail-title">已执行的收尾动作</div>
          <ul class="comp">
            <li v-for="(c, i) in failure.compensations" :key="i" :class="c.ok ? 'ok' : 'bad'">
              <span class="ico">{{ c.ok ? '✓' : '✕' }}</span>
              <span>{{ c.action }}</span>
              <span v-if="c.detail" class="comp-detail">{{ c.detail }}</span>
            </li>
          </ul>
        </template>

        <div v-if="failure?.manualCleanup?.length" class="fail-title warn">
          需要人工处理
        </div>
        <ul v-if="failure?.manualCleanup?.length" class="comp">
          <li v-for="(m, i) in failure.manualCleanup" :key="i" class="bad">
            <span class="ico">!</span><span>{{ m }}</span>
          </li>
        </ul>

        <div class="fail-actions">
          <el-button
            size="small"
            :icon="CopyDocument"
            data-test="copy-diagnostics"
            @click="copyDiagnostics"
          >
            复制诊断信息
          </el-button>
          <el-button size="small" :icon="RefreshRight" @click="retry">重试</el-button>
          <el-button size="small" text :icon="VideoPlay" @click="jobStore.setExpanded(true)">
            在任务控制台查看
          </el-button>
        </div>
      </div>
    </el-alert>

    <!-- T11.6：成功提示（刷新由父级监听 deployed 事件完成） -->
    <el-alert
      v-else-if="succeeded"
      class="ok"
      type="success"
      show-icon
      :closable="false"
      title="发布成功"
      data-test="publish-success"
    >
      <div class="ok-body">
        <span v-if="displayJob?.finishedAt">
          完成于 {{ formatTime(displayJob.finishedAt) }} ·
          {{ formatDuration(displayJob.startedAt, displayJob.finishedAt) }}
        </span>
        <span class="spacer" />
        <el-button size="small" text :icon="VideoPlay" @click="jobStore.setExpanded(true)">
          查看日志
        </el-button>
      </div>
    </el-alert>

    <!-- ------------------------------------------------------- 确认弹窗 -->
    <el-dialog
      v-model="dialogOpen"
      title="确认发布"
      width="720px"
      :close-on-click-modal="false"
      data-test="publish-dialog"
    >
      <div v-if="preparing" class="preparing">正在检查前置条件并计算差异…</div>

      <template v-else>
        <!-- 目标与产物 -->
        <el-descriptions :column="1" border size="small" class="dlg-desc">
          <el-descriptions-item label="目标">
            <span class="mono">{{ target.remotePath }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="本地产物">
            <span v-if="preview" class="mono">{{ preview.artifact.localPath }}</span>
            <span v-else class="muted">{{ previewError || '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="preview" label="内容">
            {{ preview.artifact.fileCount }} 个文件 · {{ formatBytes(preview.artifact.totalBytes) }}
            <span v-if="preview.artifact.excludedCount" class="muted">
              （已排除 {{ preview.artifact.excludedCount }} 个）
            </span>
            <span v-if="preview.artifact.skippedSymlinks" class="muted">
              （跳过 {{ preview.artifact.skippedSymlinks }} 个符号链接）
            </span>
          </el-descriptions-item>
          <el-descriptions-item v-if="preview" label="本地指纹">
            <span class="mono" data-test="preview-roothash">{{
              preview.artifact.rootHash.slice(0, 16)
            }}</span>
            <span class="muted">…</span>
            <el-tag
              v-if="preview.artifact.possiblyStale"
              size="small"
              type="warning"
              class="ml"
              >产物可能过期</el-tag
            >
          </el-descriptions-item>
          <el-descriptions-item v-if="preview" label="对照版本">
            <span v-if="preview.lastVersionTag" class="mono">{{ preview.lastVersionTag }}</span>
            <span v-else class="muted">首次发布（没有可对照的上一版）</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="preview?.retainPolicyText" label="保留策略">
            {{ preview.retainPolicyText }}
            <span class="muted">（发布成功后自动执行）</span>
          </el-descriptions-item>
        </el-descriptions>

        <!-- T11.3：差异摘要 -->
        <div v-if="preview" class="diff" data-test="preview-diff">
          <div class="diff-title">与上一次发布相比</div>
          <div class="diff-cards">
            <div class="diff-card" :class="diffClass(preview.diff.counts.added)">
              <div class="diff-num" data-test="diff-added">{{ preview.diff.counts.added }}</div>
              <div class="diff-label">新增</div>
            </div>
            <div class="diff-card" :class="diffClass(preview.diff.counts.modified)">
              <div class="diff-num" data-test="diff-modified">
                {{ preview.diff.counts.modified }}
              </div>
              <div class="diff-label">修改</div>
            </div>
            <div class="diff-card" :class="diffClass(preview.diff.counts.deleted)">
              <div class="diff-num" data-test="diff-deleted">{{ preview.diff.counts.deleted }}</div>
              <div class="diff-label">删除</div>
            </div>
            <div class="diff-card diff-none">
              <div class="diff-num">{{ preview.diff.counts.unchanged }}</div>
              <div class="diff-label">未变</div>
            </div>
          </div>

          <el-collapse v-if="preview.diff.counts.added + preview.diff.counts.modified + preview.diff.counts.deleted > 0">
            <el-collapse-item title="查看变动明细" name="1">
              <div v-if="preview.diff.added.length" class="diff-list">
                <div class="diff-list-title">新增</div>
                <div v-for="p in preview.diff.added" :key="`a-${p}`" class="diff-path">+ {{ p }}</div>
              </div>
              <div v-if="preview.diff.modified.length" class="diff-list">
                <div class="diff-list-title">修改</div>
                <div v-for="p in preview.diff.modified" :key="`m-${p}`" class="diff-path">
                  ~ {{ p }}
                </div>
              </div>
              <div v-if="preview.diff.deleted.length" class="diff-list">
                <div class="diff-list-title danger">删除（发布后将从服务器上消失）</div>
                <div v-for="p in preview.diff.deleted" :key="`d-${p}`" class="diff-path">
                  − {{ p }}
                </div>
              </div>
              <div v-if="preview.diff.truncated" class="muted">
                （列表已截断，计数是完整的）
              </div>
            </el-collapse-item>
          </el-collapse>

          <div v-if="preview.diff.firstPublish" class="first-publish">
            这是该目标的首次发布：服务器上还没有可比对的版本。
          </div>
        </div>

        <el-alert
          v-else-if="previewError"
          type="warning"
          show-icon
          :closable="false"
          :title="`无法计算差异：${previewError}`"
        />

        <!-- 前置校验 -->
        <div class="precheck">
          <div class="diff-title">前置校验</div>
          <el-alert
            v-if="offline"
            type="error"
            show-icon
            :closable="false"
            :title="`无法完成前置校验：${precheckError}`"
          >
            <div class="muted">请先恢复与该环境的连接，再发起发布。</div>
          </el-alert>
          <ul v-else-if="precheck" class="checks">
            <li
              v-for="it in precheck.items"
              :key="it.key"
              :class="it.level"
              :data-test="`precheck-${it.key}`"
            >
              <span class="ico">{{
                it.level === 'ok' ? '✓' : it.level === 'warn' ? '!' : '✕'
              }}</span>
              <div class="body">
                <div class="label">{{ it.label }}</div>
                <div class="detail">{{ it.detail }}</div>
                <div v-if="it.suggestion" class="suggest">{{ it.suggestion }}</div>

                <!-- 残留确认：默认**不勾**，由用户决定 -->
                <div v-if="it.key === 'residue' && it.level !== 'ok'" class="ask">
                  <el-checkbox v-model="confirmCleanResidue" data-test="confirm-residue">
                    确认清理上述残留后继续
                  </el-checkbox>
                </div>
                <div v-if="it.key === 'lock' && it.level !== 'ok'" class="ask">
                  <el-checkbox v-model="cleanStaleLock" data-test="confirm-lock">
                    确认清理该陈旧锁后继续
                  </el-checkbox>
                </div>
              </div>
            </li>
          </ul>
        </div>

        <!-- 备注 -->
        <el-input
          v-model="note"
          class="note"
          type="textarea"
          :rows="2"
          maxlength="500"
          show-word-limit
          placeholder="发布备注（可选）：这次改了什么、为什么发"
          data-test="publish-note"
        />

        <div v-if="needsConfirm" class="muted warn-line">
          本次发布需要你确认上方的残留 / 锁，未勾选则不会继续。
        </div>
      </template>

      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button
          type="primary"
          :icon="Promotion"
          :loading="starting"
          :disabled="preparing || blocked"
          data-test="confirm-publish"
          @click="start"
        >
          确认发布
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.publish {
  margin-bottom: 4px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.bar-hint {
  font-size: 12px;
  color: #909399;
}
.spacer {
  flex: 1;
}
.mono {
  font-family: Consolas, Monaco, monospace;
  word-break: break-all;
}
.muted {
  color: #909399;
  font-size: 12px;
}
.ml {
  margin-left: 6px;
}
.danger {
  color: #f56c6c;
}

.progress-box {
  margin-bottom: 10px;
}
.progress-head {
  display: flex;
  align-items: center;
  font-size: 12px;
  color: #606266;
  margin-bottom: 4px;
}
.stage {
  font-weight: 600;
}
.progress-detail {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
  word-break: break-all;
}

.fail,
.ok {
  margin-bottom: 10px;
}
.fail-body {
  font-size: 12px;
  line-height: 1.8;
}
.fail-code {
  font-family: Consolas, Monaco, monospace;
  color: #f56c6c;
}
.fail-msg {
  color: #303133;
  word-break: break-all;
}
.fail-hint {
  color: #e6a23c;
}
.fail-title {
  margin-top: 8px;
  font-weight: 600;
  color: #303133;
}
.fail-title.warn {
  color: #e6a23c;
}
.comp {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}
.comp li {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.comp li.ok .ico {
  color: #67c23a;
}
.comp li.bad .ico {
  color: #f56c6c;
}
.ico {
  flex: 0 0 auto;
  width: 12px;
  font-weight: 700;
}
.comp-detail {
  color: #909399;
  word-break: break-all;
}
.fail-actions {
  margin-top: 8px;
}
.ok-body {
  display: flex;
  align-items: center;
  font-size: 12px;
}

.preparing {
  padding: 24px 0;
  text-align: center;
  color: #909399;
  font-size: 13px;
}
.dlg-desc {
  margin-bottom: 12px;
}
.diff-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin: 12px 0 8px;
}
.diff-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.diff-card {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 8px 0;
  text-align: center;
  background: #fafafa;
}
.diff-card.diff-has {
  border-color: #a0cfff;
  background: #ecf5ff;
}
.diff-num {
  font-size: 20px;
  font-weight: 700;
  color: #303133;
  line-height: 1.2;
}
.diff-label {
  font-size: 12px;
  color: #909399;
}
.diff-list {
  margin-bottom: 8px;
}
.diff-list-title {
  font-size: 12px;
  font-weight: 600;
  color: #606266;
}
.diff-path {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  color: #606266;
  word-break: break-all;
  line-height: 1.7;
}
.first-publish {
  margin-top: 8px;
  font-size: 12px;
  color: #e6a23c;
}
.checks {
  list-style: none;
  margin: 0;
  padding: 0;
}
.checks li {
  display: flex;
  gap: 6px;
  padding: 6px 0;
  font-size: 12px;
  line-height: 1.7;
  border-bottom: 1px dashed #f0f2f5;
}
.checks li.ok .ico {
  color: #67c23a;
}
.checks li.warn .ico {
  color: #e6a23c;
}
.checks li.error .ico {
  color: #f56c6c;
}
.checks .body {
  flex: 1;
  min-width: 0;
}
.checks .label {
  font-weight: 600;
  color: #303133;
}
.checks .detail {
  color: #606266;
  word-break: break-all;
}
.checks .suggest {
  color: #e6a23c;
}
.checks .ask {
  margin-top: 4px;
}
.note {
  margin-top: 12px;
}
.warn-line {
  margin-top: 8px;
  color: #e6a23c;
}
</style>
