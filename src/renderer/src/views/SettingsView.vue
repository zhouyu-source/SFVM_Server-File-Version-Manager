<script setup lang="ts">
/**
 * 设置页（B15 / T15.1 ~ T15.3 + T15.8；B18 改「关于」区）。
 *
 * ## B18：「关于」区只剩数据目录与日志目录
 *
 * 原来那张 `el-descriptions` 表格（应用版本 / Electron / Chromium / Node / 平台 /
 * 运行模式）整块去掉了 —— 那些是**一次性看过就够**的信息，占着一整块版面，
 * 而设置页真正需要能操作的是**数据目录**（可配置）与**日志目录**（跟随数据目录）。
 * 版本信息没丢：菜单「关于 SFVM」里仍然给全，排障时到那里看。
 *
 * 数据目录为什么带自己的「应用」按钮、而不是并进下面那个「保存」：
 * 见 `applyDataDir()` 上方注释 —— 它要复制台账并且**重启才生效**，
 * 与"写一次设置"完全不是一回事。
 *
 * 换目录时**原目录会在重启后被清掉**（不再"原样保留当备份"）：换目录的目的
 * 就是不把文件留在原处。删除不在这一刻做（旧库正被当前进程打开着），只登记进
 * 指针文件，由下次启动执行；设置页把"重启后会清理哪几个目录"显示出来
 * （`pendingCleanup`），免得用户以为还留着备份。
 *
 * 「配置导入 / 导出」排在页面**最底下**：它是换机器、备份配置时才用的一次性动作，
 * 不该挡在每次调设置都要看的那些项前面。
 *
 * ## 保存策略：显式点「保存」，而不是改一下就存
 *
 * 设置项里有几个是**会出网络行为**的（并发数、算法兼容模式）。改成"即改即存"
 * 的话，用户拖动滑块的过程会写几十次数据库，而且中途某个值（比如并发 8）
 * 可能刚好被正在跑的任务取走。所以这里统一：**表单态 → 点保存 → 落库**。
 *
 * 唯一例外是「日志级别」——它没有代价、且用户常常是"改完立刻想看效果"，
 * 所以它单独提供"立即应用"（仍然要点一下，只是不跟着整表单走）。
 *
 * ## 导入是**只增不改**
 *
 * 导入按名称去重，已存在的一律跳过（连接 / 环境 / 目标都是）。
 * 不做"按名字覆盖"是刻意的：覆盖意味着"别人的配置能悄悄改掉我本地的服务器地址"，
 * 而这类错误在发布那一刻才会以"文件传到了错误的机器上"的形式暴露出来。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Brush,
  Check,
  CopyDocument,
  DocumentAdd,
  FolderOpened,
  Monitor,
  Refresh,
  Upload
} from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { useMenuStore } from '../stores/menu'
import { confirmDanger } from '../utils/danger'
import { formatBytes } from '../utils/format'
import type { AppInfoOutput, DataLocationOutput } from '../../../shared/contracts/app'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_RETAIN_COUNT,
  DEFAULT_TRANSFER_CONCURRENCY,
  LOG_LEVEL_LABELS,
  LOG_LEVELS,
  SETTING_LABELS,
  TRANSFER_CONCURRENCY_MAX,
  TRANSFER_CONCURRENCY_MIN,
  type AppSettings,
  type ConfigImportResult,
  type SettingsSnapshot
} from '../../../shared/contracts/settings'
import { APP_SHORTCUTS, formatAccelerator } from '../../../shared/shortcuts'

const menu = useMenuStore()

/* ------------------------------------------------------------- 表单状态 */

const loading = ref(true)
const saving = ref(false)
const errorText = ref('')
const info = ref<AppInfoOutput | null>(null)

/**
 * 把表单转成**可以跨 IPC 传的普通值**。
 *
 * ## 为什么必须深一层地抹掉 Proxy
 *
 * `form` 是 `reactive()` 的对象，它的**嵌套对象**同样是 Proxy —— 这里就是
 * `form.defaultRetainPolicy`。而 Electron 的 IPC 用**结构化克隆**，
 * 其 V8 序列化器**拒绝 Proxy**，直接传会报：
 *
 *     An object could not be cloned.
 *
 * 浅拷贝（`{ ...form }`）不够：顶层变普通对象了，嵌套那层还是 Proxy。
 * 这个坑 B12 在"删除勾选的版本"上踩过一次（那次是 `ref([])` 的数组代理），
 * 这里是它的翻版 —— 而且更难发现：保存失败只弹一条错误提示，
 * 表单看起来还是新值，于是"保存成功了吗"完全看不出来。
 * （B15 的 DoD 真窗口 E2E 抓到。）
 *
 * 用 `JSON` 往返而不是 `structuredClone`：后者对 Proxy 同样是抛错，
 * 而 `JSON` 往返能**顺带**把不可序列化的东西（函数、undefined）丢掉，
 * 于是"传过去的一定是普通数据"这件事由这一行保证。
 */
function plainSettings(): AppSettings {
  return JSON.parse(JSON.stringify(toSettings())) as AppSettings
}

/**
 * 表单里的草稿。
 *
 * ## 为什么不用 `reactive<AppSettings>` 直接对着契约对象改
 *
 * 契约里 `defaultRetainPolicy` 是一个**对象**（`{ mode, value }`），而把它直接
 * 接到 `el-select` / `el-input-number` 上有两个坑，B15 里都碰到了：
 *
 * 1. **`el-option` 的 `:value` 传对象是靠引用比较的** —— 每次渲染都会新建一个字面量，
 *    于是 `modelValue` 永远匹配不上任何选项（下拉看着是空的）；
 * 2. **`v-model` 写到嵌套路径上（`form.defaultRetainPolicy.value`）时，
 *    通过"直接写 DOM + 派发 input 事件"驱动它是不生效的** —— 真机上表现为
 *    "输入框显示 3、保存按钮却仍是禁用的"（模型里还是 20）。
 *    E2E 就是靠这条诊断抓到它的。
 *
 * 所以表单拆成**扁平字段**：`retainMode` 是字符串（`'none' | 'count' | 'days'`），
 * `retainValue` 是数字。这与 `TargetWizard` 里目标级保留策略的写法一致 ——
 * 那里一开始就这么做，所以从没踩到这两个坑。
 *
 * 与契约对象之间的转换集中在 `toSettings()` / `fromSettings()` 两处，
 * 别的地方不再接触嵌套结构。
 */
interface SettingsForm {
  downloadDir: string | null
  transferConcurrency: number
  logLevel: AppSettings['logLevel']
  hashCompatMode: boolean
  retainMode: 'none' | 'count' | 'days'
  retainValue: number
  /** B20：自定义脚本总闸（默认关） */
  allowUserScripts: boolean
  /** B20：Git Bash 的 bash.exe 路径；null = 自动探测 */
  gitBashPath: string | null
}

const saved = ref<AppSettings>({ ...DEFAULT_APP_SETTINGS })
const form = reactive<SettingsForm>({
  downloadDir: DEFAULT_APP_SETTINGS.downloadDir,
  transferConcurrency: DEFAULT_APP_SETTINGS.transferConcurrency,
  logLevel: DEFAULT_APP_SETTINGS.logLevel,
  hashCompatMode: DEFAULT_APP_SETTINGS.hashCompatMode,
  retainMode: DEFAULT_APP_SETTINGS.defaultRetainPolicy ? 'count' : 'none',
  retainValue: DEFAULT_APP_SETTINGS.defaultRetainPolicy?.value ?? DEFAULT_RETAIN_COUNT,
  allowUserScripts: DEFAULT_APP_SETTINGS.allowUserScripts,
  gitBashPath: DEFAULT_APP_SETTINGS.gitBashPath
})

/** 表单 → 契约（提交时用）。 */
function toSettings(): AppSettings {
  return {
    downloadDir: form.downloadDir,
    transferConcurrency: form.transferConcurrency,
    logLevel: form.logLevel,
    hashCompatMode: form.hashCompatMode,
    defaultRetainPolicy:
      form.retainMode === 'none'
        ? null
        : { mode: form.retainMode, value: Math.max(1, Math.floor(form.retainValue)) },
    allowUserScripts: form.allowUserScripts,
    // 空串在契约里没有意义（契约是 `string | null`）→ 归一成 null
    gitBashPath: form.gitBashPath?.trim() ? form.gitBashPath.trim() : null
  }
}

/** 契约 → 表单（读回来时用）。 */
function fromSettings(s: AppSettings): void {
  form.downloadDir = s.downloadDir
  form.transferConcurrency = s.transferConcurrency
  form.logLevel = s.logLevel
  form.hashCompatMode = s.hashCompatMode
  form.retainMode = s.defaultRetainPolicy?.mode ?? 'none'
  form.retainValue = s.defaultRetainPolicy?.value ?? DEFAULT_RETAIN_COUNT
  form.allowUserScripts = s.allowUserScripts
  form.gitBashPath = s.gitBashPath
}

const issues = ref<SettingsSnapshot['issues']>([])
const effectiveDownloadDir = ref('')

const isMac = computed(() => info.value?.platform === 'darwin')

/**
 * 日志级别下拉的绑定值。
 *
 * `el-option` 的 `value` 不接受 `null`（它的类型是字符串/数字/布尔/对象），
 * 而"跟随默认"在契约里就是 `null`。所以下拉用一个哨兵字符串，读写时转换 ——
 * 比把契约里的 `null` 改成 `'default'` 好：那个 `null` 是要落库的语义，
 * 串上一根界面专用的哨兵字符串，将来换界面时就成了历史包袱。
 */
const LOG_LEVEL_DEFAULT = '__default__'
const logLevelSelect = computed<string>({
  get: () => form.logLevel ?? LOG_LEVEL_DEFAULT,
  set: (v) => {
    form.logLevel = v === LOG_LEVEL_DEFAULT ? null : (v as AppSettings['logLevel'])
  }
})

/** 比较的是"表单转成契约之后"的值，而不是表单的字段名 —— 两者的形状本来就不同。 */
const dirty = computed(() => JSON.stringify(toSettings()) !== JSON.stringify(saved.value))

const dirtyFields = computed(() => {
  const now = toSettings()
  const out: string[] = []
  for (const key of Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>) {
    if (JSON.stringify(now[key]) !== JSON.stringify(saved.value[key])) {
      out.push(SETTING_LABELS[key])
    }
  }
  return out
})

/* --------------------------------------------------------------- 读设置 */

async function load(): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    const [snap, appInfo, loc] = await Promise.all([
      api.settings.get(),
      api.app.info(),
      api.app.dataLocationGet()
    ])
    applySnapshot(snap)
    info.value = appInfo
    applyDataLocation(loc)
  } catch (e) {
    errorText.value = (e as IpcBusinessError).toUserText()
  } finally {
    loading.value = false
  }
}

function applySnapshot(snap: SettingsSnapshot): void {
  saved.value = { ...snap.settings }
  fromSettings(snap.settings)
  issues.value = snap.issues
  effectiveDownloadDir.value = snap.effectiveDownloadDir
}

onMounted(async () => {
  await load()
  /**
   * 菜单「打开设置」推的命令走到这里就结束了（切页本身就是全部动作）；
   * 顺手把可能残留的 `new-connection` 消费掉 —— 否则用户之后手工切到连接页时
   * 会莫名弹出一个新建表单（那正是"信箱不清空"会造成的现象）。
   */
  menu.consume('new-connection')
})

/* --------------------------------------------------------------- 写设置 */

async function save(): Promise<void> {
  saving.value = true
  try {
    const snap = await api.settings.update(plainSettings())
    applySnapshot(snap)
    ElMessage.success('设置已保存并生效')
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    saving.value = false
  }
}

/** 恢复默认值（只改表单，仍要点保存） */
function resetToDefaults(): void {
  fromSettings({ ...DEFAULT_APP_SETTINGS })
  ElMessage.info('已填入默认值，点「保存」后生效')
}

/**
 * 日志级别：单独一个"立即应用"。
 *
 * 它没有网络副作用，用户改它通常就是想马上看到效果，所以不跟着整表单的保存走；
 * 但也**不**做成即改即存 —— 那样每按一次方向键就写一次库、刷一次级别。
 */
const applyingLevel = ref(false)

async function applyLogLevel(): Promise<void> {
  applyingLevel.value = true
  try {
    // 这里是标量，但保持同一写法：将来若把它改成对象，不会又踩一次 Proxy
    const snap = await api.settings.update({ logLevel: form.logLevel })
    applySnapshot(snap)
    ElMessage.success('日志级别已立即生效')
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    applyingLevel.value = false
  }
}

async function pickDownloadDir(): Promise<void> {
  try {
    const r = await api.app.pickDirectory({ defaultPath: form.downloadDir })
    if (r) form.downloadDir = r.path
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

/* --------------------------------------------------------------- 脚本执行 */

/**
 * 「允许执行自定义脚本」开关前的危险确认（B20）。
 *
 * 用 `el-switch` 的 `before-change` 而不是"先切过去、再弹框问"：
 * 后者在用户点"取消"时得把开关**拨回来**，中间那一帧既是错误的线上状态
 * （`dirty` 已经变了、按钮已经亮了），也会让人以为"已经开了"。
 * `before-change` 返回 false 时开关**根本没动过**。
 *
 * 关掉方向不拦：关闭永远是安全的，加一道确认只会让用户以为"关不掉"。
 */
async function beforeToggleUserScripts(): Promise<boolean> {
  if (form.allowUserScripts) return true
  return confirmDanger({
    title: '打开「允许执行自定义脚本」？',
    consequence:
      '打开后，在目标页添加入的脚本会被真正执行 —— 本地脚本在本机跑，服务端脚本用你已连接的服务器账号跑。' +
      '本工具不检查脚本内容，也不会替你挡住写错的命令。',
    remoteEffect: 'exec',
    remoteDetail: '执行什么完全由脚本内容决定，可能是关服务、删文件或改配置。',
    confirmText: '我明白，打开'
  })
}

/** 选 Git Bash 的 bash.exe（B20）。选完不立即保存，跟着「保存」一起生效。 */
async function pickGitBash(): Promise<void> {
  try {
    const r = await api.app.pickExecutable({
      title: '选择 Git Bash 的 bash.exe',
      defaultPath: form.gitBashPath
    })
    if (r) form.gitBashPath = r.path
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

/* ----------------------------------------------------------- 导出 / 导入 */

const exporting = ref(false)
const exportText = ref('')
const exportName = ref('')
const copying = ref(false)

async function doExport(): Promise<void> {
  exporting.value = true
  try {
    const r = await api.settings.export()
    exportText.value = r.text
    exportName.value = r.suggestedName
    ElMessage.success('已生成导出内容（未写入文件）')
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    exporting.value = false
  }
}

async function exportToFile(): Promise<void> {
  exporting.value = true
  try {
    const r = await api.settings.exportToFile()
    // 用户取消时不提示：他显然知道自己点了取消
    if (r.path) ElMessage.success(`已导出到 ${r.path}`)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    exporting.value = false
  }
}

async function copyExport(): Promise<void> {
  copying.value = true
  try {
    await navigator.clipboard.writeText(exportText.value)
    ElMessage.success('已复制到剪贴板')
  } catch {
    // 剪贴板可能被系统策略拒绝：让用户手动全选（textarea 是可选的）
    ElMessage.warning('复制失败，请手动全选文本框内容复制')
  } finally {
    copying.value = false
  }
}

const importText = ref('')
const importing = ref(false)
const importResult = ref<ConfigImportResult | null>(null)
const importError = ref('')

async function doImport(fromFile: boolean): Promise<void> {
  importing.value = true
  importError.value = ''
  importResult.value = null
  try {
    if (fromFile) {
      const r = await api.settings.importFromFile()
      if (!r) return // 用户取消
      importResult.value = r
    } else {
      importResult.value = await api.settings.import({
        text: importText.value,
        applySettings: true
      })
    }
    const r = importResult.value
    ElMessage.success(
      `导入完成：连接 +${r.connections.created}、环境 +${r.environments.created}、目标 +${r.targets.created}`
    )
    // 设置可能被导入内容改过 → 重新读一遍表单
    await load()
  } catch (e) {
    importError.value = (e as IpcBusinessError).toUserText()
  } finally {
    importing.value = false
  }
}

/* --------------------------------------------------------------- 关于 */

/**
 * 数据目录（B18）。
 *
 * ## 为什么它**不跟着上面那张表单走**
 *
 * 上面那个「保存」是「写一次数据库"」，而改数据目录要**把台账复制到新目录**
 * 并且**重启才生效** —— 语义完全不同。硬塞进同一张表单，用户会以为点一次保存
 * 就切过去了，然后纳闷"数据怎么还在原来那"。
 *
 * 所以这里单独一套：独立草稿、独立「应用」按钮、独立提示条
 * （提示条要说清"已保存但**要重启**"这件事，这是最容易误解的一点）。
 */
const dataLocation = ref<DataLocationOutput | null>(null)
/** 草稿；空串 = 用默认目录（对应契约里的 `null`） */
const dataDirDraft = ref('')
const applyingDataDir = ref(false)
const dataDirNotice = ref<{ type: 'success' | 'warning' | 'error'; text: string; warnings: string[] } | null>(
  null
)

const effectiveDataDir = computed(() => dataLocation.value?.effectiveDir ?? '')
const logDir = computed(() => dataLocation.value?.logDir ?? '')

/** 去尾分隔符：`D:\X\` 与 `D:\X` 是同一处，不归一化会让"是否改动过"永远判不准。 */
function normDir(v: string): string {
  return v.trim().replace(/[\\/]+$/, '')
}

const dataDirDirty = computed(() => {
  const loc = dataLocation.value
  if (!loc) return false
  const configured = loc.isDefault ? '' : loc.configuredDir
  return normDir(dataDirDraft.value) !== normDir(configured)
})

function applyDataLocation(loc: DataLocationOutput): void {
  dataLocation.value = loc
  dataDirDraft.value = loc.isDefault ? '' : loc.configuredDir
}

async function pickDataDir(): Promise<void> {
  try {
    const r = await api.app.pickDirectory({
      defaultPath: dataDirDraft.value || effectiveDataDir.value
    })
    if (r) {
      dataDirDraft.value = r.path
      dataDirNotice.value = null
    }
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

async function applyDataDir(): Promise<void> {
  applyingDataDir.value = true
  dataDirNotice.value = null
  try {
    const r = await api.app.dataLocationSet(dataDirDraft.value.trim() || null)
    applyDataLocation(r.state)
    if (!r.ok) {
      // 失败原因本身就是给用户看的处置说明（"目标目录里已有一份台账"…）
      dataDirNotice.value = { type: 'error', text: r.reason, warnings: [] }
      ElMessage.error('数据目录没有改动')
      return
    }
    dataDirNotice.value = r.restartRequired
      ? {
          type: 'warning',
          // 这半句不能省：不说清楚，用户重启前会以为已经切过去了
          text: `已保存。重启应用后才会切到新目录，重启前仍使用 ${r.state.effectiveDir}。`,
          warnings: r.warnings
        }
      : {
          type: 'success',
          text: '数据目录已是该位置，没有需要复制的数据。',
          warnings: r.warnings
        }
    ElMessage.success(r.restartRequired ? '已保存，重启后生效' : '已保存')
  } catch (e) {
    dataDirNotice.value = { type: 'error', text: (e as IpcBusinessError).toUserText(), warnings: [] }
  } finally {
    applyingDataDir.value = false
  }
}

async function openDir(path: string, label: string): Promise<void> {
  if (!path) {
    ElMessage.warning(`拿不到${label}的路径`)
    return
  }
  try {
    await api.app.revealPath(path)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

/**
 * 快捷键表的数据源。
 *
 * `APP_SHORTCUTS` 是 `readonly`（它是共享常量，不该被界面改），
 * 而 `el-table` 的 `data` 要可变数组 —— 这里拷一份。
 */
const shortcutRows = [...APP_SHORTCUTS]

/** 导出内容的体积展示（让用户对"这份配置多大"有概念） */
const exportSizeText = computed(() => {
  if (!exportText.value) return ''
  return formatBytes(new TextEncoder().encode(exportText.value).length)
})
</script>

<template>
  <section class="settings" data-test="settings-page">
    <h2>设置</h2>

    <el-alert v-if="errorText" type="error" :title="errorText" :closable="false" show-icon />

    <!--
      有设置项读不出来时的告警（B15）。
      "配了但坏了"必须说出来：否则用户改了设置却不生效，界面上一点提示都没有。
    -->
    <el-alert
      v-if="issues.length"
      type="warning"
      :closable="false"
      show-icon
      data-test="settings-issues"
    >
      <template #title>有 {{ issues.length }} 项设置读不出来，已按默认值生效</template>
      <ul class="issue-list">
        <li v-for="i in issues" :key="i.key">
          <strong>{{ i.label }}</strong
          >：存储的值无法解析（<span class="mono">{{ i.raw }}</span
          >），当前按「{{ i.fallbackText }}」处理。
        </li>
      </ul>
    </el-alert>

    <el-skeleton v-if="loading" :rows="8" animated />

    <template v-else>
      <!-- ------------------------------------------------ 下载与传输 -->
      <el-divider content-position="left">下载与传输</el-divider>

      <el-form label-width="120px" class="settings-form" @submit.prevent>
        <el-form-item label="默认下载目录">
          <div class="field-row">
            <el-input
              v-model="form.downloadDir"
              class="grow"
              placeholder="留空则使用系统下载目录"
              clearable
              data-test="settings-download-dir"
            />
            <el-button :icon="FolderOpened" @click="pickDownloadDir">选择…</el-button>
          </div>
          <div class="hint">
            留空 → <span class="mono">{{ effectiveDownloadDir }}</span>
          </div>
        </el-form-item>

        <el-form-item label="传输并发数">
          <el-input-number
            v-model="form.transferConcurrency"
            :min="TRANSFER_CONCURRENCY_MIN"
            :max="TRANSFER_CONCURRENCY_MAX"
            data-test="settings-concurrency"
          />
          <span class="hint inline">
            同一连接内同时传输的文件数（{{ TRANSFER_CONCURRENCY_MIN }}~{{
              TRANSFER_CONCURRENCY_MAX
            }}，默认 {{ DEFAULT_TRANSFER_CONCURRENCY }}）。调大通常更快，
            但弱网或小内存服务器上容易触发断连重试。
          </span>
        </el-form-item>
      </el-form>

      <!-- ------------------------------------------------ 往期版本 -->
      <el-divider content-position="left">往期版本</el-divider>

      <el-form label-width="120px" class="settings-form" @submit.prevent>
        <el-form-item :label="SETTING_LABELS.defaultRetainPolicy">
          <!--
            选项值是**字符串**（不是对象）：`el-option` 的对象值靠引用比较，
            每次渲染都会新建字面量，于是模型永远匹配不上选项（下拉看着是空的）。
          -->
          <el-select
            v-model="form.retainMode"
            class="retain-mode"
            data-test="settings-default-retain-mode"
          >
            <el-option label="不自动清理（保留全部）" value="none" />
            <el-option label="保留最近 N 个版本" value="count" />
            <el-option label="保留最近 N 天" value="days" />
          </el-select>
          <el-input-number
            v-if="form.retainMode !== 'none'"
            v-model="form.retainValue"
            :min="1"
            :max="9999"
            class="retain-value"
            data-test="settings-default-retain-value"
          />
          <span v-if="form.retainMode !== 'none'" class="hint inline">
            {{ form.retainMode === 'count' ? '个版本（默认 20）' : '天' }}
          </span>
        </el-form-item>
        <div class="hint indent">
          只影响<strong>之后新建</strong>的目标；已有目标各自的策略在目标配置里改。
        </div>
      </el-form>

      <!-- ------------------------------------------------ 脚本执行（B20） -->
      <el-divider content-position="left">脚本执行</el-divider>

      <el-form label-width="120px" class="settings-form" @submit.prevent>
        <el-form-item :label="SETTING_LABELS.allowUserScripts">
          <!--
            开关由 `before-change` 拦一道危险确认 —— 打开它是全应用里权限最大的一步
            （从此可以在这台电脑上、以及已连接的服务器上跑任意命令）。
          -->
          <el-switch
            v-model="form.allowUserScripts"
            :before-change="beforeToggleUserScripts"
            data-test="settings-allow-user-scripts"
          />
          <span class="hint inline">
            <strong style="color: red">注意：本工具不会检查你的脚本，请确认脚本无误。</strong>
          </span>
        </el-form-item>

        <el-form-item :label="SETTING_LABELS.gitBashPath">
          <div class="field-row">
            <el-input
              v-model="form.gitBashPath"
              class="grow"
              placeholder="留空则自动探测（通常在 Git 安装目录的 bin/bash.exe）"
              clearable
              data-test="settings-git-bash-path"
            />
            <el-button :icon="FolderOpened" @click="pickGitBash">选择…</el-button>
          </div>
        </el-form-item>
      </el-form>

      <!-- ------------------------------------------------ 诊断 -->
      <el-divider content-position="left">诊断与兼容</el-divider>

      <el-form label-width="120px" class="settings-form" @submit.prevent>
        <el-form-item label="算法兼容模式">
          <el-switch v-model="form.hashCompatMode" data-test="settings-compat-mode" />
          <span class="hint inline">
            开启时，服务器上没有 <span class="mono">sha256sum</span> /
            <span class="mono">shasum</span> 会降级为流式计算（结果正确但大目录很慢）。
            关闭则直接报错中止，不静默换链路。
          </span>
        </el-form-item>

        <el-form-item :label="SETTING_LABELS.logLevel">
          <div class="field-row">
            <el-select
              v-model="logLevelSelect"
              class="retain-mode"
              data-test="settings-log-level"
            >
              <el-option label="跟随默认（开发 debug / 生产 info）" :value="LOG_LEVEL_DEFAULT" />
              <el-option
                v-for="lv in LOG_LEVELS"
                :key="lv"
                :label="`${lv} —— ${LOG_LEVEL_LABELS[lv]}`"
                :value="lv"
              />
            </el-select>
            <el-button :icon="Refresh" :loading="applyingLevel" @click="applyLogLevel">
              立即应用
            </el-button>
          </div>
        </el-form-item>
      </el-form>

      <div class="actions">
        <el-button
          type="primary"
          :icon="Check"
          :loading="saving"
          :disabled="!dirty"
          data-test="settings-save"
          @click="save"
        >
          {{ dirty ? `保存（${dirtyFields.length} 项有改动）` : '保存' }}
        </el-button>
        <el-button :icon="Brush" @click="resetToDefaults">恢复默认值</el-button>
        <span v-if="dirty" class="hint inline" data-test="settings-dirty">
          待生效：{{ dirtyFields.join('、') }}
        </span>
      </div>

      <!-- ------------------------------------------------ 快捷键 -->
      <el-divider content-position="left">快捷键</el-divider>
      <el-table :data="shortcutRows" size="small" data-test="shortcuts-table">
        <el-table-column label="功能" min-width="140">
          <template #default="{ row }">{{ row.label }}</template>
        </el-table-column>
        <el-table-column label="快捷键" width="150">
          <template #default="{ row }">
            <el-tag size="small" class="mono">{{ formatAccelerator(row.accelerator, isMac) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="说明">
          <template #default="{ row }">{{ row.description }}</template>
        </el-table-column>
      </el-table>

      <!-- ------------------------------------------------ 关于 -->
      <!--
        B18：原来的 el-descriptions 表格（版本 / Electron / Chromium / Node / 平台 /
        运行模式）整块去掉，只留「数据目录」与「日志目录」两行。
        版本信息没有消失 —— 菜单「关于 SFVM」里仍然给全，排障时到那里看。
      -->
      <el-divider content-position="left">关于</el-divider>

      <el-form v-if="dataLocation" label-width="120px" class="settings-form" @submit.prevent>
        <el-form-item label="数据目录">
          <div class="field-row">
            <el-input
              v-model="dataDirDraft"
              class="grow"
              placeholder="留空则使用默认目录"
              clearable
              data-test="about-data-dir"
            />
            <el-button :icon="FolderOpened" data-test="about-pick-data-dir" @click="pickDataDir">
              选择…
            </el-button>
            <el-button
              type="primary"
              :loading="applyingDataDir"
              :disabled="!dataDirDirty"
              data-test="about-apply-data-dir"
              @click="applyDataDir"
            >
              应用
            </el-button>
            <el-button
              :icon="FolderOpened"
              :disabled="!effectiveDataDir"
              data-test="about-open-data"
              @click="openDir(effectiveDataDir, '数据目录')"
            >
              打开
            </el-button>
          </div>

          <div class="hint" data-test="about-data-dir-hint">
            留空 = 默认目录 <span class="mono">{{ dataLocation.defaultDir }}</span>。
            <template v-if="dataLocation.restartRequired">
              <br />
              <span class="pending" data-test="about-data-dir-pending">
                已保存，重启后切到 <span class="mono">{{ dataLocation.configuredDir }}</span>
              </span>
            </template>
            <template v-if="!dataLocation.available">
              <br />
              <span class="bad" data-test="about-data-dir-unavailable">{{ dataLocation.reason }}</span>
            </template>
            <template v-if="dataLocation.pendingCleanup.length">
              <br />
              <span class="pending" data-test="about-data-dir-cleanup">
                重启后会清理：<span class="mono">{{ dataLocation.pendingCleanup.join('、') }}</span>
              </span>
            </template>
          </div>

          <div class="hint">
            更改目录会把台账复制到新目录，并删除原目录。
            <strong>重启后生效</strong>。
          </div>

          <el-alert
            v-if="dataDirNotice"
            class="dir-notice"
            :type="dataDirNotice.type"
            :closable="false"
            show-icon
            :title="dataDirNotice.text"
            data-test="about-data-dir-notice"
          >
            <ul v-if="dataDirNotice.warnings.length" class="warn-list">
              <li v-for="(w, i) in dataDirNotice.warnings" :key="i">{{ w }}</li>
            </ul>
          </el-alert>
        </el-form-item>

        <el-form-item label="日志目录">
          <div class="field-row">
            <span class="mono grow" data-test="about-log-dir">{{ logDir || '(未知)' }}</span>
            <el-button
              :icon="FolderOpened"
              :disabled="!logDir"
              data-test="about-open-logs"
              @click="openDir(logDir, '日志目录')"
            >
              打开
            </el-button>
          </div>
        </el-form-item>
      </el-form>

      <!-- 读不到状态时不能静默：否则用户会以为"设置页就是没有关于这一块" -->
      <el-alert
        v-else
        type="error"
        :closable="false"
        show-icon
        title="数据目录信息读取失败，请查看主进程日志"
        data-test="about-data-error"
      />

      <!-- ------------------------------------------------ 配置导入导出 -->
      <el-divider content-position="left">配置导入 / 导出</el-divider>

      <el-alert type="info" :closable="false" show-icon class="io-note">
        <template #title>
          导出内容包含连接（不含密码与私钥口令）、环境、目标与设置。
          <strong>密码类凭据永远不会被导出</strong>，导入后需要重新填写。
        </template>
      </el-alert>

      <div class="io-block">
        <div class="io-head">
          <strong>导出</strong>
          <div class="io-actions">
            <el-button
              size="small"
              :icon="DocumentAdd"
              :loading="exporting"
              data-test="config-export"
              @click="doExport"
            >
              生成内容
            </el-button>
            <el-button
              size="small"
              :icon="CopyDocument"
              :disabled="!exportText"
              :loading="copying"
              data-test="config-copy"
              @click="copyExport"
            >
              复制
            </el-button>
            <el-button
              size="small"
              type="primary"
              :icon="Monitor"
              :loading="exporting"
              data-test="config-export-file"
              @click="exportToFile"
            >
              导出到文件…
            </el-button>
          </div>
        </div>
        <el-input
          v-model="exportText"
          type="textarea"
          :rows="6"
          readonly
          class="mono-area"
          data-test="config-export-text"
          placeholder="点「生成内容」后在这里显示（也可直接全选复制）"
        />
        <div v-if="exportText" class="hint">
          {{ exportName }} · {{ exportSizeText }} ·
          <span data-test="config-export-secret-free">已确认不含任何密码 / 口令</span>
        </div>
      </div>

      <div class="io-block">
        <div class="io-head">
          <strong>导入</strong>
          <div class="io-actions">
            <el-button
              size="small"
              :icon="Upload"
              :loading="importing"
              :disabled="!importText.trim()"
              data-test="config-import"
              @click="doImport(false)"
            >
              从下方内容导入
            </el-button>
            <el-button
              size="small"
              type="primary"
              :icon="FolderOpened"
              :loading="importing"
              data-test="config-import-file"
              @click="doImport(true)"
            >
              从文件导入…
            </el-button>
          </div>
        </div>
        <el-input
          v-model="importText"
          type="textarea"
          :rows="6"
          class="mono-area"
          data-test="config-import-text"
          placeholder="把导出文件的内容粘贴到这里"
        />
        <!--
          判重规则要说准：原来这里笼统写"按名称去重"，而目标的判重用的是
          「环境 + 远端路径」（与新建目标时的唯一性规则一致）—— 写错会让用户
          在导入后多出一条同路径目标，而且他还以为"重复的应该被跳过了"。
        -->
        <div class="hint">
          判重规则：连接与环境按<strong>名称</strong>，目标按<strong>环境 + 远端路径</strong>。
          命中的一律跳过（<strong>不会覆盖</strong>已有配置，也不会改动本机目标）。
        </div>

        <el-alert
          v-if="importError"
          type="error"
          :title="importError"
          :closable="false"
          show-icon
        />
        <div v-if="importResult" class="import-result" data-test="config-import-result">
          <div>
            连接 +{{ importResult.connections.created }} / 跳过
            {{ importResult.connections.skipped }}；环境 +{{ importResult.environments.created }} /
            跳过 {{ importResult.environments.skipped }}；目标 +{{ importResult.targets.created }} /
            跳过 {{ importResult.targets.skipped }}；设置
            {{ importResult.settingsApplied ? '已应用' : '未改动' }}
          </div>
          <ul v-if="importResult.warnings.length" class="warn-list">
            <li v-for="(w, i) in importResult.warnings" :key="i">{{ w }}</li>
          </ul>
        </div>
      </div>

    </template>
  </section>
</template>

<style scoped>
.settings {
  max-width: 880px;
}
.settings-form {
  margin-top: 4px;
}
.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.grow {
  flex: 1;
  min-width: 0;
}
.hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.7;
  margin-top: 2px;
}
.hint.inline {
  display: inline-block;
  margin-left: 10px;
  max-width: 480px;
  vertical-align: middle;
}
.hint.indent {
  padding-left: 120px;
}
.retain-mode {
  width: 240px;
}
.retain-value {
  margin-left: 8px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0 4px;
}
.issue-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
}
.io-note {
  margin-bottom: 10px;
}
.io-block {
  margin-bottom: 14px;
}
.io-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.io-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.mono-area :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.import-result {
  margin-top: 8px;
  font-size: 12px;
  color: #303133;
  background: #f5f7fa;
  border-radius: 4px;
  padding: 8px 10px;
}
.warn-list {
  margin: 6px 0 0;
  padding-left: 18px;
  color: #b88230;
  line-height: 1.7;
}
/* 数据目录的提示条：它嵌在表单项里，要自己撑满一行 */
.dir-notice {
  width: 100%;
  margin-top: 8px;
}
/* 「已保存，重启后生效」—— 这句最容易被忽略，给个提醒色 */
.pending {
  color: #b88230;
}
.bad {
  color: #f56c6c;
}
</style>
