/**
 * 工作环境与目标 store（T06.1）。
 *
 * 与 connection store 同样的约定：**IPC 调用集中在 store**，组件只读状态。
 * 额外维护"当前选中的环境 / 目标"，让左侧环境树与右侧内容区解耦 ——
 * 两边都只跟 store 打交道，不必层层传递 props。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, IpcBusinessError } from '../api'
import type {
  EnvironmentView,
  EnvironmentInput,
  TargetView,
  TargetInput,
  TargetCreateResult,
  HealthReport,
  LocalArtifactInfo,
  PickArtifactInput
} from '../../../shared/contracts/workspace'

export const useWorkspaceStore = defineStore('workspace', () => {
  /* ------------------------------------------------------------- state */

  const environments = ref<EnvironmentView[]>([])
  /** environmentId -> 该环境下的目标列表 */
  const targetsByEnv = ref<Record<string, TargetView[]>>({})
  /**
   * targetId -> 本地产物轻量信息（B11 / T11.2）。
   *
   * 与目标列表分开缓存是刻意的：它**不连服务器**，随时可以单独刷新，
   * 而目标列表的刷新路径还没接上"本地文件变了"这种事件。
   */
  const artifactByTarget = ref<Record<string, LocalArtifactInfo>>({})

  const currentEnvId = ref<string | null>(null)
  const currentTargetId = ref<string | null>(null)

  const loading = ref(false)
  /** 是否成功完成过一次环境加载（判"空"要用它，不能只看 `loading`，理由见 CONNECTION store） */
  const loaded = ref(false)
  const error = ref('')

  /* ----------------------------------------------------------- getters */

  const currentEnv = computed(
    () => environments.value.find((e) => e.id === currentEnvId.value) ?? null
  )

  const currentTargets = computed(() =>
    currentEnvId.value ? (targetsByEnv.value[currentEnvId.value] ?? []) : []
  )

  /**
   * 当前选中的目标。
   *
   * 刻意在**所有环境**里查找，而不是只在 currentEnvId 下：
   * 这样即使"选中目标"与"选中环境"因某种时序暂时不一致，
   * 详情页也不会莫名空白。查找是便宜的（几十条量级）。
   */
  const currentTarget = computed(() => {
    if (!currentTargetId.value) return null
    for (const list of Object.values(targetsByEnv.value)) {
      const hit = list.find((t) => t.id === currentTargetId.value)
      if (hit) return hit
    }
    return null
  })

  /** 是否为空状态（用于 T06.7 的引导） */
  const isEmpty = computed(() => environments.value.length === 0)

  /** 生产环境用红色标识（方案书 §9.2） */
  function isProd(envId: string): boolean {
    return environments.value.find((e) => e.id === envId)?.envType === 'prod'
  }

  /* ----------------------------------------------------------- actions */

  async function fetchEnvironments(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      environments.value = await api.env.list()
      loaded.value = true
      // 当前选中项被删掉时自动回退到第一个
      if (currentEnvId.value && !environments.value.some((e) => e.id === currentEnvId.value)) {
        currentEnvId.value = environments.value[0]?.id ?? null
        currentTargetId.value = null
      }
      if (!currentEnvId.value && environments.value.length > 0) {
        currentEnvId.value = environments.value[0].id
      }
      // 预取所有环境的目标：环境树要展示"环境 → 目标"两级。
      // 不预取的话首次进入会看到"暂无目标"，用户会以为数据丢了。
      await Promise.all(environments.value.map((e) => fetchTargets(e.id)))
    } catch (e) {
      error.value = (e as IpcBusinessError).toUserText()
    } finally {
      loading.value = false
    }
  }

  async function fetchTargets(environmentId: string): Promise<void> {
    try {
      const list = await api.targets.list(environmentId)
      targetsByEnv.value = { ...targetsByEnv.value, [environmentId]: list }
    } catch (e) {
      error.value = (e as IpcBusinessError).toUserText()
    }
  }

  /** 刷新当前环境的目标；若未指定环境则用 currentEnvId */
  async function refreshTargets(environmentId?: string): Promise<void> {
    const id = environmentId ?? currentEnvId.value
    if (!id) return
    await fetchTargets(id)
  }

  /**
   * 只重取**环境列表本身**（拿回后端现算的 `targetCount`），不重取目标列表。
   *
   * 目标的增 / 删 / 改都会改变某个环境的 `targetCount`，而它是后端从 `targets`
   * 表现算出来的**另一份**数据（`services/workspace.ts` 的 `listEnvironments`）：
   * 只刷新 `targetsByEnv` 的话，环境名右边那个绿色数字会停在旧值，
   * 要重启应用才更新（用户报的就是这个）。
   *
   * 刻意不用 `fetchEnvironments()`：那会把**所有**环境的目标都重取一遍，
   * 为了一个数字不值当（而且它会重设选中态）。
   */
  async function refreshEnvCounts(): Promise<void> {
    try {
      environments.value = await api.env.list()
    } catch (e) {
      error.value = (e as IpcBusinessError).toUserText()
    }
  }

  function selectEnvironment(id: string): void {
    currentEnvId.value = id
    currentTargetId.value = null
    void refreshTargets(id)
  }

  /**
   * 选中目标。
   *
   * 注意必须**同时把 currentEnvId 切到该目标所属环境**：
   * currentTarget 是在"当前环境的目标列表"里查找的，
   * 只设 currentTargetId 会导致点击"非当前环境"下的目标时查不到 ——
   * 表现为"点了没反应"。（这个 bug 实际出现过，特此记录。）
   */
  function selectTarget(id: string | null): void {
    currentTargetId.value = id
    if (!id) return
    const owner = Object.entries(targetsByEnv.value).find(([, list]) =>
      list.some((t) => t.id === id)
    )
    if (owner && owner[0] !== currentEnvId.value) {
      currentEnvId.value = owner[0]
    }
  }

  /* ---------------------------------------------------------- 环境 CRUD */

  async function createEnvironment(input: EnvironmentInput): Promise<EnvironmentView> {
    const created = await api.env.create(input)
    await fetchEnvironments()
    selectEnvironment(created.id)
    return created
  }

  async function updateEnvironment(
    id: string,
    patch: Partial<EnvironmentInput>
  ): Promise<EnvironmentView> {
    const updated = await api.env.update(id, patch)
    await fetchEnvironments()
    return updated
  }

  /** 删除前先问后端"会影响到什么"，用于确认弹窗文案（T06.3/T06.6）。 */
  async function describeEnvRemoval(id: string): Promise<{ targetCount: number; warning: string }> {
    return api.env.describeRemoval(id)
  }

  async function removeEnvironment(id: string): Promise<{ removedTargets: number }> {
    const r = await api.env.remove(id)
    const { [id]: _removed, ...rest } = targetsByEnv.value
    targetsByEnv.value = rest
    if (currentEnvId.value === id) {
      currentEnvId.value = null
      currentTargetId.value = null
    }
    await fetchEnvironments()
    return r
  }

  /* ---------------------------------------------------------- 目标 CRUD */

  /**
   * 新建目标（含体检）。
   * createMissingDir 只在用户明确选择"现在创建空目录"时为 true。
   */
  async function createTarget(
    input: TargetInput & { createMissingDir?: boolean }
  ): Promise<TargetCreateResult> {
    const result = await api.targets.create(input)
    await fetchTargets(input.environmentId)
    // 环境名右边的目标计数来自 environments（后端现算），必须一起刷新
    await refreshEnvCounts()
    currentTargetId.value = result.target.id
    return result
  }

  async function updateTarget(id: string, patch: Partial<TargetInput>): Promise<TargetView> {
    const updated = await api.targets.update(id, patch)
    await refreshTargets(updated.environmentId)
    await refreshEnvCounts()
    return updated
  }

  async function removeTarget(
    id: string
  ): Promise<{ removedReleases: number; removedArchives: number }> {
    const target = Object.values(targetsByEnv.value)
      .flat()
      .find((t) => t.id === id)
    const envId = target?.environmentId ?? currentEnvId.value

    const r = await api.targets.remove(id)
    if (currentTargetId.value === id) currentTargetId.value = null
    if (envId) await fetchTargets(envId)
    await refreshEnvCounts()
    return r
  }

  /**
   * 体检（只读）。
   * 传 id 查已保存的目标；传 input 查表单里的草稿目标 ——
   * 后者是"向导里实时体检"的关键，否则用户只能先保存再发现不可用。
   */
  async function healthCheck(params: { id?: string; input?: TargetInput }): Promise<HealthReport> {
    return api.targets.healthCheck(params)
  }

  /** 仅推导归档目录（不连服务器），供表单实时预览。 */
  async function previewArchiveDir(
    remotePath: string,
    archiveDir?: string | null
  ): Promise<string> {
    return api.targets.previewArchiveDir(remotePath, archiveDir)
  }

  /* ------------------------------------------------- 本地产物（B11） */

  /** 当前已经取到的产物信息（未取过时 undefined，UI 据此区分"还没查"与"查过没有"）。 */
  function artifactInfoOf(targetId: string): LocalArtifactInfo | undefined {
    return artifactByTarget.value[targetId]
  }

  /**
   * 重新探测本地产物。
   *
   * 失败**不抛给调用方**：详情页上这一块是辅助信息，它坏掉不该让整个页面报错；
   * 失败时把结果清掉，UI 会回到"点一下查询"的状态。
   */
  async function refreshArtifactInfo(targetId: string): Promise<LocalArtifactInfo | null> {
    try {
      const info = await api.targets.artifactStat(targetId)
      artifactByTarget.value = { ...artifactByTarget.value, [targetId]: info }
      return info
    } catch (e) {
      error.value = (e as IpcBusinessError).toUserText()
      return null
    }
  }

  /** 弹出系统对话框选择本地产物（渲染进程没有 fs，只能走主进程）。 */
  async function pickLocalArtifact(input: PickArtifactInput): Promise<string | null> {
    const r = await api.app.pickArtifact(input)
    return r?.path ?? null
  }

  /** 在文件管理器里打开/选中本地路径；返回失败原因（成功为 null）。 */
  async function revealLocalPath(path: string): Promise<string | null> {
    const r = await api.app.revealPath(path)
    return r.ok ? null : (r.reason ?? '打开失败')
  }

  /** 在本机终端里打开本地目录；返回失败原因（成功为 null）。 */
  async function openLocalTerminal(path: string): Promise<string | null> {
    const r = await api.app.openTerminal(path)
    return r.ok ? null : (r.reason ?? '打开失败')
  }

  /**
   * 保存本地产物配置（路径 + 排除规则）—— T11.1 的"配置保存后能读到"。
   *
   * 走 `updateTarget` 而不是另开一个通道：本地产物是目标的一部分，
   * 它必须在**同一次**写入里生效（分开写会出现"路径更新了、排除规则没更新"的中间态）。
   */
  async function saveLocalArtifact(
    id: string,
    patch: { localPath: string | null; localExclude?: string[] }
  ): Promise<TargetView> {
    const updated = await updateTarget(id, patch)
    // 配置变了，缓存里的产物信息立刻作废（否则徽标会显示上一个路径的结论）
    await refreshArtifactInfo(id)
    return updated
  }

  return {
    // state
    environments,
    targetsByEnv,
    artifactByTarget,
    currentEnvId,
    currentTargetId,
    loading,
    loaded,
    error,
    // getters
    currentEnv,
    currentTargets,
    currentTarget,
    isEmpty,
    isProd,
    // actions
    fetchEnvironments,
    fetchTargets,
    refreshTargets,
    selectEnvironment,
    selectTarget,
    createEnvironment,
    updateEnvironment,
    describeEnvRemoval,
    removeEnvironment,
    createTarget,
    updateTarget,
    removeTarget,
    healthCheck,
    previewArchiveDir,
    artifactInfoOf,
    refreshArtifactInfo,
    pickLocalArtifact,
    revealLocalPath,
    openLocalTerminal,
    saveLocalArtifact
  }
})
