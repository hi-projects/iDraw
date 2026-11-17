<script setup lang="ts">
/**
 * 画布编辑本体:只负责把运行时挂到 SVG 容器上,以及只读预览与属性面板。
 *
 * 工具栏不在这里 —— 独立版和 iMark 插件各自决定工具栏长什么样、文件入口放哪里。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { CanvasRuntime } from '../engine/runtime'
import { pushNotice } from './notice'
import CanvasStylePanel from './CanvasStylePanel.vue'
import CanvasWelcome from './CanvasWelcome.vue'

const props = defineProps<{ runtime: CanvasRuntime; welcome?: boolean }>()

const host = ref<HTMLElement | null>(null)
/** 用户点了「空白画布」后不再弹出引导卡片,把画布让出来 */
const dismissed = ref(false)
const readOnly = computed(() => props.runtime.readOnly)
const showEmpty = computed(
  () =>
    props.welcome !== false &&
    !readOnly.value &&
    !dismissed.value &&
    props.runtime.ui.nodeCount === 0 &&
    props.runtime.ui.edgeCount === 0
)

function startBlank(): void {
  dismissed.value = true
  props.runtime.focus()
}

function insertTemplate(kind: 'flowchart' | 'gantt'): void {
  props.runtime.insertTemplate(kind)
}

function openTemplateCommunity(): void {
  pushNotice('模板社区正在设计中，敬请期待。')
}
const previewSrc = computed(() => {
  if (!readOnly.value) return null
  const text = props.runtime.text()
  if (!text) return null
  // 只读预览用 data URL:不需要给渲染进程开放文件协议,也不会执行 SVG 里的脚本
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text)
})

/**
 * 可编辑画布的容器只有运行时存在时才渲染,而运行时总是在挂载前就绪。
 * 等容器真正出现再挂渲染器(flush: 'post' 保证 DOM 已经更新)。
 */
watch(
  host,
  (el, previous) => {
    if (previous && previous !== el) props.runtime.detachView()
    if (el) props.runtime.attachView(el)
  },
  { flush: 'post' }
)

onBeforeUnmount(() => {
  // detach 会先 flush(提交正在编辑的文字)
  props.runtime.detachView()
})
</script>

<template>
  <div class="canvas-view">
    <template v-if="readOnly">
      <div class="canvas-readonly-bar">
        <span>{{ runtime.readOnlyInfo?.reason }}</span>
      </div>
      <div class="canvas-readonly-stage">
        <img v-if="previewSrc" class="canvas-readonly-img" :src="previewSrc" alt="SVG 预览" />
        <div v-else class="canvas-readonly-empty">无法显示这个文件</div>
      </div>
    </template>

    <template v-else>
      <div ref="host" class="canvas-surface"></div>
      <CanvasWelcome
        v-if="showEmpty"
        @blank="startBlank"
        @template="insertTemplate"
        @import="openTemplateCommunity"
      />
      <CanvasStylePanel :runtime="runtime" />
    </template>
  </div>
</template>
