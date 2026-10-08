<script setup lang="ts">
/**
 * 往期版本区块（B12：T12.1~T12.7 的容器）。
 *
 * 为什么单独做一个容器组件，而不是把逻辑塞进 `TargetDetail.vue`：
 * 这一块有**四个会改变服务器状态的动作**（下载 / 删除 / 校验 / 保留策略清理）
 * 与两份要同步刷新的数据（列表 + 台账汇总）。散在详情页里，每次新增一个动作
 * 都要记得去补一遍刷新，漏一个就会出现"删了但计数没变"这种没人信得过的界面。
 * 集中在这里，"动作完成后刷什么"只有一处答案。
 *
 * E2E 依赖的 `data-test=archive-summary` / `archive-count` 保留在工具栏上
 * （B11 的 E2E 用它们断言"发布后往期版本列表更新了"）。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Brush, Delete, DocumentChecked, Refresh, Setting } from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { useWorkspaceStore } from '../stores/workspace'
import ArchiveTable from './ArchiveTable.vue'
import ArchiveDownloadDialog from './ArchiveDownloadDialog.vue'
import ArchiveDetailDrawer from './ArchiveDetailDrawer.vue'
import RollbackDialog from './RollbackDialog.vue'
import ReconcileDialog from './ReconcileDialog.vue'
import DangerConfirm from './DangerConfirm.vue'
import { confirmDanger } from '../utils/danger'
import { formatBytes } from '../utils/format'
import type { ArchiveSummary, ArchiveView } from '../../../shared/contracts/archive'
import type { TargetView } from '../../../shared/contracts/workspace'

const props = defineProps<{ target: TargetView }>()
const emit = defineEmits<{ changed: []; edit: [] }>()

const ws = useWorkspaceStore()

const rows = ref<ArchiveView[]>([])
const summary = ref<ArchiveSummary | null>(null)
const loading = ref(false)
const loadError = ref('')
const selectedIds = ref<string[]>([])
const busy = ref(false)

const downloadOpen = ref(false)
const downloadTarget = ref<ArchiveView | null>(null)
/** 回滚（B13）：与下载共用"选中哪一行"的思路，但动作会改远端，所以走独立弹窗 */
const rollbackOpen = ref(false)
const rollbackTarget = ref<ArchiveView | null>(null)
/**
 * 与服务器对账（B14）：远端才是真相来源，本地台账只是缓存。
 * 数据库被删、应用崩过、或者有人手工动过归档目录，都要靠它把账修回来。
 */
const reconcileOpen = ref(false)
const detailOpen = ref(false)
const detailTarget = ref<ArchiveView | null>(null)

const removeOpen = ref(false)
const removeIds = ref<string[]>([])
const removing = ref(false)
/** 删除前的"将释放多少"（台账口径，来自汇总与选中行） */
const removeBytes = computed(() =>
  rows.value.filter((r) => removeIds.value.includes(r.id)).reduce((a, r) => a + r.totalBytes, 0)
)
const removeIncludeInvalid = computed(() =>
  rows.value.some((r) => removeIds.value.includes(r.id) && r.status !== 'valid')
)

const isProd = computed(() => ws.isProd(props.target.environmentId))

const policyText = computed(() => {
  const p = props.target.retainPolicy
  if (!p) return '不自动清理'
  return `按${p.mode === 'count' ? '份数' : '天数'}保留 ${p.value}`
})

const badCount = computed(() => (summary.value ? summary.value.byStatus.missing + summary.value.byStatus.corrupt : 0))

/**
 * 是否**成功完成过一次**加载（B15 / T15.5）。
 *
 * 与 `loading` 分开：判"空"要用它。`loading` 在刷新时也是 true，
 * 拿它做骨架屏会让每次刷新都把已有列表闪掉。
 */
const loadedOnce = ref(false)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    // 并行：列表与汇总是两份数据，串行会白白多等一个往返
    const [list, agg] = await Promise.all([
      api.archives.list(props.target.id),
      api.archives.summary(props.target.id)
    ])
    rows.value = list
    summary.value = agg
    loadedOnce.value = true
    // 已选中的可能已被删掉：清掉不存在的 id，否则"删除选中 3"却只删了 1 个
    const alive = new Set(list.map((r) => r.id))
    selectedIds.value = selectedIds.value.filter((id) => alive.has(id))
  } catch (e) {
    rows.value = []
    summary.value = null
    loadError.value = (e as IpcBusinessError).toUserText()
  } finally {
    loading.value = false
  }
}

function openDownload(row: ArchiveView): void {
  downloadTarget.value = row
  downloadOpen.value = true
}

function openDetail(row: ArchiveView): void {
  detailTarget.value = row
  detailOpen.value = true
}

function openRollback(row: ArchiveView): void {
  rollbackTarget.value = row
  rollbackOpen.value = true
}

/**
 * 回滚完成。
 *
 * 除了刷新本区块（往期版本列表里多了一条"回滚前的那一版"），还要**往上冒一个
 * `changed`** —— 回滚是归档区里唯一会改动"当前版本"的操作，而"当前版本"那个
 * 描述项归父组件（`TargetDetail`）管。不冒这个事件，界面就会停在旧版本号上，
 * 切走再切回来才更新（B13 上线后用户实测踩到）。
 */
function onRollbackFinished(): void {
  void load()
  emit('changed')
}

function askRemove(ids: string[]): void {
  if (ids.length === 0) return
  removeIds.value = ids
  removeOpen.value = true
}

async function doRemove(): Promise<void> {
  const ids = removeIds.value
  if (ids.length === 0) return
  removing.value = true
  try {
    /**
     * 注意 `[...ids]`：`removeIds.value` 是 Vue 的**响应式代理数组**，
     * 而 Electron 的 IPC 用的是结构化克隆 —— V8 的序列化器**拒绝 Proxy**，
     * 报的是一句毫无线索的 `An object could not be cloned.`（真窗口 E2E 抓到过）。
     * 跨进程传参一律传普通值。
     */
    const r = await api.archives.remove({ archiveIds: [...ids] })
    if (r.failed.length === 0) {
      ElMessage.success(`已删除 ${r.removed.length} 个往期版本，释放 ${formatBytes(r.freedBytes)}`)
    } else {
      // 部分失败**不能**说成"完成了"：哪几个没删成、为什么，都要给出来
      ElMessage.warning(
        `已删除 ${r.removed.length} 个，${r.failed.length} 个失败：` +
          r.failed.map((f) => `${f.versionTag}（${f.reason}）`).join('；')
      )
    }
    removeOpen.value = false
    selectedIds.value = []
    await load()
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    removing.value = false
  }
}

async function doVerify(row: ArchiveView): Promise<void> {
  busy.value = true
  try {
    const r = await api.archives.verify(row.id)
    if (r.ok) ElMessage.success(`${r.versionTag} 校验通过（${r.message}）`)
    else ElMessage.warning(`${r.versionTag} 校验未通过：${r.message}`)
    await load()
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    busy.value = false
  }
}

async function runRetention(): Promise<void> {
  busy.value = true
  try {
    const r = await api.archives.applyRetention(props.target.id)
    if (r.invalidReason) ElMessage.error(`保留策略不可用：${r.invalidReason}`)
    else if (r.removed.length === 0 && r.failed.length === 0) ElMessage.info(`无需清理（${r.policyText}）`)
    else {
      ElMessage.success(
        `已清理 ${r.removed.length} 个版本，释放 ${formatBytes(r.removed.reduce((a, x) => a + x.bytes, 0))}` +
          (r.failed.length > 0 ? `；${r.failed.length} 个失败` : '')
      )
    }
    await load()
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    busy.value = false
  }
}

async function confirmRetention(): Promise<void> {
  /**
   * 这段文案原来写的是 `**真的删除服务器上的归档目录**` —— Markdown 的加粗。
   * 而 `ElMessageBox` **不渲染 Markdown**，用户看到的是一串字面量星号（B15 / T15.6 修掉）。
   * 现在改走 `confirmDanger()`，"对服务器的影响"那句话有唯一来源。
   */
  const ok = await confirmDanger({
    title: '执行保留策略',
    consequence: `将立即按当前策略清理往期版本（${policyText.value}）。`,
    remoteEffect: 'files',
    remoteDetail: '被清理的归档目录会从服务器上删除，之后无法再下载或回滚到这些版本。',
    confirmText: '执行清理'
  })
  if (!ok) return
  await runRetention()
}

/** 供父组件在发布成功后调用（T11.6：发布完会多出一条往期版本） */
defineExpose({ reload: load })

/**
 * 目标切换与"发布成功"合并成一个 watcher。
 *
 * 拆成两个会在**切目标**时连续 load 两次：`target.id` 变了触发一次 load，
 * 新的 `lastDeployAt` 与旧目标的不同又触发一次。一个 watcher 里判"到底哪个变了"，
 * 保证每次变化只 load 一次。
 */
watch(
  () => [props.target.id, props.target.lastDeployAt] as const,
  ([id, at], prev) => {
    const prevId = prev?.[0]
    const prevAt = prev?.[1]
    if (id !== prevId) {
      // 换目标：清掉选中并整块重来
      selectedIds.value = []
      void load()
      return
    }
    // 同一目标下 `lastDeployAt` 变了 —— 发布成功，保留策略是异步跑的，可能刚清理过
    if (at !== prevAt) void load()
  },
  { immediate: true }
)
</script>

<template>
  <div class="arch-section" v-loading="loading">
    <div class="bar">
      <div class="left" data-test="archive-summary">
        共
        <strong data-test="archive-count">{{ loadedOnce ? (summary?.count ?? rows.length) : '…' }}</strong>
        个往期版本
        <span class="sep">·</span>
        占用
        <strong data-test="archive-usage">{{
          loadedOnce ? formatBytes(summary?.totalBytes ?? 0) : '…'
        }}</strong>
        <el-tag v-if="badCount > 0" size="small" type="warning" class="ml" data-test="archive-bad">
          {{ badCount }} 个状态异常
        </el-tag>
        <span class="sep">·</span>
        <span class="muted">保留策略：{{ policyText }}</span>
      </div>
      <span class="spacer" />
      <el-button size="small" :icon="Refresh" :disabled="busy" data-test="archive-refresh" @click="load">
        刷新
      </el-button>
      <el-button size="small" :icon="Setting" data-test="archive-edit-policy" @click="emit('edit')">
        配置策略
      </el-button>
      <el-button
        size="small"
        :icon="DocumentChecked"
        data-test="archive-reconcile"
        @click="reconcileOpen = true"
      >
        对账
      </el-button>
      <el-button
        size="small"
        :icon="Brush"
        :disabled="busy || (summary?.count ?? 0) === 0"
        data-test="archive-run-retention"
        @click="confirmRetention"
      >
        立即清理
      </el-button>
      <el-button
        size="small"
        type="danger"
        :icon="Delete"
        :disabled="busy || selectedIds.length === 0"
        data-test="archive-remove-selected"
        @click="askRemove(selectedIds)"
      >
        删除选中（{{ selectedIds.length }}）
      </el-button>
    </div>

    <el-alert
      v-if="loadError"
      class="mb8"
      type="error"
      show-icon
      :closable="false"
      :title="loadError"
    />

    <!--
      首次加载还没回来 → 骨架屏（B15 / T15.5）。
      这一块的"空"尤其容易骗人：上面那行统计会先显示"共 0 个往期版本 · 占用 0 B"，
      而目标可能其实有几个 GB 的归档还没读出来。所以统计行与表格一起等。
    -->
    <el-skeleton v-if="!loadedOnce" :rows="4" animated data-test="archive-skeleton" />

    <ArchiveTable
      v-else
      v-model:selected-ids="selectedIds"
      :rows="rows"
      :busy="busy"
      @detail="openDetail"
      @download="openDownload"
      @remove="askRemove"
      @rollback="openRollback"
      @verify="doVerify"
    />

    <ArchiveDownloadDialog v-model="downloadOpen" :archive="downloadTarget" @finished="load" />
    <ArchiveDetailDrawer v-model="detailOpen" :archive="detailTarget" />
    <!--
      回滚成功后要刷新两样东西：往期版本列表（回滚前那一版被归档进来了）
      与台账汇总。`load` 内部会并行拉这两份。
    -->
    <RollbackDialog
      v-model="rollbackOpen"
      :target="target"
      :archive="rollbackTarget"
      @finished="onRollbackFinished"
    />

    <!-- 对账改了台账（补录 / 标缺失）→ 列表与汇总都要刷新 -->
    <ReconcileDialog v-model="reconcileOpen" :target="target" @changed="load" />

    <DangerConfirm
      v-model="removeOpen"
      title="删除往期版本"
      :detail="`将删除 ${removeIds.length} 个往期版本，释放约 ${formatBytes(removeBytes)}。`"
      remote-effect="files"
      :remote-detail="`这 ${removeIds.length} 个归档目录会从服务器上删除，之后无法再下载或回滚到它们。`"
      :warning="
        removeIncludeInvalid
          ? '选中项中包含状态异常（已丢失 / 已损坏）的版本，删除后这条历史记录将不再可见。'
          : '这是不可逆操作。'
      "
      confirm-text="删除"
      :require-typed-name="isProd"
      :expected-name="target.name"
      :loading="removing"
      @confirm="doRemove"
    />
  </div>
</template>

<style scoped>
.arch-section {
  min-height: 200px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  color: #303133;
  flex-wrap: wrap;
}
.bar .sep {
  color: #dcdfe6;
}
.bar .spacer {
  flex: 1;
}
.muted {
  color: #909399;
  font-size: 12px;
}
.ml {
  margin-left: 6px;
}
.mb8 {
  margin-bottom: 8px;
}
</style>
