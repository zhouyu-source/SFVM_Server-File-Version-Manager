<script setup lang="ts">
/**
 * 新建 / 编辑目标向导（T06.4）。
 *
 * 交互设计（方案书 §9.2「新建目标向导」）：
 * - 左侧填路径，**右侧实时显示体检清单**（路径存在 / 可写 / 归档目录 / 哈希能力）
 * - 归档目录随远程路径实时推导（纯计算，不连服务器），用户可覆盖
 * - 「体检」按钮做真实只读探测；有 error 级问题时不允许保存
 * - 路径不存在的目录型目标，询问「现在创建空目录 / 仅登记待首次发布」
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { FirstAidKit } from '@element-plus/icons-vue'
import { useWorkspaceStore } from '../stores/workspace'
import { IpcBusinessError } from '../api'
import type {
  TargetView,
  TargetKind,
  HealthReport,
  HealthCheck,
  RetainPolicy
} from '../../../shared/contracts/workspace'

const props = defineProps<{
  modelValue: boolean
  environmentId: string
  editing: TargetView | null
}>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [] }>()

const ws = useWorkspaceStore()

const formRef = ref<FormInstance>()
const saving = ref(false)
const checking = ref(false)
const report = ref<HealthReport | null>(null)
/** 归档目录推导结果（实时，不连服务器） */
const derivedArchiveDir = ref('')
/** 用户是否选择了"现在创建空目录" */
const createMissingDir = ref(false)

const form = reactive<{
  name: string
  remotePath: string
  kind: TargetKind
  archiveDirOverride: string
  useCustomArchiveDir: boolean
  localPath: string
  localExcludeText: string
  verifyRemote: boolean
  deployStrategy: 'rename' | 'copy'
  autoConnect: boolean
  retainMode: 'none' | 'count' | 'days'
  retainValue: number
}>({
  name: '',
  remotePath: '',
  kind: 'dir',
  archiveDirOverride: '',
  useCustomArchiveDir: false,
  localPath: '',
  localExcludeText: '',
  verifyRemote: true,
  deployStrategy: 'rename',
  autoConnect: false,
  retainMode: 'none',
  retainValue: 10
})

const isEditing = computed(() => props.editing !== null)

const rules: FormRules = {
  name: [{ required: true, message: '请输入目标名称', trigger: 'blur' }],
  remotePath: [{ required: true, message: '请填写服务器上的绝对路径', trigger: 'blur' }]
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    report.value = null
    createMissingDir.value = false

    const t = props.editing
    if (t) {
      form.name = t.name
      form.remotePath = t.remotePath
      form.kind = t.kind
      form.useCustomArchiveDir = t.archiveDirOverridden
      form.archiveDirOverride = t.archiveDirOverridden ? t.archiveDir : ''
      form.localPath = t.localPath ?? ''
      form.localExcludeText = t.localExclude.join('\n')
      form.verifyRemote = t.verifyRemote
      form.deployStrategy = t.deployStrategy
      form.autoConnect = t.autoConnect
      form.retainMode = t.retainPolicy?.mode ?? 'none'
      form.retainValue = t.retainPolicy?.value ?? 10
    } else {
      form.name = ''
      form.remotePath = ''
      form.kind = 'dir'
      form.useCustomArchiveDir = false
      form.archiveDirOverride = ''
      form.localPath = ''
      form.localExcludeText = '*.map\n*.log'
      form.verifyRemote = true
      form.deployStrategy = 'rename'
      form.autoConnect = false
      form.retainMode = 'none'
      form.retainValue = 10
    }
    void refreshDerivedArchiveDir()
  }
)

/** 远程路径变化时实时推导归档目录（纯计算） */
watch(
  () => form.remotePath,
  () => void refreshDerivedArchiveDir()
)

async function refreshDerivedArchiveDir(): Promise<void> {
  const p = form.remotePath.trim()
  if (!p || !p.startsWith('/')) {
    derivedArchiveDir.value = ''
    return
  }
  try {
    derivedArchiveDir.value = await ws.previewArchiveDir(
      p,
      form.useCustomArchiveDir ? form.archiveDirOverride : null
    )
  } catch {
    derivedArchiveDir.value = ''
  }
}

watch(
  () => [form.useCustomArchiveDir, form.archiveDirOverride],
  () => void refreshDerivedArchiveDir()
)

/** 按 `.jar` 推断类型（用户可改） */
function onPathBlur(): void {
  const p = form.remotePath.trim().toLowerCase()
  if (p && !isEditing.value) {
    form.kind = p.endsWith('.jar') ? 'file' : 'dir'
  }
}

function buildInput(): Parameters<typeof ws.createTarget>[0] {
  const exclude = form.localExcludeText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  const retainPolicy: RetainPolicy | null =
    form.retainMode === 'none'
      ? null
      : { mode: form.retainMode, value: Math.max(1, form.retainValue) }

  return {
    environmentId: props.environmentId,
    name: form.name.trim(),
    remotePath: form.remotePath.trim(),
    kind: form.kind,
    archiveDir: form.useCustomArchiveDir ? form.archiveDirOverride.trim() || null : null,
    localPath: form.localPath.trim() || null,
    localExclude: exclude,
    verifyRemote: form.verifyRemote,
    retainPolicy,
    deployStrategy: form.deployStrategy,
    autoConnect: form.autoConnect,
    createMissingDir: createMissingDir.value
  }
}

/** 体检（对真实服务器做一次只读探测）。草稿目标也能查，无需先保存。 */
async function runCheck(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return

  checking.value = true
  report.value = null
  try {
    report.value =
      isEditing.value && props.editing
        ? await ws.healthCheck({ id: props.editing.id })
        : await ws.healthCheck({ input: buildInput() })
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    checking.value = false
  }
}

async function save(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return

  saving.value = true
  try {
    if (isEditing.value && props.editing) {
      await ws.updateTarget(props.editing.id, buildInput())
      ElMessage.success('目标已更新')
    } else {
      const result = await ws.createTarget(buildInput())
      report.value = result.healthCheck
      ElMessage.success('目标已创建')
    }
    emit('saved')
    emit('update:modelValue', false)
  } catch (e) {
    const err = e as IpcBusinessError
    // 体检不通过时后端把报告放在 detail 里，取出展示在右侧清单
    const d = err.detail as { report?: HealthReport } | undefined
    if (d?.report) report.value = d.report
    ElMessage.error(err.toUserText())
  } finally {
    saving.value = false
  }
}

function checkIcon(level: HealthCheck['level']): string {
  return level === 'ok' ? '✓' : level === 'warn' ? '!' : '✕'
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    :title="isEditing ? '编辑目标' : '新建目标'"
    size="880px"
    @update:model-value="emit('update:modelValue', false)"
  >
    <div class="layout">
      <!-- 左：表单 -->
      <div class="form-col">
        <el-form ref="formRef" :model="form" :rules="rules" label-width="96px" data-test="target-form">
          <el-form-item label="名称" prop="name">
            <el-input v-model="form.name" placeholder="如：订单服务" data-test="target-name" />
          </el-form-item>

          <el-form-item label="远端路径" prop="remotePath">
            <el-input
              v-model="form.remotePath"
              placeholder="/opt/app/dist 或 /opt/svc/order.jar"
              data-test="target-remote-path"
              @blur="onPathBlur"
            />
            <div class="hint">必须是绝对路径；不能包含 .. 或换行</div>
          </el-form-item>

          <el-form-item label="类型">
            <el-radio-group v-model="form.kind" data-test="target-kind">
              <el-radio-button value="dir" data-test="target-kind-dir"
                >目录</el-radio-button
              >
              <el-radio-button value="file" data-test="target-kind-file"
                >单文件</el-radio-button
              >
            </el-radio-group>
          </el-form-item>

          <el-form-item label="归档目录">
            <el-checkbox v-model="form.useCustomArchiveDir" data-test="target-custom-archive"
              >自定义</el-checkbox
            >
            <el-input
              v-if="form.useCustomArchiveDir"
              v-model="form.archiveDirOverride"
              placeholder="/data/versions/xxx"
              class="mt"
            />
            <div v-else class="hint">
              自动推导为：<code>{{ derivedArchiveDir || '（填写远端路径后显示）' }}</code>
            </div>
            <div class="hint">必须与目标在**同一父目录**，换版才能用 rename 原子完成</div>
          </el-form-item>

          <el-form-item label="本地产物">
            <el-input
              v-model="form.localPath"
              placeholder="D:\\build\\dist（可留空，稍后配置）"
              data-test="target-local-path"
            />
          </el-form-item>

          <el-form-item label="排除规则">
            <el-input
              v-model="form.localExcludeText"
              type="textarea"
              :rows="3"
              placeholder="每行一条，如 *.map"
              data-test="target-exclude"
            />
            <div class="hint">上传时按此过滤本地文件</div>
          </el-form-item>

          <el-form-item label="发布后校验">
            <el-switch v-model="form.verifyRemote" data-test="target-verify" />
            <span class="hint" style="margin-left: 8px">
              上传后逐文件比对哈希（生产建议开启）
            </span>
          </el-form-item>

          <el-form-item label="换版策略">
            <el-radio-group v-model="form.deployStrategy" data-test="target-strategy">
              <el-radio-button value="rename" data-test="target-strategy-rename"
                >rename（原子，推荐）</el-radio-button
              >
              <el-radio-button value="copy" data-test="target-strategy-copy"
                >copy（跨文件系统时用）</el-radio-button
              >
            </el-radio-group>
          </el-form-item>

          <el-form-item label="保留策略">
            <el-radio-group v-model="form.retainMode" data-test="target-retain">
              <el-radio-button value="none" data-test="target-retain-none"
                >不自动清理</el-radio-button
              >
              <el-radio-button value="count" data-test="target-retain-count"
                >按份数</el-radio-button
              >
              <el-radio-button value="days" data-test="target-retain-days"
                >按天数</el-radio-button
              >
            </el-radio-group>
            <el-input-number
              v-if="form.retainMode !== 'none'"
              v-model="form.retainValue"
              :min="1"
              :max="999"
              class="mt"
            />
          </el-form-item>

          <el-form-item label="自动登录">
            <el-switch v-model="form.autoConnect" data-test="target-auto-connect" />
          </el-form-item>
        </el-form>
      </div>

      <!-- 右：实时体检清单（方案书 §9.2） -->
      <div class="check-col">
        <h4>路径体检</h4>

        <!-- 未体检时展示可即时推导的信息 -->
        <template v-if="!report">
          <ul class="pre">
            <li>
              <span class="ico ok">✓</span>远端路径格式
              <span class="val">{{ form.remotePath || '（未填写）' }}</span>
            </li>
            <li>
              <span class="ico ok">✓</span>归档目录（推导）
              <span class="val">{{ derivedArchiveDir || '（未填写）' }}</span>
            </li>
          </ul>
          <p class="sub">
            点击「体检」可对真实服务器做一次**只读探测**：
            路径是否存在、父目录是否可写、远端哈希能力。
          </p>
          <el-button
            :icon="FirstAidKit"
            :loading="checking"
            data-test="target-check-btn"
            @click="runCheck"
          >
            体检
          </el-button>
        </template>

        <!-- 体检结果 -->
        <template v-else>
          <ul class="checks">
            <li v-for="c in report.checks" :key="c.key" :class="c.level">
              <span class="ico" :class="c.level">{{ checkIcon(c.level) }}</span>
              <div class="body">
                <div class="label">{{ c.label }}</div>
                <div class="detail">{{ c.detail }}</div>
                <div v-if="c.suggestion" class="suggest">{{ c.suggestion }}</div>

                <!-- 目录不存在且用户选择"创建"时的询问（方案书 §11） -->
                <div v-if="c.key === 'path' && c.data?.canCreate === true" class="ask">
                  <el-checkbox v-model="createMissingDir"> 现在创建空目录 </el-checkbox>
                  <span class="sub"> （不勾选则仅登记该目标，等待首次发布时创建） </span>
                </div>
              </div>
            </li>
          </ul>

          <el-alert
            v-if="!report.ok"
            type="error"
            show-icon
            :closable="false"
            title="体检未通过，请先处理标红的问题再保存"
          />
          <el-button class="mt" :loading="checking" data-test="target-recheck-btn" @click="runCheck"
            >重新体检</el-button
          >
        </template>
      </div>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" data-test="target-save-btn" @click="save"
        >保存</el-button
      >
    </template>
  </el-drawer>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 20px;
  min-height: 0;
}
.form-col {
  min-width: 0;
}
.check-col {
  border-left: 1px solid #ebeef5;
  padding-left: 16px;
}
.check-col h4 {
  margin: 0 0 12px;
  font-size: 13px;
  color: #606266;
}
.hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
.hint code {
  background: #f5f7fa;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: Consolas, Monaco, monospace;
}
.mt {
  margin-top: 8px;
}
.sub {
  font-size: 12px;
  color: #909399;
  line-height: 1.7;
}

.pre,
.checks {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}
.pre li,
.checks li {
  display: flex;
  gap: 6px;
  font-size: 12px;
  line-height: 1.7;
  padding: 6px 0;
}
.checks li {
  border-bottom: 1px dashed #f0f2f5;
  align-items: flex-start;
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
.val {
  color: #303133;
  word-break: break-all;
}
.body {
  flex: 1;
  min-width: 0;
}
.label {
  color: #303133;
  font-weight: 600;
}
.detail {
  color: #606266;
  word-break: break-all;
}
.suggest {
  color: #e6a23c;
  margin-top: 2px;
}
.ask {
  margin-top: 6px;
}
</style>
