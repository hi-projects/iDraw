<script setup lang="ts">
/**
 * 独立版的画布面板:自己的工具栏 + 共用画布本体。
 *
 * 画布本体(挂载、只读预览、属性面板)在 `src/editor/CanvasView.vue`;
 * 插件有自己的 Shell 和工具栏,不会复用这里的文件入口。
 */
import type { CanvasRuntime } from '../../../engine/runtime'
import CanvasView from '../../../editor/CanvasView.vue'
import CanvasToolbar from './CanvasToolbar.vue'

defineProps<{ runtime: CanvasRuntime }>()
const emit = defineEmits<{ (e: 'file-action', action: 'new' | 'open' | 'save'): void }>()
</script>

<template>
  <div class="canvas-pane" data-idraw-canvas-pane>
    <CanvasToolbar
      v-if="!runtime.readOnly"
      :runtime="runtime"
      @file-action="emit('file-action', $event)"
    />
    <!-- 独立版的启动页在 App 层处理,进入编辑器后不再叠引导卡片 -->
    <CanvasView :runtime="runtime" :welcome="false" />
  </div>
</template>
