<script setup lang="ts">
/**
 * 独立版的画布面板:自己的工具栏 + 共用画布本体。
 *
 * 画布本体(挂载、只读预览、属性面板)在 `src/editor/CanvasView.vue`;
 * 插件有自己的 Shell 和工具栏,不会复用这里的文件入口。
 */
import { ref } from 'vue'
import { FolderOpen } from 'lucide-vue-next'
import type { CanvasRuntime } from '../../../engine/runtime'
import CanvasView from '../../../editor/CanvasView.vue'
import CanvasToolbar from './CanvasToolbar.vue'
import ShapePanel from './ShapePanel.vue'

defineProps<{
  runtime: CanvasRuntime
  /** 只有用户主动新建画布时才展示空白画布/模板卡片 */
  welcome: boolean
  /** 单独打开的只读文件:保留一条「返回仓库」的窄条 */
  showBack?: boolean
}>()
const emit = defineEmits<{
  (e: 'file-action', action: 'new' | 'open' | 'save' | 'export-png' | 'back'): void
}>()

const shapePanelOpen = ref(false)
</script>

<template>
  <div class="canvas-pane" data-idraw-canvas-pane>
    <CanvasToolbar
      v-if="!runtime.readOnly"
      :runtime="runtime"
      :shapes-open="shapePanelOpen"
      @toggle-shapes="shapePanelOpen = !shapePanelOpen"
    />
    <!-- 只读的外部 SVG 没有编辑工具栏,但临时打开的只读文件仍要能回到仓库选择页 -->
    <div v-else-if="showBack" class="canvas-readonly-nav">
      <button
        class="canvas-readonly-back"
        data-action="back-to-picker"
        title="返回仓库选择"
        @click="emit('file-action', 'back')"
      >
        <FolderOpen :size="15" />
        返回仓库
      </button>
    </div>
    <!--
      空白画布/模板卡片只在用户主动「新建画布」时出现;打开已有画布或
      从选择页进入临时画布时不弹。Boolean prop 缺省会被 Vue 转成 false,
      App 会显式传 welcome。
    -->
    <CanvasView :runtime="runtime" :welcome="welcome" />

    <Transition name="shape-drawer">
      <ShapePanel
        v-if="shapePanelOpen && !runtime.readOnly"
        :runtime="runtime"
        @close="shapePanelOpen = false"
      />
    </Transition>
  </div>
</template>
