<script setup lang="ts">
/**
 * 目标页的「脚本」区块（B20 / T20.8）。
 *
 * ## 这个面板在 B20 里做什么
 *
 * 让用户在某个目标上**跑一条脚本**：填脚本 → 选在本机还是服务器上跑 → 执行。
 * 执行会建一条任务（底部任务控制台里能看到实时输出、能取消），并把这次执行的
 * 退出码 / 耗时 / 输出落进 `script_runs` 表 —— 所以**重启应用后还查得到**。
 * 多步骤的自动化流水线是 B21，这里刻意只做"一条"。
 *
 * ## 为什么整块 UI 由 `allowUserScripts` 决定要不要渲染
 *
 * 这是全应用权限最大的一个入口（跑任意命令）。总闸关着时**不显示表单**，
 * 只显示"怎么打开" —— 因为一个"填好了却没法执行"的表单，比一句"功能未开启"
 * 更让人困惑。开关在「设置 → 脚本执行」，默认关。
 *
 * ## 为什么执行位置默认落在「本机」
 *
 * 服务器上的操作是不可撤销的（关了服务就是关了），而本机脚本跑坏了至少不牵连线上。
 * 默认值不改变危险程度，但能少一次误点。
 */
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { CaretRight, Document, FolderOpened, Refresh, VideoPlay } from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { confirmDanger } from '../utils/danger'
import { formatDateTime, formatDuration } from '../utils/format'
import {
  DEFAULT_SCRIPT_RUN_LIST_LIMIT,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  LOCAL_SHELL_LABELS,
  STEP_TAIL_MAX_LINES,
  clampScriptTimeout,
  defaultStepName,
  describeScriptRunStatus,
  scriptRunStatusTagType,
  type LocalShell,
  type ScriptCapabilities,
  type ScriptKind,
  type ScriptRunView,
  type ScriptStepRunView
} from '../../../shared/contracts/script'
import type { TargetView } from '../../../shared/contracts/workspace'

const props = defineProps<{ target: TargetView }>()

const router = useRouter()

/* ------------------------------------------------------------------ 能力 */

const caps = ref<ScriptCapabilities | null>(null)
const capsError = ref('')

async function loadCaps(): Promise<void> {
  try {
    caps.value = await api.scripts.capabilities()
    capsError.value = ''
    // 默认解释器跟着能力探测走（用户上次选过就不再覆盖）
    if (!shell.value && caps.value.defaultShell) shell.value = caps.value.defaultShell
  } catch (e) {
    capsError.value = (e as IpcBusinessError).toUserText()
  }
}

/* ------------------------------------------------------------ 表单草稿 */

const kind = ref<ScriptKind>('local')
const shell = ref<LocalShell | null>(null)
const cwd = ref<string | null>(null)
const name = ref('')
/** 超时按**秒**填：让用户填 300000 毫秒是难为人的 */
const timeoutSec = ref(Math.round(DEFAULT_SCRIPT_TIMEOUT_MS / 1000))
const script = ref('')

/** 本机步骤可选的解释器（含"没找到"的，用来解释为什么不能选） */
const shellOptions = computed(
  () =>
    caps.value?.shells.map((s) => ({
      shell: s.shell,
      label: LOCAL_SHELL_LABELS[s.shell],
      available: s.available,
      exePath: s.exePath
    })) ?? []
)

const currentShellExe = computed(
  () => caps.value?.shells.find((s) => s.shell === shell.value)?.exePath ?? null
)

/** 本机步骤必须有可用的解释器；服务器步骤不需要（用的是 ssh 通道） */
const shellOk = computed(
  () => kind.value === 'remote' || (shell.value !== null && currentShellExe.value !== null)
)

const canRun = computed(() => script.value.trim().length > 0 && shellOk.value && !starting.value)

/* ------------------------------------------------------------------ 执行 */

const starting = ref(false)

/**
 * 执行前的一句话确认（**只在服务器上执行时**问）。
 *
 * 本机脚本不问：用户本来就在自己机器上，而且"构筑一下"这类脚本一天要跑几十次，
 * 每次都弹框会让人学会无脑点确认 —— 那才是真正危险的。
 * 服务器上执行不一样：它是不可撤销的，而且服务端脚本的典型内容就是"关服务"。
 */
async function confirmRemote(): Promise<boolean> {
  return confirmDanger({
    title: '在服务器上执行这段脚本？',
    consequence: `脚本会以已连接的服务器账号在你的目标上运行，执行完之前无法撤销。\n\n${
      script.value.length > 400 ? `${script.value.slice(0, 400)}…（已截断显示）` : script.value
    }`,
    remoteEffect: 'exec',
    remoteDetail: '具体做什么由脚本内容决定。',
    confirmText: '执行'
  })
}

async function run(): Promise<void> {
  if (!canRun.value) return
  if (kind.value === 'remote') {
    const ok = await confirmRemote()
    if (!ok) return
  }

  starting.value = true
  try {
    await api.scripts.runStep({
      targetId: props.target.id,
      kind: kind.value,
      name: name.value.trim() || defaultStepName(kind.value),
      script: script.value,
      ...(kind.value === 'local' && shell.value ? { shell: shell.value } : {}),
      ...(kind.value === 'local' ? { cwd: cwd.value } : {}),
      timeoutMs: clampScriptTimeout(timeoutSec.value * 1000)
    })
    ElMessage.success('已加入任务队列，可在底部任务控制台查看实时输出')
    // 立刻刷一次：新记录会以"执行中"出现在列表里，用户不至于以为没跑起来
    await loadRuns(true)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    starting.value = false
  }
}

async function pickCwd(): Promise<void> {
  try {
    const r = await api.app.pickDirectory({ defaultPath: cwd.value })
    if (r) cwd.value = r.path
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

/* ------------------------------------------------------------ 运行记录 */

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

/**
 * 有记录处于"执行中"时轮询。
 *
 * 用轮询而不是"等任务事件"：任务事件只知道 `jobId`，而这里要的是运行记录
 * （`runId` 那张表）。轮询还顺带覆盖了"别处发起的执行"（B21 的流水线），
 * 不必为每种发起方式各接一次事件。
 */
let pollTimer: ReturnType<typeof setInterval> | null = null

const anyRunning = computed(() => runs.value.some((r) => r.status === 'running'))

function stopPoll(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

watch(anyRunning, (running) => {
  stopPoll()
  if (running) pollTimer = setInterval(() => void loadRuns(true), 1500)
})

onScopeDispose(stopPoll)

/* -------------------------------------------------------------- 时钟 */

/**
 * 执行中的耗时得自己走。
 *
 * 每一行都起一个定时器太浪费，而且列表刷新时会被重建；这里用一个整体的
 * `now`，只在**确实有执行中的记录**时才走 —— 没有的话连定时器都不建。
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

function stepOf(run: ScriptRunView): ScriptStepRunView | null {
  return run.steps[0] ?? null
}

/**
 * 把表格 slot 的 `row` 收窄回 `ScriptRunView`。
 *
 * `el-table` 的槽位把行数据声明成 `DefaultRow = Record<PropertyKey, any>` ——
 * 只有索引签名、没有具名属性，所以 `row.title` 能读，但把 `row` 整体传给
 * 带类型的函数就会报"缺少必需属性"。在边界上收窄一次即可，
 * 别为此把函数的参数放成"最小形状"（那样白丢类型约束）。
 * 与 `TaskConsole.vue` 里的 `toJobView()` 是同一套写法。
 */
function toRunView(row: unknown): ScriptRunView {
  return row as ScriptRunView
}

function stepDuration(run: ScriptRunView): string {
  const s = stepOf(run)
  if (!s) return '—'
  if (s.finishedAt) return formatDuration(s.startedAt, s.finishedAt)
  // 执行中：拿当前时刻算，与任务台的计时口径一致
  return formatDuration(s.startedAt, new Date(now.value).toISOString())
}

/** "本机 · PowerShell" / "服务器" —— 列表与详情共用一套说法。 */
function kindTextOf(step: ScriptStepRunView | null): string {
  if (!step) return '—'
  if (step.kind === 'local') {
    return step.shell ? `本机 · ${LOCAL_SHELL_LABELS[step.shell]}` : '本机'
  }
  return '服务器'
}

function kindText(run: ScriptRunView): string {
  return kindTextOf(stepOf(run))
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
  try {
    await navigator.clipboard.writeText(step.outputTail ?? '')
    ElMessage.success('已复制输出尾部')
  } catch {
    ElMessage.warning('复制失败，请手动选中复制')
  }
}

function goSettings(): void {
  void router.push('/settings')
}

/* -------------------------------------------------------------- 生命周期 */

async function refresh(): Promise<void> {
  await Promise.all([loadCaps(), loadRuns()])
}

onMounted(refresh)

// 换目标时整块重来 —— 运行记录是**按目标**的，不刷新就会看到上一个目标的记录
watch(
  () => props.target.id,
  () => {
    runs.value = []
    detailRun.value = null
    detailOpen.value = false
    void refresh()
  }
)
</script>

<template>
  <section class="script-panel" data-test="script-panel">
    <!-- ------------------------------------------------ 总闸关着：只说明怎么开 -->
    <template v-if="caps && !caps.allowUserScripts">
      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="自定义脚本功能未开启"
        data-test="script-gate-off"
      >
        <p class="gate-text">
          这个功能默认关闭 —— 开启后可以在本机或服务器上执行你填写的任意命令。
        </p>
        <p class="gate-text">
          需要的到「设置 → 脚本执行」里打开<strong>允许执行自定义脚本</strong>。
        </p>
        <el-button size="small" :icon="CaretRight" @click="goSettings">去设置里打开</el-button>
      </el-alert>
    </template>

    <!-- ------------------------------------------------ 正常态 -->
    <template v-else-if="caps">
      <!--
        权限提示**常驻**（不做成一次性气泡）：脚本失败最常见的原因就是服务器账户
        权限不够，而那时用户往往已经忘了"这软件是拿哪个账号连的"。
      -->
      <el-alert
        class="perm"
        type="warning"
        show-icon
        :closable="false"
        title="脚本以你当前的权限执行"
        data-test="script-permission-hint"
      >
        <p class="gate-text">
          服务端脚本用的是<strong>你登录服务器时用的那个账户</strong>。请确认它的权限足够
          （例如重启服务要 <span class="mono">sudo</span> / <span class="mono">systemctl</span>
          权限、写目标目录要对应属主），否则脚本会在中途失败。
        </p>
      </el-alert>

      <el-form label-width="96px" class="script-form" @submit.prevent>
        <el-form-item label="执行位置">
          <el-radio-group v-model="kind" data-test="script-kind">
            <el-radio-button value="local" data-test="script-run-kind-local">本机执行</el-radio-button>
            <el-radio-button value="remote" data-test="script-run-kind-remote"
              >服务器执行</el-radio-button
            >
          </el-radio-group>
          <span class="hint inline">
            {{
              kind === 'local'
                ? '在你自己的电脑上跑（例如构筑 JAR 包）。'
                : '通过已连接的服务器账号跑（例如关服务、启服务）。'
            }}
          </span>
        </el-form-item>

        <template v-if="kind === 'local'">
          <el-form-item label="解释器">
            <el-select
              v-model="shell"
              class="shell-select"
              placeholder="选择解释器"
              data-test="script-shell"
            >
              <el-option
                v-for="s in shellOptions"
                :key="s.shell"
                :label="s.available ? s.label : `${s.label}（本机未找到）`"
                :value="s.shell"
                :disabled="!s.available"
              />
            </el-select>
            <!-- 显示"实际会用哪个 exe"：找不到时这段就是唯一的线索 -->
            <span v-if="currentShellExe" class="hint inline mono ellipsis">
              {{ currentShellExe }}
            </span>
            <span v-else class="hint inline warn">
              没找到这个解释器。装好它，或在「设置 → 脚本执行」里手工指定路径。
            </span>
          </el-form-item>

          <el-form-item label="工作目录">
            <div class="field-row">
              <el-input
                v-model="cwd"
                class="grow"
                placeholder="留空则用应用可执行文件所在目录"
                clearable
                data-test="script-cwd"
              />
              <el-button :icon="FolderOpened" @click="pickCwd">选择…</el-button>
            </div>
          </el-form-item>
        </template>

        <el-form-item label="步骤名">
          <el-input
            v-model="name"
            class="grow"
            :placeholder="defaultStepName(kind)"
            maxlength="120"
            data-test="script-name"
          />
        </el-form-item>

        <el-form-item label="脚本">
          <el-input
            v-model="script"
            type="textarea"
            :rows="7"
            class="mono-area"
            :placeholder="
              kind === 'local'
                ? '例如：mvn -q -DskipTests package'
                : '例如：systemctl stop my-backend'
            "
            data-test="script-text"
          />
        </el-form-item>

        <el-form-item label="超时">
          <el-input-number
            v-model="timeoutSec"
            :min="1"
            :max="3600"
            :step="30"
            data-test="script-timeout"
          />
          <span class="hint inline">秒。超时后会先尝试正常结束，再强行杀进程树。</span>
        </el-form-item>
      </el-form>

      <div class="run-bar">
        <el-button
          type="primary"
          :icon="VideoPlay"
          :disabled="!canRun"
          :loading="starting"
          data-test="script-run"
          @click="run"
        >
          {{ kind === 'local' ? '在本机执行' : '在服务器上执行' }}
        </el-button>
        <span class="hint inline">
          会建一条任务 —— 底部任务控制台里能看到实时输出、也能取消。
        </span>
      </div>
    </template>

    <!-- 能力探测本身失败（例如主进程报错）：别静默什么都不显示 -->
    <el-alert
      v-else-if="capsError"
      type="error"
      show-icon
      :closable="false"
      :title="`读取脚本能力失败：${capsError}`"
      data-test="script-caps-error"
    />

    <!-- ------------------------------------------------ 运行记录 -->
    <div class="runs">
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
        description="还没有执行过脚本"
        :image-size="56"
        data-test="script-runs-empty"
      />

      <el-table
        v-else
        :data="runs"
        size="small"
        row-key="runId"
        data-test="script-runs-table"
      >
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
            <span class="mono">{{ stepDuration(toRunView(row)) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="退出码" width="82">
          <template #default="{ row }">
            <!--
              `null` 是"没拿到"（超时被杀、连接断开），与"退出码 0"是两件事 ——
              显示成 0 会让人以为成功了。
            -->
            <span v-if="stepOf(toRunView(row))?.exitCode === null" class="muted">—</span>
            <span v-else class="mono">{{ stepOf(toRunView(row))?.exitCode }}</span>
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
    </div>

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
            <el-button
              v-if="s.outputTail"
              link
              data-test="script-copy-output"
              @click="copyTail(s)"
            >
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
.script-panel {
  margin-top: 8px;
}
.gate-text {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.6;
}
.perm {
  margin-bottom: 12px;
}
.script-form {
  margin-top: 4px;
}
.shell-select {
  width: 200px;
}
.hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
.hint.inline {
  margin-left: 10px;
}
.hint.warn {
  color: #e6a23c;
}
.mono {
  font-family: Consolas, Monaco, 'Courier New', monospace;
}
.ellipsis {
  max-width: 380px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.grow {
  flex: 1 1 auto;
}
.mono-area :deep(textarea) {
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 12.5px;
  line-height: 1.6;
}
.run-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 4px 0 18px;
}
.runs {
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
.spacer {
  flex: 1 1 auto;
}
.cell-name {
  line-height: 1.4;
}
.cell-sub {
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}
.muted {
  color: #c0c4cc;
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
