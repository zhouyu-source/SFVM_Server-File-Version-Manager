<script setup lang="ts">
/**
 * 目标页的「自动化流水线」区块（B21 / T21.6）。
 *
 * ## 它解决什么
 *
 * 用户的原型：`①构筑 JAR（本机）→ ②关服务（服务器）→ ③发布 jar → ④启服务（服务器）`。
 * 这里让用户把这条流程**存下来**，之后一键跑完整条，或者只跑其中某一步
 * （比如只想"重启一下服务"，不必重新构筑与发布）。
 *
 * ## 三个刻意的取舍
 *
 * 1. **步骤列表用普通 `div` 而不是 `el-table-v2`**。步骤行里有输入框、
 *    单选、上下移按钮，而 `el-table-v2` 的行高是写死的（虚拟滚动的前提），
 *    在里面放可编辑控件要么被裁掉、要么把行高撑破。这不是能力问题，
 *    是"表格"这个形状不适合"可编辑的有序清单"。
 * 2. **不做拖动排序**，只有上移/下移。拖动在长列表里更顺手，但要引入拖拽库
 *    与一堆边界情况（拖出容器、拖到自身），而上移/下移对 10 步以内的清单完全够用。
 * 3. **跑整条一律先确认**，确认框里列全步骤。流水线是"一次点击触发一串不可撤销
 *    的操作"，这一步的确认成本远低于误触的代价。生产环境还要逐字输入目标名。
 *
 * ## 它是脚本功能在目标页的唯一入口
 *
 * B20 曾有一个独立的「脚本」区块（跑单条脚本的表单 + 常驻权限提示），
 * 那个入口已被流水线的"一步"取代，已删除。于是两件事搬到了这里：
 *
 * - **常驻的服务器权限提示** → 编辑器里「服务器执行」步骤的「步骤名」下面
 *   （它本来就只对服务器步骤有意义，放在那一步里比放在页面上更贴题）；
 * - **总闸关着时的"去哪儿打开"** → 这块自己说明（见下方模板），
 *   因为已经没有别的地方会讲这件事了。
 *
 * 运行记录（`script_runs`）跟在它后面，见 `RunHistoryPanel.vue`。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  ArrowDown,
  ArrowUp,
  CaretRight,
  Delete,
  EditPen,
  Plus,
  Refresh,
  VideoPlay
} from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { isTerminalStatus, type JobView } from '../../../shared/contracts/job'
import { useJobStore } from '../stores/job'
import { confirmDanger, confirmDangerWithName } from '../utils/danger'
import { formatDateTime } from '../utils/format'
import {
  DEFAULT_SCRIPT_TIMEOUT_MS,
  LOCAL_SHELL_LABELS,
  SCRIPT_KIND_LABELS,
  clampScriptTimeout,
  type LocalShell,
  type ScriptCapabilities
} from '../../../shared/contracts/script'
import {
  PIPELINE_MAX_STEPS,
  PIPELINE_ON_FAILURE_LABELS,
  PIPELINE_STEP_KIND_LABELS,
  describeStepKind,
  pipelineStepSummary,
  type PipelineOnFailure,
  type PipelinePreview,
  type PipelineStepKind,
  type PipelineStepView,
  type PipelineView
} from '../../../shared/contracts/pipeline'
import type { TargetView } from '../../../shared/contracts/workspace'

const props = defineProps<{ target: TargetView }>()

/**
 * 发布步骤成功后要通知父级刷新（见下方 watch 的注释）。
 * `versionTag` 传 null：任务视图里没有发布结果，当前版本号由父级刷新时自己读。
 */
const emit = defineEmits<{
  deployed: [{ jobId: string; versionTag: string | null }]
}>()

const router = useRouter()

/** 总闸关着时唯一的出路：开关在「设置 → 脚本执行」 */
function goSettings(): void {
  void router.push('/settings')
}

/* ------------------------------------------------------------------ 能力 */

const caps = ref<ScriptCapabilities | null>(null)
const capsError = ref('')

/**
 * 读能力（总闸开关 + 本机可用的解释器）。
 *
 * 读不出来时**要说出来**：这块现在是脚本与流水线在目标页的**唯一入口**，
 * 静默什么都不渲染会让人以为功能被删了。
 */
async function loadCaps(): Promise<void> {
  try {
    caps.value = await api.scripts.capabilities()
    capsError.value = ''
  } catch (e) {
    caps.value = null
    capsError.value = (e as IpcBusinessError).toUserText()
  }
}

/* ------------------------------------------------------------------ 列表 */

const list = ref<PipelineView[]>([])
const loading = ref(false)
const loadError = ref('')

async function load(silent = false): Promise<void> {
  // 竞态守卫（P1-8）：发起时记下目标，返回时目标已切换就丢弃这份旧响应——
  // 否则快速切换目标时，先发的慢响应后到，界面上显示 A 目标的流水线、
  // 操作上下文却是 B 目标，可能对错误的对象执行运行/删除。
  const requested = props.target.id
  if (!silent) loading.value = true
  try {
    const result = await api.pipelines.list({ targetId: requested })
    if (props.target.id !== requested) return
    list.value = result
    loadError.value = ''
  } catch (e) {
    if (props.target.id !== requested) return
    if (!silent) loadError.value = (e as IpcBusinessError).toUserText()
  } finally {
    if (!silent && props.target.id === requested) loading.value = false
  }
}

/* ------------------------------------------------------------ 编辑草稿 */

/**
 * 编辑期的步骤。
 *
 * `key` 是**渲染用的稳定标识**：步骤要能上下移，而 `v-for` 拿索引当 key 时
 * 移动会让输入框"串味"（Vue 复用了 DOM，光标与内容跟着走错行）。
 * 步骤的数据库 id 不能用来当 key —— 新建的步骤还没有 id。
 */
interface StepDraft {
  key: string
  kind: PipelineStepKind
  name: string
  script: string
  shell: LocalShell | null
  cwd: string | null
  timeoutSec: number
  onFailure: PipelineOnFailure
}

const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const draftName = ref('')
const draftDesc = ref('')
const draftSteps = ref<StepDraft[]>([])
const saving = ref(false)
const editorError = ref('')

let keySeed = 0
function nextKey(): string {
  keySeed += 1
  return `s${keySeed}`
}

const shellOptions = computed(
  () =>
    caps.value?.shells.map((s) => ({
      shell: s.shell,
      label: LOCAL_SHELL_LABELS[s.shell],
      available: s.available
    })) ?? []
)

function newStep(kind: PipelineStepKind = 'local'): StepDraft {
  return {
    key: nextKey(),
    kind,
    name: kind === 'deploy' ? '发布' : SCRIPT_KIND_LABELS[kind],
    script: '',
    shell: caps.value?.defaultShell ?? null,
    cwd: null,
    timeoutSec: Math.round(DEFAULT_SCRIPT_TIMEOUT_MS / 1000),
    onFailure: 'stop'
  }
}

function openNew(): void {
  editingId.value = null
  draftName.value = ''
  draftDesc.value = ''
  // 默认给一个"本机构筑"的空步骤：用户的原型第一步几乎总是它，
  // 而空白清单会让人不知道从哪儿下手
  draftSteps.value = [newStep('local')]
  editorError.value = ''
  editorOpen.value = true
}

function openEdit(p: PipelineView): void {
  editingId.value = p.pipelineId
  draftName.value = p.name
  draftDesc.value = p.description ?? ''
  draftSteps.value = p.steps.map((s) => ({
    key: nextKey(),
    kind: s.kind,
    name: s.name,
    script: s.script,
    shell: s.shell ?? caps.value?.defaultShell ?? null,
    cwd: s.cwd,
    timeoutSec: Math.round(s.timeoutMs / 1000),
    onFailure: s.onFailure
  }))
  editorError.value = ''
  editorOpen.value = true
}

const deployCount = computed(() => draftSteps.value.filter((s) => s.kind === 'deploy').length)

const canSave = computed(() => {
  if (!draftName.value.trim()) return false
  if (draftSteps.value.length === 0) return false
  if (deployCount.value > 1) return false
  return draftSteps.value.every((s) =>
    s.kind === 'deploy' ? true : s.script.trim().length > 0
  )
})

function addStep(): void {
  if (draftSteps.value.length >= PIPELINE_MAX_STEPS) {
    ElMessage.warning(`一条流水线最多 ${PIPELINE_MAX_STEPS} 步`)
    return
  }
  draftSteps.value.push(newStep('remote'))
}

function removeStep(i: number): void {
  draftSteps.value.splice(i, 1)
}

function moveStep(i: number, delta: number): void {
  const j = i + delta
  if (j < 0 || j >= draftSteps.value.length) return
  const arr = draftSteps.value
  const tmp = arr[i]!
  arr[i] = arr[j]!
  arr[j] = tmp
}

/** 换类型时把"不合法的东西"清掉：发布步骤不该留着一段脚本再存进库里。 */
function onKindChange(st: StepDraft): void {
  if (st.kind === 'deploy') {
    st.script = ''
    if (!st.name.trim() || st.name === '本机执行' || st.name === '服务器执行') st.name = '发布'
    return
  }
  if (!st.name.trim() || st.name === '发布') st.name = SCRIPT_KIND_LABELS[st.kind]
}

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  editorError.value = ''
  try {
    await api.pipelines.save({
      targetId: props.target.id,
      ...(editingId.value ? { pipelineId: editingId.value } : {}),
      name: draftName.value.trim(),
      description: draftDesc.value.trim() || null,
      steps: draftSteps.value.map((s) => ({
        name: s.name.trim() || (s.kind === 'deploy' ? '发布' : SCRIPT_KIND_LABELS[s.kind]),
        kind: s.kind,
        script: s.kind === 'deploy' ? '' : s.script,
        shell: s.kind === 'local' ? s.shell : null,
        cwd: s.kind === 'local' ? s.cwd : null,
        timeoutMs: clampScriptTimeout(s.timeoutSec * 1000),
        onFailure: s.onFailure
      }))
    })
    editorOpen.value = false
    ElMessage.success('已保存')
    await load(true)
  } catch (e) {
    // 保存失败留在对话框里：关掉的话用户刚填的步骤就白填了
    editorError.value = (e as IpcBusinessError).toUserText()
  } finally {
    saving.value = false
  }
}

async function removePipeline(p: PipelineView): Promise<void> {
  const ok = await confirmDanger({
    title: `删除流水线「${p.name}」？`,
    consequence: `只会删掉这条流水线的定义（${p.steps.length} 个步骤）。已经跑过的运行记录会保留，方便回看当时执行了什么。`,
    remoteEffect: 'none',
    confirmText: '删除'
  })
  if (!ok) return
  try {
    await api.pipelines.remove({ pipelineId: p.pipelineId })
    ElMessage.success('已删除')
    await load(true)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

/* ------------------------------------------------------------------ 执行 */

/**
 * 确认文案里的"将依次执行"。
 *
 * 用 `→` 串成一行而不是每步一行：`ElMessageBox` 不渲染 Markdown，
 * 换行在它的正文里会被折成空格 —— 一行写法至少在任何渲染下都读得通。
 */
function stepsLine(steps: Array<{ seq: number; name: string; kindLabel: string }>): string {
  const shown = steps.slice(0, 6).map((s) => `${s.seq}. ${s.name}（${s.kindLabel}）`)
  const more = steps.length > 6 ? ` ……共 ${steps.length} 步` : ''
  return `将依次执行：${shown.join(' → ')}${more}`
}

/** 按预览结果挑危险档位：有服务器脚本就是最宽的 exec，否则可能只是 files。 */
function effectOf(p: PipelinePreview): { effect: 'none' | 'files' | 'exec'; detail?: string } {
  if (p.hasRemoteStep) {
    return {
      effect: 'exec',
      detail: p.hasDeployStep
        ? '其中「发布」这一步会替换目标路径上的文件，旧版本先进版本库。具体做什么由脚本内容决定。'
        : '具体做什么由脚本内容决定。'
    }
  }
  if (p.hasDeployStep) {
    return { effect: 'files', detail: '会替换目标路径上的文件（旧版本先进版本库，可以回滚）。' }
  }
  return { effect: 'none' }
}

/** 跑之前问一次。返回用户输入的目标名（生产环境才有意义）。 */
async function confirmRun(
  title: string,
  consequence: string,
  p: PipelinePreview
): Promise<{ go: boolean; typed?: string }> {
  const eff = effectOf(p)
  const base = {
    title,
    consequence,
    remoteEffect: eff.effect,
    ...(eff.detail ? { remoteDetail: eff.detail } : {}),
    confirmText: '执行'
  } as const

  if (p.requiresTypedName) {
    // 生产环境：用"把输入值带回来"的那个版本，让服务端那道校验真的能校验
    const r = await confirmDangerWithName({ ...base, requireTypedName: p.targetName })
    return r.ok ? { go: true, typed: r.typed } : { go: false }
  }
  return { go: await confirmDanger(base) }
}

async function previewOf(pipelineId: string): Promise<PipelinePreview | null> {
  try {
    return await api.pipelines.preview({ pipelineId })
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
    return null
  }
}

/* ------------------------------------------------- 发布后的页面刷新（T11.6 的流水线侧） */

const jobStore = useJobStore()

/**
 * 本面板启动的、含发布步骤的任务 id。
 *
 * 流水线的发布步骤在**主进程**里直接调 `deploy.run`（见文件头，为避免任务框架
 * 自锁死锁），渲染层不会像 `PublishPanel` 那样"自己发起的任务自己看得见结果"——
 * 目标页的当前版本号 / 往期版本列表 consequently 不会刷新。所以这里盯住任务
 * store：自己启动的含发布步骤的任务整条成功后，向上发 `deployed`，让
 * `TargetDetail` 走与手动发布同一个刷新入口。
 */
const deployJobIds = ref<string[]>([])

watch(
  () => jobStore.jobs.filter((j) => deployJobIds.value.includes(j.jobId)),
  (mine) => {
    const done = mine.filter((j) => isTerminalStatus(j.status))
    if (done.length === 0) return
    const finishedIds = new Set(done.map((j) => j.jobId))
    deployJobIds.value = deployJobIds.value.filter((id) => !finishedIds.has(id))
    for (const job of done) {
      if (job.status === 'succeeded') emit('deployed', { jobId: job.jobId, versionTag: null })
    }
  }
)

/** 任务启动成功后登记（只在确实带发布步骤时——其他步骤不影响目标页数据）。 */
function trackDeployJob(job: JobView, hasDeployStep: boolean): void {
  if (hasDeployStep) deployJobIds.value = [...deployJobIds.value, job.jobId]
}

async function runAll(p: PipelineView): Promise<void> {
  const preview = await previewOf(p.pipelineId)
  if (!preview) return

  // 正文只写"会发生什么"；「对服务器的影响」那一行由 `confirmDanger` 统一追加
  // （别在这里再拼一遍 —— 会重复出现两次）
  const r = await confirmRun(
    `跑整条流水线「${p.name}」？`,
    `${stepsLine(preview.steps)}\n\n中间某一步失败时，按该步的设置决定「终止整条」还是「继续往下跑」。`,
    preview
  )
  if (!r.go) return

  try {
    const job = await api.pipelines.run({
      pipelineId: p.pipelineId,
      ...(r.typed === undefined ? {} : { typedName: r.typed })
    })
    trackDeployJob(job, p.steps.some((s) => s.kind === 'deploy'))
    ElMessage.success('已加入任务队列，可在底部任务控制台看实时输出')
    await load(true)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

async function runOne(p: PipelineView, step: PipelineStepView): Promise<void> {
  const preview = await previewOf(p.pipelineId)
  if (!preview) return
  const one = preview.steps.find((s) => s.seq === step.seq)
  if (!one) return

  const single: PipelinePreview = { ...preview, steps: [one] }
  const r = await confirmRun(
    `只跑第 ${step.seq} 步「${step.name}」？`,
    // 不用 Markdown 的星号加粗：`ElMessageBox` 不渲染 Markdown，用户会看到字面量星号
    `只跑这一步（${one.kindLabel}），其他步骤不会被触发。\n\n这一步会执行：${one.summary}`,
    single
  )
  if (!r.go) return

  try {
    const job = await api.pipelines.runStep({
      pipelineId: p.pipelineId,
      seq: step.seq,
      ...(r.typed === undefined ? {} : { typedName: r.typed })
    })
    trackDeployJob(job, step.kind === 'deploy')
    ElMessage.success('已加入任务队列')
    await load(true)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

/* -------------------------------------------------------------- 展示助手 */

function tagTypeOf(kind: PipelineStepKind): 'primary' | 'warning' | 'success' | 'info' {
  if (kind === 'deploy') return 'warning'
  if (kind === 'remote') return 'primary'
  return 'info'
}

function summaryOf(step: PipelineStepView): string {
  return pipelineStepSummary({
    kind: step.kind,
    script: step.script,
    remotePath: step.kind === 'deploy' ? props.target.remotePath : null
  })
}

function shellLabelOf(step: PipelineStepView): string | null {
  if (step.kind !== 'local') return null
  const s = step.shell ?? caps.value?.defaultShell ?? null
  return s ? LOCAL_SHELL_LABELS[s] : null
}

/* -------------------------------------------------------------- 生命周期 */

async function refresh(): Promise<void> {
  await Promise.all([loadCaps(), load()])
}

onMounted(refresh)

// 换目标整块重来 —— 流水线是按目标的
watch(
  () => props.target.id,
  () => {
    list.value = []
    editorOpen.value = false
    void refresh()
  }
)
</script>

<template>
  <!--
    这块现在是「脚本 / 流水线」在目标页的**唯一入口** —— B20 那个独立的「脚本」
    区块已经删掉，所以三种状态都要说清楚，不能静默不渲染：
    能力读不出来 → 报错；总闸关着 → 说明去哪儿打开；否则 → 正常面板。
    （`caps` 还没读回来时三种都不渲染，避免闪一下"功能未开启"。）
  -->
  <el-alert
    v-if="capsError"
    type="error"
    show-icon
    :closable="false"
    :title="`读取脚本能力失败：${capsError}`"
    data-test="script-caps-error"
  />

  <el-alert
    v-else-if="caps && !caps.allowUserScripts"
    type="info"
    show-icon
    :closable="false"
    title="自定义脚本功能未开启"
    data-test="script-gate-off"
  >
    <p class="gate-text">
      这个功能默认关闭 —— 开启后可以在本机或服务器上执行你填写的任意命令，
      并把这些步骤存成自动化脚本。
    </p>
    <p class="gate-text">需要的到「设置 → 脚本执行」里打开<strong>开启自定义脚本</strong>。</p>
    <el-button size="small" :icon="CaretRight" @click="goSettings">去设置里打开</el-button>
  </el-alert>

  <section v-else-if="caps" class="pipeline-panel" data-test="pipeline-panel">
    <div class="head">
      <span class="hint inline">
        把一串操作存成一条流水线。
      </span>
      <span class="spacer" />
      <el-button
        link
        :icon="Refresh"
        :loading="loading"
        data-test="pipeline-refresh"
        @click="load()"
      >
        刷新
      </el-button>
      <el-button type="primary" size="small" :icon="Plus" data-test="pipeline-new" @click="openNew">
        新建流水线
      </el-button>
    </div>

    <el-alert v-if="loadError" type="error" show-icon :closable="false" :title="loadError" />

    <el-empty
      v-else-if="!list.length"
      description="还没有流水线"
      :image-size="56"
      data-test="pipeline-empty"
    />

    <div v-else class="items" data-test="pipeline-list">
      <div v-for="p in list" :key="p.pipelineId" class="item" data-test="pipeline-item">
        <div class="item-head">
          <span class="name">{{ p.name }}</span>
          <el-tag size="small" type="info">{{ p.steps.length }} 步</el-tag>
          <span class="spacer" />
          <el-button
            size="small"
            type="primary"
            :icon="VideoPlay"
            data-test="pipeline-run"
            @click="runAll(p)"
          >
            一键执行
          </el-button>
          <el-button size="small" :icon="EditPen" data-test="pipeline-edit" @click="openEdit(p)">
            编辑
          </el-button>
          <el-button
            size="small"
            link
            type="danger"
            :icon="Delete"
            data-test="pipeline-remove"
            @click="removePipeline(p)"
          >
            删除
          </el-button>
        </div>

        <div v-if="p.description" class="desc">{{ p.description }}</div>

        <ol class="steps" data-test="pipeline-steps">
          <li v-for="s in p.steps" :key="s.stepId" class="step" data-test="pipeline-step-row">
            <span class="seq">{{ s.seq }}</span>
            <el-tag size="small" :type="tagTypeOf(s.kind)">{{ describeStepKind(s.kind) }}</el-tag>
            <span class="step-name">{{ s.name }}</span>
            <span v-if="shellLabelOf(s)" class="muted">{{ shellLabelOf(s) }}</span>
            <span class="summary mono" :title="summaryOf(s)">{{ summaryOf(s) }}</span>
            <span class="spacer" />
            <span v-if="s.onFailure === 'continue'" class="muted">失败后继续</span>
            <el-button
              link
              size="small"
              data-test="pipeline-run-step"
              @click="runOne(p, s)"
            >
              只跑这步
            </el-button>
          </li>
        </ol>

        <div class="meta">
          更新于 <span class="mono">{{ formatDateTime(p.updatedAt) }}</span>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------------ 编辑器 -->
    <el-dialog
      v-model="editorOpen"
      :title="editingId ? '编辑流水线' : '新建流水线'"
      width="760px"
      :close-on-click-modal="false"
      data-test="pipeline-editor"
    >
      <el-form label-width="86px" @submit.prevent>
        <el-form-item label="名称">
          <el-input
            v-model="draftName"
            class="grow"
            maxlength="60"
            placeholder="例如：后端一键发版"
            data-test="pipeline-name"
          />
        </el-form-item>
        <el-form-item label="说明">
          <el-input
            v-model="draftDesc"
            class="grow"
            maxlength="200"
            placeholder="可选"
            data-test="pipeline-description"
          />
        </el-form-item>
      </el-form>

      <div class="steps-head">
        <strong>步骤</strong>
        <span class="hint inline">从上到下依次执行</span>
        <span class="spacer" />
        <el-button size="small" :icon="Plus" data-test="pipeline-step-add" @click="addStep">
          添加步骤
        </el-button>
      </div>

      <el-alert
        v-if="deployCount > 1"
        class="warn"
        type="warning"
        show-icon
        :closable="false"
        title="一条流水线里最多只能有一个「发布」步骤"
      />

      <div class="editor-steps" data-test="pipeline-editor-steps">
        <div v-for="(st, i) in draftSteps" :key="st.key" class="editor-step">
          <div class="editor-step-head">
            <span class="seq">{{ i + 1 }}</span>
            <el-radio-group
              v-model="st.kind"
              size="small"
              data-test="pipeline-step-kind"
              @change="onKindChange(st)"
            >
              <el-radio-button
                v-for="k in (['local', 'remote', 'deploy'] as const)"
                :key="k"
                :value="k"
              >
                {{ PIPELINE_STEP_KIND_LABELS[k] }}
              </el-radio-button>
            </el-radio-group>
            <span class="spacer" />
            <el-button
              link
              size="small"
              :icon="ArrowUp"
              :disabled="i === 0"
              data-test="pipeline-step-up"
              @click="moveStep(i, -1)"
            />
            <el-button
              link
              size="small"
              :icon="ArrowDown"
              :disabled="i === draftSteps.length - 1"
              data-test="pipeline-step-down"
              @click="moveStep(i, 1)"
            />
            <el-button
              link
              size="small"
              type="danger"
              :icon="Delete"
              data-test="pipeline-step-remove"
              @click="removeStep(i)"
            />
          </div>

          <div class="editor-step-body">
            <el-form label-width="86px" @submit.prevent>
              <el-form-item label="步骤名">
                <el-input
                  v-model="st.name"
                  class="grow"
                  maxlength="120"
                  data-test="pipeline-step-name"
                />
              </el-form-item>

              <!--
                服务器步骤的常驻权限提示（从目标页「脚本」区块搬来的，B20）。
                挂在「步骤名」正下方而不是弹成一次性气泡：脚本失败最常见的原因
                就是服务器账户权限不够，而那时用户往往已经忘了"这软件是拿哪个
                账号连的"。只对服务器步骤显示 —— 本机脚本与这条无关。
              -->
              <el-alert
                v-if="st.kind === 'remote'"
                class="perm"
                type="warning"
                show-icon
                :closable="false"
                title="脚本以你当前的权限执行"
                data-test="script-permission-hint"
              >
                <p class="gate-text">
                  服务端脚本用的是<strong>你登录服务器时用的那个账户</strong>。请确认它的权限足够
                  （例如重启服务要 <span class="mono">sudo</span> /
                  <span class="mono">systemctl</span> 权限、写目标目录要对应属主），否则脚本会在中途失败。
                </p>
              </el-alert>

              <template v-if="st.kind !== 'deploy'">
                <el-form-item v-if="st.kind === 'local'" label="解释器">
                  <el-select
                    v-model="st.shell"
                    class="shell-select"
                    data-test="pipeline-step-shell"
                  >
                    <el-option
                      v-for="s in shellOptions"
                      :key="s.shell"
                      :label="s.available ? s.label : `${s.label}（本机未找到）`"
                      :value="s.shell"
                      :disabled="!s.available"
                    />
                  </el-select>
                </el-form-item>

                <el-form-item v-if="st.kind === 'local'" label="工作目录">
                  <el-input
                    v-model="st.cwd"
                    class="grow"
                    placeholder="留空则用应用可执行文件所在目录"
                    clearable
                    data-test="pipeline-step-cwd"
                  />
                </el-form-item>

                <el-form-item label="脚本">
                  <el-input
                    v-model="st.script"
                    type="textarea"
                    :rows="4"
                    class="mono-area"
                    :placeholder="
                      st.kind === 'local'
                        ? '例如：mvn -q -DskipTests package'
                        : '例如：systemctl stop my-backend'
                    "
                    data-test="pipeline-step-script"
                  />
                </el-form-item>
              </template>

              <el-alert
                v-else
                class="info"
                type="info"
                show-icon
                :closable="false"
                data-test="pipeline-step-deploy-note"
              >
                <template #title>这一步执行的是应用自己的发布流程</template>
                不需要填脚本 —— 它会做前置校验、上传、归档旧版本、换版，
                并写进「发布历史」（旧版本可以回滚）。发布什么由目标的
                <span class="mono">本地产物</span> 与
                <span class="mono">服务器路径</span> 决定，在目标配置里改。
              </el-alert>

              <el-form-item label="超时">
                <el-input-number
                  v-model="st.timeoutSec"
                  :min="1"
                  :max="3600"
                  :step="30"
                  data-test="pipeline-step-timeout"
                />
                <span class="hint inline">秒</span>
              </el-form-item>

              <el-form-item label="失败后">
                <el-radio-group v-model="st.onFailure" data-test="pipeline-step-onfailure">
                  <el-radio value="stop">{{ PIPELINE_ON_FAILURE_LABELS.stop }}</el-radio>
                  <el-radio value="continue">{{ PIPELINE_ON_FAILURE_LABELS.continue }}</el-radio>
                </el-radio-group>
                <span class="hint inline">
                  {{
                    st.onFailure === 'stop'
                      ? '这一步失败就不跑后面的了（适合"关服务"之后的步骤）。'
                      : '失败了也往下跑（适合清理、收集日志这类收尾步骤）。'
                  }}
                </span>
              </el-form-item>
            </el-form>
          </div>
        </div>
      </div>

      <el-alert v-if="editorError" type="error" show-icon :closable="false" :title="editorError" />

      <template #footer>
        <el-button :disabled="saving" @click="editorOpen = false">取消</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="!canSave"
          data-test="pipeline-save"
          @click="save"
        >
          保存
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.pipeline-panel {
  margin-top: 8px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.spacer {
  flex: 1 1 auto;
}
.hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
.hint.inline {
  margin-left: 0;
}
.mono {
  font-family: Consolas, Monaco, 'Courier New', monospace;
}
.muted {
  font-size: 12px;
  color: #909399;
}
.items {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.item {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 10px 12px;
}
.item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.name {
  font-weight: 600;
}
.desc {
  margin-top: 4px;
  font-size: 12.5px;
  color: #606266;
}
.steps {
  list-style: none;
  margin: 8px 0 4px;
  padding: 0;
}
.step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 13px;
}
.seq {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--el-fill-color);
  font-size: 11px;
  flex: 0 0 auto;
}
.step-name {
  flex: 0 0 auto;
}
/*
  摘要可能很长：给它一个可伸缩的上限 + 省略号，而不是让它把行撑破。
  用 title 属性把全文留着，鼠标停一下能看到。
*/
.summary {
  font-size: 12px;
  color: #909399;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12px;
  color: #c0c4cc;
  margin-top: 4px;
}
.steps-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0 8px;
}
.editor-steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 46vh;
  overflow: auto;
}
.editor-step {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 8px 10px;
}
.editor-step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.editor-step-body {
  border-top: 1px dashed var(--el-border-color-lighter);
  padding-top: 8px;
}
.shell-select {
  width: 200px;
}
.mono-area :deep(textarea) {
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 12.5px;
  line-height: 1.6;
}
.warn {
  margin-bottom: 10px;
}
.info {
  margin-bottom: 12px;
}
/*
  「脚本以你当前的权限执行」—— 常量提示，常驻在服务器步骤的「步骤名」下面。
  它没有 form-item 包着，所以自己留出与下一个表单项之间的间距。
*/
.perm {
  margin-bottom: 12px;
}
.gate-text {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.6;
}
.gate-text:last-of-type {
  margin-bottom: 8px;
}
.grow {
  flex: 1 1 auto;
}
</style>
