<script setup lang="ts">
/**
 * 连接列表页（T04.2 + T04.5 + T04.9）。
 *
 * 覆盖：
 * - 表格：名称 / 主机 / 状态 / 最近连接 / 操作（T04.2）
 * - 新建按钮、编辑、删除（有关联环境时后端会拒绝并给出中文原因）
 * - 离线的连接其依赖操作置灰并给出原因（T04.9）
 * - 指纹确认入口：待确认的连接上显示"确认指纹"按钮（T04.6）
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Delete, EditPen, Link, Odometer, Plus, SwitchButton } from '@element-plus/icons-vue'
import { useConnectionStore } from '../stores/connection'
import { useMenuStore } from '../stores/menu'
import { IpcBusinessError } from '../api'
import { confirmDanger } from '../utils/danger'
import { formatDateTime } from '../utils/format'
import ConnectionFormDrawer from '../components/ConnectionFormDrawer.vue'
import HostKeyDialog from '../components/HostKeyDialog.vue'
import ConnectivityBadge from '../components/ConnectivityBadge.vue'
import type { ConnectionView } from '../../../shared/contracts/connection'

const store = useConnectionStore()
const menu = useMenuStore()

const drawerOpen = ref(false)
const editing = ref<ConnectionView | null>(null)
const busyId = ref('')

/* 指纹确认弹窗状态（T04.6） */
const keyDialog = ref({
  open: false,
  connectionId: '',
  connectionName: '',
  keyType: '',
  fingerprint: '',
  kind: 'unknown' as 'unknown' | 'mismatch',
  expected: ''
})

onMounted(async () => {
  await store.fetchCredentialStatus()
  await store.fetchList()
  await store.refreshStates()

  /**
   * 菜单「新建连接」（⌘/Ctrl+N）会先切到本页、再把命令放进信箱（T15.7）。
   * 放在 `fetchList()` **之后**：表单里的"测试连接"要用到已有连接的状态，
   * 而且用户看到的是一个已经加载完的列表 + 一个打开的表单，而不是白屏加表单。
   */
  if (menu.consume('new-connection')) openCreate()
})

const canSaveSecret = computed(() => store.credential.available)

function openCreate(): void {
  editing.value = null
  drawerOpen.value = true
}

function openEdit(row: ConnectionView): void {
  editing.value = row
  drawerOpen.value = true
}

async function toggleConnect(row: ConnectionView): Promise<void> {
  busyId.value = row.id
  try {
    if (store.statusOf(row.id) === 'online') {
      await store.disconnect(row.id)
      ElMessage.info(`已断开 ${row.name}`)
    } else {
      await store.connect(row.id)
      ElMessage.success(`${row.name} 已连接`)
    }
  } catch (e) {
    const err = e as IpcBusinessError
    // 主机密钥不一致或首次连接：弹确认框而不是只报错（T04.6）
    if (err.code === 'E_HOST_KEY_CHANGED' || err.code === 'E_HOST_KEY_UNKNOWN') {
      const detail = (err.detail ?? {}) as { actual?: string; expected?: string; keyType?: string }
      keyDialog.value = {
        open: true,
        connectionId: row.id,
        connectionName: row.name,
        keyType: detail.keyType ?? 'ssh-ed25519',
        fingerprint: detail.actual ?? row.hostKeyFingerprint ?? '',
        kind: err.code === 'E_HOST_KEY_CHANGED' ? 'mismatch' : 'unknown',
        expected: detail.expected ?? ''
      }
    } else {
      ElMessage.error(err.toUserText())
    }
  } finally {
    busyId.value = ''
  }
}

/** 连接测试（列表里直接测，不改在线状态） */
async function quickTest(row: ConnectionView): Promise<void> {
  busyId.value = row.id
  try {
    const r = await store.test({ id: row.id })
    ElMessage.success(`连通正常，耗时 ${r.latencyMs} ms`)
    if (r.hostKeyStatus === 'unknown') {
      keyDialog.value = {
        open: true,
        connectionId: row.id,
        connectionName: row.name,
        keyType: r.hostKeyType,
        fingerprint: r.hostKeyFingerprint,
        kind: 'unknown',
        expected: ''
      }
    } else if (r.hostKeyStatus === 'mismatch') {
      keyDialog.value = {
        open: true,
        connectionId: row.id,
        connectionName: row.name,
        keyType: r.hostKeyType,
        fingerprint: r.hostKeyFingerprint,
        kind: 'mismatch',
        expected: row.hostKeyFingerprint ?? ''
      }
    }
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    busyId.value = ''
  }
}

async function remove(row: ConnectionView): Promise<void> {
  const ok = await confirmDanger({
    title: '删除连接',
    consequence: `将删除连接「${row.name}」以及本机保存的凭据（有环境引用它时会被拒绝）。`,
    remoteEffect: 'none',
    confirmText: '删除'
  })
  if (!ok) return // 用户取消

  try {
    await store.remove(row.id)
    ElMessage.success('已删除')
  } catch (e) {
    // 被环境引用时后端返回 E_IN_USE，这里展示中文原因
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

async function onTrusted(): Promise<void> {
  await store.fetchList()
}

/**
 * Element Plus 的 el-table 插槽把行类型声明为它内部的 `DefaultRow`，
 * 与我们的业务类型不兼容，直接在模板里传参会报 TS2345。
 * 这里用显式包装函数收口成 ConnectionView，避免在模板里散落类型断言。
 */
function asConnection(row: unknown): ConnectionView {
  return row as ConnectionView
}
</script>

<template>
  <section>
    <div class="head">
      <h2>连接管理</h2>
      <span class="spacer" />
      <el-button v-if="canSaveSecret === false" type="warning" plain size="small" disabled>
        本机无法保存密码
      </el-button>
      <el-button type="primary" :icon="Plus" data-test="conn-new-btn" @click="openCreate"
        >新建连接</el-button
      >
    </div>

    <el-alert
      v-if="!canSaveSecret"
      type="warning"
      show-icon
      :closable="false"
      class="mb"
      :title="store.credential.reason || '本机密钥链不可用'"
      description="应用不会以明文保存密码，请在每次连接时手动输入。这不会影响其他功能。"
    />

    <!--
      首次加载给骨架屏（B15 / T15.5）。
      判据是 `!loaded` 而不是 `loading`：慢启动时"还在加载"与"确实一条都没有"
      在数据上长得一样（都是空数组），但界面必须相反 —— 用 `loading` 判会先闪一下
      "还没有连接"，用户照着这句话就去点新建了。
      `loaded` 之后再加 `v-loading` 覆盖刷新场景（刷新时表格还在，只是淡一层即可）。
    -->
    <el-skeleton v-if="!store.loaded" :rows="5" animated data-test="connections-skeleton" />

    <el-table
      v-else
      :data="store.list"
      v-loading="store.loading"
      border
      stripe
      empty-text="还没有连接，点击右上角「新建连接」"
    >
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column label="主机" min-width="180">
        <template #default="{ row }">{{ row.host }}:{{ row.port }}</template>
      </el-table-column>
      <el-table-column prop="username" label="用户名" width="120" />
      <el-table-column label="认证" width="110">
        <template #default="{ row }">
          <span v-if="row.authType === 'privateKey'">私钥</span>
          <span v-else-if="row.authType === 'password'">密码</span>
          <span v-else>agent</span>
          <el-tag v-if="row.hasSecret" size="small" type="info" class="ml">已存</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <ConnectivityBadge
            :status="store.statusOf(row.id)"
            :reason="store.reasonOf(row.id)"
            :retry-attempt="store.states[row.id]?.retryAttempt"
          />
        </template>
      </el-table-column>
      <el-table-column label="最近连接" width="170">
        <template #default="{ row }">{{
          row.lastConnectedAt ? formatDateTime(row.lastConnectedAt) : '—'
        }}</template>
      </el-table-column>
      <el-table-column label="自动登录" width="90" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.autoConnect" type="success" size="small">开</el-tag>
          <span v-else class="muted">关</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }">
          <!--
            连接/断开是这个页面**唯一的状态切换**，保留文字（图标不足以表达"当前是哪种态"）；
            测试 / 编辑 / 删除是常规动作，密集的表格里只放图标 + tooltip。
          -->
          <el-button
            size="small"
            :icon="store.statusOf(row.id) === 'online' ? SwitchButton : Link"
            :loading="busyId === row.id"
            :data-test="`conn-toggle-${row.id}`"
            @click="toggleConnect(asConnection(row))"
          >
            {{ store.statusOf(row.id) === 'online' ? '断开' : '连接' }}
          </el-button>
          <el-tooltip content="测试连接" placement="top">
            <el-button
              size="small"
              :icon="Odometer"
              aria-label="测试连接"
              :data-test="`conn-test-${row.id}`"
              :loading="busyId === row.id"
              @click="quickTest(asConnection(row))"
            />
          </el-tooltip>
          <el-tooltip content="编辑连接配置" placement="top">
            <el-button
              size="small"
              :icon="EditPen"
              aria-label="编辑连接配置"
              :data-test="`conn-edit-${row.id}`"
              @click="openEdit(asConnection(row))"
            />
          </el-tooltip>
          <el-tooltip content="删除连接（不会动服务器上的文件）" placement="top">
            <el-button
              size="small"
              type="danger"
              plain
              :icon="Delete"
              aria-label="删除连接"
              :data-test="`conn-remove-${row.id}`"
              @click="remove(asConnection(row))"
            />
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>

    <!-- 离线原因单独展示，便于排查（T04.9） -->
    <div v-if="store.statusSummary.some((s) => s.reason)" class="reasons">
      <el-divider content-position="left">离线原因</el-divider>
      <div v-for="s in store.statusSummary.filter((x) => x.reason)" :key="s.id" class="reason-row">
        <el-tag size="small" type="danger">{{ s.name }}</el-tag>
        <span class="reason-text">{{ s.reason }}</span>
      </div>
    </div>

    <ConnectionFormDrawer
      v-model="drawerOpen"
      :editing="editing"
      @saved="store.fetchList()"
      @need-trust="
        (p) =>
          (keyDialog = {
            open: true,
            connectionId: p.connectionId,
            connectionName: editing?.name ?? '',
            keyType: p.keyType,
            fingerprint: p.fingerprint,
            kind: 'unknown',
            expected: ''
          })
      "
    />

    <HostKeyDialog
      v-model="keyDialog.open"
      :connection-id="keyDialog.connectionId"
      :connection-name="keyDialog.connectionName"
      :key-type="keyDialog.keyType"
      :fingerprint="keyDialog.fingerprint"
      :kind="keyDialog.kind"
      :expected="keyDialog.expected"
      @trusted="onTrusted"
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
.head h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.mb {
  margin-bottom: 12px;
}
.ml {
  margin-left: 6px;
}
.muted {
  color: #c0c4cc;
}
.reasons {
  margin-top: 16px;
}
.reason-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  line-height: 1.8;
}
.reason-text {
  color: #909399;
}
</style>
