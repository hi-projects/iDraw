<script setup lang="ts">
/**
 * 形状面板里的线稿预览。
 *
 * 直接复用引擎的 shapeParts,所以面板里看到的轮廓与真正画到画布上的形状一致;
 * 预览只用细描边、不填充,风格接近线稿图标库。
 */
import { computed } from 'vue'
import type { CanvasNode, ShapeKind } from '../engine/model'
import { NODE_DEFAULTS } from '../engine/model'
import { shapeParts } from '../engine/shapes'

const props = defineProps<{ shape: ShapeKind }>()

function escapeAttr(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

const svg = computed(() => {
  if (props.shape === 'text') {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 24 24"><text x="11" y="18" text-anchor="middle" font-size="17" font-weight="600" fill="currentColor">T</text></svg>'
  }
  const node: CanvasNode = {
    id: 'preview',
    shape: props.shape,
    x: 0,
    y: 0,
    w: 22,
    h: 22,
    text: '',
    style: {
      ...NODE_DEFAULTS,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      radius: 5
    }
  }
  const inner = shapeParts(node)
    .map(part => {
      const attrs = Object.entries(part.attrs)
        .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
        .join(' ')
      return `<${part.tag} ${attrs} />`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 24 24">${inner}</svg>`
})
</script>

<template>
  <span class="shape-preview" aria-hidden="true" v-html="svg"></span>
</template>
