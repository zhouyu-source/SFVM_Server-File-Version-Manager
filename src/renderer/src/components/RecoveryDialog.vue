<script setup lang="ts">
/**
 * 崩溃恢复（B14 / T14.4 ~ T14.5）。
 *
 * ## 这个弹窗的存在本身就是一个结论
 *
 * 它只在"台账里有没做完的操作"时才被打开（入口是应用启动后的横幅）。
 * 那种状态意味着：**上次应用没能把一件事做完** —— 断电、强杀、断网、
 * 或者用户自己取消到一半。此时服务器上的状态介于"操作前"与"操作后"之间，
 * 而**只有人知道该往哪边走**，所以这里的做法是先勘察、再给选项，绝不自动决定。
 *
 * ## 三个选项各自意味着什么
 *
 * | 选项 | 做什么 | 什么时候对 |
 * | --- | --- | --- |
 * | 恢复旧版本 | 把这次操作归档的旧版本搬回目标路径，再清残留 | 想回到操作前的状态（最保守） |
 * | 放弃并清理 | 只清掉暂存与锁、把记录收尾，**不动目标路径** | 目标路径上的内容是自己想要的 / 准备重新发布 |
 * | 重新发布 | 关掉弹窗、回到发布面板 | 本地产物已经就绪，重新走一遍更省事 |
 *
 * **"恢复旧版本"在目标路径上有内容时是禁用的**，而且禁用原因会写出来 ——
 * 那套内容可能是这次操作换上去的半成品、也可能是别人放的，
 * 这种判断不该由工具替用户下。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { confirmDanger } from '../utils/danger'
import { RefreshLeft, Refresh, VideoPlay } from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { formatTime } from '../utils/format'
import type {
  RecoverResult,
  RecoveryDiagnosis,
  StartupScan,
  UnfinishedRelease
} from '../../../shared/contracts/reconcile'

const props = defineProps<{ modelValue: boolean }>()

const emit = defineEmits<{
  'update:modelValue': [boolean]
  /** 用户选了「重新发布」：父组件去把发布面板打开（或提示他去目标页） */
  retry: [targetId: string]
  /** 处理过若干条 → 父组件重新跑一次启动扫描（横幅该消失了） */
  done: []
}>()

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const scan = ref<StartupScan | null>(null)
const loading = ref(false)
const errorText = ref('')
/** 每条记录的现场勘察结果 */
const diagnoses = ref<Record<string, RecoveryDiagnosis>>({})
/** 正在勘察/处理的那条 */
const busyId = ref('')
const results = ref<Record<string, RecoverResult>>({})

const items = computed<UnfinishedRelease[]>(() => scan.value?.unfinished ?? [])

async function load(): Promise<void> {
  loading.value = true
  errorText.value = ''
  diagnoses.value = {}
  results.value = {}
  try {
    scan.value = await api.reconcile.startupScan()
  } catch (e) {
    scan.value = null
    errorText.value = (e as IpcBusinessError).toUserText()
  } finally {
    loading.value = false
  }
}

/** 勘察一条记录的现场（连服务器看目标 / 归档 / 锁 / 暂存）。 */
async function inspect(item: UnfinishedRelease): Promise<void> {
  busyId.value = item.releaseId
  try {
    diagnoses.value = {
      ...diagnoses.value,
      [item.releaseId]: await api.reconcile.diagnose({
        targetId: item.targetId,
        releaseId: item.releaseId
      })
    }
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    busyId.value = ''
  }
}

/**
 * 执行一个收场动作。
 *
 * 两个动作都会**改动远端**（搬回旧版本 / 删暂存与锁），所以都要先确认；
 * 确认文案里说清"会发生什么"，而不是一句"确定吗"。
 */
async function act(item: UnfinishedRelease, mode: 'restore-old' | 'abandon'): Promise<void> {
  const d = diagnoses.value[item.releaseId]

  /**
   * 两个动作都会**改动远端**，所以都要说清"对服务器的影响"（T15.6）：
   * - 恢复旧版本：目标路径上的内容会被归档里的旧版本**替换**；
   * - 放弃并清理：只清暂存与锁，**目标路径一个字都不动** ——
   *   这一点尤其要说，因为用户看到的是"未完成的发布"，很容易以为"清理"等于"回退"。
   */
  const ok = await confirmDanger({
    title: mode === 'restore-old' ? '恢复旧版本' : '放弃并清理',
    consequence:
      mode === 'restore-old'
        ? `将把归档里的 ${d?.archive?.versionTag ?? '旧版本'} 搬回目标路径 ${d?.remotePath}，` +
          '并清掉这次操作留下的暂存目录与锁。'
        : `不会改动目标路径 ${d?.remotePath}，只清掉这次操作留下的暂存目录与锁，` +
          '并把这条记录标记为失败。',
    remoteEffect: 'files',
    remoteDetail:
      mode === 'restore-old'
        ? `目标路径 ${d?.remotePath} 上的内容会被替换成归档里的那一版。`
        : `会删除目标路径父目录下的暂存目录（.sfvm-staging-*）与发布锁 .sfvm.lock；目标路径本身不动。`,
    confirmText: mode === 'restore-old' ? '恢复' : '清理'
  })
  if (!ok) return

  busyId.value = item.releaseId
  try {
    const r = await api.reconcile.recover({
      targetId: item.targetId,
      releaseId: item.releaseId,
      mode,
      cleanResidue: true
    })
    results.value = { ...results.value, [item.releaseId]: r }
    if (r.status === 'success') ElMessage.success('处理完成')
    else ElMessage.warning(`部分完成：${r.manualCleanup.length} 项需要人工处理`)

    /**
     * 处理完就把这条从列表里摘掉（`startupScan` 是按台账算的，
     * 收尾后台账行变成 FAILED 就不再是"未结束"了）。
     */
    scan.value = await api.reconcile.startupScan()
    const rest = { ...diagnoses.value }
    delete rest[item.releaseId]
    diagnoses.value = rest
    emit('done')
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    busyId.value = ''
  }
}

function retry(item: UnfinishedRelease): void {
  emit('retry', item.targetId)
  open.value = false
}

function optionOf(d: RecoveryDiagnosis | undefined, mode: string): { enabled: boolean; reason: string } {
  const o = d?.options.find((x) => x.mode === mode)
  return { enabled: o?.enabled ?? false, reason: o?.reason ?? '' }
}

watch(
  () => props.modelValue,
  (v) => {
    if (v) void load()
  },
  { immediate: true }
)
</script>

<template>
  <el-dialog
    v-model="open"
    title="未完成的操作"
    width="860px"
    :close-on-click-modal="false"
    data-test="recovery-dialog"
  >
    <div v-loading="loading" class="rv-body">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="上次有操作没做完 —— 服务器上的状态介于「操作前」与「操作后」之间"
        data-test="recovery-banner"
      >
        这个列表来自本地台账里的「未结束」记录（只读本地，不需要联网）。
        先点「查看现场」，看清目标路径、归档与残留的实际状态，再决定往哪边走。
        <b>应用不会自动替你决定。</b>
      </el-alert>

      <el-alert
        v-if="errorText"
        class="rv-error"
        type="error"
        :closable="false"
        show-icon
        :title="errorText"
        data-test="recovery-error"
      />

      <el-empty v-if="!loading && items.length === 0" description="没有未完成的操作" :image-size="70" />

      <div v-for="item in items" :key="item.releaseId" class="rv-item" :data-test="`recovery-item-${item.releaseId}`">
        <div class="rv-head">
          <el-tag size="small" :type="item.action === 'rollback' ? 'warning' : 'primary'">
            {{ item.action === 'rollback' ? '回滚' : '发布' }}
          </el-tag>
          <strong>{{ item.targetName }}</strong>
          <span class="muted">{{ item.environmentName }}</span>
          <span class="mono muted">{{ item.versionTag }}</span>
          <span class="spacer" />
          <span class="muted">
            停在「{{ item.currentStep ?? item.status }}」· {{ formatTime(item.startedAt) }}
          </span>
          <el-button
            size="small"
            :icon="VideoPlay"
            :loading="busyId === item.releaseId"
            :data-test="`recovery-inspect-${item.releaseId}`"
            @click="inspect(item)"
          >
            查看现场
          </el-button>
        </div>

        <!-- 现场勘察结果 -->
        <div v-if="diagnoses[item.releaseId]" class="rv-scene" :data-test="`recovery-scene-${item.releaseId}`">
          <div class="rv-summary">{{ diagnoses[item.releaseId]!.summary }}</div>
          <div class="rv-detail muted">
            <div>目标路径：<span class="mono">{{ diagnoses[item.releaseId]!.remotePath }}</span></div>
            <div v-if="diagnoses[item.releaseId]!.archive">
              这次归档的旧版本：
              <span class="mono">{{ diagnoses[item.releaseId]!.archive!.versionTag }}</span>
              <template v-if="!diagnoses[item.releaseId]!.archive!.storageExists">（归档目录已不存在）</template>
            </div>
            <div v-if="diagnoses[item.releaseId]!.staging.length">
              暂存残留 {{ diagnoses[item.releaseId]!.staging.length }} 个：
              <span class="mono">{{ diagnoses[item.releaseId]!.staging.join('、') }}</span>
            </div>
            <div v-if="diagnoses[item.releaseId]!.lock">
              远端锁：
              <span class="mono">{{ diagnoses[item.releaseId]!.lock!.path }}</span>
              <template v-if="diagnoses[item.releaseId]!.lock!.stale">（已陈旧）</template>
            </div>
          </div>

          <div class="rv-actions">
            <el-tooltip
              :content="optionOf(diagnoses[item.releaseId], 'restore-old').reason"
              placement="top"
            >
              <span>
                <el-button
                  type="warning"
                  :icon="RefreshLeft"
                  :disabled="!optionOf(diagnoses[item.releaseId], 'restore-old').enabled"
                  :loading="busyId === item.releaseId"
                  :data-test="`recovery-restore-${item.releaseId}`"
                  @click="act(item, 'restore-old')"
                >
                  恢复旧版本
                </el-button>
              </span>
            </el-tooltip>
            <el-button
              :loading="busyId === item.releaseId"
              :data-test="`recovery-abandon-${item.releaseId}`"
              @click="act(item, 'abandon')"
            >
              放弃并清理
            </el-button>
            <el-button
              :icon="Refresh"
              :data-test="`recovery-retry-${item.releaseId}`"
              @click="retry(item)"
            >
              重新发布
            </el-button>
          </div>

          <div v-if="!optionOf(diagnoses[item.releaseId], 'restore-old').enabled" class="rv-hint muted">
            「恢复旧版本」当前不可用：{{ optionOf(diagnoses[item.releaseId], 'restore-old').reason }}
          </div>

          <!-- 执行结果：逐条如实展示 -->
          <div v-if="results[item.releaseId]" class="rv-result" :data-test="`recovery-result-${item.releaseId}`">
            <div v-for="(a, i) in results[item.releaseId]!.actions" :key="i" :class="{ bad: !a.ok }">
              {{ a.ok ? '✓' : '✗' }} {{ a.action }}<template v-if="a.detail">：{{ a.detail }}</template>
            </div>
            <div v-if="results[item.releaseId]!.manualCleanup.length" class="bad">
              需要人工处理：{{ results[item.releaseId]!.manualCleanup.join('；') }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button data-test="recovery-close" @click="open = false">关闭</el-button>
      <el-button :icon="Refresh" :loading="loading" data-test="recovery-refresh" @click="load">
        重新检查
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.rv-body {
  min-height: 120px;
}
.rv-error {
  margin-top: 10px;
}
.rv-item {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 10px 12px;
  margin-top: 10px;
}
.rv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.rv-scene {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed #ebeef5;
}
.rv-summary {
  font-size: 13px;
  color: #303133;
  margin-bottom: 6px;
}
.rv-detail {
  font-size: 12px;
  line-height: 1.8;
  word-break: break-all;
}
.rv-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
.rv-hint {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.6;
}
.rv-result {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.8;
  color: #303133;
}
.rv-result .bad {
  color: #f56c6c;
}
</style>
