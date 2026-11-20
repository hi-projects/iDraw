<script setup lang="ts">
/** 底部状态栏:仓库/画布身份与保存状态。自动保存模式要让人一眼看出来。 */
import { computed } from 'vue'
import {
  AlertCircle,
  Cloud,
  CloudOff,
  FileImage,
  FolderOpen,
  Loader2
} from 'lucide-vue-next'
import type { SaveStatus } from '../workspaceTypes'

const props = defineProps<{
  workspaceName: string | null
  docName: string | null
  autoSave: boolean
  hasPath: boolean
  readOnly: boolean
  status: SaveStatus
}>()

const statusText = computed(() => {
  if (props.readOnly) return '只读预览'
  if (props.autoSave) {
    if (props.status === 'saving') return '自动保存中…'
    if (props.status === 'error') return '自动保存失败'
    if (props.status === 'dirty') return '未保存'
    return '已自动保存'
  }
  if (props.status === 'saving') return '保存中…'
  if (props.status === 'error') return '保存失败'
  if (props.status === 'dirty') return '未保存'
  return props.hasPath ? '已保存' : '未保存'
})
</script>

<template>
  <footer class="idraw-statusbar">
    <div class="idraw-status-left">
      <div v-if="$slots.actions" class="idraw-status-actions">
        <slot name="actions" />
      </div>
      <span v-if="$slots.actions" class="idraw-status-divider"></span>
      <template v-if="workspaceName">
        <FolderOpen :size="12" />
        <span class="idraw-status-name">{{ workspaceName }}</span>
        <template v-if="docName">
          <span class="idraw-status-sep">/</span>
          <span class="idraw-status-doc">{{ docName }}</span>
        </template>
      </template>
      <template v-else>
        <FileImage :size="12" />
        <span class="idraw-status-name">临时画布</span>
        <span class="idraw-status-doc">{{ docName }}</span>
      </template>
    </div>

    <div class="idraw-status-right">
      <span v-if="!docName" class="idraw-status-save is-muted">
        选择或新建一张画布
      </span>
      <span v-else-if="readOnly" class="idraw-status-save is-muted">
        <AlertCircle :size="12" />
        {{ statusText }}
      </span>
      <span v-else class="idraw-status-save" :class="{ 'is-dirty': status === 'dirty', 'is-error': status === 'error' }">
        <Loader2 v-if="status === 'saving'" :size="12" class="workspace-spin" />
        <AlertCircle v-else-if="status === 'error'" :size="12" />
        <Cloud v-else-if="autoSave" :size="12" />
        <CloudOff v-else :size="12" />
        <template v-if="autoSave">自动保存 · {{ statusText }}</template>
        <template v-else>不会自动保存 · {{ statusText }}</template>
      </span>
    </div>
  </footer>
</template>
