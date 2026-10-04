<script setup lang="ts">
/**
 * 危险操作确认弹窗（T06.6）。
 *
 * 方案书 §9.3「危险操作分级」：
 * - 生产环境的一切破坏性操作，必须输入目标名才能确认
 * - 测试环境仅需点击确认
 *
 * 设计上做成**通用组件**，供"删除环境 / 删除目标 / 删除往期版本 / 回滚"共用，
 * 避免每个入口各写一套确认逻辑（那样迟早会有一个漏掉分级判断）。
 */
import { computed, ref, watch } from 'vue'
import { Warning } from '@element-plus/icons-vue'
import { remoteEffectLine, type RemoteEffect } from '../utils/danger'

const props = defineProps<{
  modelValue: boolean
  title: string
  /** 说明正文；换行会被保留 */
  detail?: string
  /** 危险等级的提示文案（如"此操作不可恢复"） */
  warning?: string
  /**
   * 对服务器的影响（B15 / T15.6）。
   *
   * **必填**，且由 `remoteEffectLine()` 统一渲染 —— 见 `utils/danger.ts` 里
   * "为什么要把这句话统一起来"。做成必填是因为：默认值无论取哪个都会有人漏填，
   * 而漏填的后果是"危险操作没告诉你它删不删服务器文件"。
   */
  remoteEffect: RemoteEffect
  /** remoteEffect === 'files' 时说明删什么 */
  remoteDetail?: string
  confirmText?: string
  cancelText?: string
  /**
   * 生产环境分级：为真时要求用户输入 expectedName 才能确认。
   * 由调用方传 `workspace.isProd(envId)` 的结果。
   */
  requireTypedName?: boolean
  /** requireTypedName 为真时需要用户逐字输入的名称 */
  expectedName?: string
  /** 确认按钮的 loading 由调用方控制（异步操作） */
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [boolean]
  confirm: []
}>()

const typed = ref('')

const needType = computed(() => props.requireTypedName === true)

/** "对服务器的影响"那一行（措辞来自 utils/danger.ts，不要在这里改写） */
const effectText = computed(() => remoteEffectLine(props.remoteEffect, props.remoteDetail))

/** 输入的名称是否匹配（忽略首尾空白与大小写差异） */
const typedOk = computed(() => {
  if (!needType.value) return true
  const a = typed.value.trim().toLowerCase()
  const b = (props.expectedName ?? '').trim().toLowerCase()
  return a.length > 0 && a === b
})

// 每次打开都清空输入，避免上次的输入残留导致误确认
watch(
  () => props.modelValue,
  (open) => {
    if (open) typed.value = ''
  }
)

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="480px"
    :close-on-click-modal="false"
    :close-on-press-escape="!loading"
    @update:model-value="close"
  >
    <p v-if="detail" class="detail">{{ detail }}</p>

    <!--
      服务器影响单独一块：它是这类弹窗里最要紧的一句话，不该混在正文里被读漏。
      会删服务器文件时用 danger 色，不删时用 info 色 —— 颜色本身也在传达"严重程度"。
    -->
    <el-alert
      class="effect"
      :type="remoteEffect === 'files' ? 'error' : 'info'"
      show-icon
      :closable="false"
      :title="effectText"
      data-test="danger-remote-effect"
    />

    <el-alert v-if="warning" type="warning" show-icon :closable="false" :title="warning" />

    <!-- 生产环境才出现的二次确认输入（分级控制） -->
    <div v-if="needType" class="typed">
      <p class="hint">
        这是<strong>生产环境</strong>操作。请输入
        <code>{{ expectedName }}</code>
        以确认：
      </p>
      <el-input
        v-model="typed"
        :placeholder="expectedName"
        :disabled="loading"
        @keyup.enter="typedOk && emit('confirm')"
      />
      <p v-if="typed.length > 0 && !typedOk" class="mismatch">输入的名称不一致</p>
    </div>

    <template #footer>
      <el-button :disabled="loading" @click="close">{{ cancelText || '取消' }}</el-button>
      <el-button
        type="danger"
        :icon="Warning"
        :disabled="!typedOk"
        :loading="loading"
        @click="emit('confirm')"
      >
        {{ confirmText || '确认执行' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.detail {
  margin: 0 0 12px;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.7;
  color: #303133;
}
.effect {
  margin-bottom: 10px;
}
.typed {
  margin-top: 14px;
}
.hint {
  font-size: 12px;
  color: #606266;
  margin: 0 0 6px;
}
.hint code {
  background: #f5f7fa;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: Consolas, Monaco, monospace;
}
.mismatch {
  margin: 6px 0 0;
  font-size: 12px;
  color: #f56c6c;
}
</style>
