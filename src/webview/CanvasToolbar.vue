<script setup lang="ts">
/**
 * iMark 插件里的画布工具栏。
 *
 * 与独立版分开维护:这里用 iMark 的紧凑图标按钮。新建 / 打开 / 保存、选择 /
 * 平移 / 连线 / 文本和撤销 / 重做都不再占工具栏位(快捷键与命令仍然可用);
 * 导出 PNG 也只保留在命令/菜单里。形状入口改为「插入」,在上方弹出与独立版
 * 一致的分组形状面板。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Grid2x2, Grid3x3, Maximize2, ZoomIn, ZoomOut } from 'lucide-vue-next'
import type { ShapeKind } from '../engine/model'
import type { CanvasRuntime } from '../engine/runtime'
import { SHAPE_GROUPS } from '../editor/shapeCatalog'
import ShapePreview from '../editor/ShapePreview.vue'

const props = defineProps<{ runtime: CanvasRuntime }>()

const insertOpen = ref(false)

function pickShape(kind: ShapeKind): void {
  insertOpen.value = false
  props.runtime.setPendingShape(kind)
  props.runtime.focus()
}

function toggleInsert(): void {
  if (props.runtime.ui.readOnly) return
  insertOpen.value = !insertOpen.value
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && insertOpen.value) insertOpen.value = false
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function zoomPercent(): string {
  return `${Math.round(props.runtime.ui.scale * 100)}%`
}
</script>

<template>
  <div class="canvas-toolbar imark-toolbar" role="toolbar" aria-label="画布工具">
    <div class="canvas-tool-group canvas-insert-wrap">
      <button
        class="canvas-tool-btn canvas-insert-toggle"
        :class="{ active: insertOpen || runtime.ui.tool === 'shape' }"
        title="插入"
        @click="toggleInsert"
      >
        插入
      </button>
      <div v-if="insertOpen" class="canvas-insert-mask" @click="insertOpen = false" />
      <div v-if="insertOpen" class="canvas-insert-panel" aria-label="插入">
        <section v-for="group in SHAPE_GROUPS" :key="group.title" class="shape-group">
          <div class="shape-group-title">{{ group.title }}</div>
          <div class="shape-grid">
            <button
              v-for="item in group.items"
              :key="item.kind"
              class="shape-item"
              :class="{ active: runtime.ui.pendingShape === item.kind }"
              type="button"
              @click="pickShape(item.kind)"
            >
              <ShapePreview :shape="item.kind" />
              <span>{{ item.label }}</span>
            </button>
          </div>
        </section>
      </div>
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
      <button class="canvas-tool-btn canvas-zoom-label" title="重置为 100%" @click="runtime.resetZoom()">
        {{ zoomPercent() }}
      </button>
      <button class="canvas-tool-btn" title="放大" @click="runtime.zoomIn()">
        <ZoomIn :size="16" />
      </button>
      <button class="canvas-tool-btn" title="适应画布" @click="runtime.fitScreen()">
        <Maximize2 :size="16" />
      </button>
      <button class="canvas-tool-btn" title="适应内容" @click="runtime.fitContent()">适应内容</button>
    </div>
  </div>
</template>
