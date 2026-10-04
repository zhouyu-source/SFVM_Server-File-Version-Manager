<script setup lang="ts">
/**
 * 往期版本表格（B12 / T12.1~T12.2）。
 *
 * ## 为什么用 `el-table-v2`
 *
 * 留着几千个历史版本是真实存在的（每天发布 × 数年）。普通 `el-table` 会把
 * 全部行渲染成 DOM，1000 行就已经明显卡顿；`el-table-v2` 只渲染视口内的行。
 * 代价是它**不支持 `type="selection"`** —— 勾选框、表头全选、行操作按钮
 * 都得用 `cellRenderer` 自己画，这也是本文件里 h() 较多的原因。
 *
 * ## 只负责"画"，不负责"取数"
 *
 * 数据来自 `ArchiveSection`（它才知道怎么拉列表与汇总）。这样表格组件可以
 * 在任何一份 `ArchiveView[]` 上复用，也让"哪一次点击发起了哪个请求"
 * 全部集中在一处，排查起来只有一条线索。
 */
import { computed, h, type Component, type VNode } from 'vue'
import { ElButton, ElCheckbox, ElTag, ElTooltip } from 'element-plus'
import { CircleCheck, Delete, Download, RefreshLeft, View } from '@element-plus/icons-vue'
import { formatBytes, formatDateTime } from '../utils/format'
import {
  archiveStatusTagType,
  describeArchiveStatus,
  type ArchiveView
} from '../../../shared/contracts/archive'
import type { Column } from 'element-plus'

const props = defineProps<{
  rows: ArchiveView[]
  /** 已勾选的归档 id（受控） */
  selectedIds: string[]
  /** 有任务在跑时禁用会改远端状态的操作 */
  busy?: boolean
}>()

const emit = defineEmits<{
  'update:selectedIds': [string[]]
  detail: [ArchiveView]
  download: [ArchiveView]
  remove: [string[]]
  verify: [ArchiveView]
  /** 回滚到这一版（B13） */
  rollback: [ArchiveView]
}>()

const selectedSet = computed(() => new Set(props.selectedIds))

function toggleRow(id: string, checked: boolean): void {
  const next = new Set(props.selectedIds)
  if (checked) next.add(id)
  else next.delete(id)
  emit('update:selectedIds', [...next])
}

const allSelected = computed(
  () => props.rows.length > 0 && props.rows.every((r) => selectedSet.value.has(r.id))
)

function toggleAll(checked: boolean): void {
  emit('update:selectedIds', checked ? props.rows.map((r) => r.id) : [])
}

/* ----------------------------------------------------------- 单元格 */

/**
 * 行内操作按钮：**只放图标，含义交给 tooltip**。
 *
 * 这一列在表格里会重复出现上百次，文字版本（详情/下载/校验/回滚/删除）
 * 加起来会挤掉版本号与时间这些真正需要横向空间的信息。
 * 图标一律配 `aria-label`：鼠标悬停看 tooltip，读屏/自动化测试有名字可用。
 */
function iconAction(
  icon: Component,
  tip: string,
  testId: string,
  onClick: () => void,
  extra: Record<string, unknown> = {}
): VNode {
  return h(
    ElTooltip,
    { content: tip, placement: 'top', showAfter: 300 },
    {
      default: () =>
        h(ElButton, {
          link: true,
          size: 'small',
          icon,
          'data-test': testId,
          'aria-label': tip,
          onClick,
          ...extra
        })
    }
  )
}

/** 行操作。回滚占位到 B13 —— 按钮**存在但禁用**，比"以后再加"更诚实。 */
function actionCell(row: ArchiveView): VNode {
  const tag = row.versionTag
  return h('div', { class: 'arch-actions' }, [
    iconAction(View, '查看这个版本的文件清单', `arch-detail-${tag}`, () => emit('detail', row)),
    iconAction(
      Download,
      '下载这个版本到本机',
      `arch-download-${tag}`,
      () => emit('download', row),
      { type: 'primary', disabled: props.busy }
    ),
    iconAction(CircleCheck, '重新校验远端内容', `arch-verify-${tag}`, () => emit('verify', row)),
    // 回滚（B13）：把这一版恢复成当前版本。它会先归档当前版本再换上去 ——
    // 与"下载"不同，这个动作会改动服务器，所以确认弹窗里会把两版并排摆出来。
    iconAction(
      RefreshLeft,
      '回滚到这一版（会把当前版本先归档）',
      `arch-rollback-${tag}`,
      () => emit('rollback', row),
      { type: 'warning', disabled: props.busy }
    ),
    iconAction(
      Delete,
      '删除这个往期版本',
      `arch-remove-${tag}`,
      () => emit('remove', [row.id]),
      { type: 'danger', disabled: props.busy }
    )
  ])
}

const columns = computed<Column<ArchiveView>[]>(() => [
  {
    key: 'select',
    title: '',
    width: 44,
    align: 'center',
    headerCellRenderer: () =>
      h(ElCheckbox, {
        modelValue: allSelected.value,
        indeterminate: props.selectedIds.length > 0 && !allSelected.value,
        'data-test': 'arch-select-all',
        disabled: props.rows.length === 0,
        'onUpdate:modelValue': (v: string | number | boolean) => toggleAll(Boolean(v))
      }),
    cellRenderer: ({ rowData }: { rowData: ArchiveView }) =>
      h(ElCheckbox, {
        modelValue: selectedSet.value.has(rowData.id),
        'data-test': `arch-select-${rowData.versionTag}`,
        'onUpdate:modelValue': (v: string | number | boolean) => toggleRow(rowData.id, Boolean(v))
      })
  },
  {
    key: 'versionTag',
    title: '版本',
    dataKey: 'versionTag',
    width: 210,
    cellRenderer: ({ rowData }: { rowData: ArchiveView }) =>
      h('span', { class: 'mono', 'data-test': 'arch-version' }, rowData.versionTag)
  },
  {
    key: 'archivedAt',
    title: '归档时间',
    dataKey: 'archivedAt',
    width: 160,
    cellRenderer: ({ rowData }: { rowData: ArchiveView }) =>
      h('span', {}, formatDateTime(rowData.archivedAt))
  },
  {
    key: 'totalBytes',
    title: '大小',
    dataKey: 'totalBytes',
    width: 100,
    align: 'right',
    cellRenderer: ({ rowData }: { rowData: ArchiveView }) =>
      h('span', {}, formatBytes(rowData.totalBytes))
  },
  {
    key: 'fileCount',
    title: '文件数',
    dataKey: 'fileCount',
    width: 84,
    align: 'right',
    cellRenderer: ({ rowData }: { rowData: ArchiveView }) => h('span', {}, String(rowData.fileCount))
  },
  {
    key: 'shortHash',
    title: '指纹',
    dataKey: 'shortHash',
    width: 110,
    cellRenderer: ({ rowData }: { rowData: ArchiveView }) =>
      h('span', { class: 'mono', title: rowData.rootHash }, rowData.shortHash)
  },
  {
    key: 'status',
    title: '状态',
    dataKey: 'status',
    width: 90,
    cellRenderer: ({ rowData }: { rowData: ArchiveView }) =>
      h(
        ElTag,
        { size: 'small', type: archiveStatusTagType(rowData.status), 'data-test': 'arch-status' },
        () => describeArchiveStatus(rowData.status)
      )
  },
  {
    key: 'actions',
    title: '操作',
    width: 150,
    cellRenderer: ({ rowData }: { rowData: ArchiveView }) => actionCell(rowData)
  }
])
</script>

<template>
  <div class="arch-table-wrap" data-test="archive-table">
    <el-auto-resizer v-if="rows.length">
      <template #default="{ width, height }">
        <el-table-v2
          :columns="columns"
          :data="rows"
          :width="width"
          :height="Math.max(180, height)"
          :row-height="42"
          :header-height="38"
          row-key="id"
          fixed
        />
      </template>
    </el-auto-resizer>
    <el-empty v-else description="暂无往期版本" :image-size="60" />
  </div>
</template>

<style scoped>
.arch-table-wrap {
  height: 380px;
}
.mono {
  font-family: Consolas, Monaco, monospace;
}
/* 行内操作按钮排成一行，别换行（换行会让行高对不上 row-height） */
:deep(.arch-actions) {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  white-space: nowrap;
}
</style>
