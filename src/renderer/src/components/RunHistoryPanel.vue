<script setup lang="ts">
/**
 * 目标页的「运行记录」（B20 的 `script_runs` / `script_step_runs`）。
 *
 * ## 它为什么存在
 *
 * 任务与其返回值**都不落库**：`jobs` 是内存态，重启就没了。所以"上次那一步成没成、
 * 退出码多少、输出尾部是什么"只能来自这两张表 —— 这张列表的**唯一理由**就是
 * "重启应用后还查得到"（B20 / T20.8）。
 *
 * ## 为什么它挂在流水线下面
 *
 * B20 时它长在目标页独立的「脚本」区块里（一个"跑一条脚本"的表单 + 这张列表）。
 * B21 的流水线把"跑一条脚本"收成了"一步"，那个表单就成了重复入口，已删掉；
 * 列表搬到流水线下面 —— 它现在回答的是"这条流水线上次跑成什么样"。
 *
 * 搬过来之后有一处**行为上的放宽**：它不再受 `allowUserScripts` 总闸的影响。
 * 总闸关着时流水线区块整块不渲染，但**这张表照旧显示** —— 关掉总闸不等于要
 * 抹掉之前跑过的记录。
 *
 * ## 为什么用轮询（辅以任务状态）
 *
 * 任务事件只知道 `jobId`，而这里要的是运行记录（`runId` 那张表）。轮询还顺带
 * 覆盖了"别处发起的执行"（流水线一键跑整条、只跑某一步），不必为每种发起方式
 * 各接一次事件。但**光有轮询不够**：轮询条件是"列表里有 running 行"，而新发起的
 * 执行那一行还没进来 —— 所以轮询条件要或上"任务 store 里本目标的活动任务数"
 * （见下方 `activeJobCount`），并在其变化时各拉一次。
 */
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Document, FolderOpened, Refresh } from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { isTerminalStatus } from '../../../shared/contracts/job'
import { useJobStore } from '../stores/job'
import { formatDateTime, formatDuration } from '../utils/format'
import { writeClipboard } from '../utils/clipboard'
import {
  DEFAULT_SCRIPT_RUN_LIST_LIMIT,
  LOCAL_SHELL_LABELS,
  STEP_TAIL_MAX_LINES,
  describeScriptRunStatus,
  scriptRunStatusTagType,
  type ScriptRunView,
  type ScriptStepRunView
} from '../../../shared/contracts/script'
import type { TargetView } from '../../../shared/contracts/workspace'

const props = defineProps<{ target: TargetView }>()

/* ------------------------------------------------------------- 运行记录 */

const runs = ref<ScriptRunView[]>([])
const loadingRuns = ref(false)
const runsError = ref('')

/**
 * 拉运行记录。
 *
 * `silent = true` 用于轮询：不点亮"刷新"按钮，否则列表每 1.5 秒闪一下，
 * 用户会以为界面出了问题。
 */
async function loadRuns(silent = false): Promise<void> {
  if (!silent) loadingRuns.value = true
  try {
    runs.value = await api.scripts.runs({
      targetId: props.target.id,
      limit: DEFAULT_SCRIPT_RUN_LIST_LIMIT
    })
    runsError.value = ''
  } catch (e) {
    if (!silent) runsError.value = (e as IpcBusinessError).toUserText()
  } finally {
    if (!silent) loadingRuns.value = false
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null

const anyRunning = computed(() => runs.value.some((r) => r.status === 'running'))

function stopPoll(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

const jobStore = useJobStore()

/**
 * 本目标正在跑（含排队）的任务数。
 *
 * 运行记录行是**任务执行时才写库**的 —— 从"点了执行"到"running 行被拉进列表"
 * 之间有个窗口，这段时间 `anyRunning` 恒为 false，光靠它轮询永远转不起来，
 * 新记录就"不自动出现"（只在任务 store 里能看到活动任务）。所以轮询条件要
 * **或上本目标的活动任务数**；活动任务数变化时再各拉一次（开始时尽快显示新行、
 * 结束时尽快拿到终态与退出码）。
 */
const activeJobCount = computed(
  () =>
    jobStore.jobs.filter((j) => j.targetId === props.target.id && !isTerminalStatus(j.status))
      .length
)

const needPoll = computed(() => anyRunning.value || activeJobCount.value > 0)

watch(
  needPoll,
  (polling) => {
    stopPoll()
    if (polling) pollTimer = setInterval(() => void loadRuns(true), 1500)
  },
  // 挂载/换目标时列表可能一进来就有 running 行（或活动任务），立即建轮询
  { immediate: true }
)

watch(activeJobCount, (count, prev) => {
  if (count > prev) void loadRuns(true)
  else if (count === 0 && prev > 0) void loadRuns(true)
})

onScopeDispose(stopPoll)

/* ------------------------------------------------------------------ 时钟 */

/**
 * 执行中的耗时得自己走。
 *
 * 每一行都起一个定时器太浪费，而且列表刷新时会被重建；这里用一个整体的 `now`，
 * 只在**确实有执行中的记录**时才走 —— 没有的话连定时器都不建。
 */
const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | null = null

watch(
  anyRunning,
  (running) => {
    if (clockTimer !== null) {
      clearInterval(clockTimer)
      clockTimer = null
    }
    if (running) {
      clockTimer = setInterval(() => {
        now.value = Date.now()
      }, 1000)
    }
  },
  { immediate: true }
)

onScopeDispose(() => {
  if (clockTimer !== null) clearInterval(clockTimer)
})

/*
 * 注意：这里**没有** `stepOf()` 这类"取第一步"的助手了。
 * B20 时列表的耗时与退出码都取 `steps[0]`（那时恒为一步），B21 起一条记录可能有
 * 多步 —— 那些取法会把"一条跑了 5 分钟的流水线"显示成"第一步的 3 秒"。
 * 现在分别用 `runDuration()` / `runExitCode()`，语义写在各自的注释里。
 */

/**
 * 把表格 slot 的 `row` 收窄回 `ScriptRunView`。
 *
 * `el-table` 的槽位把行数据声明成 `DefaultRow = Record<PropertyKey, any>` ——
 * 只有索引签名、没有具名属性，所以 `row.title` 能读，但把 `row` 整体传给带类型的
 * 函数就会报"缺少必需属性"。在边界上收窄一次即可，别为此把函数的参数放成
 * "最小形状"（那样白丢类型约束）。与 `TaskConsole.vue` 里的 `toJobView()` 同一套写法。
 */
function toRunView(row: unknown): ScriptRunView {
  return row as ScriptRunView
}

/**
 * 列表里的"耗时"取**整条运行**的起止，而不是某一步的。
 *
 * B21 起一条记录可能有多个步骤，取第一步的会让"一条跑了 5 分钟的流水线"显示成
 * "第一步的 3 秒"。用运行自己的起止时间对单步（B20）也几乎无差。
 */
function runDuration(run: ScriptRunView): string {
  if (run.finishedAt) return formatDuration(run.startedAt, run.finishedAt)
  // 执行中：拿当前时刻算，与任务台的计时口径一致
  return formatDuration(run.startedAt, new Date(now.value).toISOString())
}

/**
 * 列表里的"退出码"。
 *
 * 单步运行：就是那一步的。多步（流水线）：优先显示**失败那一步**的退出码 ——
 * 那才是用户想知道的；全部成功时显示最后一步的（流水线里最后一步成不成，
 * 通常就等于"整件事成不成"）。
 */
function runExitCode(run: ScriptRunView): number | null {
  if (run.steps.length === 1) return run.steps[0]!.exitCode
  const failed = run.steps.find((s) => s.status === 'failed')
  if (failed) return failed.exitCode
  return run.steps.length > 0 ? run.steps[run.steps.length - 1]!.exitCode : null
}

/** "本机 · PowerShell" / "服务器" / "发布" —— 列表与详情共用一套说法。 */
function kindTextOf(step: ScriptStepRunView | null): string {
  if (!step) return '—'
  // B21 起步骤也可能是"发布"：它既不是本机也不是服务器命令，
  // 归到任何一边都会让人以为"这一步跑了条 shell"
  if (step.kind === 'deploy') return '发布'
  if (step.kind === 'local') {
    return step.shell ? `本机 · ${LOCAL_SHELL_LABELS[step.shell]}` : '本机'
  }
  return '服务器'
}

function kindText(run: ScriptRunView): string {
  // 多步（流水线）：说"几步"比说"第一步在哪跑"有用得多
  if (run.steps.length > 1) return `${run.steps.length} 个步骤`
  return kindTextOf(run.steps[0] ?? null)
}

/* ---------------------------------------------------------------- 详情 */

const detailOpen = ref(false)
const detailRun = ref<ScriptRunView | null>(null)
const detailLoading = ref(false)

async function openDetail(run: ScriptRunView): Promise<void> {
  detailOpen.value = true
  detailLoading.value = true
  // 先用手上这份渲染（列表里已经有名字与状态），再补完整输出
  detailRun.value = run
  try {
    detailRun.value = await api.scripts.runDetail({ runId: run.runId })
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    detailLoading.value = false
  }
}

async function cancel(run: ScriptRunView): Promise<void> {
  try {
    await api.jobs.cancel(run.jobId)
    ElMessage.info('已请求取消，正在中止子进程')
    await loadRuns(true)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

async function revealOutput(step: ScriptStepRunView): Promise<void> {
  if (!step.outputPath) return
  try {
    const r = await api.app.revealPath(step.outputPath)
    if (!r.ok) ElMessage.warning(r.reason || '打开失败')
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

async function copyTail(step: ScriptStepRunView): Promise<void> {
  // 走统一的 writeClipboard（内部对 navigator.clipboard 与 execCommand 双路兜底），
  // 别直接摸 navigator.clipboard —— 那样在不支持的环境下"点了没反应"且无法自证
  const ok = await writeClipboard(step.outputTail ?? '')
  if (ok) ElMessage.success('已复制输出尾部')
  else ElMessage.warning('复制失败，请手动选中复制')
}

/* -------------------------------------------------------------- 生命周期 */

onMounted(() => void loadRuns())

// 换目标时整块重来 —— 运行记录是**按目标**的，不刷新就会看到上一个目标的记录
watch(
  () => props.target.id,
  () => {
    runs.value = []
    detailRun.value = null
    detailOpen.value = false
    void loadRuns()
  }
)
</script>

<template>
  <section class="run-history" data-test="run-history">
    <div class="runs-head">
      <span class="runs-title">运行记录</span>
      <span class="hint inline">重启应用后仍然保留（退出码、耗时与输出尾部）</span>
      <span class="spacer" />
      <el-button
        link
        :icon="Refresh"
        :loading="loadingRuns"
        data-test="script-runs-refresh"
        @click="loadRuns()"
      >
        刷新
      </el-button>
    </div>

    <el-alert v-if="runsError" type="error" show-icon :closable="false" :title="runsError" />

    <el-empty
      v-else-if="!runs.length"
      description="还没有执行过"
      :image-size="56"
      data-test="script-runs-empty"
    />

    <el-table v-else :data="runs" size="small" row-key="runId" data-test="script-runs-table">
      <el-table-column label="开始时间" width="164">
        <template #default="{ row }">
          <span class="mono">{{ formatDateTime(row.startedAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="步骤" min-width="180">
        <template #default="{ row }">
          <div class="cell-name">{{ row.title }}</div>
          <div class="cell-sub">
            <el-tag v-if="row.trigger === 'pipeline'" size="small" type="info">流水线</el-tag>
            {{ kindText(toRunView(row)) }}
          </div>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="96">
        <template #default="{ row }">
          <el-tag size="small" :type="scriptRunStatusTagType(row.status)">
            {{ describeScriptRunStatus(row.status) }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="耗时" width="92">
        <template #default="{ row }">
          <span class="mono">{{ runDuration(toRunView(row)) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="退出码" width="82">
        <template #default="{ row }">
          <!--
            `null` 是"没拿到"（超时被杀、连接断开），与"退出码 0"是两件事 ——
            显示成 0 会让人以为成功了。
          -->
          <span v-if="runExitCode(toRunView(row)) === null" class="muted">—</span>
          <span v-else class="mono">{{ runExitCode(toRunView(row)) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="132">
        <template #default="{ row }">
          <!--
            行内按钮**只切 visibility**，不切 display（B12 的教训：display:none → inline-flex
            会改行高，表格抖一下；而且纯 visibility 下按钮仍可 Tab 聚焦，所以选择器里
            带上 :focus-within）。
          -->
          <span class="row-actions">
            <el-button
              link
              type="primary"
              :icon="Document"
              data-test="script-run-detail"
              @click="openDetail(toRunView(row))"
            >
              详情
            </el-button>
            <el-button
              v-if="row.status === 'running'"
              link
              type="danger"
              data-test="script-run-cancel"
              @click="cancel(toRunView(row))"
            >
              取消
            </el-button>
          </span>
        </template>
      </el-table-column>
    </el-table>

    <!-- ------------------------------------------------ 详情 -->
    <el-dialog
      v-model="detailOpen"
      title="执行详情"
      width="720px"
      :close-on-click-modal="true"
      data-test="script-detail-dialog"
    >
      <div v-if="detailRun" class="detail" v-loading="detailLoading">
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="开始时间">
            {{ formatDateTime(detailRun.startedAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="结束时间">
            {{ detailRun.finishedAt ? formatDateTime(detailRun.finishedAt) : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="总状态">
            <el-tag size="small" :type="scriptRunStatusTagType(detailRun.status)">
              {{ describeScriptRunStatus(detailRun.status) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="发起人">
            {{ detailRun.operator || '—' }}
          </el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="detailRun.errorMessage"
          class="err"
          type="error"
          show-icon
          :closable="false"
          :title="detailRun.errorMessage"
        />

        <div v-for="s in detailRun.steps" :key="s.stepRunId" class="step">
          <div class="step-head">
            <strong>{{ s.seq }}. {{ s.name }}</strong>
            <el-tag size="small" :type="scriptRunStatusTagType(s.status)">
              {{ describeScriptRunStatus(s.status) }}
            </el-tag>
            <span class="hint inline">
              {{ kindTextOf(s) }} · 耗时
              {{ s.finishedAt ? formatDuration(s.startedAt, s.finishedAt) : '进行中' }} · 退出码
              {{ s.exitCode === null ? '未取得' : s.exitCode }}
            </span>
          </div>

          <el-alert
            v-if="s.errorMessage"
            class="err"
            type="error"
            show-icon
            :closable="false"
            :title="s.errorMessage"
          />

          <div class="out-head">
            <span class="hint inline">
              输出<template v-if="s.outputPath">
                （完整输出已落盘，共 {{ s.outputBytes }} 字节<template v-if="s.truncated"
                  >，超过上限已截断</template
                >）
              </template>
              <template v-else>（本次没有落盘输出）</template>
            </span>
            <span class="spacer" />
            <el-button
              v-if="s.outputPath"
              link
              :icon="FolderOpened"
              data-test="script-open-output"
              @click="revealOutput(s)"
            >
              打开输出文件
            </el-button>
            <el-button v-if="s.outputTail" link data-test="script-copy-output" @click="copyTail(s)">
              复制尾部
            </el-button>
          </div>

          <pre v-if="s.outputTail" class="output" data-test="script-output-tail">{{
            s.outputTail
          }}</pre>
          <p v-else class="muted no-out">（这一步没有输出）</p>

          <p v-if="s.outputPath && s.outputTail" class="hint tail-note">
            上面是最后 {{ STEP_TAIL_MAX_LINES }} 行以内的摘要；完整输出在
            <span class="mono">{{ s.outputPath }}</span>
          </p>
        </div>
      </div>

      <template #footer>
        <el-button @click="detailOpen = false">关闭</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
/*
  顶边一道分隔线：这块紧跟在流水线列表下面，没有自己的 divider 了 ——
  靠它把"定义"与"执行结果"分开。
*/
.run-history {
  margin-top: 12px;
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 10px;
}
.runs-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.runs-title {
  font-size: 13px;
  font-weight: 600;
}
.hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
.hint.inline {
  margin-left: 10px;
}
.spacer {
  flex: 1 1 auto;
}
.mono {
  font-family: Consolas, Monaco, 'Courier New', monospace;
}
.muted {
  color: #c0c4cc;
}
.cell-name {
  line-height: 1.4;
}
.cell-sub {
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}
/*
  行内操作按钮**始终占位**，只切 visibility —— 用 display 切换会让行高跳动，
  而且按钮在 visibility:hidden 时**仍然可以 Tab 聚焦**，所以要把 :focus-within
  一并写进显隐规则（否则会出现"看不见但能按回车"的按钮）。
*/
.row-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  visibility: hidden;
  white-space: nowrap;
}
tr:hover .row-actions,
.row-actions:focus-within {
  visibility: visible;
}
.row-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.detail .err {
  margin: 10px 0 0;
}
.step {
  margin-top: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 10px 12px;
}
.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.out-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0;
}
.output {
  margin: 0;
  padding: 8px 10px;
  max-height: 300px;
  overflow: auto;
  background: #f5f7fa;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
}
.no-out {
  margin: 2px 0;
  font-size: 12px;
}
.tail-note {
  margin: 6px 0 0;
}
</style>
