<script setup lang="ts">
/**
 * 版本明细抽屉（B12 / T12.7）。
 *
 * 打开与翻页都会**读一次远端 `manifest.json`** —— 内容清单的唯一真相在那儿
 * （方案书 §5.3），台账里只有汇总数字。服务端分页：一个上千文件的归档不会
 * 把整份 relPath 列表灌进渲染进程。
 *
 * 顺带把 manifest 的**告警**（更高版本的 schema、不认识的字段）显示出来：
 * 那些字段多半来自"更新版应用写下的归档"，静默忽略会让用户以为这台机器
 * 看全了所有信息。
 */
import { computed, ref, watch } from 'vue'
import { api, IpcBusinessError } from '../api'
import { formatBytes, formatDateTime } from '../utils/format'
import {
  ARCHIVE_DETAIL_DEFAULT_LIMIT,
  archiveStatusTagType,
  describeArchiveStatus,
  type ArchiveDetail,
  type ArchiveView
} from '../../../shared/contracts/archive'

const props = defineProps<{
  modelValue: boolean
  archive: ArchiveView | null
}>()

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

const detail = ref<ArchiveDetail | null>(null)
const loading = ref(false)
const error = ref('')
const page = ref(1)

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const totalPages = computed(() =>
  detail.value ? Math.max(1, Math.ceil(detail.value.total / detail.value.limit)) : 1
)

async function load(offset = 0): Promise<void> {
  const a = props.archive
  if (!a) return
  loading.value = true
  error.value = ''
  try {
    detail.value = await api.archives.detail({
      archiveId: a.id,
      offset,
      limit: ARCHIVE_DETAIL_DEFAULT_LIMIT
    })
  } catch (e) {
    detail.value = null
    error.value = (e as IpcBusinessError).toUserText()
  } finally {
    loading.value = false
  }
}

function changePage(p: number): void {
  page.value = p
  void load((p - 1) * ARCHIVE_DETAIL_DEFAULT_LIMIT)
}

watch(
  () => props.modelValue,
  (v) => {
    if (!v) return
    page.value = 1
    void load(0)
  },
  { immediate: true }
)

watch(
  () => props.archive?.id,
  () => {
    if (props.modelValue) {
      page.value = 1
      void load(0)
    }
  }
)
</script>

<template>
  <el-drawer v-model="open" size="720px" :title="`版本明细 · ${archive?.versionTag ?? ''}`">
    <div v-loading="loading" class="detail-body">
      <el-alert
        v-if="error"
        type="error"
        show-icon
        :closable="false"
        :title="error"
        data-test="archive-detail-error"
      />

      <template v-if="detail">
        <div v-if="detail.warnings.length" class="mb8">
          <el-alert type="warning" show-icon :closable="false" title="清单提示">
            <ul class="warn-list">
              <li v-for="(w, i) in detail.warnings" :key="i">{{ w }}</li>
            </ul>
          </el-alert>
        </div>

        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="目标名">{{ detail.manifest.targetName }}</el-descriptions-item>
          <el-descriptions-item label="归档时路径">
            <span class="mono">{{ detail.manifest.originalPath }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="类型">
            {{ detail.manifest.kind === 'dir' ? '目录' : '文件' }}
          </el-descriptions-item>
          <el-descriptions-item label="归档时间">
            {{ formatDateTime(detail.manifest.archivedAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="文件数">{{ detail.manifest.fileCount }}</el-descriptions-item>
          <el-descriptions-item label="总大小">
            {{ formatBytes(detail.manifest.totalBytes) }}
          </el-descriptions-item>
          <el-descriptions-item label="清单版本">
            v{{ detail.manifest.schemaVersion }}
          </el-descriptions-item>
          <el-descriptions-item label="操作人">
            {{ detail.manifest.operator ?? '（未记录）' }}
          </el-descriptions-item>
          <el-descriptions-item label="根指纹" :span="2">
            <span class="mono" data-test="detail-root-hash">{{ detail.manifest.rootHash }}</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.manifest.note" label="备注" :span="2">
            {{ detail.manifest.note }}
          </el-descriptions-item>
          <el-descriptions-item label="台账状态">
            <el-tag size="small" :type="archiveStatusTagType(archive?.status ?? 'valid')">
              {{ describeArchiveStatus(archive?.status ?? 'valid') }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="读取耗时">{{ detail.durationMs }} ms</el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">
          文件清单（共 {{ detail.total }} 个，本页 {{ detail.files.length }} 个）
        </el-divider>

        <el-table :data="detail.files" size="small" border height="320" data-test="detail-files">
          <el-table-column type="index" label="#" width="56" />
          <el-table-column prop="relPath" label="相对路径" min-width="260">
            <template #default="{ row }">
              <span class="mono">{{ row.relPath }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="size" label="大小" width="100" align="right">
            <template #default="{ row }">{{ formatBytes(row.size) }}</template>
          </el-table-column>
          <el-table-column prop="hash" label="SHA-256" width="140">
            <template #default="{ row }">
              <span class="mono" :title="row.hash">{{ row.hash.slice(0, 12) }}…</span>
            </template>
          </el-table-column>
        </el-table>

        <div class="pager">
          <el-pagination
            v-model:current-page="page"
            :page-size="detail.limit"
            :total="detail.total"
            layout="prev, pager, next, total"
            background
            small
            @current-change="changePage"
          />
          <span class="muted">共 {{ totalPages }} 页</span>
        </div>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.detail-body {
  min-height: 120px;
}
.mono {
  font-family: Consolas, Monaco, monospace;
  word-break: break-all;
}
.muted {
  color: #909399;
  font-size: 12px;
}
.mb8 {
  margin-bottom: 8px;
}
.warn-list {
  margin: 0;
  padding-left: 18px;
}
.pager {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
</style>
