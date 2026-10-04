<script setup lang="ts">
/**
 * 回滚一个往期版本（B13 / T13.2 ~ T13.5）。
 *
 * ## 这个弹窗要回答的唯一问题：「我会失去什么？」
 *
 * 回滚是**唯一一个会同时改动两处**的操作：服务器的目标路径，以及版本库
 * （当前版本会被归档进去）。所以对比与告知不是装饰，是这个弹窗的主体：
 *
 * 1. **两栏对比**（T13.3）：当前版本 vs 要换上的版本，时间 / 指纹 / 大小 / 文件数；
 * 2. **两个选项各自的后果**写在选项旁边（T13.2 / T13.4），不靠用户猜：
 *    - 保留来源版本 → 用复制（慢一点，版本库里那一版还在，可以再滚回来）；
 *    - 跳过校验 → 黄色警告（ROLLBACK_SKIP_VERIFY_WARNING，与服务端同一份文案）。
 *
 * ## 数字的口径必须标出来
 *
 * "当前版本"的数字来自**台账里最近一次成功操作的记录** —— 那是那次操作当时的快照。
 * 用户完全可能在两次操作之间手工往目标目录塞过东西。所以两边分别标
 * "台账记录" / "归档记录"，而不是含糊地写成"当前"与"目标"。
 * 想要服务器上的**现状**，要连服务器现算 —— 那是确认弹窗之后的阶段 0/1 的事。
 *
 * ## 进度
 *
 * 回滚跑在 `JobService` 里（与发布同一套：可取消、有进度、有日志），
 * 底部任务条会自动显示同一个任务，这里只是换个更贴近操作的呈现。**不另算进度**。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Close, RefreshLeft } from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { useJobStore } from '../stores/job'
import { formatBytes, formatPercent, formatTime } from '../utils/format'
import { isTerminalStatus, type JobView } from '../../../shared/contracts/job'
import {
  ROLLBACK_SKIP_VERIFY_WARNING,
  type RollbackPreview,
  type RollbackSide
} from '../../../shared/contracts/rollback'
import type { ArchiveView } from '../../../shared/contracts/archive'
import type { TargetView } from '../../../shared/contracts/workspace'

const props = defineProps<{
  modelValue: boolean
  target: TargetView
  archive: ArchiveView | null
}>()

const emit = defineEmits<{
  'update:modelValue': [boolean]
  /** 回滚成功（父组件据此重新拉列表与汇总：当前版本被归档成了新的一条） */
  finished: []
}>()

const jobStore = useJobStore()

const preview = ref<RollbackPreview | null>(null)
const loading = ref(false)
const previewError = ref('')

/** 保留来源版本（T13.4）。默认保留：回滚往往是为了"看一眼旧版本"，之后还可能要滚回去 */
const keepSource = ref(true)
/** 跳过完整性校验（T13.2）。默认关闭 —— 校验是这条路上唯一能拦住"内容被改过"的关卡 */
const skipVerify = ref(false)

const starting = ref(false)
const startedJob = ref<JobView | null>(null)
const failText = ref('')

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

/** 任务视图：优先用 store 里的（它带最新状态），拿不到时退回启动响应 */
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
const running = computed(() => Boolean(job.value && !isTerminalStatus(job.value.status)))
const succeeded = computed(() => job.value?.status === 'succeeded')
const failed = computed(() => job.value?.status === 'failed')

/**
 * 失败时的**补偿明细**。
 *
 * 回滚最坏的形态是"把当前版本归档了、新内容又没铺上去" —— 那时目标路径是空的。
 * 服务层会把"刚才做了哪些补救"放进错误详情，这里必须展示出来：
 * 用户此刻最需要知道的是"我的东西还在不在、在哪"。
 */
const compensations = computed<Array<{ action: string; ok: boolean; detail?: string }>>(() => {
  const detail = job.value?.error?.detail as
    | { failure?: { compensations?: Array<{ action: string; ok: boolean; detail?: string }> } }
    | undefined
  return detail?.failure?.compensations ?? []
})

/** 回滚后服务器上会是哪个版本（用于成功提示） */
const targetVersion = computed(() => preview.value?.target.versionTag ?? props.archive?.versionTag ?? '')

async function loadPreview(): Promise<void> {
  if (!props.archive) return
  loading.value = true
  previewError.value = ''
  try {
    preview.value = await api.rollback.preview({
      targetId: props.target.id,
      archiveId: props.archive.id
    })
  } catch (e) {
    preview.value = null
    previewError.value = (e as IpcBusinessError).toUserText()
  } finally {
    loading.value = false
  }
}

async function start(): Promise<void> {
  const a = props.archive
  if (!a || !preview.value) return
  starting.value = true
  failText.value = ''
  try {
    const view = await api.rollback.start({
      targetId: props.target.id,
      archiveId: a.id,
      keepSource: keepSource.value,
      skipVerify: skipVerify.value
    })
    startedJob.value = view
    // 底部任务条也切到它：用户能在那里看到同一份日志
    jobStore.select(view.jobId)
  } catch (e) {
    failText.value = (e as IpcBusinessError).toUserText()
  } finally {
    starting.value = false
  }
}

async function cancel(): Promise<void> {
  const id = job.value?.jobId
  if (!id) return
  await jobStore.cancel(id)
}

/** 每次打开都是新的一次回滚：清掉上一次的状态与选项 */
watch(
  () => props.modelValue,
  (v) => {
    if (!v) return
    startedJob.value = null
    failText.value = ''
    preview.value = null
    keepSource.value = true
    skipVerify.value = false
    void loadPreview()
  },
  { immediate: true }
)

watch(
  () => props.archive?.id,
  () => {
    if (!props.modelValue) return
    startedJob.value = null
    failText.value = ''
    void loadPreview()
  }
)

/** 成功时提示一次，并通知父组件刷新（版本库里会多一条"回滚前"的归档） */
watch(succeeded, (ok) => {
  if (!ok) return
  ElMessage.success(`已回滚到 ${targetVersion.value}`)
  emit('finished')
})

/** 供模板用：把一侧的数字渲染成行 */
function sideRows(side: RollbackSide | null): Array<{ label: string; value: string }> {
  if (!side) return []
  return [
    { label: '版本号', value: side.versionTag },
    { label: '内容指纹', value: side.rootHash ? `${side.rootHash.slice(0, 16)}…` : '未知' },
    { label: '大小', value: formatBytes(side.totalBytes) },
    { label: '文件数', value: `${side.fileCount} 个` },
    { label: '时间', value: side.at ? formatTime(side.at) : '未知' }
  ]
}
</script>

<template>
  <el-dialog
    v-model="open"
    title="回滚到往期版本"
    width="760px"
    :close-on-click-modal="false"
    data-test="rollback-dialog"
  >
    <div v-loading="loading" class="rb-body">
      <!-- 预览失败（台账读不出来 / 版本不属于该目标）：给出原因，且不允许继续 -->
      <el-alert
        v-if="previewError"
        type="error"
        :closable="false"
        show-icon
        :title="previewError"
        data-test="rollback-preview-error"
      />

      <template v-else-if="preview">
        <div class="rb-head">
          <span class="muted">目标</span>
          <strong>{{ preview.targetName }}</strong>
          <span class="mono muted">{{ preview.remotePath }}</span>
        </div>

        <!-- 两栏对比（T13.3）：左边是会被替换掉的，右边是会被换上的 -->
        <div class="rb-compare">
          <div class="rb-side rb-from" data-test="rollback-side-current">
            <div class="rb-side-title">
              当前版本
              <span class="rb-origin">台账记录</span>
            </div>
            <template v-if="preview.current">
              <div
                v-for="row in sideRows(preview.current)"
                :key="row.label"
                class="rb-row"
                :data-test="`rollback-current-${row.label}`"
              >
                <span class="rb-label">{{ row.label }}</span>
                <span class="rb-value mono">{{ row.value }}</span>
              </div>
            </template>
            <div v-else class="rb-empty">台账里没有这个目标的成功记录</div>
            <div class="rb-note">这一版会先被归档进版本库，然后再被换掉</div>
          </div>

          <div class="rb-arrow">→</div>

          <div class="rb-side rb-to" data-test="rollback-side-target">
            <div class="rb-side-title">
              要回滚到的版本
              <span class="rb-origin">归档记录</span>
            </div>
            <div
              v-for="row in sideRows(preview.target)"
              :key="row.label"
              class="rb-row"
              :data-test="`rollback-target-${row.label}`"
            >
              <span class="rb-label">{{ row.label }}</span>
              <span class="rb-value mono">{{ row.value }}</span>
            </div>
            <div class="rb-note">
              归档于 {{ preview.target.at ? formatTime(preview.target.at) : '未知时间' }}
              <el-tag
                v-if="preview.target.status !== 'valid'"
                size="small"
                :type="preview.target.status === 'corrupt' ? 'danger' : 'warning'"
                data-test="rollback-target-status"
              >
                {{ preview.target.status === 'corrupt' ? '内容损坏' : '目录缺失' }}
              </el-tag>
            </div>
          </div>
        </div>

        <el-alert
          v-for="(w, i) in preview.warnings"
          :key="i"
          class="rb-warn"
          type="warning"
          :closable="false"
          show-icon
          :title="w"
          data-test="rollback-warning"
        />

        <!-- 选项：后果写在旁边，不靠用户猜 -->
        <div class="rb-options">
          <label class="rb-option">
            <el-checkbox v-model="keepSource" data-test="rollback-keep-source" />
            <span class="rb-option-body">
              <span class="rb-option-title">保留这个版本在版本库里</span>
              <span class="rb-option-desc">
                用复制的方式恢复（大版本会慢一些）。之后还能再回滚回来。
                取消勾选则是把内容**搬走**，这条版本会从版本库里消失。
              </span>
            </span>
          </label>

          <label class="rb-option">
            <el-switch v-model="skipVerify" data-test="rollback-skip-verify" />
            <span class="rb-option-body">
              <span class="rb-option-title">跳过完整性校验（快速回滚）</span>
              <span class="rb-option-desc">
                默认会逐文件比对归档内容与它的清单 —— 那需要读一遍服务器上的内容，大版本要等一会儿。
                跳过就只能省下这段时间，代价见下方警告。
              </span>
            </span>
          </label>

          <el-alert
            v-if="skipVerify"
            class="rb-warn"
            type="warning"
            :closable="false"
            show-icon
            :title="ROLLBACK_SKIP_VERIFY_WARNING"
            data-test="rollback-skip-verify-warning"
          />
        </div>

        <!-- 运行中 -->
        <div v-if="job" class="rb-progress">
          <el-progress
            :percentage="percent"
            :status="failed ? 'exception' : undefined"
            data-test="rollback-percent"
          />
          <div class="rb-stage">
            <span data-test="rollback-stage">{{ stageText }}</span>
            <span class="muted">{{ formatPercent(percent) }}</span>
            <span v-if="running" class="spacer" />
            <el-button v-if="running" size="small" :icon="Close" @click="cancel">
              取消回滚
            </el-button>
          </div>
        </div>

        <div v-if="failText" class="rb-fail" data-test="rollback-fail-text">{{ failText }}</div>

        <!-- 失败：把补偿明细摊开（此刻用户最需要知道"东西还在不在"） -->
        <div v-if="failed" class="rb-fail-block" data-test="rollback-failure">
          <div class="rb-fail-title">
            {{ job?.error?.message ?? '回滚失败' }}
          </div>
          <div v-if="job?.error?.hint" class="rb-fail-hint">{{ job.error.hint }}</div>
          <ul v-if="compensations.length" class="rb-comp-list">
            <li v-for="(c, i) in compensations" :key="i" :class="{ bad: !c.ok }">
              {{ c.ok ? '已完成补偿' : '补偿失败' }}：{{ c.detail ?? c.action }}
            </li>
          </ul>
        </div>
      </template>
    </div>

    <template #footer>
      <el-button :disabled="running" @click="open = false">关闭</el-button>
      <el-button
        v-if="!succeeded"
        type="warning"
        :icon="RefreshLeft"
        :loading="starting"
        :disabled="running || loading || !preview"
        data-test="rollback-start"
        @click="start"
      >
        确认回滚
      </el-button>
      <el-button v-else type="primary" data-test="rollback-close" @click="open = false">
        完成
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.rb-body {
  min-height: 120px;
}
.rb-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  margin-bottom: 12px;
}
.rb-compare {
  display: flex;
  align-items: stretch;
  gap: 12px;
}
.rb-side {
  flex: 1;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 10px 12px;
  min-width: 0;
}
.rb-to {
  border-color: #e6a23c;
  background: #fdf6ec;
}
.rb-side-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.rb-origin {
  font-weight: 400;
  font-size: 11px;
  color: #909399;
  border: 1px solid #e4e7ed;
  border-radius: 2px;
  padding: 0 4px;
}
.rb-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
}
.rb-label {
  color: #909399;
  flex: 0 0 60px;
}
.rb-value {
  color: #303133;
  word-break: break-all;
}
.rb-empty {
  font-size: 12px;
  color: #e6a23c;
  padding: 4px 0;
}
.rb-note {
  margin-top: 8px;
  font-size: 11px;
  color: #909399;
  line-height: 1.5;
}
.rb-arrow {
  display: flex;
  align-items: center;
  color: #c0c4cc;
  font-size: 18px;
}
.rb-warn {
  margin-top: 10px;
}
.rb-options {
  margin-top: 14px;
}
.rb-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  cursor: pointer;
}
.rb-option-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rb-option-title {
  font-size: 13px;
  color: #303133;
}
.rb-option-desc {
  font-size: 11px;
  color: #909399;
  line-height: 1.6;
}
.rb-progress {
  margin-top: 14px;
}
.rb-stage {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #303133;
  margin-top: 6px;
}
.rb-fail {
  margin-top: 10px;
  font-size: 12px;
  color: #f56c6c;
}
.rb-fail-block {
  margin-top: 10px;
  border: 1px solid #fbc4c4;
  background: #fef0f0;
  border-radius: 4px;
  padding: 10px 12px;
}
.rb-fail-title {
  font-size: 13px;
  color: #f56c6c;
  font-weight: 600;
}
.rb-fail-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
  line-height: 1.6;
}
.rb-comp-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #303133;
  line-height: 1.7;
}
.rb-comp-list li.bad {
  color: #f56c6c;
}
</style>
