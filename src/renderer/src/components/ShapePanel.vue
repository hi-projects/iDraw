<script setup lang="ts">
/**
 * 从画布左侧滑出的「插入」面板。
 *
 * 工具栏上的插入图标负责开合;面板里按「文本 / 基本形状 / 其它」分组展示所有
 * 可用形状。点击某个形状后设置 pendingShape 并收起面板,接下来在画布上拖画。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import type { ShapeKind } from '../../../engine/model'
import type { CanvasRuntime } from '../../../engine/runtime'
import { SHAPE_GROUPS } from '../../../editor/shapeCatalog'
import ShapePreview from '../../../editor/ShapePreview.vue'

const props = defineProps<{ runtime: CanvasRuntime }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const panelEl = ref<HTMLElement | null>(null)
/** 正在从面板把形状拖进画布(拖动中隐藏遮罩,让画布上的实时预览可见) */
const dragging = ref(false)
let drag: {
  kind: ShapeKind
  pointerId: number
  startX: number
  startY: number
  active: boolean
} | null = null
let suppressClick = false

function choose(kind: ShapeKind): void {
  // 刚拖拽过(松手又落回面板)时不要再当成点击去选形状
  if (suppressClick) {
    suppressClick = false
    return
  }
  props.runtime.setPendingShape(kind)
  props.runtime.focus()
  emit('close')
}

function overPanel(event: PointerEvent): boolean {
  const rect = panelEl.value?.getBoundingClientRect()
  if (!rect) return false
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  )
}

function onPointerDown(event: PointerEvent, kind: ShapeKind): void {
  if (event.button !== 0) return
  drag = {
    kind,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false
  }
  // 合成事件/没有活动指针时捕获会抛错,捕获只是锦上添花
  try {
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  } catch {
    /* 忽略 */
  }
}

function onPointerMove(event: PointerEvent): void {
  const state = drag
  if (!state || event.pointerId !== state.pointerId) return
  if (!state.active) {
    if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 4) return
    state.active = true
    dragging.value = true
  }
  if (overPanel(event)) props.runtime.clearInsertPreview()
  else props.runtime.showInsertPreview(state.kind, event.clientX, event.clientY)
}

function finishDrag(event: PointerEvent, cancelled: boolean): void {
  const state = drag
  if (!state || event.pointerId !== state.pointerId) return
  drag = null
  dragging.value = false
  try {
    ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
  } catch {
    /* 忽略 */
  }
  if (!state.active) return
  suppressClick = true
  props.runtime.clearInsertPreview()
  if (cancelled || overPanel(event)) return
  if (props.runtime.insertShapeAt(state.kind, event.clientX, event.clientY)) emit('close')
}

function onPointerUp(event: PointerEvent): void {
  finishDrag(event, false)
}

function onPointerCancel(event: PointerEvent): void {
  finishDrag(event, true)
}

function cancelDrag(): void {
  if (!drag) return
  drag = null
  dragging.value = false
  props.runtime.clearInsertPreview()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('blur', cancelDrag)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('blur', cancelDrag)
  cancelDrag()
})
</script>

<template>
  <div class="shape-panel-layer" :class="{ 'is-dragging': dragging }">
    <div class="shape-panel-mask" @click="emit('close')" />

    <aside ref="panelEl" class="shape-panel" aria-label="插入">
      <header class="shape-panel-head">
        <span>插入</span>
        <button
          class="shape-panel-close"
          type="button"
          data-tooltip="关闭"
          aria-label="关闭"
          @click="emit('close')"
        >
          <X :size="14" />
        </button>
      </header>

      <div class="shape-panel-body">
        <section v-for="group in SHAPE_GROUPS" :key="group.title" class="shape-group">
          <div class="shape-group-title">{{ group.title }}</div>
          <div class="shape-grid">
            <button
              v-for="item in group.items"
              :key="item.kind"
              class="shape-item"
              :class="{ active: runtime.ui.pendingShape === item.kind }"
              type="button"
              @click="choose(item.kind)"
              @pointerdown="onPointerDown($event, item.kind)"
              @pointermove="onPointerMove"
              @pointerup="onPointerUp"
              @pointercancel="onPointerCancel"
            >
              <ShapePreview :shape="item.kind" />
              <span>{{ item.label }}</span>
            </button>
          </div>
        </section>
      </div>
    </aside>
  </div>
</template>
