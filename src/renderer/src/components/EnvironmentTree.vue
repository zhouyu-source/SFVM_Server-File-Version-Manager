<script setup lang="ts">
/**
 * 左侧环境树（T06.2）：环境 → 目标 两级。
 *
 * 交互要点（方案书 §9.1 / §9.2）：
 * - 生产环境带红色标识，一眼能区分
 * - 离线连接的目标整体置灰（T04.9 的延续）
 * - 目标行悬停出现「新建/删除」等操作
 * - 空状态给出引导（T06.7）
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  CaretBottom,
  CaretRight,
  DeleteFilled,
  Document,
  EditPen,
  Folder,
  Plus
} from '@element-plus/icons-vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useConnectionStore } from '../stores/connection'
import { IpcBusinessError } from '../api'
import DangerConfirm from './DangerConfirm.vue'
import { confirmDanger } from '../utils/danger'
import { ref } from 'vue'
import type { EnvironmentView, TargetView } from '../../../shared/contracts/workspace'

const emit = defineEmits<{
  'new-environment': []
  'edit-environment': [EnvironmentView]
  'new-target': []
  'select-target': []
}>()

const ws = useWorkspaceStore()
const conn = useConnectionStore()

/** 删除环境确认弹窗状态 */
const delEnv = ref({
  open: false,
  id: '',
  name: '',
  detail: '',
  requireTypedName: false,
  loading: false
})

const expanded = ref<Record<string, boolean>>({})

function toggle(envId: string): void {
  expanded.value = { ...expanded.value, [envId]: !expanded.value[envId] }
}

function isExpanded(envId: string): boolean {
  // 默认展开；仅记录显式折叠
  return expanded.value[envId] !== false
}

/** 该环境绑定的连接是否在线 —— 离线时目标整体置灰 */
function envOffline(env: EnvironmentView): boolean {
  return conn.statusOf(env.connectionId) !== 'online'
}

async function selectEnv(env: EnvironmentView): Promise<void> {
  ws.selectEnvironment(env.id)
  if (!expanded.value[env.id]) toggle(env.id)
  await ws.refreshTargets(env.id)
}

/** 点选目标：选中写入 store；再上抛事件让 App 把主区域带到目标页展示详情。 */
function onTargetClick(t: TargetView): void {
  ws.selectTarget(t.id)
  emit('select-target')
}

async function openDeleteEnv(env: EnvironmentView): Promise<void> {
  try {
    // 先问后端"会影响到什么"，把真实数量写进确认文案，
    // 并明确"不动服务器文件"——这一点用户最容易误解
    const info = await ws.describeEnvRemoval(env.id)
    delEnv.value = {
      open: true,
      id: env.id,
      name: env.name,
      detail: info.warning,
      // 生产环境要求输入环境名（方案书 §9.3 危险操作分级）
      requireTypedName: env.envType === 'prod',
      loading: false
    }
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

async function confirmDeleteEnv(): Promise<void> {
  delEnv.value.loading = true
  try {
    const r = await ws.removeEnvironment(delEnv.value.id)
    ElMessage.success(`已删除环境，同时清理了 ${r.removedTargets} 个目标的本地配置`)
    delEnv.value.open = false
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    delEnv.value.loading = false
  }
}

/** 删除目标：同样只清本地台账，不动服务器文件 */
async function deleteTarget(targetId: string, name: string, envId: string): Promise<void> {
  const isProdEnv = ws.isProd(envId)
  const ok = await confirmDanger({
    title: '删除目标',
    consequence: `将删除目标「${name}」的本机配置与台账记录（往期版本索引也会一起消失）。`,
    remoteEffect: 'none',
    confirmText: '删除',
    // 生产环境要求输入名称（与 DangerConfirm 组件一致的分级策略）
    ...(isProdEnv ? { requireTypedName: name } : {})
  })
  if (!ok) return

  try {
    const r = await ws.removeTarget(targetId)
    ElMessage.success(`已删除，清理台账 ${r.removedReleases} 条`)
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

const hasEnvironments = computed(() => ws.environments.length > 0)
/** 连一个连接都没有时，引导先去建连接（T06.7 的第一层空状态） */
const noConnection = computed(() => conn.list.length === 0)
</script>

<template>
  <div class="tree">
    <div class="head">
      <span class="title">工作环境</span>
      <span class="spacer" />
      <el-tooltip content="新建环境" :enterable="false" placement="top">
        <el-button
          link
          size="small"
          :icon="Plus"
          aria-label="新建环境"
          data-test="env-new-btn"
          :disabled="noConnection"
          @click="emit('new-environment')"
        />
      </el-tooltip>
    </div>

    <!-- 空状态：没有连接时先引导建连接 -->
    <div v-if="noConnection" class="empty">
      <p>还没有可用的 SSH 连接。</p>
      <p class="sub">环境需要绑定一个连接，请先到「连接」页新建。</p>
    </div>

    <!-- 空状态：有连接但没环境 -->
    <div v-else-if="!hasEnvironments" class="empty">
      <p>还没有工作环境。</p>
      <p class="sub">环境用来区分生产 / 测试，并绑定一个连接。</p>
      <el-button
        type="primary"
        size="small"
        :icon="Plus"
        data-test="env-new-empty-btn"
        @click="emit('new-environment')"
      >
        新建环境
      </el-button>
    </div>

    <!-- 环境列表 -->
    <ul v-else class="env-list">
      <li v-for="env in ws.environments" :key="env.id" class="env">
        <div
          class="env-row"
          :class="{ active: ws.currentEnvId === env.id }"
          @click="selectEnv(env)"
        >
          <span class="caret" @click.stop="toggle(env.id)">
            <el-icon>
              <component :is="isExpanded(env.id) ? CaretBottom : CaretRight" />
            </el-icon>
          </span>
          <span class="dot" :style="{ background: env.color || '#909399' }" />
          <span class="name" :title="env.name">{{ env.name }}</span>
          <el-tag v-if="env.envType === 'prod'" type="danger" size="small" effect="dark"
            >生产</el-tag
          >
          <span class="count">{{ env.targetCount }}</span>

          <span class="ops" @click.stop>
            <el-tooltip content="编辑环境" :enterable="false" placement="top">
              <el-button
                link
                size="small"
                :icon="EditPen"
                aria-label="编辑环境"
                @click="emit('edit-environment', env)"
              />
            </el-tooltip>
            <el-tooltip content="删除环境" :enterable="false" placement="top">
              <el-button
                link
                size="small"
                type="danger"
                :icon="DeleteFilled"
                aria-label="删除环境"
                @click="openDeleteEnv(env)"
              />
            </el-tooltip>
          </span>
        </div>

        <!-- 目标层 -->
        <ul v-if="isExpanded(env.id)" class="target-list">
          <li
            v-for="t in ws.targetsByEnv[env.id] ?? []"
            :key="t.id"
            class="target"
            :class="{
              active: ws.currentTargetId === t.id,
              dimmed: envOffline(env)
            }"
            @click="onTargetClick(t)"
          >
            <span class="kind" :title="t.kind === 'dir' ? '目录' : '文件'">
              <el-icon>
                <component :is="t.kind === 'dir' ? Folder : Document" />
              </el-icon>
            </span>
            <span class="name" :title="t.remotePath">{{ t.name }}</span>

            <span class="ops" @click.stop>
              <el-tooltip
                :enterable="false"
                :content="envOffline(env) ? '连接离线，无法操作' : '删除目标'"
                placement="top"
              >
                <el-button
                  link
                  size="small"
                  type="danger"
                  :icon="DeleteFilled"
                  aria-label="删除目标"
                  :disabled="envOffline(env)"
                  @click="deleteTarget(t.id, t.name, env.id)"
                />
              </el-tooltip>
            </span>
          </li>

          <li v-if="(ws.targetsByEnv[env.id] ?? []).length === 0" class="no-target">暂无目标</li>

          <li class="add-target">
            <el-button
              link
              size="small"
              :icon="Plus"
              data-test="add-target-btn"
              :disabled="envOffline(env)"
              @click="
                () => {
                  ws.selectEnvironment(env.id)
                  emit('new-target')
                }
              "
            >
              添加目标
            </el-button>
            <span v-if="envOffline(env)" class="sub">（连接离线）</span>
          </li>
        </ul>
      </li>
    </ul>

    <DangerConfirm
      v-model="delEnv.open"
      title="删除环境"
      :detail="delEnv.detail"
      remote-effect="none"
      :require-typed-name="delEnv.requireTypedName"
      :expected-name="delEnv.name"
      confirm-text="删除环境"
      :loading="delEnv.loading"
      @confirm="confirmDeleteEnv"
    />
  </div>
</template>

<style scoped>
.tree {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  padding: 0 4px 8px;
}
.title {
  font-size: 13px;
  color: #909399;
  letter-spacing: 0.5px;
}
.spacer {
  flex: 1;
}
.empty {
  padding: 12px 4px;
  font-size: 13px;
  color: #606266;
  line-height: 1.7;
}
.empty .sub {
  color: #909399;
  margin: 4px 0 8px;
}

.env-list,
.target-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.env-list {
  overflow: auto;
}
/*
 * 行高一律用 `height` 固定（而不是 min-height / padding 撑开）：
 * 行内元素的显隐不得影响行高，否则鼠标划过时整棵树会抖。
 */
.env-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  overflow: hidden;
}
.env-row:hover {
  background: #ecf5ff;
}
.env-row.active {
  background: #d9ecff;
}
.caret {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  flex: 0 0 auto;
  color: #909399;
  font-size: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  color: #00dd37;
  font-size: 12px;
  font-weight: bold;
  flex: 0 0 auto;
}
/* 生产标签：固定高度，不参与撑高行（行高已由 .env-row 的 height 定死） */
.env-row :deep(.el-tag) {
  height: 18px;
  padding: 0 5px;
  font-size: 11px;
  line-height: 18px;
  flex: 0 0 auto;
}

/*
 * 行内操作按钮：**始终占位**，只切可见性。
 *
 * 早先用 `display: none → inline-flex` 来显隐，元素会进出文档流，
 * 按钮的固有高度把行撑高，鼠标划过时整行跳动（抖动）。
 * 改成 visibility/opacity 后布局宽度恒定，名字的省略位置也不会跟着跳。
 */
.ops {
  display: inline-flex;
  gap: 2px;
  flex: 0 0 auto;
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.env-row:hover .ops,
.env-row:focus-within .ops,
.target:hover .ops,
.target:focus-within .ops {
  visibility: visible;
  opacity: 1;
}
.ops button {
  margin: 0;
  width: 22px;
  height: 22px;
  padding: 0;
}
.target-list {
  margin-left: 18px;
  border-left: 1px solid #ebeef5;
  padding-left: 4px;
}
.target {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  overflow: hidden;
}
.target:hover {
  background: #f5f7fa;
}
.target.active {
  background: #ecf5ff;
  color: #409eff;
}
.target.dimmed {
  opacity: 0.45;
}
.kind {
  display: flex;
  align-items: center;
  color: #909399;
  flex: 0 0 auto;
}
.no-target,
.add-target {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 6px;
  font-size: 13px;
  color: #909399;
}
/* "添加目标"是真实按钮，撑高会连带整行；限制在行高内 */
.add-target :deep(.el-button) {
  height: 22px;
  padding: 0;
  font-size: 13px;
}
</style>
