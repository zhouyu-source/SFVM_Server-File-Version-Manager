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

/* ------------------------------------------------------- 回滚标记（B19） */

/**
 * 「版本」列里跟在版本号后面的回滚标记。
 *
 * 从 `releases` 派生（主进程 `archive.list` 里算好），三种身份：
 *
 * - **回滚而来**：这一版就是当前线上版本 —— 某次回滚把它恢复了上去；
 * - **回滚归档**：这一版是某次回滚把**当时的线上版本**归档出来的产物；
 * - **已被回滚取代**：这一版曾经在线上，后来被下一次回滚换掉了。
 *
 * 前两种与第三种可以叠加：一版先被回滚到线上、之后又被换掉。这时两个标记都显示 ——
 * "它从哪来"和"它现在还在不在线上"是两个不同的问题，答案不同就要都说出来。
 *
 * 标记一律挂 `data-test`：这是 E2E 的契约，以后改文案/换图标不该让用例失效。
 */
function rollbackMarks(row: ArchiveView): VNode | null {
  const nodes: VNode[] = []
  const mark = row.rollback
  const when = (at: string | null): string => (at ? `（${formatDateTime(at)}）` : '')

  if (mark) {
    const isSource = mark.role === 'source'
    const tip = isSource
      ? `这一版就是当前的线上版本 —— 由回滚恢复${when(mark.at)}`
      : `这是回滚时把当时的线上版本归档出来的产物 —— 那次回滚恢复的是 ${mark.toVersionTag}${when(mark.at)}`
    nodes.push(
      h(
        ElTooltip,
        { content: tip, placement: 'top', showAfter: 300 },
        {
          default: () =>
            h(
              ElTag,
              {
                size: 'small',
                type: isSource ? 'success' : 'warning',
                'data-test': isSource
                  ? `arch-rollback-source-${row.versionTag}`
                  : `arch-rollback-archived-${row.versionTag}`
              },
              () => (isSource ? '回滚版本' : '回滚归档')
            )
        }
      )
    )
  }

  if (row.supersededByRollbackAt) {
    nodes.push(
      h(
        ElTooltip,
        {
          content: `这一版的内容已经被后来的回滚取代，不在线上了${when(row.supersededByRollbackAt)}`,
          placement: 'top',
          showAfter: 300
        },
        {
          default: () =>
            h(
              ElTag,
              { size: 'small', type: 'info', 'data-test': `arch-superseded-${row.versionTag}` },
              () => '已被回滚取代'
            )
        }
      )
    )
  }

  return nodes.length > 0 ? h('div', { class: 'arch-marks' }, nodes) : null
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
    // 320：版本号本身 22 字符等宽约 154px，后面还要容下最多两个标记 tag
    width: 320,
    cellRenderer: ({ rowData }: { rowData: ArchiveView }) => {
      const marks = rollbackMarks(rowData)
      return h('div', { class: 'arch-version-cell' }, [
        h('span', { class: 'mono', 'data-test': 'arch-version' }, rowData.versionTag),
        ...(marks ? [marks] : [])
      ])
    }
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
/* 版本号 + 回滚标记同排。
   两个选择器都写：`h()` 创建的节点会带上本组件的 scopeId（普通选择器命中），
   而 `:deep()` 形式与上面 `.arch-actions` 一致、万一层级不同也能兜住。
   这里不图好看，只图**绝不折行** —— 折行会顶破写死的 `row-height: 42`。 */
:deep(.arch-version-cell),
.arch-version-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
}
:deep(.arch-marks),
.arch-marks {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}
</style>
