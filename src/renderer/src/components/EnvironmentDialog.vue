<script setup lang="ts">
/**
 * 环境新建 / 编辑弹窗（T06.3）。
 *
 * 要点：
 * - 必须绑定一个连接（后端也强校验），所以没连接时入口本就该被禁用
 * - 环境类型决定默认颜色：生产红、测试蓝、自定义灰（方案书 §9.1）
 * - 名称为空或重复时，错误由后端返回中文文案，这里直接展示
 */
import { computed, reactive, ref, watch } from 'vue'
import { Check, Close } from '@element-plus/icons-vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useWorkspaceStore } from '../stores/workspace'
import { useConnectionStore } from '../stores/connection'
import { IpcBusinessError } from '../api'
import type { EnvironmentView, EnvType } from '../../../shared/contracts/workspace'

const props = defineProps<{ modelValue: boolean; editing: EnvironmentView | null }>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [] }>()

const ws = useWorkspaceStore()
const conn = useConnectionStore()

const formRef = ref<FormInstance>()
const saving = ref(false)

/** 与环境类型对应的默认色（与后端 ENV_COLORS 保持一致） */
const TYPE_COLOR: Record<EnvType, string> = {
  prod: '#f56c6c',
  test: '#409eff',
  custom: '#909399'
}

const form = reactive<{
  name: string
  envType: EnvType
  connectionId: string
  description: string
  color: string
}>({
  name: '',
  envType: 'test',
  connectionId: '',
  description: '',
  color: TYPE_COLOR.test
})

const isEditing = computed(() => props.editing !== null)

const rules: FormRules = {
  name: [{ required: true, message: '请输入环境名称', trigger: 'blur' }],
  connectionId: [{ required: true, message: '请选择一个连接', trigger: 'change' }]
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    const e = props.editing
    if (e) {
      form.name = e.name
      form.envType = e.envType
      form.connectionId = e.connectionId
      form.description = e.description ?? ''
      form.color = e.color ?? TYPE_COLOR[e.envType]
    } else {
      form.name = ''
      form.envType = 'test'
      form.connectionId = conn.list[0]?.id ?? ''
      form.description = ''
      form.color = TYPE_COLOR.test
    }
  }
)

/** 切换类型时跟随更新颜色（用户改过颜色则不覆盖） */
function onTypeChange(v: string | number | boolean | undefined): void {
  const t = v as EnvType
  if (Object.values(TYPE_COLOR).includes(form.color)) {
    form.color = TYPE_COLOR[t]
  }
}

async function save(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return

  saving.value = true
  try {
    const payload = {
      name: form.name.trim(),
      envType: form.envType,
      connectionId: form.connectionId,
      description: form.description.trim() || null,
      color: form.color
    }
    if (isEditing.value && props.editing) {
      await ws.updateEnvironment(props.editing.id, payload)
      ElMessage.success('环境已更新')
    } else {
      await ws.createEnvironment(payload)
      ElMessage.success('环境已创建')
    }
    emit('saved')
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
    :title="isEditing ? '编辑环境' : '新建环境'"
    width="480px"
    @update:model-value="emit('update:modelValue', false)"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="88px" data-test="env-form">
      <el-form-item label="名称" prop="name">
        <el-input v-model="form.name" placeholder="如：生产环境" data-test="env-name" />
      </el-form-item>

      <el-form-item label="类型">
        <el-radio-group v-model="form.envType" data-test="env-type" @change="onTypeChange">
          <el-radio-button value="test" data-test="env-type-test">测试</el-radio-button>
          <el-radio-button value="prod" data-test="env-type-prod">生产</el-radio-button>
          <el-radio-button value="custom" data-test="env-type-custom">自定义</el-radio-button>
        </el-radio-group>
        <div class="hint">生产环境会被红标，且删除等破坏性操作需要额外输入名称确认。</div>
      </el-form-item>

      <el-form-item label="绑定连接" prop="connectionId">
        <el-select
          v-model="form.connectionId"
          placeholder="选择一个 SSH 连接"
          style="width: 100%"
          data-test="env-connection"
        >
          <el-option
            v-for="c in conn.list"
            :key="c.id"
            :label="`${c.name}（${c.username}@${c.host}:${c.port}）`"
            :value="c.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="标识色">
        <el-color-picker v-model="form.color" />
        <span class="hint" style="margin-left: 8px">用于左侧环境树的圆点</span>
      </el-form-item>

      <el-form-item label="描述">
        <el-input v-model="form.description" type="textarea" :rows="2" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button :icon="Close" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button
        type="primary"
        :icon="Check"
        :loading="saving"
        data-test="env-save-btn"
        @click="save"
        >保存</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
.hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
</style>
