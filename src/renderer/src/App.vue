<script setup lang="ts">
/**
 * 应用外壳（方案书 §9.1 的四区骨架）。
 *
 * 布局职责：
 * - 顶部：连接状态条（T04.7）
 * - 左侧：环境树（T06.2）
 * - 中间：路由内容（目标详情 / 连接管理 / 设置）
 * - 底部：任务控制台（B08）
 *
 * 环境与目标的弹窗统一挂在这里：左侧树与内容区都要打开它们，
 * 放在共同父级比两边各自维护更简单。
 *
 * 自动登录由**主进程**负责（方案书 §7.3），渲染进程只订阅状态事件（T04.8）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from './api'
import { WarnTriangleFilled } from '@element-plus/icons-vue'
import { useConnectionStore } from './stores/connection'
import { useWorkspaceStore } from './stores/workspace'
import { useMenuStore } from './stores/menu'
import EnvironmentTree from './components/EnvironmentTree.vue'
import EnvironmentDialog from './components/EnvironmentDialog.vue'
import TargetWizard from './components/TargetWizard.vue'
import TaskConsole from './components/TaskConsole.vue'
import RecoveryDialog from './components/RecoveryDialog.vue'
import { describeStatus } from '../../shared/contracts/connection-state'
import type { EnvironmentView, TargetView } from '../../shared/contracts/workspace'

const conn = useConnectionStore()
const ws = useWorkspaceStore()
const menu = useMenuStore()
const pingOk = ref(false)

/* ------------------------------------------------------------ 弹窗状态 */

const envDialogOpen = ref(false)
const editingEnv = ref<EnvironmentView | null>(null)

const wizardOpen = ref(false)
const editingTarget = ref<TargetView | null>(null)

/* ------------------------------------------------ 未完成的操作（B14 / T14.4） */

/**
 * 启动时扫一遍"上次没做完"的操作，有的话在顶部挂一条横幅。
 *
 * 这是**纯本地**查询（只读台账里的非终态记录），所以放在启动流程里没有代价；
 * 真正的远端勘察要等用户点了「处理」才做 —— 启动时不该因为要连服务器而卡住。
 */
const recoveryOpen = ref(false)
const unfinishedCount = ref(0)

async function scanUnfinished(): Promise<void> {
  try {
    unfinishedCount.value = (await api.reconcile.startupScan()).unfinished.length
  } catch {
    // 扫不出来不该影响启动：这只是个提示
    unfinishedCount.value = 0
  }
}

const router = useRouter()

/** 用户在恢复弹窗里选了「重新发布」：把他带到目标页（发布面板在那里）。 */
function onRecoveryRetry(): void {
  void router.push('/targets')
  ElMessage.info('请在该目标的详情页点「发布到服务器」重新发起一次')
}

/* ------------------------------------------------ 菜单命令（B15 / T15.7） */

let offMenu: (() => void) | null = null

/**
 * 处理主进程推来的菜单命令。
 *
 * 快捷键只在**原生菜单**里注册，渲染进程收不到按键事件，所以每一项都要在这里
 * 落地成具体动作：
 * - `new-connection` / `settings`：切页 + （前者）把命令放进信箱，由连接页打开表单；
 * - `refresh`：重载界面。这里**不用** `router.go(0)`，它在 hash 路由下语义含糊；
 *   直接用 `location.reload()` —— 会停在同一个 hash 路由上，且所有页面都会
 *   重新走一遍挂载流程（也就是"重新拉一遍数据"这件事本身）。
 */
function onMenuCommand(command: string): void {
  switch (command) {
    case 'new-connection':
      menu.setPending('new-connection')
      void router.push('/connections')
      break
    case 'settings':
      void router.push('/settings')
      break
    case 'refresh':
      window.location.reload()
      break
    default:
      break
  }
}

function openNewEnvironment(): void {
  editingEnv.value = null
  envDialogOpen.value = true
}

function openEditEnvironment(env: EnvironmentView): void {
  editingEnv.value = env
  envDialogOpen.value = true
}

function openNewTarget(): void {
  editingTarget.value = null
  wizardOpen.value = true
}

function openEditTarget(t: TargetView): void {
  editingTarget.value = t
  wizardOpen.value = true
}

/** 左侧树点选了目标：选中已在 store 里，这里只需把主区域带到目标页展示详情。 */
function onTreeSelectTarget(): void {
  // 已在目标页时同路由 push 会被 vue-router 当重复导航丢弃，直接跳过省一次空转
  if (router.currentRoute.value.path !== '/targets') void router.push('/targets')
}

/* ------------------------------------------------------------ 生命周期 */

onMounted(async () => {
  // 先订阅，避免错过主进程在建连过程中推送的状态（自动登录可能已经开始）
  conn.subscribe()
  await conn.fetchCredentialStatus()
  await conn.fetchList()
  await conn.refreshStates()
  pingOk.value = true

  await ws.fetchEnvironments()

  // B14 / T14.4：启动残留扫描（纯本地，只读台账 —— 不会拖慢启动）
  await scanUnfinished()

  // B15 / T15.7：菜单命令（快捷键改了之后要能立刻生效，所以订阅放在启动流程里）
  offMenu = api.menu.onCommand((payload) => onMenuCommand(payload.command))
})

onUnmounted(() => {
  conn.unsubscribeState()
  offMenu?.()
  offMenu = null
})

/* ------------------------------------------------------------ 顶栏展示 */

const topbarItems = computed(() => conn.statusSummary.slice(0, 4))
const moreCount = computed(() => Math.max(0, conn.statusSummary.length - topbarItems.value.length))

function dotClass(status: string): string {
  switch (status) {
    case 'online':
      return 'dot ok'
    case 'connecting':
    case 'reconnecting':
      return 'dot warn'
    case 'offline':
      return 'dot err'
    default:
      return 'dot idle'
  }
}
</script>

<template>
  <div class="sfvm-shell">
    <header class="sfvm-topbar">
      <strong class="sfvm-brand">SFVM</strong>

      <!-- 顶部连接状态条（T04.7） -->
      <div class="sfvm-states">
        <el-tooltip
          v-for="c in topbarItems"
          :key="c.id"
          :content="
            c.reason ? `${describeStatus(c.status)}：${c.reason}` : describeStatus(c.status)
          "
          placement="bottom"
        >
          <span class="state-item">
            <i :class="dotClass(c.status)" />
            <span class="state-name">{{ c.name }}</span>
            <span class="state-text">{{ describeStatus(c.status) }}</span>
          </span>
        </el-tooltip>
        <span v-if="moreCount > 0" class="state-more">+{{ moreCount }}</span>
        <span v-if="conn.statusSummary.length === 0" class="state-more">未配置连接</span>
      </div>

      <span class="sfvm-spacer" />

      <!-- 主进程通路自检（B01 的静默失败教训：IPC 断了必须显式提示） -->
      <span v-if="!pingOk" class="sfvm-ipc-warn" title="主进程通路自检未通过">
        主进程通信异常
      </span>

      <nav class="sfvm-nav">
        <RouterLink to="/connections">连接</RouterLink>
        <RouterLink to="/targets">目标</RouterLink>
        <RouterLink to="/settings">设置</RouterLink>
      </nav>
    </header>

    <!--
      未完成的操作（B14 / T14.4）：只在真的有时才出现。
      它是**提示**不是阻塞 —— 未结束的记录确实会挡住下一次发布（阶段 0 会拦），
      但用户完全可以先去看看别的，所以这里不强制弹窗、也不禁用任何东西。
    -->
    <el-alert
      v-if="unfinishedCount > 0"
      class="sfvm-recover-bar"
      type="warning"
      show-icon
      :closable="false"
      data-test="recovery-bar"
    >
      <template #title>
        <span class="sfvm-recover-title">
          有 {{ unfinishedCount }} 个操作上次没做完
          <span class="muted">
            —— 服务器上的状态可能介于「操作前」与「操作后」之间，建议先处理它们
          </span>
        </span>
      </template>
      <el-button
        size="small"
        type="warning"
        :icon="WarnTriangleFilled"
        data-test="recovery-bar-open"
        @click="recoveryOpen = true"
      >
        查看并处理
      </el-button>
    </el-alert>

    <div class="sfvm-body">
      <!-- 左侧环境树（T06.2） -->
      <aside class="sfvm-sidebar">
        <EnvironmentTree
          @new-environment="openNewEnvironment"
          @edit-environment="openEditEnvironment"
          @new-target="openNewTarget"
          @select-target="onTreeSelectTarget"
        />
      </aside>

      <main class="sfvm-content">
        <RouterView
          :wizard-open="wizardOpen"
          @update:wizard-open="wizardOpen = $event"
          @new-environment="openNewEnvironment"
          @edit-environment="openEditEnvironment"
          @edit-target="openEditTarget"
        />
      </main>
    </div>

    <footer class="sfvm-taskbar">
      <TaskConsole />
    </footer>
  </div>

  <!-- 环境与目标的弹窗统一挂在根级，避免受内容区滚动/层叠影响 -->
  <EnvironmentDialog v-model="envDialogOpen" :editing="editingEnv" />

  <RecoveryDialog v-model="recoveryOpen" @retry="onRecoveryRetry" @done="scanUnfinished" />

  <TargetWizard
    v-if="ws.currentEnvId"
    v-model="wizardOpen"
    :environment-id="ws.currentEnvId"
    :editing="editingTarget"
    @saved="ws.refreshTargets()"
  />
</template>

<style>
:root {
  --sfvm-border: #dcdfe6;
  --sfvm-bg: #f5f7fa;
  --sfvm-fg: #303133;
  --sfvm-muted: #909399;
  --sfvm-brand: #409eff;
}

* {
  box-sizing: border-box;
}

html,
body,
#app {
  height: 100%;
  margin: 0;
}

body {
  font-family:
    'Microsoft YaHei',
    system-ui,
    -apple-system,
    sans-serif;
  color: var(--sfvm-fg);
}

.sfvm-recover-bar {
  border-radius: 0;
}
.sfvm-recover-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sfvm-shell {
  display: grid;
  /* 第三行用 auto：底部任务控制台展开时会自己撑高（面板高度由组件决定） */
  grid-template-rows: 48px 1fr auto;
  height: 100%;
}

.sfvm-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--sfvm-border);
  background: #fff;
}

.sfvm-brand {
  color: var(--sfvm-brand);
  letter-spacing: 1px;
}

.sfvm-states {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}

.state-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #606266;
  white-space: nowrap;
}

.state-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.state-text {
  color: var(--sfvm-muted);
}

.state-more {
  font-size: 12px;
  color: var(--sfvm-muted);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  background: #c0c4cc;
}
.dot.ok {
  background: #67c23a;
}
.dot.warn {
  background: #e6a23c;
}
.dot.err {
  background: #f56c6c;
}
.dot.idle {
  background: #c0c4cc;
}

.sfvm-spacer {
  flex: 1;
}

.sfvm-nav a {
  margin-left: 12px;
  color: var(--sfvm-fg);
  text-decoration: none;
  font-size: 13px;
}

.sfvm-nav a.router-link-active {
  color: var(--sfvm-brand);
  font-weight: 600;
}

.sfvm-body {
  display: grid;
  grid-template-columns: 300px 1fr;
  min-height: 0;
}

.sfvm-sidebar {
  border-right: 1px solid var(--sfvm-border);
  background: var(--sfvm-bg);
  padding: 10px 8px;
  overflow: auto;
}

.sfvm-content {
  padding: 16px;
  overflow: auto;
}

.sfvm-taskbar {
  /* 具体条高与样式由 TaskConsole 自己决定（收起 36px / 展开时更高） */
  min-height: 36px;
  background: #fff;
}
</style>
