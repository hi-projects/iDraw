<script setup lang="ts">
/**
 * 画布工具栏:插入、吸附、网格、缩放。
 *
 * 这里只调用 runtime 的方法,不碰场景对象;按钮的可用状态读 runtime.ui
 * (reactive 摘要)。画布 DOM 由 CanvasPane 挂载,runtime 负责渲染。
 */
import { Grid2x2, Grid3x3, Maximize2, Shapes, ZoomIn, ZoomOut } from 'lucide-vue-next'
import type { CanvasRuntime } from '../../../engine/runtime'

const props = defineProps<{ runtime: CanvasRuntime; shapesOpen?: boolean }>()
const emit = defineEmits<{
  (e: 'toggle-shapes'): void
}>()

function zoomPercent(): string {
  return `${Math.round(props.runtime.ui.scale * 100)}%`
}
</script>

<template>
  <div
    class="canvas-toolbar canvas-ui canvas-toolbar-chrome"
    role="toolbar"
    aria-label="画布工具"
  >
    <div class="canvas-tool-group">
      <button
        class="canvas-tool-btn"
        :class="{ active: shapesOpen || runtime.ui.tool === 'shape' }"
        data-action="toggle-shapes"
        data-tooltip="插入"
        aria-label="插入"
        @click="emit('toggle-shapes')"
      >
        <Shapes :size="14" />
      </button>
    </div>

    <div class="canvas-tool-group">
      <button
        class="canvas-tool-btn"
        :class="{ active: runtime.ui.snap }"
        title="网格吸附"
        @click="runtime.setSnap(!runtime.ui.snap)"
      >
        <Grid3x3 :size="14" />
      </button>
      <button
        class="canvas-tool-btn"
        :class="{ active: runtime.ui.gridVisible }"
        :title="runtime.ui.gridVisible ? '隐藏网格' : '显示网格'"
        @click="runtime.setGridVisible(!runtime.ui.gridVisible)"
      >
        <Grid2x2 :size="14" />
      </button>
    </div>

    <div class="canvas-toolbar-spacer"></div>

    <div class="canvas-tool-group canvas-zoom">
      <button class="canvas-tool-btn" title="缩小" @click="runtime.zoomOut()">
        <ZoomOut :size="14" />
      </button>
      <button class="canvas-tool-btn canvas-zoom-label" title="重置为 100%" @click="runtime.resetZoom()">
        {{ zoomPercent() }}
      </button>
      <button class="canvas-tool-btn" title="放大" @click="runtime.zoomIn()">
        <ZoomIn :size="14" />
      </button>
      <button class="canvas-tool-btn" title="适应画布" @click="runtime.fitScreen()">
        <Maximize2 :size="14" />
      </button>
      <button class="canvas-tool-btn" title="适应内容" @click="runtime.fitContent()">适应内容</button>
    </div>

  </div>
</template>
