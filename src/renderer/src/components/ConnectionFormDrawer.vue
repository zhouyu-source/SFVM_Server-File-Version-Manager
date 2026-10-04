<script setup lang="ts">
/**
 * 连接表单抽屉（T04.3 + T04.4 + T04.5）。
 *
 * 覆盖：
 * - 名称 / 主机 / 端口 / 用户名 / 认证方式切换（T04.3）
 * - 认证方式分支：密码（"已保存"态 + 更换）/ 私钥文件选择 + 口令（T04.4）
 * - 连接测试：按钮 loading + 耗时 + 失败原因（T04.5）
 *
 * `secret` 的三态语义（与后端一致，这里是最容易出错的地方）：
 * - 编辑时不动密码框 → 提交不带 secret → 保持原值
 * - 点"更换密码"后填新值 → 带 secret → 覆盖
 * - 点"清除已保存密码" → 带空串 → 清空
 */
import { computed, reactive, ref, watch } from 'vue'
import { Check, Close, FolderOpened, Odometer } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { IpcBusinessError } from '../api'
import { useConnectionStore } from '../stores/connection'
import type {
  ConnectionInput,
  ConnectionView,
  TestResult
} from '../../../shared/contracts/connection'

const props = defineProps<{ modelValue: boolean; editing: ConnectionView | null }>()
const emit = defineEmits<{
  'update:modelValue': [boolean]
  /** 测试成功且需要用户确认新指纹时，交给父组件弹确认框 */
  needTrust: [{ connectionId: string; keyType: string; fingerprint: string }]
  saved: []
}>()

const store = useConnectionStore()

const formRef = ref<FormInstance>()
const testing = ref(false)
const saving = ref(false)
const testResult = ref<TestResult | null>(null)
const testError = ref('')

/** 是否处于"更换密码"状态；编辑且已有保存的密码时默认 false（显示"已保存"） */
const replacingSecret = ref(false)

const form = reactive<{
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  secret: string
  privateKeyPath: string
  autoConnect: boolean
  remark: string
}>({
  name: '',
  host: '',
  port: 22,
  username: '',
  authType: 'privateKey',
  secret: '',
  privateKeyPath: '',
  autoConnect: false,
  remark: ''
})

const isEditing = computed(() => props.editing !== null)
const hasSavedSecret = computed(() => props.editing?.hasSecret === true)
/** 本机无法安全保存密码时，UI 必须禁用"保存密码"并说明原因（T03.2 / T04.4） */
const canSaveSecret = computed(() => store.credential.available)

const rules: FormRules = {
  name: [{ required: true, message: '请输入连接名称', trigger: 'blur' }],
  host: [{ required: true, message: '请输入主机地址', trigger: 'blur' }],
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  port: [
    {
      required: true,
      type: 'number',
      min: 1,
      max: 65535,
      message: '端口范围 1-65535',
      trigger: 'blur'
    }
  ]
}

/** 打开抽屉时按当前编辑对象重置表单 */
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    testResult.value = null
    testError.value = ''
    replacingSecret.value = false

    const e = props.editing
    if (e) {
      form.name = e.name
      form.host = e.host
      form.port = e.port
      form.username = e.username
      form.authType = e.authType
      form.secret = ''
      form.privateKeyPath = e.privateKeyPath ?? ''
      form.autoConnect = e.autoConnect
      form.remark = e.remark ?? ''
    } else {
      form.name = ''
      form.host = ''
      form.port = 22
      form.username = ''
      form.authType = 'privateKey'
      form.secret = ''
      form.privateKeyPath = ''
      form.autoConnect = false
      form.remark = ''
    }
  }
)

/**
 * 组装提交给主进程的入参。
 * 关键：secret 只在"确实要改"时才带上，否则不传（保持原值）。
 */
function buildInput(): ConnectionInput {
  const input: ConnectionInput = {
    name: form.name.trim(),
    host: form.host.trim(),
    port: form.port,
    username: form.username.trim(),
    authType: form.authType,
    autoConnect: form.autoConnect,
    remark: form.remark.trim() || undefined
  }

  if (form.authType === 'privateKey') {
    input.privateKeyPath = form.privateKeyPath.trim() || null
    // 口令：仅当用户填了才作为 secret 提交
    if (form.secret) input.secret = form.secret
  } else if (form.authType === 'password') {
    input.privateKeyPath = null
    if (replacingSecret.value && form.secret) {
      input.secret = form.secret
    } else if (!isEditing.value && form.secret) {
      input.secret = form.secret
    }
    // 编辑且未点"更换" → 不传 secret → 保持原值
  }

  return input
}

async function chooseKeyFile(): Promise<void> {
  // 防御：preload 与主进程不参与 HMR，改了必须重启 dev 才会生效。
  // 若运行中的实例是改造前启动的，这里会拿到 undefined —— 明确告知用户，
  // 而不是抛一个只有一闪而过 toast 的 TypeError。
  const bridge = window.sfvm?.app as typeof window.sfvm.app | undefined
  if (typeof bridge?.pickPrivateKey !== 'function') {
    ElMessageBox.alert(
      '当前运行的应用实例还没有"文件选择"能力。\n\n' +
        'preload 与主进程的代码不会热更新：如果你是修改后没有重启开发服务，' +
        '请结束应用并重新执行 pnpm dev:nosandbox。\n\n' +
        '在此之前，可以直接在下方的输入框里填写私钥的完整路径。',
      '文件选择功能不可用',
      { type: 'warning', confirmButtonText: '知道了' }
    ).catch(() => undefined)
    return
  }

  try {
    // 注意：preload 层返回的是 IpcResult 信封 `{ok,data}`，**不是**裸值。
    // 曾把它当成已解包的 {path} 用，于是 picked 是 truthy 但 picked.path 恒为
    // undefined —— 表现为"文件能选，但选完输入框没反应"。
    const result = await bridge.pickPrivateKey()
    if (!result.ok) {
      ElMessage.error(result.hint ? `${result.message}｜${result.hint}` : result.message)
      return
    }
    if (result.data?.path) {
      form.privateKeyPath = result.data.path
    }
    // result.data === null 表示用户取消，静默即可
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

async function runTest(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return

  testing.value = true
  testResult.value = null
  testError.value = ''

  try {
    // 已保存的连接：优先用后端已有凭据测（避免要求用户重新输密码）
    const params =
      isEditing.value && props.editing && !replacingSecret.value && !form.secret
        ? { id: props.editing.id }
        : { input: buildInput() }

    const result = await store.test(params)
    testResult.value = result

    if (result.hostKeyStatus === 'mismatch') {
      testError.value =
        '主机密钥与上次记录不一致！这可能是服务器重装，也可能是中间人攻击，请确认后再继续。'
    } else if (result.hostKeyStatus === 'unknown' && isEditing.value && props.editing) {
      // 首次见到该指纹：交给父组件弹确认框（T04.6）
      emit('needTrust', {
        connectionId: props.editing.id,
        keyType: result.hostKeyType,
        fingerprint: result.hostKeyFingerprint
      })
    }
  } catch (e) {
    testError.value = (e as IpcBusinessError).toUserText()
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return

  if (!canSaveSecret.value && form.authType === 'password' && form.secret) {
    ElMessage.warning(store.credential.reason ?? '本机无法安全保存密码，请改为每次手动输入。')
    return
  }

  saving.value = true
  try {
    if (isEditing.value && props.editing) {
      await store.update(props.editing.id, buildInput())
      ElMessage.success('连接已更新')
    } else {
      await store.create(buildInput())
      ElMessage.success('连接已创建')
    }
    emit('saved')
    emit('update:modelValue', false)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    saving.value = false
  }
}

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    :title="isEditing ? '编辑连接' : '新建连接'"
    size="520px"
    @update:model-value="close"
  >
    <el-alert
      v-if="!canSaveSecret"
      type="warning"
      show-icon
      :closable="false"
      class="mb"
      :title="store.credential.reason || '本机无法安全保存密码'"
    />

    <el-form ref="formRef" :model="form" :rules="rules" label-width="96px" data-test="conn-form">
      <el-form-item label="名称" prop="name">
        <el-input v-model="form.name" placeholder="如：生产-主服务器" data-test="conn-name" />
      </el-form-item>

      <el-form-item label="主机" prop="host">
        <el-input v-model="form.host" placeholder="IP 或域名" data-test="conn-host" />
      </el-form-item>

      <el-form-item label="端口" prop="port">
        <el-input-number
          v-model="form.port"
          :min="1"
          :max="65535"
          controls-position="right"
          data-test="conn-port"
        />
      </el-form-item>

      <el-form-item label="用户名" prop="username">
        <el-input v-model="form.username" placeholder="如：root" data-test="conn-username" />
      </el-form-item>

      <el-form-item label="认证方式">
        <el-radio-group v-model="form.authType" data-test="conn-auth">
          <el-radio-button value="privateKey" data-test="conn-auth-privateKey"
            >SSH 私钥</el-radio-button
          >
          <el-radio-button value="password" data-test="conn-auth-password">账号密码</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <!-- 私钥分支（T04.4） -->
      <template v-if="form.authType === 'privateKey'">
        <el-form-item label="私钥文件">
          <div class="row">
            <el-input
              v-model="form.privateKeyPath"
              placeholder="选择私钥文件（只保存路径）"
              data-test="conn-key-path"
            />
            <el-button :icon="FolderOpened" @click="chooseKeyFile">浏览…</el-button>
          </div>
          <div class="hint">私钥内容不会被复制或上传，应用只记录文件路径。</div>
        </el-form-item>

        <el-form-item label="私钥口令">
          <el-input
            v-model="form.secret"
            type="password"
            show-password
            data-test="conn-secret"
            :placeholder="hasSavedSecret ? '已保存（留空表示不修改）' : '私钥未加密则留空'"
            :disabled="!canSaveSecret && !hasSavedSecret"
          />
        </el-form-item>
      </template>

      <!-- 密码分支（T04.4） -->
      <template v-else>
        <el-form-item label="密码">
          <template v-if="hasSavedSecret && !replacingSecret">
            <div class="row">
              <el-tag type="success" size="small">已保存</el-tag>
              <el-button link type="primary" @click="replacingSecret = true">更换密码</el-button>
              <el-button
                link
                type="danger"
                @click="
                  () => {
                    replacingSecret = true
                    form.secret = ''
                  }
                "
              >
                清除
              </el-button>
            </div>
            <div class="hint">密码已加密保存在本机，不会显示明文。</div>
          </template>
          <template v-else>
            <el-input
              v-model="form.secret"
              type="password"
              show-password
              :placeholder="canSaveSecret ? '登录密码' : '本机无法保存，仅本次会话有效'"
            />
            <div v-if="!canSaveSecret" class="hint warn">
              本机密钥链不可用，密码不会被保存，重启应用后需要重新输入。
            </div>
            <div v-if="isEditing && replacingSecret" class="hint">
              留空并保存表示清除已保存的密码。
            </div>
          </template>
        </el-form-item>
      </template>

      <el-form-item label="自动登录">
        <el-switch v-model="form.autoConnect" data-test="conn-auto-connect" />
        <span class="hint">开启后应用启动时会自动建立连接</span>
      </el-form-item>

      <el-form-item label="备注">
        <el-input v-model="form.remark" type="textarea" :rows="2" />
      </el-form-item>
    </el-form>

    <!-- 连接测试结果（T04.5） -->
    <el-alert
      v-if="testError"
      type="error"
      show-icon
      :closable="false"
      class="mb"
      data-test="conn-test-error"
    >
      <template #title>连接失败</template>
      <div class="pre">{{ testError }}</div>
    </el-alert>

    <el-alert
      v-else-if="testResult"
      :type="testResult.hostKeyStatus === 'mismatch' ? 'error' : 'success'"
      show-icon
      :closable="false"
      class="mb"
      data-test="conn-test-result"
      :title="`连接成功（耗时 ${testResult.latencyMs} ms）`"
    >
      <div class="kv">
        <b>平台</b>{{ testResult.capability.platform }} · 家目录 {{ testResult.capability.homeDir }}
      </div>
      <div class="kv">
        <b>远端哈希工具</b>
        <span v-if="testResult.capability.hasSha256sum">sha256sum ✅</span>
        <span v-else-if="testResult.capability.hasShasum">shasum ✅</span>
        <span v-else class="warn">无（发布校验将降级为流式计算，较慢）</span>
      </div>
      <div class="kv">
        <b>磁盘检查</b>{{ testResult.capability.hasDf ? 'df 可用 ✅' : 'df 不可用' }}
      </div>
      <div class="kv"><b>主机指纹</b>{{ testResult.hostKeyType }}</div>
      <div class="kv mono">{{ testResult.hostKeyFingerprint }}</div>
      <div class="kv">
        <b>指纹状态</b>
        <el-tag v-if="testResult.hostKeyStatus === 'match'" type="success" size="small"
          >与记录一致</el-tag
        >
        <el-tag v-else-if="testResult.hostKeyStatus === 'unknown'" type="warning" size="small"
          >首次连接，待确认</el-tag
        >
        <el-tag v-else type="danger" size="small">与记录不一致</el-tag>
      </div>
    </el-alert>

    <template #footer>
      <div class="footer">
        <el-button
          :icon="Odometer"
          :loading="testing"
          data-test="conn-test-btn"
          @click="runTest"
          >测试连接</el-button
        >
        <span class="spacer" />
        <el-button :icon="Close" @click="close">取消</el-button>
        <el-button
          type="primary"
          :icon="Check"
          :loading="saving"
          data-test="conn-save-btn"
          @click="save"
          >保存</el-button
        >
      </div>
    </template>
  </el-drawer>
</template>

<style scoped>
.mb {
  margin-bottom: 12px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
}
.hint {
  color: #909399;
  font-size: 12px;
  line-height: 1.5;
}
.hint.warn {
  color: #e6a23c;
}
.pre {
  white-space: pre-wrap;
  font-size: 12px;
}
.kv {
  font-size: 12px;
  line-height: 1.7;
}
.kv b {
  display: inline-block;
  min-width: 88px;
  color: #606266;
}
.mono {
  font-family: Consolas, Monaco, monospace;
  word-break: break-all;
  color: #303133;
}
.footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.spacer {
  flex: 1;
}
.warn {
  color: #e6a23c;
}
</style>
