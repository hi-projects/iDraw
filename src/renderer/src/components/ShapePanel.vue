<script setup lang="ts">
/**
 * 从画布左侧滑出的「插入」面板。
 *
 * 工具栏上的插入图标负责开合;面板里按「文本 / 基本形状 / 其它」分组展示所有
 * 可用形状。点击某个形状后设置 pendingShape 并收起面板,接下来在画布上拖画。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { X } from 'lucide-vue-next'
import type { ShapeKind } from '../../../engine/model'
import type { CanvasRuntime } from '../../../engine/runtime'
import { SHAPE_GROUPS } from '../../../editor/shapeCatalog'
import ShapePreview from '../../../editor/ShapePreview.vue'

const props = defineProps<{ runtime: CanvasRuntime }>()
const emit = defineEmits<{ (e: 'close'): void }>()

function choose(kind: ShapeKind): void {
  props.runtime.setPendingShape(kind)
  props.runtime.focus()
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="shape-panel-layer">
    <div class="shape-panel-mask" @click="emit('close')" />

    <aside class="shape-panel" aria-label="插入">
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
