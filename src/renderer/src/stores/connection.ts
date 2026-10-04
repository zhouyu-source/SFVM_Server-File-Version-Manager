/**
 * 连接 store（T04.1）。
 *
 * 设计（方案书 §4.3）：IPC 事件订阅**集中在 store 内注册一次**，组件只读状态。
 * 否则每个组件各自订阅会出现重复回调、忘记取消、状态不一致等问题。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, IpcBusinessError } from '../api'
import type {
  ConnectionView,
  ConnectionInput,
  ConnectionPatch,
  TestResult,
  CredentialStatus
} from '../../../shared/contracts/connection'
import type { ConnectionState, ConnectionStatus } from '../../../shared/contracts/connection-state'
import { isOperable } from '../../../shared/contracts/connection-state'

export const useConnectionStore = defineStore('connection', () => {
  /* ------------------------------------------------------------- state */

  const list = ref<ConnectionView[]>([])
  /** connectionId -> 状态 */
  const states = ref<Record<string, ConnectionState>>({})
  const credential = ref<CredentialStatus>({ available: true, backend: '' })
  const loading = ref(false)
  /**
   * 是否**成功完成过一次**列表加载（B15 / T15.5）。
   *
   * 与 `loading` 分开是必要的：慢启动时"正在加载"和"确实没有数据"看起来一模一样
   * （`list` 都是空数组），而两者的界面完全是反的 —— 前者该给骨架屏，
   * 后者该给"还没有连接，点右上角新建"。用 `loading` 判会让冷启动先闪一下
   * "还没有连接"，用户照着这句话就去点了新建。
   */
  const loaded = ref(false)
  const error = ref<string>('')

  /** 事件订阅句柄，避免重复注册 */
  let unsubscribe: (() => void) | null = null

  /* ----------------------------------------------------------- getters */

  const onlineIds = computed(() =>
    Object.values(states.value)
      .filter((s) => s.status === 'online')
      .map((s) => s.connectionId)
  )

  const onlineCount = computed(() => onlineIds.value.length)

  /** 顶部状态条使用的摘要：每个连接一条。 */
  const statusSummary = computed(() =>
    list.value.map((c) => ({
      id: c.id,
      name: c.name,
      host: c.host,
      status: statusOf(c.id),
      reason: states.value[c.id]?.reason,
      code: states.value[c.id]?.code,
      retryAttempt: states.value[c.id]?.retryAttempt
    }))
  )

  function statusOf(id: string): ConnectionStatus {
    return states.value[id]?.status ?? 'idle'
  }

  /** 该连接当前是否可发起写操作（T04.9 离线态置灰的依据）。 */
  function operable(id: string): boolean {
    return isOperable(statusOf(id))
  }

  function reasonOf(id: string): string | undefined {
    return states.value[id]?.reason
  }

  /* ----------------------------------------------------------- actions */

  /** 注册状态事件订阅（幂等）。由 App 启动时调用一次。 */
  function subscribe(): void {
    if (unsubscribe) return
    unsubscribe = api.connections.onState((state) => {
      states.value = { ...states.value, [state.connectionId]: state }
      // 连上后刷新一次列表，让 lastConnectedAt 等字段跟上
      if (state.status === 'online') void fetchList()
    })
  }

  function unsubscribeState(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  async function fetchList(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      list.value = await api.connections.list()
      loaded.value = true
    } catch (e) {
      error.value = (e as IpcBusinessError).toUserText()
    } finally {
      loading.value = false
    }
  }

  /** 首次进入时把每个已知连接的当前状态取回来（页面刷新后也能显示正确状态）。 */
  async function refreshStates(): Promise<void> {
    const next: Record<string, ConnectionState> = {}
    await Promise.all(
      list.value.map(async (c) => {
        try {
          next[c.id] = await api.connections.state(c.id)
        } catch {
          next[c.id] = { connectionId: c.id, status: 'idle' }
        }
      })
    )
    states.value = next
  }

  async function fetchCredentialStatus(): Promise<void> {
    try {
      credential.value = await api.connections.credentialStatus()
    } catch {
      // 取不到时保守假设"可用"，真正的写入会被主进程拒绝并提示
      credential.value = { available: true, backend: '' }
    }
  }

  async function create(input: ConnectionInput): Promise<ConnectionView> {
    const created = await api.connections.create(input)
    await fetchList()
    return created
  }

  async function update(id: string, patch: ConnectionPatch): Promise<ConnectionView> {
    const updated = await api.connections.update(id, patch)
    await fetchList()
    return updated
  }

  async function remove(id: string): Promise<void> {
    await api.connections.remove(id)
    const { [id]: _removed, ...rest } = states.value
    states.value = rest
    await fetchList()
  }

  /** 连接测试：不改状态，只返回结果供弹窗展示。 */
  async function test(params: { id?: string; input?: ConnectionInput }): Promise<TestResult> {
    return api.connections.test(params)
  }

  async function connect(id: string): Promise<void> {
    const state = await api.connections.connect(id)
    states.value = { ...states.value, [id]: state }
    await fetchList()
  }

  async function disconnect(id: string): Promise<void> {
    await api.connections.disconnect(id)
    states.value = { ...states.value, [id]: { connectionId: id, status: 'idle' } }
    await fetchList()
  }

  /** 确认信任主机指纹（TOFU）。 */
  async function trustHostKey(id: string, keyType: string, fingerprint: string): Promise<void> {
    await api.connections.trustHostKey(id, keyType, fingerprint)
    await fetchList()
  }

  return {
    // state
    list,
    states,
    credential,
    loading,
    loaded,
    error,
    // getters
    onlineIds,
    onlineCount,
    statusSummary,
    // helpers
    statusOf,
    operable,
    reasonOf,
    // actions
    subscribe,
    unsubscribeState,
    fetchList,
    refreshStates,
    fetchCredentialStatus,
    create,
    update,
    remove,
    test,
    connect,
    disconnect,
    trustHostKey
  }
})
