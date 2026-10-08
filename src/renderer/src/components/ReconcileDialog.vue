<script setup lang="ts">
/**
 * 对账（B14 / T14.1 ~ T14.3）。
 *
 * ## 这个弹窗要传达的核心事实：**远端才是真相来源**
 *
 * 台账（本地 SQLite）只是缓存。换台电脑、删了数据库、应用崩过，服务器上的
 * 归档目录都还在，而且每个版本目录里的 `manifest.json` 是自描述的。
 * 对账就是把两边摆在一起，让用户看见差异，然后按"以远端为准"的原则修账。
 *
 * 所以报告不是只给一个结论数字，而是**逐条列出判定依据**：
 * `台账里有吗 / 远端有吗 / 有 manifest 吗` → 最终结论。
 * 用户能自己核对，而不是只能相信工具。
 *
 * ## 两个开关为什么要摆出来
 *
 * - **深度校验**：要读一遍服务器上的全部内容（逐文件哈希）。几百 MB 的产物
 *   在这台机器上要跑几分钟，所以默认关 —— 但它才是唯一能发现"内容被改过"的手段，
 *   「损坏」那一栏只在它开着的时候才有数。
 * - **补录**：默认开。关掉就是"只想看看差异、先别动我的台账"（诊断模式）。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, DocumentChecked, Refresh } from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { formatBytes, formatDateTime } from '../utils/format'
import { LOCK_REMOVE_HINT, type ReconcileReport } from '../../../shared/contracts/reconcile'
import type { TargetView } from '../../../shared/contracts/workspace'

const props = defineProps<{
  modelValue: boolean
  target: TargetView
}>()

const emit = defineEmits<{
  'update:modelValue': [boolean]
  /** 台账被改过（补录/标缺失）→ 父组件刷新版本列表与汇总 */
  changed: []
}>()

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const report = ref<ReconcileReport | null>(null)
const running = ref(false)
const errorText = ref('')

/** 深度校验（慢）：唯一能发现"内容被改过"的手段 */
const deep = ref(false)
/** 补录远端多出来的版本（关掉 = 只诊断不修改） */
const adopt = ref(true)
const removingLock = ref(false)

/**
 * 删掉远端锁（T14.6）。
 *
 * 方案书 §6.8 的立场是"**锁只由人确认后清理**"：它可能是另一台机器上正在进行的
 * 发布，而"那台机器还在跑吗"只有人判断得了。所以这里把风险原文摆出来让用户确认，
 * 而不是弹一句"确定吗"。
 *
 * 也**不受"30 分钟"限制**：那个阈值是"自动提示陈旧"的门槛（`LOCK_STALE_MS`），
 * 不是"允许人工清理"的门槛 —— 应用被强杀之后，那把 5 分钟前留下的锁同样是死的。
 */
async function askRemoveLock(): Promise<void> {
  try {
    await ElMessageBox.confirm(LOCK_REMOVE_HINT, '清理远端锁', {
      type: 'warning',
      confirmButtonText: '确认清理',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  removingLock.value = true
  try {
    const r = await api.reconcile.removeLock(props.target.id)
    ElMessage.success(r.removed ? '已删除远端锁' : '锁已经不存在了')
    await run()
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    removingLock.value = false
  }
}

const hasFindings = computed(() => {
  const c = report.value?.counts
  if (!c) return false
  return c.adopted > 0 || c.foundMissing > 0 || c.markedMissing > 0 || c.corrupt > 0 || c.withoutManifest > 0
})

/**
 * 每次发起的序号。对账要跑好几秒，期间用户可能切走目标 ——
 * 只有"最后一次发起"才允许写回报告与状态。旧报告挂到新目标上比"数据旧"严重得多：
 * 用户可能基于一份错目标的对账结果去做修复动作。
 */
let runToken = 0

async function run(): Promise<void> {
  const targetId = props.target.id
  const token = ++runToken
  running.value = true
  errorText.value = ''
  try {
    const r = await api.reconcile.run({
      targetId,
      deep: deep.value,
      adopt: adopt.value
    })
    // 目标已切换 / 又发起了新一次对账 → 丢弃这份结果
    if (token !== runToken || props.target.id !== targetId) return
    report.value = r
    const c = r.counts
    if (c.adopted > 0 || c.markedMissing > 0) {
      emit('changed')
      ElMessage.success('对账完成，台账已按远端修正')
    } else if (c.foundMissing > 0) {
      ElMessage.success(
        `对账完成：发现 ${c.foundMissing} 个版本远端已不存在（未标记，台账未改动）`
      )
    } else {
      ElMessage.success('对账完成，台账与远端一致')
    }
  } catch (e) {
    if (token !== runToken || props.target.id !== targetId) return
    report.value = null
    errorText.value = (e as IpcBusinessError).toUserText()
  } finally {
    if (token === runToken) running.value = false
  }
}

/** 每次打开都是新的一次对账：清掉上一次的报告 */
watch(
  () => props.modelValue,
  (v) => {
    if (!v) return
    report.value = null
    errorText.value = ''
    void run()
  },
  { immediate: true }
)

watch(
  () => props.target.id,
  () => {
    if (props.modelValue) void run()
  }
)

const STATUS_TEXT: Record<string, string> = {
  valid: '正常',
  missing: '已失效',
  corrupt: '内容损坏',
  adopted: '已补录',
  updated: '已修正',
  'no-manifest': '缺少清单'
}
function statusText(s: string): string {
  return STATUS_TEXT[s] ?? s
}
function statusType(s: string): 'success' | 'warning' | 'danger' | 'info' {
  if (s === 'valid') return 'success'
  if (s === 'corrupt') return 'danger'
  if (s === 'missing' || s === 'no-manifest') return 'warning'
  return 'info'
}
</script>

<template>
  <el-dialog
    v-model="open"
    title="与服务器对账"
    width="820px"
    :close-on-click-modal="false"
    data-test="reconcile-dialog"
  >
    <div class="rc-body" v-loading="running" element-loading-text="正在读取远端归档目录…">
      <el-descriptions :column="2" size="small" border>
        <el-descriptions-item label="目标">{{ target.name }}</el-descriptions-item>
        <el-descriptions-item label="远端路径">
          <span class="mono">{{ target.remotePath }}</span>
        </el-descriptions-item>
      </el-descriptions>

      <div class="rc-options">
        <label class="rc-option">
          <el-switch v-model="deep" :disabled="running" data-test="reconcile-deep" />
          <span class="rc-option-body">
            <span class="rc-option-title">深度校验（逐文件比对内容）</span>
            <span class="rc-option-desc">
              要读一遍服务器上的全部内容，大版本会跑几分钟。只有它能发现"文件被改过"
              —— 不开的话「损坏」那一栏永远是 0，不代表没有问题。
            </span>
          </span>
        </label>
        <label class="rc-option">
          <el-switch v-model="adopt" :disabled="running" data-test="reconcile-adopt" />
          <span class="rc-option-body">
            <span class="rc-option-title">按远端修正台账（补录 / 标记失效）</span>
            <span class="rc-option-desc">
              关掉就是只诊断不修改。补录的字段全部来自远端那份 manifest，
              包括归档时间 —— 本地台账记错了也会以远端为准。
            </span>
          </span>
        </label>
      </div>

      <el-alert
        v-if="errorText"
        type="error"
        :closable="false"
        show-icon
        :title="errorText"
        data-test="reconcile-error"
      />

      <template v-if="report">
        <!-- 结论：四个数字一眼可辨 -->
        <div class="rc-counts" data-test="reconcile-counts">
          <div class="rc-count rc-adopted">
            <b data-test="reconcile-adopted">{{ report.counts.adopted }}</b>
            <span>补录 / 修正</span>
          </div>
          <div class="rc-count rc-missing">
            <b data-test="reconcile-missing">{{ report.counts.markedMissing }}</b>
            <span>已失效</span>
          </div>
          <div class="rc-count rc-corrupt">
            <b data-test="reconcile-corrupt">{{ report.counts.corrupt }}</b>
            <span>内容损坏</span>
          </div>
          <div class="rc-count rc-ok">
            <b data-test="reconcile-ok">{{ report.counts.ok }}</b>
            <span>正常</span>
          </div>
        </div>

        <div class="rc-meta muted">
          远端归档目录：
          <span class="mono">{{ report.archiveDir }}</span>
          <template v-if="!report.archiveDirExists">（不存在 —— 这个目标还没归档过）</template>
          ｜耗时 {{ report.durationMs }}ms
          <template v-if="report.deep">｜已做深度校验</template>
        </div>

        <!-- 需要用户注意的东西 -->
        <el-alert
          v-if="report.counts.withoutManifest > 0"
          class="rc-warn"
          type="warning"
          :closable="false"
          show-icon
          :title="`发现 ${report.counts.withoutManifest} 个目录没有可用的 manifest —— 未补录，需要人工处理`"
          data-test="reconcile-no-manifest"
        >
          没有清单就无法知道它的内容与归档时间，补进台账只会得到一条既不能校验、
          也不能回滚的记录。下面的明细里能看到具体是哪几个，请到服务器上核对后决定去留。
        </el-alert>

        <el-alert
          v-if="report.stagingResidue.length > 0"
          class="rc-warn"
          type="warning"
          :closable="false"
          show-icon
          :title="`远端还有 ${report.stagingResidue.length} 个暂存残留目录`"
          data-test="reconcile-staging"
        >
          通常是上次操作中断留下的。可以在底部任务控制台用「清理残留」处理，
          或到服务器上手工删除。
        </el-alert>

        <!-- 逐条明细：把判定依据摊开 -->
        <div class="rc-items">
          <div class="rc-items-title">
            逐条结论（{{ report.items.length }}）
            <span v-if="!hasFindings" class="muted">—— 没有需要处理的东西</span>
          </div>
          <el-table :data="report.items" size="small" max-height="300" data-test="reconcile-items">
            <el-table-column prop="versionTag" label="版本号" width="190">
              <template #default="{ row }">
                <span class="mono">{{ row.versionTag }}</span>
              </template>
            </el-table-column>
            <el-table-column label="时间" width="150">
              <template #default="{ row }">
                <span class="muted">{{ row.archivedAt ? formatDateTime(row.archivedAt) : '未知' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="大小" width="90">
              <template #default="{ row }">
                <span class="muted">{{
                  row.totalBytes === null ? '未知' : formatBytes(row.totalBytes)
                }}</span>
              </template>
            </el-table-column>
            <el-table-column label="判定依据" width="200">
              <template #default="{ row }">
                <span class="muted rc-proof">
                  台账{{ row.inLedger ? '有' : '无' }} · 远端{{ row.onRemote ? '有' : '无' }} ·
                  清单{{ row.hasManifest ? '有' : '无' }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="结论" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="说明" min-width="200">
              <template #default="{ row }">
                <span class="muted">{{ row.note ?? '—' }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 锁（T14.6）：只展示，不在这里删 —— 删锁要用户明确确认 -->
        <div v-if="report.lock" class="rc-lock">
          <el-alert
            type="warning"
            :closable="false"
            show-icon
            :title="
              report.lock.stale
                ? '远端有一把陈旧的锁（可能是上次操作中断留下的）'
                : '远端有一把锁：可能有另一台机器正在操作这个目标'
            "
            data-test="reconcile-lock"
          >
            <div class="mono rc-lock-path">{{ report.lock.path }}</div>
            <div class="muted">
              创建者 {{ report.lock.hostname ?? '未知' }} ·
              {{ report.lock.ts ? formatDateTime(report.lock.ts) : '时间未知' }}
              <template v-if="report.lock.unreadable">· 内容无法解析</template>
            </div>
            <div class="muted">
              只有确认没有其他人在操作这个目标时才该删它。删除后请立刻重新发起操作，
              否则这期间另一个操作可能悄悄开始。
            </div>
            <el-button
              class="rc-lock-btn"
              size="small"
              type="warning"
              :loading="removingLock"
              data-test="reconcile-remove-lock"
              @click="askRemoveLock"
            >
              清理这把锁
            </el-button>
          </el-alert>
        </div>
      </template>

      <div v-else-if="!running && !errorText" class="muted rc-empty">
        <el-icon><DocumentChecked /></el-icon>
        还没有对账结果
      </div>
    </div>

    <template #footer>
      <el-button :disabled="running" @click="open = false">关闭</el-button>
      <el-button
        type="primary"
        :icon="running ? CircleCheck : Refresh"
        :loading="running"
        data-test="reconcile-run"
        @click="run"
      >
        {{ running ? '对账中…' : '重新对账' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.rc-body {
  min-height: 120px;
}
.rc-body :deep(.el-descriptions__cell) {
  vertical-align: middle;
}
.rc-options {
  margin: 12px 0;
}
.rc-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
  cursor: pointer;
}
.rc-option-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rc-option-title {
  font-size: 13px;
  color: #303133;
}
.rc-option-desc {
  font-size: 11px;
  color: #909399;
  line-height: 1.6;
}
.rc-counts {
  display: flex;
  gap: 10px;
  margin: 12px 0 8px;
}
.rc-count {
  flex: 1;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.rc-count b {
  font-size: 20px;
  line-height: 1.2;
}
.rc-count span {
  font-size: 11px;
  color: #909399;
}
.rc-adopted b {
  color: #409eff;
}
.rc-missing b {
  color: #e6a23c;
}
.rc-corrupt b {
  color: #f56c6c;
}
.rc-ok b {
  color: #67c23a;
}
.rc-meta {
  font-size: 12px;
  margin-bottom: 8px;
}
.rc-warn {
  margin-bottom: 8px;
}
.rc-items-title {
  font-size: 13px;
  color: #303133;
  margin: 10px 0 6px;
}
.rc-proof {
  font-size: 11px;
}
.rc-lock-btn {
  margin-top: 6px;
}
.rc-lock-path {
  font-size: 11px;
  word-break: break-all;
  margin: 4px 0;
}
.rc-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  padding: 24px 0;
  font-size: 13px;
}
</style>
