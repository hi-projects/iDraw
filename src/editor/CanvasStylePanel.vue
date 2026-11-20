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
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Bold,
  BringToFront,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownRight,
  Italic,
  Minus,
  MoveHorizontal,
  MoveVertical,
  Spline,
  SendToBack,
  Trash2
} from 'lucide-vue-next'
import { computed, ref } from 'vue'
import type { ArrowMode, ArrowStyle, EdgeRouting, EdgeStyle, NodeStyle } from '../engine/model'
import type { CanvasAlignMode, CanvasDistributeMode, CanvasRuntime } from '../engine/runtime'
import { pushNotice } from './notice'

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

/* ---------- 颜色:拖动时实时预览,确认时只记一条撤销 ---------- */

const previousFill = ref<string | null>(null)
/** 本轮填充色编辑开始前的颜色(用于生成撤销记录和"上一填充色") */
let fillEditStart: string | null = null

function previewNode<K extends keyof NodeStyle>(key: K, e: Event): void {
  props.runtime.previewNodeStyle({ [key]: str(e) } as Partial<NodeStyle>)
}

function commitNode<K extends keyof NodeStyle>(key: K, e: Event): void {
  props.runtime.previewNodeStyle({ [key]: str(e) } as Partial<NodeStyle>)
  props.runtime.commitStylePreview()
}

function previewEdge<K extends keyof EdgeStyle>(key: K, e: Event): void {
  props.runtime.previewEdgeStyle({ [key]: str(e) } as Partial<EdgeStyle>)
}

function commitEdge<K extends keyof EdgeStyle>(key: K, e: Event): void {
  props.runtime.previewEdgeStyle({ [key]: str(e) } as Partial<EdgeStyle>)
  props.runtime.commitStylePreview()
}

function onFillInput(e: Event): void {
  if (fillEditStart === null) fillEditStart = props.runtime.ui.nodeStyle?.fill ?? null
  previewNode('fill', e)
}

function onFillChange(e: Event): void {
  if (fillEditStart === null) fillEditStart = props.runtime.ui.nodeStyle?.fill ?? null
  previewNode('fill', e)
  props.runtime.commitStylePreview()
  if (fillEditStart !== null) previousFill.value = fillEditStart
  fillEditStart = null
}

function toggleNoFill(e: Event): void {
  const none = checked(e)
  const current = props.runtime.ui.nodeStyle?.fill ?? null
  if (current !== null) previousFill.value = current
  patchNode('fill', none ? 'none' : '#ffffff')
}

function restorePreviousFill(): void {
  const prev = previousFill.value
  if (prev === null) return
  const current = props.runtime.ui.nodeStyle?.fill ?? null
  props.runtime.applyNodeStyle({ fill: prev })
  // 交换两个颜色,按钮可以来回切换
  previousFill.value = current
}

function fillRgb(): string | null {
  const value = props.runtime.ui.nodeStyle?.fill
  const match = value ? /^#([0-9a-f]{6})$/i.exec(value.trim()) : null
  if (!match) return null
  const n = parseInt(match[1], 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

async function copyFillRgb(): Promise<void> {
  const rgb = fillRgb()
  if (!rgb) return
  try {
    await navigator.clipboard.writeText(rgb)
    pushNotice(`已复制 ${rgb}`)
  } catch {
    pushNotice('复制失败', 'error')
  }
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

function edgeWidth(e: Event): void {
  props.runtime.applyEdgeStyle({ strokeWidth: Math.max(0, num(e)) })
}

function edgeDash(e: Event): void {
  props.runtime.applyEdgeStyle({ dash: checked(e) })
}

function edgeFontSize(e: Event): void {
  props.runtime.applyEdgeStyle({ fontSize: Math.max(6, num(e)) })
}

function edgeBold(): void {
  const style = props.runtime.ui.edgeStyle
  if (style) props.runtime.applyEdgeStyle({ bold: !style.bold })
}

function edgeItalic(): void {
  const style = props.runtime.ui.edgeStyle
  if (style) props.runtime.applyEdgeStyle({ italic: !style.italic })
}

function applyRouting(routing: EdgeRouting): void {
  props.runtime.setEdgeRouting(routing)
}

function applyArrow(arrow: ArrowMode): void {
  props.runtime.setEdgeArrow(arrow)
}

function applyArrowStyle(style: ArrowStyle): void {
  props.runtime.setEdgeArrowStyle(style)
}

function changeArrowSize(e: Event): void {
  props.runtime.setEdgeArrowSize(num(e))
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
      <div class="canvas-style-section-title">形状</div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">填充</label>
        <input
          type="color"
          :value="ns.fill === 'none' ? '#ffffff' : ns.fill"
          @input="onFillInput"
          @change="onFillChange"
        />
        <button
          class="canvas-color-mini"
          title="复制填充 RGB"
          :disabled="ns.fill === 'none'"
          @click="copyFillRgb"
        >
          <Copy :size="12" />
        </button>
        <button
          v-if="previousFill"
          class="canvas-color-prev"
          :class="{ 'is-none': previousFill === 'none' }"
          :style="previousFill === 'none' ? undefined : { background: previousFill }"
          :title="previousFill === 'none' ? '恢复为无填充' : '恢复上一填充色'"
          @click="restorePreviousFill"
        ></button>
        <label class="canvas-style-check">
          <input type="checkbox" :checked="ns.fill === 'none'" @change="toggleNoFill" />
          无填充
        </label>
      </div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">描边</label>
        <input
          type="color"
          :value="ns.stroke"
          @input="previewNode('stroke', $event)"
          @change="commitNode('stroke', $event)"
        />
      </div>
      <div
        v-if="runtime.ui.shape === 'roundRect' || runtime.ui.shape === 'rect'"
        class="canvas-style-row"
      >
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
      </div>

      <div class="canvas-style-sep"></div>

      <div class="canvas-style-section-title">字体</div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">字体颜色</label>
        <input
          type="color"
          :value="ns.color"
          @input="previewNode('color', $event)"
          @change="commitNode('color', $event)"
        />
        <button class="canvas-style-toggle" :class="{ active: ns.bold }" @click="applyBold">
          B
        </button>
        <button class="canvas-style-toggle" :class="{ active: ns.italic }" @click="applyItalic">
          I
        </button>
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
      </div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">水平对齐</label>
        <button class="canvas-style-toggle" :class="{ active: ns.align === 'left' }" @click="applyAlign('left')">
          左
        </button>
        <button class="canvas-style-toggle" :class="{ active: ns.align === 'center' }" @click="applyAlign('center')">
          中
        </button>
        <button class="canvas-style-toggle" :class="{ active: ns.align === 'right' }" @click="applyAlign('right')">
          右
        </button>
      </div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">垂直对齐</label>
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
      <div v-if="ns" class="canvas-style-sep"></div>
      <div class="canvas-style-section-title">连线</div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">连线颜色</label>
        <input
          type="color"
          :value="es.stroke"
          @input="previewEdge('stroke', $event)"
          @change="commitEdge('stroke', $event)"
        />
      </div>
      <div class="canvas-style-row">
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
        <label class="canvas-style-label">连线样式</label>
        <div class="canvas-style-seg" role="group" aria-label="连线方式">
          <button
            class="canvas-style-toggle"
            :class="{ active: runtime.ui.edgeRouting === 'orthogonal' }"
            title="正交"
            aria-label="正交"
            @click="applyRouting('orthogonal')"
          >
            <CornerDownRight :size="15" />
          </button>
          <button
            class="canvas-style-toggle"
            :class="{ active: runtime.ui.edgeRouting === 'straight' }"
            title="直线"
            aria-label="直线"
            @click="applyRouting('straight')"
          >
            <Minus :size="15" />
          </button>
          <button
            class="canvas-style-toggle"
            :class="{ active: runtime.ui.edgeRouting === 'curve' }"
            title="曲线"
            aria-label="曲线"
            @click="applyRouting('curve')"
          >
            <Spline :size="15" />
          </button>
        </div>
      </div>

      <div class="canvas-style-sep"></div>
      <div class="canvas-style-section-title">标签</div>
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
      </div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">标签颜色</label>
        <input
          type="color"
          :value="es.color"
          @input="previewEdge('color', $event)"
          @change="commitEdge('color', $event)"
        />
        <button
          class="canvas-style-toggle"
          :class="{ active: es.bold }"
          title="标签加粗"
          aria-label="标签加粗"
          @click="edgeBold"
        >
          <Bold :size="14" />
        </button>
        <button
          class="canvas-style-toggle"
          :class="{ active: es.italic }"
          title="标签倾斜"
          aria-label="标签倾斜"
          @click="edgeItalic"
        >
          <Italic :size="14" />
        </button>
      </div>

      <div class="canvas-style-sep"></div>
      <div class="canvas-style-section-title">箭头</div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">箭头方向</label>
        <div class="canvas-style-seg" role="group" aria-label="箭头方向">
          <button
            class="canvas-style-toggle"
            :class="{ active: runtime.ui.edgeArrow === 'end' }"
            title="终点"
            aria-label="终点"
            @click="applyArrow('end')"
          >
            <ArrowRight :size="15" />
          </button>
          <button
            class="canvas-style-toggle"
            :class="{ active: runtime.ui.edgeArrow === 'start' }"
            title="起点"
            aria-label="起点"
            @click="applyArrow('start')"
          >
            <ArrowLeft :size="15" />
          </button>
          <button
            class="canvas-style-toggle"
            :class="{ active: runtime.ui.edgeArrow === 'both' }"
            title="双向"
            aria-label="双向"
            @click="applyArrow('both')"
          >
            <ArrowLeftRight :size="15" />
          </button>
          <button
            class="canvas-style-toggle"
            :class="{ active: runtime.ui.edgeArrow === 'none' }"
            title="无箭头"
            aria-label="无箭头"
            @click="applyArrow('none')"
          >
            <Minus :size="15" />
          </button>
        </div>
      </div>

      <div class="canvas-style-row">
        <label class="canvas-style-label">箭头样式</label>
        <div class="canvas-style-seg" role="group" aria-label="箭头样式">
          <button
            class="canvas-style-toggle"
            :class="{ active: runtime.ui.edgeArrowStyle === 'solid' }"
            title="实心箭头"
            aria-label="实心箭头"
            @click="applyArrowStyle('solid')"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path d="M6 6l12 6-12 6z" fill="currentColor" />
            </svg>
          </button>
          <button
            class="canvas-style-toggle"
            :class="{ active: runtime.ui.edgeArrowStyle === 'hollow' }"
            title="空心箭头"
            aria-label="空心箭头"
            @click="applyArrowStyle('hollow')"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                d="M6 6l12 6-12 6z"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <div class="canvas-style-row">
        <label class="canvas-style-label">箭头大小</label>
        <input
          class="canvas-style-number canvas-arrow-size"
          type="number"
          min="2"
          max="20"
          step="1"
          :value="runtime.ui.edgeArrowSize ?? 9"
          @change="changeArrowSize"
        />
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
