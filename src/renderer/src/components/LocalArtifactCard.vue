<script setup lang="ts">
/**
 * 本地产物卡片（B11 / T11.1 配置表单 + T11.2 过期徽标 + T11.7 打开外壳）。
 *
 * ## 三个设计取舍
 *
 * 1. **探测与配置分开**：卡片一打开就探测（只 stat + 目录遍历，不连服务器、
 *    不算哈希），所以配置区默认是**只读**的 —— 想改才点"修改"。这样最常见
 *    的场景（"我构建完了，看一眼对不对"）零点击即可完成。
 * 2. **过期只提示不阻止**：徽标是 `warning` 而不是 `error`，文案里也写清
 *    "不会阻止发布"。一个稳定的产物几天不动是正常的，把它当错误拦下来
 *    只会训练用户无视提示（方案书 T11.2）。
 * 3. **两个"打开"按钮语义不同**：目录用 `openPath`（进去看），文件用
 *    `showItemInFolder`（选中它）—— 直接打开 `.jar` 会被压缩软件抢走，
 *    那不是用户点这个按钮想要的。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, EditPen, FolderOpened, Monitor, Refresh } from '@element-plus/icons-vue'
import { useWorkspaceStore } from '../stores/workspace'
import { IpcBusinessError } from '../api'
import { formatBytes } from '../utils/format'
import type { TargetView } from '../../../shared/contracts/workspace'

const props = defineProps<{ target: TargetView }>()
const emit = defineEmits<{ saved: [] }>()

const ws = useWorkspaceStore()

const editing = ref(false)
const saving = ref(false)
const pathDraft = ref('')
const excludeDraft = ref('')

const info = computed(() => ws.artifactInfoOf(props.target.id))
const configured = computed(() => Boolean(props.target.localPath))
const exists = computed(() => info.value?.exists === true)

/** 徽标集合：一条都不显示时说明"一切正常"。 */
const badges = computed(() => {
  const out: Array<{ text: string; type: 'success' | 'warning' | 'danger' | 'info' }> = []
  const i = info.value
  if (!i) return out
  if (!configured.value) return out
  if (!i.exists) {
    out.push({ text: '本地路径不存在', type: 'danger' })
    return out
  }
  if (i.kindMismatch) out.push({ text: i.kindMismatch, type: 'danger' })
  // 文件名不一致**不影响能否发布**（发布时按配置的名字上传），所以是 warning 而不是
  // danger —— 它要回答的是"发上去以后叫什么名字"。完整说明在下方 hint 行里。
  if (i.nameMismatch) out.push({ text: '文件名与服务器端不一致', type: 'warning' })
  if (i.possiblyStale) out.push({ text: `可能过期 · ${i.ageText ?? ''}`, type: 'warning' })
  else if (i.ageText) out.push({ text: `最近变动 ${i.ageText}`, type: 'success' })
  return out
})

const summaryText = computed(() => {
  const i = info.value
  if (!i || !i.exists) return ''
  const parts: string[] = []
  if (i.fileCount !== null) parts.push(`${i.fileCount} 个文件`)
  if (i.totalBytes !== null) parts.push(formatBytes(i.totalBytes))
  if (i.kind) parts.push(i.kind === 'dir' ? '目录' : '文件')
  return parts.join(' · ')
})

async function refresh(): Promise<void> {
  if (props.target.localPath) await ws.refreshArtifactInfo(props.target.id)
}

watch(
  () => [props.target.id, props.target.localPath],
  () => {
    editing.value = false
    void refresh()
  },
  { immediate: true }
)

function beginEdit(): void {
  pathDraft.value = props.target.localPath ?? ''
  excludeDraft.value = props.target.localExclude.join('\n')
  editing.value = true
}

async function pick(): Promise<void> {
  try {
    const picked = await ws.pickLocalArtifact({
      kind: props.target.kind,
      current: pathDraft.value || props.target.localPath
    })
    if (picked) pathDraft.value = picked
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    const exclude = excludeDraft.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    await ws.saveLocalArtifact(props.target.id, {
      localPath: pathDraft.value.trim() || null,
      localExclude: exclude
    })
    editing.value = false
    ElMessage.success('本地产物配置已保存')
    emit('saved')
  } catch (e) {
    ElMessage.error((e as IpcBusinessError).toUserText())
  } finally {
    saving.value = false
  }
}

/** T11.7：打开所在目录 / 在终端中打开。失败时把**原因**说出来，不静默。 */
async function openShell(which: 'reveal' | 'terminal'): Promise<void> {
  const p = props.target.localPath
  if (!p) return
  const reason = which === 'reveal' ? await ws.revealLocalPath(p) : await ws.openLocalTerminal(p)
  if (reason) ElMessage.warning(reason)
}

const placehoder = computed(() =>
  props.target.kind === 'dir' ? 'D:\\build\\dist' : 'D:\\build\\order.jar'
)
</script>

<template>
  <div class="artifact">
    <el-descriptions :column="2" border size="small">
      <el-descriptions-item label="本地产物">
        <template v-if="configured">
          <span class="mono">{{ target.localPath }}</span>
        </template>
        <span v-else class="muted">未配置</span>
      </el-descriptions-item>

      <el-descriptions-item label="内容">
        <span v-if="summaryText">{{ summaryText }}</span>
        <span v-else-if="configured && info && !info.exists" class="danger">路径不存在</span>
        <span v-else class="muted">—</span>
      </el-descriptions-item>

      <el-descriptions-item label="排除规则">
        <template v-if="target.localExclude.length">
          <el-tag v-for="e in target.localExclude" :key="e" size="small" class="mr">{{ e }}</el-tag>
        </template>
        <span v-else class="muted">无</span>
      </el-descriptions-item>

      <el-descriptions-item label="状态">
        <template v-if="badges.length">
          <el-tag
            v-for="b in badges"
            :key="b.text"
            :type="b.type"
            size="small"
            class="mr"
            :title="b.type === 'warning' ? '仅提示，不会阻止发布' : undefined"
            >{{ b.text }}</el-tag
          >
        </template>
        <span v-else class="muted">—</span>
      </el-descriptions-item>
    </el-descriptions>

    <div v-if="info?.kindMismatch" class="hint warn">{{ info.kindMismatch }}</div>
    <div v-else-if="info?.nameMismatch" class="hint warn" data-test="artifact-name-mismatch">
      {{ info.nameMismatch }}。仅提示，不会阻止发布。
    </div>
    <div v-else-if="info?.possiblyStale" class="hint warn">
      最近一次变动是 {{ info.ageText }}，可能不是刚构建的产物。仅提示，不会阻止发布。
    </div>

    <!-- 编辑态（T11.1）：路径选择 + 排除规则 -->
    <div v-if="editing" class="editor">
      <el-form label-width="86px" size="small">
        <el-form-item :label="target.kind === 'dir' ? '产物目录' : '产物文件'">
          <el-input v-model="pathDraft" :placeholder="placehoder" class="path-input" />
          <el-button class="ml" :icon="FolderOpened" @click="pick">浏览…</el-button>
        </el-form-item>
        <el-form-item label="排除规则">
          <el-input
            v-model="excludeDraft"
            type="textarea"
            :rows="3"
            placeholder="每行一条，如 *.map"
          />
          <div class="hint">上传时按此过滤本地文件；支持 <code>*</code> 通配</div>
        </el-form-item>
      </el-form>
    </div>

    <div class="actions">
      <template v-if="editing">
        <el-button size="small" type="primary" :icon="Check" :loading="saving" @click="save">
          保存
        </el-button>
        <el-button size="small" @click="editing = false">取消</el-button>
      </template>
      <template v-else>
        <el-button size="small" :icon="EditPen" @click="beginEdit">
          {{ configured ? '修改配置' : '配置本地产物' }}
        </el-button>
        <el-button
          size="small"
          :icon="FolderOpened"
          :disabled="!exists"
          @click="openShell('reveal')"
        >
          打开所在目录
        </el-button>
        <el-button
          size="small"
          :icon="Monitor"
          :disabled="!exists || info?.kind !== 'dir'"
          @click="openShell('terminal')"
        >
          在终端中打开
        </el-button>
        <el-button size="small" text :icon="Refresh" @click="refresh">重新探测</el-button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.artifact {
  margin-bottom: 8px;
}
.mono {
  font-family: Consolas, Monaco, monospace;
  word-break: break-all;
}
.muted {
  color: #c0c4cc;
}
.danger {
  color: #f56c6c;
}
.mr {
  margin-right: 4px;
}
.ml {
  margin-left: 8px;
}
.hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.7;
  margin: 6px 0 0;
}
.hint.warn {
  color: #e6a23c;
}
.hint code {
  background: #f5f7fa;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: Consolas, Monaco, monospace;
}
.editor {
  margin-top: 12px;
  padding: 12px 12px 0;
  background: #fafafa;
  border-radius: 4px;
}
.path-input {
  width: calc(100% - 90px);
}
.actions {
  margin-top: 10px;
}
</style>
