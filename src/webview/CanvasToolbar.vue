<script setup lang="ts">
/**
 * iMark 插件里的画布工具栏。
 *
 * 与独立版分开维护:这里用 iMark 的紧凑图标按钮,文件入口只保留打开/保存/新建;
 * 窗口标题、面板标题和主菜单都由 iMark 提供。
 */
import { ref } from 'vue'
import {
  Download,
  FolderOpen,
  Grid2x2,
  Grid3x3,
  Hand,
  Maximize2,
  MousePointer2,
  Plus,
  Redo2,
  Save,
  Spline,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut
} from 'lucide-vue-next'
import type { ShapeKind } from '../engine/model'
import type { CanvasRuntime } from '../engine/runtime'

const props = defineProps<{ runtime: CanvasRuntime }>()
const emit = defineEmits<{ (e: 'file-action', action: 'new' | 'open' | 'save'): void }>()

const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: 'rect', label: '矩形' },
  { kind: 'roundRect', label: '圆角矩形' },
  { kind: 'ellipse', label: '椭圆' },
  { kind: 'diamond', label: '菱形' },
  { kind: 'parallelogram', label: '平行四边形' },
  { kind: 'hexagon', label: '六边形' },
  { kind: 'cylinder', label: '圆柱' },
  { kind: 'document', label: '文档' },
  { kind: 'text', label: '文本' }
]

const shapesOpen = ref(false)

function pickShape(kind: ShapeKind): void {
  shapesOpen.value = false
  props.runtime.setPendingShape(kind)
}

function toggleShapes(): void {
  if (props.runtime.ui.readOnly) return
  shapesOpen.value = !shapesOpen.value
}

function zoomPercent(): string {
  return `${Math.round(props.runtime.ui.scale * 100)}%`
}
</script>

<template>
  <div class="canvas-toolbar imark-toolbar" role="toolbar" aria-label="画布工具">
    <div class="canvas-tool-group">
      <button class="canvas-tool-btn" title="新建 (Ctrl+N)" @click="emit('file-action', 'new')">
        <Plus :size="16" />
      </button>
      <button class="canvas-tool-btn" title="打开 (Ctrl+O)" @click="emit('file-action', 'open')">
        <FolderOpen :size="16" />
      </button>
      <button class="canvas-tool-btn" title="保存 (Ctrl+S)" @click="emit('file-action', 'save')">
        <Save :size="16" />
      </button>
    </div>

    <div class="canvas-tool-group">
      <button
        class="canvas-tool-btn"
        :class="{ active: runtime.ui.tool === 'select' }"
        title="选择 (V)"
        @click="runtime.setTool('select')"
      >
        <MousePointer2 :size="16" />
      </button>
      <button
        class="canvas-tool-btn"
        :class="{ active: runtime.ui.tool === 'pan' }"
        title="平移 (H / 按住空格)"
        @click="runtime.setTool('pan')"
      >
        <Hand :size="16" />
      </button>
      <button
        class="canvas-tool-btn"
        :class="{ active: runtime.ui.tool === 'edge' }"
        title="连接线 (L)"
        @click="runtime.setTool('edge')"
      >
        <Spline :size="16" />
      </button>
      <button
        class="canvas-tool-btn"
        :class="{ active: runtime.ui.tool === 'text' }"
        title="文本 (T)"
        @click="runtime.setTool('text')"
      >
        <Type :size="16" />
      </button>
    </div>

    <div class="canvas-tool-group canvas-shape-wrap">
      <button
        class="canvas-tool-btn canvas-shape-toggle"
        :class="{ active: shapesOpen || runtime.ui.tool === 'shape' }"
        title="形状"
        @click="toggleShapes"
      >
        形状
      </button>
      <div v-if="shapesOpen" class="canvas-shape-mask" @click="shapesOpen = false" />
      <div v-if="shapesOpen" class="canvas-shape-menu">
        <button
          v-for="shape in SHAPES"
          :key="shape.kind"
          class="canvas-shape-item"
          :class="{ active: runtime.ui.pendingShape === shape.kind }"
          @click="pickShape(shape.kind)"
        >
          {{ shape.label }}
        </button>
      </div>
    </div>

    <div class="canvas-tool-group">
      <button
        class="canvas-tool-btn"
        title="撤销 (Ctrl+Z)"
        :disabled="!runtime.ui.canUndo"
        @click="runtime.undo()"
      >
        <Undo2 :size="16" />
      </button>
      <button
        class="canvas-tool-btn"
        title="重做 (Ctrl+Shift+Z)"
        :disabled="!runtime.ui.canRedo"
        @click="runtime.redo()"
      >
        <Redo2 :size="16" />
      </button>
    </div>

    <div class="canvas-tool-group">
      <button
        class="canvas-tool-btn"
        :class="{ active: runtime.ui.snap }"
        title="网格吸附"
        @click="runtime.setSnap(!runtime.ui.snap)"
      >
        <Grid3x3 :size="16" />
      </button>
      <button
        class="canvas-tool-btn"
        :class="{ active: runtime.ui.gridVisible }"
        :title="runtime.ui.gridVisible ? '隐藏网格' : '显示网格'"
        @click="runtime.setGridVisible(!runtime.ui.gridVisible)"
      >
        <Grid2x2 :size="16" />
      </button>
    </div>

    <div class="canvas-toolbar-spacer"></div>

    <div class="canvas-tool-group canvas-zoom">
      <button class="canvas-tool-btn" title="缩小" @click="runtime.zoomOut()">
        <ZoomOut :size="16" />
      </button>
      <button class="canvas-tool-btn canvas-zoom-label" title="重置视图" @click="runtime.resetZoom()">
        {{ zoomPercent() }}
      </button>
      <button class="canvas-tool-btn" title="放大" @click="runtime.zoomIn()">
        <ZoomIn :size="16" />
      </button>
      <button class="canvas-tool-btn" title="初始视图" @click="runtime.fitScreen()">
        <Maximize2 :size="16" />
      </button>
      <button class="canvas-tool-btn" title="适应内容" @click="runtime.fitContent()">适应内容</button>
    </div>

    <div class="canvas-tool-group">
      <button class="canvas-tool-btn" title="导出 PNG" @click="runtime.exportPng()">
        <Download :size="16" />
      </button>
    </div>
  </div>
</template>
