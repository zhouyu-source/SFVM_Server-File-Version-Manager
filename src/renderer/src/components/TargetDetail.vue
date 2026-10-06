<script setup lang="ts">
/**
 * 目标详情页（T06.5 骨架 → B11 填入发布区）。
 *
 * 分区顺序就是用户的操作顺序：
 * 1. 状态卡片 —— 远端路径 / 归档目录 / 当前版本 / 最近发布 / 策略；
 * 2. **本地产物**（B11 / T11.1~T11.2 + T11.7）—— 先配好"要发什么"；
 * 3. **发布**（B11 / T11.3~T11.6）—— 确认 → 进度 → 失败详情 → 成功后刷新；
 * 4. **往期版本**（B12 / T12.1~T12.7）—— 表格 / 下载 / 删除 / 明细 / 保留策略；
 *    回滚属于 B13。这一块整体交给 `ArchiveSection`：它自己有四个会改远端状态的动作
 *    与两份要同步刷新的数据，"动作完成后刷什么"只有一处答案。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Edit, FirstAidKit } from '@element-plus/icons-vue'
import { api, IpcBusinessError } from '../api'
import { formatDateTime } from '../utils/format'
import { useWorkspaceStore } from '../stores/workspace'
import { useConnectionStore } from '../stores/connection'
import PublishPanel from './PublishPanel.vue'
import LocalArtifactCard from './LocalArtifactCard.vue'
import ArchiveSection from './ArchiveSection.vue'
import ScriptPanel from './ScriptPanel.vue'
import type { TargetView, HealthReport, HealthCheck } from '../../../shared/contracts/workspace'
import type { DeployCurrentVersion } from '../../../shared/contracts/deploy'

const props = defineProps<{ target: TargetView }>()
const emit = defineEmits<{ edit: [TargetView] }>()

const ws = useWorkspaceStore()
const conn = useConnectionStore()

const checking = ref(false)
const report = ref<HealthReport | null>(null)

/** 往期版本区块（B12）：发布成功后由它自己重载列表与汇总 */
const archiveRef = ref<InstanceType<typeof ArchiveSection> | null>(null)
/** 当前线上版本（= 最近一次成功操作，发布或回滚都算）；拿不到为 null */
const currentVersion = ref<DeployCurrentVersion | null>(null)
const currentVersionTag = computed(() => currentVersion.value?.versionTag ?? null)
/**
 * 「当前版本是不是回滚来的」。
 *
 * `action` 本来就是 `deploy.currentVersion` 的返回值之一（`'deploy' | 'rollback'`），
 * 只是这里原先只取了 `versionTag` 把它丢了。之后只要有一次新的**发布**成功，
 * `action` 就变回 `'deploy'`，标记自动消失 —— 不需要任何额外的清理逻辑。
 */
const isCurrentRollback = computed(() => currentVersion.value?.action === 'rollback')
const rollbackTip = computed(() => {
  const at = currentVersion.value?.at
  const when = at ? `（${formatDateTime(at)}）` : ''
  return `当前线上版本由回滚恢复${when} —— 它的内容来自版本库中的往期版本，不是本地发布`
})

const env = computed(() => ws.environments.find((e) => e.id === props.target.environmentId))
const offline = computed(() =>
  env.value ? conn.statusOf(env.value.connectionId) !== 'online' : true
)
const isProd = computed(() => env.value?.envType === 'prod')

const lastDeployText = computed(() =>
  props.target.lastDeployAt ? formatDateTime(props.target.lastDeployAt) : '从未发布'
)

async function runCheck(): Promise<void> {
  checking.value = true
  report.value = null
  try {
    report.value = await ws.healthCheck({ id: props.target.id })
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    checking.value = false
  }
}

/**
 * 拿"当前线上版本号"。
 *
 * `deploy.currentVersion`：**纯台账**（最近一次成功操作 —— 发布或回滚都算），
 * 不连服务器、不读本地文件。
 *
 * ## 这里踩过两个坑，都记下来
 *
 * 1. 原来用 `deploy.preview().lastVersionTag`。`preview` 是**发布预览**，
 *    它第一件事就是要求目标配了本地产物路径（否则抛 `E_LOCAL_PATH_MISSING`），
 *    而且会**算一次全量本地指纹**。两个后果：没配本地产物路径的目标
 *    「当前版本」永远显示"未知"（明明台账里有记录）；每次切到目标页都白 hash
 *    一遍整个产物目录 —— 而这个数字与本地内容毫无关系。
 * 2. 更要命的是当时 `preview` 把 `lastVersionTag` 与"上一版清单是否存在"
 *    耦合在一起：**回滚不写逐文件清单**，于是回滚完这个号直接是 null，
 *    界面显示空，切走再切回来才刷新（用户实测报上来的就是这个）。
 *    现在两个问题都修了：`preview` 解耦、界面改走这个轻量通道。
 */
async function loadCurrentVersion(): Promise<void> {
  try {
    currentVersion.value = await api.deploy.currentVersion(props.target.id)
  } catch {
    // 读不出来时说明"未知"，但不要清掉上一次的值制造闪烁 ——
    // 这里的失败绝大多数是"目标被删了"，那时整个组件都要卸载
    currentVersion.value = null
  }
}

/**
 * T11.6：一次发布成功之后，把这一页上**所有会变的东西**刷新一遍。
 *
 * 四样缺一不可：目标（`lastDeployAt`）、本地产物（结论要重算）、
 * 往期版本（多了一条）、当前版本号（换成刚发的那一版）。
 * 少刷一个，用户就会看到"发布成功了，但那一块还是旧的" ——
 * 而这类"部分刷新"最难被发现，用户会以为数据本来就这样。
 */
async function onDeployed(payload: { jobId: string; versionTag: string | null }): Promise<void> {
  ElMessage.success(
    payload.versionTag ? `发布成功：已更新为 ${payload.versionTag}` : '发布成功'
  )
  await Promise.all([
    ws.refreshTargets(props.target.environmentId),
    ws.refreshArtifactInfo(props.target.id),
    // 往期版本区块自己重载（内部并行拉列表 + 汇总）
    Promise.resolve(archiveRef.value?.reload()),
    loadCurrentVersion()
  ])
}

watch(
  () => props.target.id,
  () => {
    report.value = null
    currentVersion.value = null
    void loadCurrentVersion()
  },
  { immediate: true }
)

function icon(level: HealthCheck['level']): string {
  return level === 'ok' ? '✓' : level === 'warn' ? '!' : '✕'
}
</script>

<template>
  <section class="detail">
    <header class="head">
      <div class="title">
        <h2>{{ target.name }}</h2>
        <el-tag v-if="isProd" type="danger" size="small" effect="dark">生产</el-tag>
        <el-tag size="small" type="info">{{ target.kind === 'dir' ? '目录' : '文件' }}</el-tag>
        <el-tag v-if="offline" size="small" type="warning">连接离线</el-tag>
      </div>
      <span class="spacer" />
      <el-button size="small" :icon="Edit" @click="emit('edit', target)">编辑</el-button>
      <el-button size="small" :icon="FirstAidKit" :loading="checking" @click="runCheck">
        体检
      </el-button>
    </header>

    <!-- 当前状态卡片 -->
    <el-descriptions :column="2" border size="small">
      <el-descriptions-item label="远端路径">
        <span class="mono">{{ target.remotePath }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="归档目录">
        <span class="mono">{{ target.archiveDir }}</span>
        <el-tag v-if="target.archiveDirOverridden" size="small" type="info" class="ml"
          >自定义</el-tag
        >
      </el-descriptions-item>
      <el-descriptions-item label="当前版本">
        <template v-if="currentVersionTag">
          <span class="mono" data-test="current-version">{{ currentVersionTag }}</span>
          <!--
            回滚提示（B19）：`data-test` 是 E2E 的契约，两个元素分开挂，
            这样"当前版本是什么"与"它是不是回滚来的"可以分别断言。
          -->
          <el-tooltip v-if="isCurrentRollback" :content="rollbackTip" placement="top">
            <el-tag
              size="small"
              type="warning"
              class="ml"
              data-test="current-version-rollback"
              >回滚</el-tag
            >
          </el-tooltip>
        </template>
        <span v-else class="muted">未知（还没发布过，或本地产物未配置）</span>
      </el-descriptions-item>
      <el-descriptions-item label="最近发布">
        <span data-test="last-deploy">{{ lastDeployText }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="发布后校验">
        {{ target.verifyRemote ? '开启' : '关闭' }}
      </el-descriptions-item>
      <el-descriptions-item label="换版策略">
        {{ target.deployStrategy === 'rename' ? 'rename（原子）' : 'copy' }}
      </el-descriptions-item>
      <el-descriptions-item label="保留策略">
        <template v-if="target.retainPolicy">
          按{{ target.retainPolicy.mode === 'count' ? '份数' : '天数' }}保留
          {{ target.retainPolicy.value }}
        </template>
        <span v-else class="muted">不自动清理</span>
      </el-descriptions-item>
      <el-descriptions-item label="排除规则">
        <template v-if="target.localExclude.length">
          <el-tag v-for="e in target.localExclude" :key="e" size="small" class="mr">{{ e }}</el-tag>
        </template>
        <span v-else class="muted">无</span>
      </el-descriptions-item>
    </el-descriptions>

    <!-- 体检结果（按需展示） -->
    <div v-if="report" class="report">
      <el-divider content-position="left">体检结果</el-divider>
      <ul class="checks">
        <li v-for="c in report.checks" :key="c.key">
          <span class="ico" :class="c.level">{{ icon(c.level) }}</span>
          <div>
            <div class="label">{{ c.label }}</div>
            <div class="detail-text">{{ c.detail }}</div>
            <div v-if="c.suggestion" class="suggest">{{ c.suggestion }}</div>
          </div>
        </li>
      </ul>
    </div>

    <!-- 本地产物（T11.1 / T11.2 / T11.7） -->
    <el-divider content-position="left">本地产物</el-divider>
    <LocalArtifactCard :target="target" @saved="ws.refreshTargets(target.environmentId)" />

    <!-- 发布（T11.3 ~ T11.6） -->
    <el-divider content-position="left">发布</el-divider>
    <PublishPanel
      :target="target"
      @deployed="onDeployed"
      @saved="ws.refreshTargets(target.environmentId)"
    />

    <!--
      脚本（B20）。
      挂在「发布」之后、与发布同级：用户提的场景就是"构筑 → 关服务 → 发布 → 启服务"，
      脚本与发布本来就该挨着看。B21 的流水线也落在这里。
    -->
    <el-divider content-position="left">脚本</el-divider>
    <ScriptPanel :target="target" />

    <!-- 往期版本（B12 / T12.1~T12.7；回滚在 B13） -->
    <el-divider content-position="left">往期版本</el-divider>
    <!--
      `changed` = 归档区改了"当前版本"（目前只有回滚会）。
      必须重新拉一次版本号：否则右上的「当前版本」会停在旧值上，
      要等切走再切回来才更新 —— 而回滚恰恰就是为了改它。
    -->
    <ArchiveSection
      ref="archiveRef"
      :target="target"
      @edit="emit('edit', target)"
      @changed="() => void loadCurrentVersion()"
    />
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title h2 {
  margin: 0;
  font-size: 18px;
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
.mr {
  margin-right: 4px;
}
.report {
  margin-top: 16px;
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
.ico {
  flex: 0 0 auto;
  width: 14px;
  text-align: center;
  font-weight: 700;
}
.ico.ok {
  color: #67c23a;
}
.ico.warn {
  color: #e6a23c;
}
.ico.error {
  color: #f56c6c;
}
.label {
  font-weight: 600;
  color: #303133;
}
.detail-text {
  color: #606266;
  word-break: break-all;
}
.suggest {
  color: #e6a23c;
}
</style>
