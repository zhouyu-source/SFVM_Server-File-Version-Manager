<script setup lang="ts">
/**
 * 主机指纹确认弹窗（T04.6）。
 *
 * TOFU 的用户交互点：首次连接某台服务器时必须让用户**核对指纹**后才落库，
 * 而不是默认信任。指纹不一致时这里只做告知与阻断，不提供"仍然信任"的便捷按钮
 * —— 那会让确认流于形式（方案书 §10.3）。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CircleCheck, Close } from '@element-plus/icons-vue'
import { useConnectionStore } from '../stores/connection'
import { IpcBusinessError } from '../api'
import { formatFingerprint } from '../../../shared/host-key'

const props = defineProps<{
  modelValue: boolean
  connectionId: string
  connectionName?: string
  keyType: string
  fingerprint: string
  /** 'unknown' 首次连接（可信任）；'mismatch' 与记录不符（只告知） */
  kind?: 'unknown' | 'mismatch'
  expected?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [boolean]; trusted: [] }>()

const store = useConnectionStore()
const saving = ref(false)
const acknowledged = ref(false)

const isMismatch = computed(() => props.kind === 'mismatch')
const shown = computed(() => formatFingerprint(props.fingerprint, props.keyType))

async function trust(): Promise<void> {
  saving.value = true
  try {
    await store.trustHostKey(props.connectionId, props.keyType, props.fingerprint)
    ElMessage.success('已信任该主机指纹')
    emit('trusted')
    emit('update:modelValue', false)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="isMismatch ? '主机密钥不一致！' : '确认服务器身份'"
    width="520px"
    :close-on-click-modal="false"
    data-test="hostkey-dialog"
    @update:model-value="emit('update:modelValue', false)"
  >
    <el-alert
      v-if="isMismatch"
      type="error"
      show-icon
      :closable="false"
      title="服务器返回的主机密钥与上次记录不一致"
    >
      这可能是服务器重装或更换了密钥，**也可能是中间人攻击**。
      请通过其他可信途径（云控制台、运维同事）核对指纹后再处理。
    </el-alert>
    <el-alert
      v-else
      type="warning"
      show-icon
      :closable="false"
      title="首次连接这台服务器，请核对指纹"
    >
      指纹由服务器公钥计算得出。请与服务器上
      <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> 的输出比对一致后再信任。
    </el-alert>

    <el-descriptions :column="1" border class="mt">
      <el-descriptions-item label="连接">
        {{ connectionName || connectionId }}
      </el-descriptions-item>
      <el-descriptions-item label="算法">{{ keyType }}</el-descriptions-item>
      <el-descriptions-item label="本次指纹">
        <span class="mono">{{ shown }}</span>
      </el-descriptions-item>
      <el-descriptions-item v-if="isMismatch && expected" label="此前记录">
        <span class="mono">{{ expected }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <template #footer>
      <template v-if="isMismatch">
        <el-checkbox v-model="acknowledged">我已通过可信途径核对，确认这是预期的变更</el-checkbox>
        <div class="mt">
          <el-button @click="emit('update:modelValue', false)">取消</el-button>
          <el-button type="danger" :disabled="!acknowledged" :loading="saving" @click="trust">
            仍要信任并覆盖记录
          </el-button>
        </div>
      </template>
      <template v-else>
        <el-button :icon="Close" @click="emit('update:modelValue', false)">暂不信任</el-button>
        <el-button
          type="primary"
          :icon="CircleCheck"
          :loading="saving"
          data-test="hostkey-trust"
          @click="trust"
        >
          信任并继续
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.mono {
  font-family: Consolas, Monaco, monospace;
  word-break: break-all;
}
.mt {
  margin-top: 12px;
}
</style>
