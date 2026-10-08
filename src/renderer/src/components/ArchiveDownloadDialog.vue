<script setup lang="ts">
/**
 * 下载往期版本（B12 / T12.3~T12.4）。
 *
 * ## 两步：先看计划，再动手
 *
 * 打开弹窗时先要一份**下载计划**（`archives.downloadPlan`）：它会算出
 * "内容会落到哪个本地目录"，并在同名目录已存在时自动改成 `-2`。
 * 计划是**纯本地**的（读台账 + 一次 stat，不连服务器），所以离线也能看到落点。
 *
 * 用户看过的那个目录名会被原样带回给下载任务 —— "看到的路径"与"写入的路径"
 * 必须是同一个，否则用户没法解释为什么文件不在他以为的地方。
 *
 * ## 进度从哪来
 *
 * 下载跑在 `JobService` 里（可取消、有进度、有日志），进度与底部任务条同源，
 * 这里只是换个更贴近操作的呈现。**不在组件里另算进度**。
 */
import { computed, onScopeDispose, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Close, Download, FolderOpened } from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { useJobStore } from '../stores/job'
import { useWorkspaceStore } from '../stores/workspace'
import { formatByteProgress, formatBytes, formatPercent } from '../utils/format'
import { isTerminalStatus, type JobView } from '../../../shared/contracts/job'
import type { ArchiveDownloadPlan, ArchiveView } from '../../../shared/contracts/archive'

const props = defineProps<{
  modelValue: boolean
  archive: ArchiveView | null
}>()

const emit = defineEmits<{
  'update:modelValue': [boolean]
  /** 下载成功（父组件据此刷新列表与台账汇总） */
  finished: []
}>()

const jobStore = useJobStore()
const ws = useWorkspaceStore()

const plan = ref<ArchiveDownloadPlan | null>(null)
/** 保存位置输入框（可直接粘贴路径，也可以点「选择…」走系统对话框） */
const saveDirInput = ref('')
let saveDirTimer: ReturnType<typeof setTimeout> | null = null
const planning = ref(false)
const planError = ref('')
const starting = ref(false)
const startedJob = ref<JobView | null>(null)
/** 最近一次失败/成功的错误信息（成功时为 ''） */
const failText = ref('')

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

/** 任务视图：优先用 store 里的（它带最新状态），拿不到时退回启动响应。 */
const job = computed<JobView | null>(() => {
  const id = startedJob.value?.jobId
  if (!id) return null
  return jobStore.jobs.find((j) => j.jobId === id) ?? startedJob.value
})

const progress = computed(() => {
  const id = job.value?.jobId
  return id ? (jobStore.progressById[id] ?? null) : null
})

const percent = computed(() => progress.value?.percent ?? job.value?.percent ?? 0)
const stageText = computed(() => progress.value?.stage ?? job.value?.stage ?? '')
const progressDetail = computed(() => {
  const p = progress.value
  if (!p) return ''
  if (p.totalBytes) return formatByteProgress(p.bytes, p.totalBytes)
  return p.message ?? ''
})

const running = computed(() => Boolean(job.value && !isTerminalStatus(job.value.status)))
const succeeded = computed(() => job.value?.status === 'succeeded')
const failed = computed(() => job.value?.status === 'failed')
const cancelled = computed(() => job.value?.status === 'cancelled')

/**
 * 失败时"内容留在哪"。
 *
 * 服务层把暂存目录路径放进了错误详情（T12.4：校验失败要保留产物并说明原因）。
 * 取不到就退回计划里的 stagingPath —— 两者本就该是同一个。
 */
const stagingPath = computed(() => {
  const detail = job.value?.error?.detail as { stagingPath?: string } | undefined
  return detail?.stagingPath ?? plan.value?.stagingPath ?? ''
})

/** 成功后的落点 */
const resultPath = computed(() => plan.value?.finalPath ?? '')

async function loadPlan(saveDir?: string | null): Promise<void> {
  if (!props.archive) return
  planning.value = true
  planError.value = ''
  try {
    plan.value = await api.archives.downloadPlan({
      archiveId: props.archive.id,
      ...(saveDir ? { saveDir } : {})
    })
    // 把算出来的位置回填到输入框（首次打开时的默认值也走这条路）
    saveDirInput.value = plan.value.saveDir
  } catch (e) {
    plan.value = null
    planError.value = (e as IpcBusinessError).toUserText()
  } finally {
    planning.value = false
  }
}

/** 手输/粘贴路径后重新算计划（防抖：边打字边算会把主进程刷爆） */
watch(saveDirInput, (v) => {
  if (running.value || planning.value) return
  const next = v.trim()
  if (!next || next === plan.value?.saveDir) return
  if (saveDirTimer) clearTimeout(saveDirTimer)
  saveDirTimer = setTimeout(() => void loadPlan(next), 350)
})

// 组件销毁时清掉待触发的防抖定时器：不然它会在组件早已卸载后再去打一次 IPC
onScopeDispose(() => {
  if (saveDirTimer) {
    clearTimeout(saveDirTimer)
    saveDirTimer = null
  }
})

async function pickDir(): Promise<void> {
  try {
    const picked = await api.app.pickDirectory({ defaultPath: plan.value?.saveDir ?? null })
    if (!picked) return
    await loadPlan(picked.path)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

async function start(): Promise<void> {
  const a = props.archive
  const p = plan.value
  if (!a || !p) return
  starting.value = true
  failText.value = ''
  try {
    const view = await api.archives.download({
      archiveId: a.id,
      saveDir: p.saveDir,
      finalName: p.finalName
    })
    startedJob.value = view
    // 任务条也切到它，用户能在底部看到同一份日志
    jobStore.select(view.jobId)
  } catch (e) {
    failText.value = (e as IpcBusinessError).toUserText()
  } finally {
    starting.value = false
  }
}

/** 取消：走任务框架的取消通道（远端流会被掐断，本地暂存由任务收尾清掉） */
async function cancel(): Promise<void> {
  const id = job.value?.jobId
  if (!id) return
  await jobStore.cancel(id)
}

async function reveal(path: string): Promise<void> {
  const reason = await ws.revealLocalPath(path)
  if (reason) ElMessage.warning(reason)
}

/** 每次打开都是新的一次下载：清掉上一次的状态 */
watch(
  () => props.modelValue,
  (v) => {
    if (!v) return
    startedJob.value = null
    failText.value = ''
    plan.value = null
    void loadPlan()
  },
  { immediate: true }
)

watch(
  () => props.archive?.id,
  () => {
    if (props.modelValue) {
      startedJob.value = null
      failText.value = ''
      void loadPlan()
    }
  }
)

/** 成功时提示一次，并通知父组件刷新（列表里不会有新行，但汇总与状态可能变） */
watch(succeeded, (ok) => {
  if (!ok) return
  ElMessage.success('下载完成')
  emit('finished')
})
</script>

<template>
  <el-dialog
    v-model="open"
    title="下载往期版本"
    width="560px"
    :close-on-click-modal="false"
  >
    <div v-if="archive" class="dl">
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="版本">
          <span class="mono">{{ archive.versionTag }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="内容">
          {{ archive.fileCount }} 个文件 · {{ formatBytes(archive.totalBytes) }}
        </el-descriptions-item>
        <el-descriptions-item label="保存位置">
          <!--
            可以直接粘贴路径：系统目录对话框每次都要从树里点过去，
            而"我已经知道要放哪"是常见情况（脚本、CI、或从别处复制来的路径）
          -->
          <div class="path-row">
            <el-input
              v-model="saveDirInput"
              size="small"
              :disabled="running"
              placeholder="保存目录的绝对路径"
              data-test="download-save-dir-input"
            />
            <el-button size="small" :icon="FolderOpened" :disabled="running" @click="pickDir">
              选择…
            </el-button>
          </div>
          <div v-if="planError" class="err" data-test="download-plan-error">{{ planError }}</div>
        </el-descriptions-item>
        <el-descriptions-item label="将下载到">
          <span v-if="plan" class="mono" data-test="download-plan-path">{{ plan.finalPath }}</span>
          <span v-else class="muted">—</span>
        </el-descriptions-item>
      </el-descriptions>

      <el-alert
        v-if="plan?.adjustedFrom"
        class="tip"
        type="info"
        show-icon
        :closable="false"
        :title="`已存在同名目录 ${plan.adjustedFrom}，本次将保存为 ${plan.finalName}`"
      />

      <!-- 进度（T12.4） -->
      <div v-if="job" class="progress">
        <div class="row">
          <span class="stage">{{ stageText || '准备中' }}</span>
          <span class="spacer" />
          <span class="mono" data-test="download-percent">{{ formatPercent(percent) }}</span>
        </div>
        <el-progress :percentage="percent" :show-text="false" :stroke-width="10" />
        <div class="detail muted" data-test="download-progress-detail">{{ progressDetail }}</div>
        <div v-if="running" class="row">
          <el-button size="small" :icon="Close" @click="cancel">取消下载</el-button>
        </div>
      </div>

      <!-- 成功 -->
      <el-alert
        v-if="succeeded"
        class="tip"
        type="success"
        show-icon
        :closable="false"
        title="下载完成，内容已就位"
      >
        <div class="mono" data-test="download-result-path">{{ resultPath }}</div>
      </el-alert>

      <!-- 失败（T12.4：保留产物 + 说明原因） -->
      <el-alert
        v-if="failed || cancelled || failText"
        class="tip"
        type="error"
        show-icon
        :closable="false"
        :title="cancelled ? '下载已取消' : '下载失败'"
      >
        <div data-test="download-failure">
          <div>{{ failText || job?.error?.message || '未知原因' }}</div>
          <div v-if="job?.error?.hint" class="hint">{{ job.error.hint }}</div>
          <div v-if="stagingPath && job?.status === 'failed'" class="hint">
            已下载的部分保留在：<span class="mono">{{ stagingPath }}</span>
            <el-button link type="primary" size="small" :icon="FolderOpened" @click="reveal(stagingPath)">
              打开所在目录
            </el-button>
          </div>
        </div>
      </el-alert>
    </div>

    <template #footer>
      <el-button :disabled="running" @click="open = false">关闭</el-button>
      <el-button
        v-if="succeeded"
        type="primary"
        :icon="FolderOpened"
        data-test="download-open-result"
        @click="reveal(resultPath)"
      >
        打开所在目录
      </el-button>
      <el-button
        v-else
        type="primary"
        :icon="Download"
        :loading="starting"
        :disabled="!plan || running || planning"
        data-test="download-start"
        @click="start"
      >
        开始下载
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mono {
  font-family: Consolas, Monaco, monospace;
  word-break: break-all;
}
.muted {
  color: #909399;
  font-size: 12px;
}
.err {
  color: #f56c6c;
  font-size: 12px;
}
.path-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tip {
  margin-top: 12px;
}
.progress {
  margin-top: 12px;
}
.progress .row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.progress .stage {
  font-size: 13px;
  color: #303133;
}
.progress .spacer {
  flex: 1;
}
.detail {
  margin-top: 6px;
  min-height: 16px;
}
.hint {
  margin-top: 4px;
  font-size: 12px;
}
</style>
