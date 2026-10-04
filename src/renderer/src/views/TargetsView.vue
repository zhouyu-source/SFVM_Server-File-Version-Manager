<script setup lang="ts">
/**
 * 目标页（T06.5 容器 + T06.7 空状态引导）。
 *
 * 本身不做数据加载：环境树在左侧、选中项存在 workspace store 里，
 * 这里只负责按"当前选中了什么"呈现内容区 —— 树与内容区因此完全解耦。
 */
import { computed } from 'vue'
import { Link, Plus } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useWorkspaceStore } from '../stores/workspace'
import { useConnectionStore } from '../stores/connection'
import TargetDetail from '../components/TargetDetail.vue'
import type { TargetView, EnvironmentView } from '../../../shared/contracts/workspace'

defineProps<{ wizardOpen: boolean }>()
const emit = defineEmits<{
  'update:wizardOpen': [boolean]
  'edit-target': [TargetView]
  'edit-environment': [EnvironmentView]
  'new-environment': []
}>()

const ws = useWorkspaceStore()
const conn = useConnectionStore()
const router = useRouter()

const noConnection = computed(() => conn.list.length === 0)
const noEnv = computed(() => ws.environments.length === 0)

/**
 * 骨架屏的判据见模板注释。
 *
 * 顺带把 `noEnv` 的 `length === 0` 也变成"加载完之后才是真的空"，
 * 所以下面几个 `v-else-if` 的顺序不能乱。
 */
</script>

<template>
  <section>
    <!--
      还没加载完 → 骨架屏（B15 / T15.5）。
      这一段**必须在三层空状态之前**：环境与连接都是异步来的，冷启动时它们都是空数组，
      于是这里会先渲染出"还没有可用的 SSH 连接" —— 而实际上有连接，
      只是还没读回来。用户看到那句引导就会去点"去新建连接"。
    -->
    <el-skeleton
      v-if="!conn.loaded || !ws.loaded"
      :rows="6"
      animated
      data-test="targets-skeleton"
    />

    <!-- 第一层空状态：连连接都没有 —— 引导去建连接（T06.7） -->
    <el-empty v-else-if="noConnection" description="还没有可用的 SSH 连接">
      <p class="hint">
        环境需要绑定一个连接。请先到「连接」页新增一个 SSH 连接，<br />
        填好主机、用户名与认证方式后点击「测试连接」。
      </p>
      <el-button type="primary" :icon="Link" @click="router.push('/connections')">
        去新建连接
      </el-button>
    </el-empty>

    <!-- 第二层空状态：有连接但没环境 -->
    <el-empty v-else-if="noEnv" description="还没有工作环境">
      <p class="hint">
        工作环境用来区分生产 / 测试，并绑定一个连接。每个环境里可以放多个受管目标<br />
        （前端 <code>dist</code> 目录、后端 <code>*.jar</code> 包）。
      </p>
      <el-button
        type="primary"
        :icon="Plus"
        data-test="env-new-main-btn"
        @click="emit('new-environment')"
        >新建环境</el-button
      >
    </el-empty>

    <!-- 第三层空状态：有环境但没选中目标 -->
    <el-empty
      v-else-if="!ws.currentTarget"
      :description="`「${ws.currentEnv?.name ?? ''}」下暂未选中目标`"
    >
      <p class="hint">
        从左侧环境树选择一个目标查看详情，<br />
        或为当前环境添加一个新目标。
      </p>
      <el-button
        type="primary"
        :icon="Plus"
        data-test="target-new-btn"
        @click="emit('update:wizardOpen', true)"
        >添加目标</el-button
      >
    </el-empty>

    <!-- 目标详情 -->
    <TargetDetail v-else :target="ws.currentTarget" @edit="emit('edit-target', $event)" />
  </section>
</template>

<style scoped>
.hint {
  color: #909399;
  font-size: 13px;
  line-height: 1.9;
  margin: 8px 0 16px;
}
.hint code {
  background: #f5f7fa;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: Consolas, Monaco, monospace;
}
</style>
