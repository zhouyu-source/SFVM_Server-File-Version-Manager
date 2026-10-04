<script setup lang="ts">
/**
 * 连接状态徽标（T04.7 / T04.9 的小组件）。
 * 状态与原因都来自 store，组件不自己发请求。
 */
import { computed } from 'vue'
import { describeStatus, type ConnectionStatus } from '../../../shared/contracts/connection-state'

const props = defineProps<{
  status: ConnectionStatus
  reason?: string
  retryAttempt?: number
}>()

const type = computed(() => {
  switch (props.status) {
    case 'online':
      return 'success'
    case 'connecting':
    case 'reconnecting':
      return 'warning'
    case 'offline':
      return 'danger'
    default:
      return 'info'
  }
})

const text = computed(() => {
  const base = describeStatus(props.status)
  if (props.status === 'reconnecting' && props.retryAttempt) return `${base}(${props.retryAttempt})`
  return base
})

/** 悬停显示原因，避免把长文案塞进表格 */
const title = computed(() => props.reason || text.value)
</script>

<template>
  <el-tooltip :content="title" placement="top" :disabled="!reason">
    <el-tag :type="type" size="small" effect="light" data-test="conn-status">{{ text }}</el-tag>
  </el-tooltip>
</template>
