<script setup lang="ts">
/**
 * 画布属性面板:选中节点/边时出现在右上角。
 *
 * 面板读的是 runtime.ui 里的样式**快照**,写入一律走 applyNodeStyle /
 * applyEdgeStyle —— 场景对象不暴露给视图层,避免面板直接改字段却不进撤销栈。
 */
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  BringToFront,
  ChevronDown,
  ChevronUp,
  MoveHorizontal,
  MoveVertical,
  SendToBack,
  Trash2
} from 'lucide-vue-next'
import { computed } from 'vue'
import type { ArrowMode, EdgeRouting, NodeStyle } from '../engine/model'
import type { CanvasAlignMode, CanvasDistributeMode, CanvasRuntime } from '../engine/runtime'

const props = defineProps<{ runtime: CanvasRuntime }>()

/** 属性面板的快照(选中变化时由 runtime.syncUi 更新) */
const ns = computed(() => props.runtime.ui.nodeStyle)
const es = computed(() => props.runtime.ui.edgeStyle)

function num(e: Event): number {
  return Number((e.target as HTMLInputElement).value)
}

function str(e: Event): string {
  return (e.target as HTMLInputElement | HTMLSelectElement).value
}

function checked(e: Event): boolean {
  return (e.target as HTMLInputElement).checked
}

function patchNode<K extends keyof NodeStyle>(key: K, value: NodeStyle[K]): void {
  props.runtime.applyNodeStyle({ [key]: value } as Partial<NodeStyle>)
}

function applyFill(e: Event): void {
  patchNode('fill', str(e))
}

function toggleNoFill(e: Event): void {
  patchNode('fill', checked(e) ? 'none' : '#ffffff')
}

function applyStroke(e: Event): void {
  patchNode('stroke', str(e))
}

function applyStrokeWidth(e: Event): void {
  patchNode('strokeWidth', Math.max(0, num(e)))
}

function applyDash(e: Event): void {
  patchNode('dash', checked(e))
}

function applyRadius(e: Event): void {
  patchNode('radius', Math.max(0, num(e)))
}

function applyFontSize(e: Event): void {
  patchNode('fontSize', Math.max(6, num(e)))
}

function applyColor(e: Event): void {
  patchNode('color', str(e))
}

function applyBold(): void {
  const style = props.runtime.ui.nodeStyle
  if (style) patchNode('bold', !style.bold)
}

function applyItalic(): void {
  const style = props.runtime.ui.nodeStyle
  if (style) patchNode('italic', !style.italic)
}

function applyAlign(align: NodeStyle['align']): void {
  patchNode('align', align)
}

function applyValign(valign: NodeStyle['valign']): void {
  patchNode('valign', valign)
}

function edgeStroke(e: Event): void {
  props.runtime.applyEdgeStyle({ stroke: str(e) })
}

function edgeWidth(e: Event): void {
  props.runtime.applyEdgeStyle({ strokeWidth: Math.max(0, num(e)) })
}

function edgeDash(e: Event): void {
  props.runtime.applyEdgeStyle({ dash: checked(e) })
}

function edgeFontSize(e: Event): void {
  props.runtime.applyEdgeStyle({ fontSize: Math.max(6, num(e)) })
}

function edgeColor(e: Event): void {
  props.runtime.applyEdgeStyle({ color: str(e) })
}

function edgeRouting(e: Event): void {
  props.runtime.setEdgeRouting(str(e) as EdgeRouting)
}

function edgeArrow(e: Event): void {
  props.runtime.setEdgeArrow(str(e) as ArrowMode)
}

function align(mode: CanvasAlignMode): void {
  props.runtime.align(mode)
}

function distribute(mode: CanvasDistributeMode): void {
  props.runtime.distribute(mode)
}
</script>

<template>
  <div v-if="runtime.ui.selectedCount > 0" class="canvas-style canvas-ui">
    <div class="canvas-style-title">
      样式
      <span class="canvas-style-count">
        {{ runtime.ui.selectedNodeCount }} 个形状 · {{ runtime.ui.selectedEdgeCount }} 条连线
      </span>
    </div>

    <template v-if="ns">
      <div class="canvas-style-row">
        <label class="canvas-style-label">填充</label>
        <input
          type="color"
          :value="ns.fill === 'none' ? '#ffffff' : ns.fill"
          :disabled="ns.fill === 'none'"
          @change="applyFill"
        />
        <label class="canvas-style-check">
          <input type="checkbox" :checked="ns.fill === 'none'" @change="toggleNoFill" />
          无填充
        </label>
        <label class="canvas-style-label">描边</label>
        <input type="color" :value="ns.stroke" @change="applyStroke" />
      </div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">线宽</label>
        <input
          class="canvas-style-number"
          type="number"
          min="0"
          max="12"
          step="0.5"
          :value="ns.strokeWidth"
          @change="applyStrokeWidth"
        />
        <label class="canvas-style-check">
          <input type="checkbox" :checked="ns.dash" @change="applyDash" />
          虚线
        </label>
        <template v-if="runtime.ui.shape === 'roundRect' || runtime.ui.shape === 'rect'">
          <label class="canvas-style-label">圆角</label>
          <input
            class="canvas-style-number"
            type="number"
            min="0"
            max="80"
            step="1"
            :value="ns.radius"
            @change="applyRadius"
          />
        </template>
      </div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">字号</label>
        <input
          class="canvas-style-number"
          type="number"
          min="6"
          max="96"
          step="1"
          :value="ns.fontSize"
          @change="applyFontSize"
        />
        <label class="canvas-style-label">文字</label>
        <input type="color" :value="ns.color" @change="applyColor" />
        <button class="canvas-style-toggle" :class="{ active: ns.bold }" @click="applyBold">
          B
        </button>
        <button class="canvas-style-toggle" :class="{ active: ns.italic }" @click="applyItalic">
          I
        </button>
      </div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">水平</label>
        <button class="canvas-style-toggle" :class="{ active: ns.align === 'left' }" @click="applyAlign('left')">
          左
        </button>
        <button class="canvas-style-toggle" :class="{ active: ns.align === 'center' }" @click="applyAlign('center')">
          中
        </button>
        <button class="canvas-style-toggle" :class="{ active: ns.align === 'right' }" @click="applyAlign('right')">
          右
        </button>
        <label class="canvas-style-label">垂直</label>
        <button class="canvas-style-toggle" :class="{ active: ns.valign === 'top' }" @click="applyValign('top')">
          上
        </button>
        <button class="canvas-style-toggle" :class="{ active: ns.valign === 'middle' }" @click="applyValign('middle')">
          中
        </button>
        <button class="canvas-style-toggle" :class="{ active: ns.valign === 'bottom' }" @click="applyValign('bottom')">
          下
        </button>
      </div>
    </template>

    <template v-if="es">
      <div class="canvas-style-row">
        <label class="canvas-style-label">颜色</label>
        <input type="color" :value="es.stroke" @change="edgeStroke" />
        <label class="canvas-style-label">线宽</label>
        <input
          class="canvas-style-number"
          type="number"
          min="0"
          max="12"
          step="0.5"
          :value="es.strokeWidth"
          @change="edgeWidth"
        />
        <label class="canvas-style-check">
          <input type="checkbox" :checked="es.dash" @change="edgeDash" />
          虚线
        </label>
      </div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">路由</label>
        <select class="canvas-style-select" @change="edgeRouting">
          <option value="orthogonal">正交</option>
          <option value="straight">直线</option>
          <option value="curve">曲线</option>
        </select>
        <label class="canvas-style-label">箭头</label>
        <select class="canvas-style-select" @change="edgeArrow">
          <option value="end">终点</option>
          <option value="start">起点</option>
          <option value="both">双向</option>
          <option value="none">无</option>
        </select>
      </div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">标签字号</label>
        <input
          class="canvas-style-number"
          type="number"
          min="6"
          max="48"
          step="1"
          :value="es.fontSize"
          @change="edgeFontSize"
        />
        <label class="canvas-style-label">标签色</label>
        <input type="color" :value="es.color" @change="edgeColor" />
      </div>
    </template>

    <template v-if="runtime.ui.selectedNodeCount >= 2">
      <div class="canvas-style-sep"></div>
      <div class="canvas-style-row">
        <button class="canvas-style-tool" title="左对齐" @click="align('left')">
          <AlignStartVertical :size="15" />
        </button>
        <button class="canvas-style-tool" title="水平居中" @click="align('hcenter')">
          <AlignCenterVertical :size="15" />
        </button>
        <button class="canvas-style-tool" title="右对齐" @click="align('right')">
          <AlignEndVertical :size="15" />
        </button>
        <button class="canvas-style-tool" title="顶部对齐" @click="align('top')">
          <AlignStartHorizontal :size="15" />
        </button>
        <button class="canvas-style-tool" title="垂直居中" @click="align('vcenter')">
          <AlignCenterHorizontal :size="15" />
        </button>
        <button class="canvas-style-tool" title="底部对齐" @click="align('bottom')">
          <AlignEndHorizontal :size="15" />
        </button>
      </div>
      <div v-if="runtime.ui.selectedNodeCount >= 3" class="canvas-style-row">
        <button class="canvas-style-tool" title="水平分布" @click="distribute('h')">
          <MoveHorizontal :size="15" />
        </button>
        <button class="canvas-style-tool" title="垂直分布" @click="distribute('v')">
          <MoveVertical :size="15" />
        </button>
      </div>
    </template>

    <div class="canvas-style-sep"></div>
    <div class="canvas-style-row">
      <button class="canvas-style-tool" title="置顶" @click="runtime.order('front')">
        <BringToFront :size="15" />
      </button>
      <button class="canvas-style-tool" title="上移一层" @click="runtime.order('forward')">
        <ChevronUp :size="15" />
      </button>
      <button class="canvas-style-tool" title="下移一层" @click="runtime.order('backward')">
        <ChevronDown :size="15" />
      </button>
      <button class="canvas-style-tool" title="置底" @click="runtime.order('back')">
        <SendToBack :size="15" />
      </button>
      <button class="canvas-style-tool canvas-style-danger" title="删除 (Delete)" @click="runtime.deleteSelection()">
        <Trash2 :size="15" />
      </button>
    </div>
  </div>
</template>
