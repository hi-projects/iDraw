/**
 * 命令式 SVG 渲染。
 *
 * 场景不进 Vue 响应式,渲染也不走虚拟 DOM:节点/边按 id 复用 DOM,SVG 属性
 * 直接改。拖拽过程中只更新受影响节点的 `transform` 与相关边的 `d`
 * (见 updateNodes / updateEdges),松手后才重建一次结构。
 *
 * 只创建真正存在的内容,不生成位图:几百到上千个节点仍是普通 SVG DOM,
 * 内存随节点数线性增长,而不是随"画布像素数"。
 */
import {
  DARK_NODE_DEFAULTS,
  NODE_DEFAULTS,
  newNodeStyle,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type ShapeKind
} from './model'
import { edgeGeometry, edgeLabelPoint, type Rect } from './geometry'
import { layoutNodeText, shapeParts, textAttrs } from './shapes'

export const SVG_NS = 'http://www.w3.org/2000/svg'

export interface Viewport {
  scale: number
  tx: number
  ty: number
}

export interface Guide {
  axis: 'x' | 'y'
  /** 世界坐标 */
  value: number
}

export interface RenderState {
  doc: CanvasDoc
  viewport: Viewport
  selected: ReadonlySet<string>
  /** 只读预览里不画可拖动的连线端点 */
  readOnly: boolean
  /** 正在被浮层编辑的节点:它自己的文字先隐藏,避免和 textarea 重影 */
  editingNode: string | null
  editingEdge: string | null
  marquee: Rect | null
  /** 拖拽新建形状时的预览框(世界坐标) */
  createRect: Rect | null
  /** 正在拖画出来的形状;null 时按圆角矩形预览 */
  createShape: ShapeKind | null
  guides: Guide[]
  /** 拖拽中的连线预览(世界坐标 path d) */
  previewPath: string | null
  /** 连线时高亮的锚点节点与尺寸(世界坐标圆半径由渲染器按缩放换算) */
  anchorNode: CanvasNode | null
  hoverEdge: string | null
}

function el<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag)
}

function setAttrs(node: Element, attrs: Record<string, string | number | undefined>): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    node.setAttribute(key, String(value))
  }
}

function markerId(color: string, start: boolean, hollow = false, size = 9): string {
  const safe = color.replace(/[^0-9a-zA-Z]/g, '') || 'default'
  const style = hollow ? 'hollow-' : ''
  return start
    ? `idraw-arrow-start-${style}${safe}-${size}`
    : `idraw-arrow-${style}${safe}-${size}`
}

/** 剪贴板/预览里也要有 marker:按颜色+实心/空心+大小补齐 defs,已存在的不重复建 */
function ensureMarkers(
  defs: SVGDefsElement,
  specs: Iterable<{ color: string; hollow: boolean; size: number }>
): void {
  for (const { color, hollow, size } of specs) {
    for (const start of [false, true]) {
      const id = markerId(color, start, hollow, size)
      if (defs.querySelector(`#${id}`)) continue
      const marker = el('marker')
      setAttrs(marker, {
        id,
        viewBox: '0 0 10 10',
        refX: start ? 1 : 9,
        refY: 5,
        markerWidth: size,
        markerHeight: size,
        markerUnits: 'strokeWidth',
        orient: 'auto'
      })
      const arrow = el('path')
      if (hollow) arrow.classList.add('canvas-arrow-hollow')
      setAttrs(arrow, {
        d: start ? 'M10,0 L0,5 L10,10 z' : 'M0,0 L10,5 L0,10 z',
        fill: hollow ? '#ffffff' : color,
        stroke: hollow ? color : undefined,
        'stroke-width': hollow ? 1.2 : undefined,
        'stroke-linejoin': hollow ? 'round' : undefined
      })
      marker.append(arrow)
      defs.append(marker)
    }
  }
}

export class CanvasRenderer {
  readonly host: HTMLElement
  readonly svg: SVGSVGElement
  private defs: SVGDefsElement
  private world: SVGGElement
  private edgeLayer: SVGGElement
  private previewLayer: SVGGElement
  private nodeLayer: SVGGElement
  private overlay: SVGGElement
  private nodeEls = new Map<string, SVGGElement>()
  private edgeEls = new Map<string, SVGPathElement>()
  private labelEls = new Map<string, SVGTextElement>()
  private resizeObserver: ResizeObserver | null = null
  private viewport: Viewport = { scale: 1, tx: 0, ty: 0 }

  constructor(host: HTMLElement) {
    this.host = host
    this.svg = el('svg')
    this.svg.classList.add('canvas-svg')
    this.svg.setAttribute('xmlns', SVG_NS)
    this.defs = el('defs')
    // 编辑器里不画"纸面"矩形:背景由 .canvas-surface 铺满整个视口,视觉上是无限画布
    this.world = el('g')
    this.world.classList.add('canvas-world')
    this.edgeLayer = el('g')
    this.edgeLayer.classList.add('canvas-edge-layer')
    this.previewLayer = el('g')
    this.previewLayer.classList.add('canvas-preview-layer')
    this.nodeLayer = el('g')
    this.nodeLayer.classList.add('canvas-node-layer')
    this.overlay = el('g')
    this.overlay.classList.add('canvas-overlay')
    this.world.append(this.edgeLayer, this.previewLayer, this.nodeLayer)
    this.svg.append(this.defs, this.world, this.overlay)
    host.append(this.svg)

    // 容器尺寸变化时 viewBox 跟着变,否则隐藏/展开侧栏后画布会保持旧裁剪
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(host)
    }
    this.resize()
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    this.svg.setAttribute('width', String(w))
    this.svg.setAttribute('height', String(h))
  }

  get size(): { w: number; h: number } {
    return {
      w: Math.max(1, this.host.clientWidth),
      h: Math.max(1, this.host.clientHeight)
    }
  }

  /** 背景网格显隐(由运行时的 gridVisible 偏好驱动) */
  setGridVisible(visible: boolean): void {
    this.host.classList.toggle('canvas-grid', visible)
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport
    const { scale, tx, ty } = viewport
    this.world.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`)
    this.updateGridBackground()
  }

  /**
   * 背景点阵跟随平移/缩放,看起来像一整张无限画布。
   * 缩小到点距过密时自动跳到更疏的一档,避免糊成一片。
   */
  private updateGridBackground(): void {
    let step = 24 * this.viewport.scale
    while (step < 10) step *= 2
    const wrap = (v: number): number => ((v % step) + step) % step
    this.host.style.backgroundSize = `${step}px ${step}px`
    this.host.style.backgroundPosition = `${wrap(this.viewport.tx)}px ${wrap(this.viewport.ty)}px`
  }

  private toScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.viewport.scale + this.viewport.tx, y: y * this.viewport.scale + this.viewport.ty }
  }

  /** 客户端坐标 → 世界坐标(指针事件用) */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.host.getBoundingClientRect()
    return {
      x: (clientX - rect.left - this.viewport.tx) / this.viewport.scale,
      y: (clientY - rect.top - this.viewport.ty) / this.viewport.scale
    }
  }

  /** 世界坐标 → 容器内屏幕坐标(手柄命中测试用) */
  screenOf(x: number, y: number): { x: number; y: number } {
    return this.toScreen(x, y)
  }

  /** 全量重建页面与场景(结构/样式变化时调用) */
  renderScene(doc: CanvasDoc, selected: ReadonlySet<string>, editingNode: string | null, editingEdge: string | null, hoverEdge: string | null): void {
    ensureMarkers(
      this.defs,
      doc.edges
        .filter(e => e.arrow !== 'none')
        .map(e => ({
          color: e.style.stroke,
          hollow: e.arrowStyle === 'hollow',
          size: e.arrowSize
        }))
    )

    // ---- 边 ----
    const keepEdges = new Set<string>()
    for (const edge of doc.edges) {
      keepEdges.add(edge.id)
      let path = this.edgeEls.get(edge.id)
      if (!path) {
        path = el('path')
        path.classList.add('canvas-edge')
        path.setAttribute('data-idraw-edge', edge.id)
        this.edgeEls.set(edge.id, path)
        this.edgeLayer.append(path)
      }
      this.applyEdgeAttrs(path, edge, doc)
      path.classList.toggle('canvas-edge-hover', edge.id === hoverEdge)
      path.classList.toggle('canvas-edge-selected', selected.has(edge.id))

      if (edge.label && edge.id !== editingEdge) {
        let label = this.labelEls.get(edge.id)
        if (!label) {
          label = el('text')
          label.classList.add('canvas-edge-label')
          label.setAttribute('data-idraw-edge-label', edge.id)
          this.labelEls.set(edge.id, label)
          this.edgeLayer.append(label)
        }
        this.applyEdgeLabel(label, edge, doc)
      } else {
        this.labelEls.get(edge.id)?.remove()
        this.labelEls.delete(edge.id)
      }
    }
    for (const [id, path] of [...this.edgeEls]) {
      if (keepEdges.has(id)) continue
      path.remove()
      this.edgeEls.delete(id)
      this.labelEls.get(id)?.remove()
      this.labelEls.delete(id)
    }

    // ---- 节点 ----
    const keepNodes = new Set<string>()
    for (const node of doc.nodes) {
      keepNodes.add(node.id)
      let group = this.nodeEls.get(node.id)
      if (!group) {
        group = el('g')
        group.classList.add('canvas-node')
        group.setAttribute('data-idraw-node', node.id)
        group.setAttribute('data-node-id', node.id)
        this.nodeEls.set(node.id, group)
        this.nodeLayer.append(group)
      }
      this.renderNode(group, node, node.id === editingNode, selected.has(node.id))
    }
    for (const [id, group] of [...this.nodeEls]) {
      if (keepNodes.has(id)) continue
      group.remove()
      this.nodeEls.delete(id)
    }

    // 顺序 = 数组顺序(z-order);只有顺序真的变了才动 DOM
    this.reorder(this.nodeLayer, doc.nodes.map(n => this.nodeEls.get(n.id)!))
    // 边与其标签保持相邻:一条边被别的边盖住时,它的标签也一起盖住
    const wantedEdges: SVGElement[] = []
    for (const edge of doc.edges) {
      const path = this.edgeEls.get(edge.id)
      if (path) wantedEdges.push(path)
      const label = this.labelEls.get(edge.id)
      if (label) wantedEdges.push(label)
    }
    this.reorder(this.edgeLayer, wantedEdges)
  }

  private reorder(parent: SVGGElement, wanted: SVGElement[]): void {
    const current = Array.from(parent.children)
    let same = current.length === wanted.length
    if (same) {
      for (let i = 0; i < current.length; i++) {
        if (current[i] !== wanted[i]) {
          same = false
          break
        }
      }
    }
    if (same) return
    for (const child of wanted) parent.append(child)
  }

  private renderNode(group: SVGGElement, node: CanvasNode, hideText: boolean, selected: boolean): void {
    const transform = `translate(${node.x} ${node.y})`
    if (group.getAttribute('transform') !== transform) group.setAttribute('transform', transform)
    group.setAttribute('data-idraw-shape', node.shape)
    group.classList.toggle('canvas-node-selected', selected)
    // 无填充节点的文字跟随主题:文档里存的是固定颜色,换主题后可能和画布撞色。
    // 只处理两种默认色,用户自定义的颜色不动。
    const plainColor = node.style.color.toLowerCase()
    group.classList.toggle(
      'canvas-node-autotext',
      node.style.fill === 'none' && plainColor === NODE_DEFAULTS.color.toLowerCase()
    )
    group.classList.toggle(
      'canvas-node-autotext-inverse',
      node.style.fill === 'none' && plainColor === DARK_NODE_DEFAULTS.color.toLowerCase()
    )

    // 形状 + 文字的 DOM 只在这两样真的变了时重建;拖拽走 updateNodes 不会到这里
    const signature = [
      node.shape,
      node.w,
      node.h,
      node.style.fill,
      node.style.stroke,
      node.style.strokeWidth,
      node.style.dash,
      node.style.radius,
      hideText ? '' : node.text,
      node.style.fontSize,
      node.style.color,
      node.style.bold,
      node.style.italic,
      node.style.align,
      node.style.valign
    ].join('\u0000')
    if (group.getAttribute('data-signature') === signature) return
    group.setAttribute('data-signature', signature)
    group.replaceChildren()
    for (const part of shapeParts(node)) {
      const child = el(part.tag as 'rect')
      setAttrs(child, part.attrs)
      group.append(child)
    }
    if (!hideText && node.text) {
      const layout = layoutNodeText(node)
      const text = el('text')
      setAttrs(text, textAttrs(layout))
      text.setAttribute('data-idraw-text', node.text)
      layout.lines.forEach((line, i) => {
        const tspan = el('tspan')
        setAttrs(tspan, { x: layout.x, y: layout.y + i * layout.lineHeight })
        tspan.textContent = line
        text.append(tspan)
      })
      group.append(text)
    } else if (!hideText && node.shape === 'text') {
      // 空文本框没有任何形状/文字,不画占位就完全看不见(也无法用框选发现)。
      // 这只是编辑器的提示,保存/导出走 serialize,不会写进文件。
      const box = el('rect')
      box.classList.add('canvas-text-placeholder')
      setAttrs(box, { x: 0, y: 0, width: node.w, height: node.h, rx: 6 })
      group.append(box)
      const hint = el('text')
      hint.classList.add('canvas-text-placeholder-hint')
      setAttrs(hint, {
        x: node.w / 2,
        y: node.h / 2,
        'text-anchor': 'middle',
        'dominant-baseline': 'central'
      })
      hint.textContent = '空文本框'
      group.append(hint)
    }
  }

  private applyEdgeAttrs(path: SVGPathElement, edge: CanvasEdge, doc: CanvasDoc): void {
    const g = edgeGeometry(edge, doc)
    path.setAttribute('d', g.d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', edge.style.stroke)
    path.setAttribute('stroke-width', String(edge.style.strokeWidth))
    if (edge.style.dash) {
      path.setAttribute(
        'stroke-dasharray',
        `${edge.style.strokeWidth * 3} ${edge.style.strokeWidth * 2}`
      )
    } else {
      path.removeAttribute('stroke-dasharray')
    }
    const end = edge.arrow === 'end' || edge.arrow === 'both'
    const start = edge.arrow === 'start' || edge.arrow === 'both'
    const hollow = edge.arrowStyle === 'hollow'
    path.setAttribute(
      'marker-end',
      end ? `url(#${markerId(edge.style.stroke, false, hollow, edge.arrowSize)})` : ''
    )
    path.setAttribute(
      'marker-start',
      start ? `url(#${markerId(edge.style.stroke, true, hollow, edge.arrowSize)})` : ''
    )
  }

  private applyEdgeLabel(label: SVGTextElement, edge: CanvasEdge, doc: CanvasDoc): void {
    const at = edgeLabelPoint(edge, doc)
    const lines = edge.label.split('\n')
    const lh = Math.round(edge.style.fontSize * 1.4)
    // 让文字块的视觉中心落在标签锚点(= 选中框中心),而不是基线偏上
    const startY = at.y + edge.style.fontSize * 0.35 - ((lines.length - 1) * lh) / 2
    setAttrs(label, {
      x: at.x,
      y: startY,
      'text-anchor': 'middle',
      'font-size': edge.style.fontSize,
      'font-weight': edge.style.bold ? 600 : 400,
      'font-style': edge.style.italic ? 'italic' : 'normal',
      fill: edge.style.color,
      stroke: '#ffffff',
      'stroke-width': 4,
      'paint-order': 'stroke',
      'stroke-linejoin': 'round'
    })
    label.setAttribute('data-idraw-label', edge.label)
    label.replaceChildren()
    lines.forEach((line, i) => {
      const tspan = el('tspan')
      setAttrs(tspan, { x: at.x, y: startY + i * lh })
      tspan.textContent = line
      label.append(tspan)
    })
  }

  /** 拖拽快路径:只改节点位置,以及它与其它节点之间那些边的路径 */
  updateNodes(doc: CanvasDoc, nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): void {
    for (const id of nodeIds) {
      const node = doc.nodes.find(n => n.id === id)
      const group = this.nodeEls.get(id)
      if (!node || !group) continue
      group.setAttribute('transform', `translate(${node.x} ${node.y})`)
      // 尺寸变了(缩放)要重画形状与折行;位置变了只需要 transform
      const sig = group.getAttribute('data-signature')
      if (sig && !sig.includes(`${node.w}\u0000${node.h}`)) {
        group.removeAttribute('data-signature')
        this.renderNode(group, node, false, group.classList.contains('canvas-node-selected'))
      }
    }
    this.updateEdges(doc, edgeIds)
  }

  updateEdges(doc: CanvasDoc, edgeIds: ReadonlySet<string>): void {
    for (const id of edgeIds) {
      const edge = doc.edges.find(e => e.id === id)
      if (!edge) continue
      const path = this.edgeEls.get(id)
      if (path) this.applyEdgeAttrs(path, edge, doc)
      const label = this.labelEls.get(id)
      if (label) this.applyEdgeLabel(label, edge, doc)
    }
  }

  /** 悬浮状态:只切换 class,不重建 */
  setHoverEdge(id: string | null): void {
    for (const [edgeId, path] of this.edgeEls) {
      path.classList.toggle('canvas-edge-hover', edgeId === id)
    }
  }

  /** 连线预览与锚点(世界坐标,随缩放) */
  renderPreview(path: string | null, anchorNode: CanvasNode | null): void {
    this.previewLayer.replaceChildren()
    if (anchorNode) {
      const r = 4 / this.viewport.scale
      const points = [
        { x: anchorNode.x + anchorNode.w / 2, y: anchorNode.y },
        { x: anchorNode.x + anchorNode.w, y: anchorNode.y + anchorNode.h / 2 },
        { x: anchorNode.x + anchorNode.w / 2, y: anchorNode.y + anchorNode.h },
        { x: anchorNode.x, y: anchorNode.y + anchorNode.h / 2 }
      ]
      for (const p of points) {
        const circle = el('circle')
        circle.classList.add('canvas-anchor')
        setAttrs(circle, { cx: p.x, cy: p.y, r })
        this.previewLayer.append(circle)
      }
    }
    if (path) {
      const preview = el('path')
      preview.classList.add('canvas-edge-preview')
      setAttrs(preview, { d: path, fill: 'none' })
      this.previewLayer.append(preview)
    }
  }

  /** 选区框、缩放手柄、框选矩形与参考线(屏幕坐标,大小不随缩放变) */
  renderOverlay(state: RenderState): void {
    this.overlay.replaceChildren()
    const doc = state.doc
    const { scale } = state.viewport

    if (state.selected.size === 1) {
      const id = state.selected.values().next().value
      const edge = doc.edges.find(e => e.id === id)
      if (edge) {
        const g = edgeGeometry(edge, doc)
        const at = edgeLabelPoint(edge, doc)
        const p = this.toScreen(at.x, at.y)
        const box = el('rect')
        box.classList.add('canvas-edge-box')
        setAttrs(box, { x: p.x - 18, y: p.y - 12, width: 36, height: 24, rx: 4 })
        this.overlay.append(box)

        // 两端各画一个可拖动的手柄:端点停在拖动的位置;落在形状上按落点挂接,
        // 落在空白处变成自由端点
        if (!state.readOnly) {
          const ends: Array<['from' | 'to', number, number]> = [
            ['from', g.from.x, g.from.y],
            ['to', g.to.x, g.to.y]
          ]
          for (const [end, x, y] of ends) {
            const hp = this.toScreen(x, y)
            const handle = el('circle')
            handle.classList.add('canvas-edge-end')
            handle.setAttribute('data-edge-end', end)
            setAttrs(handle, { cx: hp.x, cy: hp.y, r: 5 })
            this.overlay.append(handle)
          }

          // 折点手柄:手动折点优先;自动布线时把现有拐角显示成可拖动手柄,
          // 拖动一次后整条路线就固定为手动折线。曲线只展示前两个控制点。
          const source =
            edge.waypoints && edge.waypoints.length > 0
              ? edge.waypoints
              : g.points.slice(1, -1)
          const waypointPoints = edge.routing === 'curve' ? source.slice(0, 2) : source
          for (let i = 0; i < waypointPoints.length; i++) {
            const wp = waypointPoints[i]!
            const hp = this.toScreen(wp.x, wp.y)
            const handle = el('rect')
            handle.classList.add('canvas-edge-waypoint')
            handle.setAttribute('data-edge-waypoint', String(i))
            setAttrs(handle, {
              x: hp.x - 4,
              y: hp.y - 4,
              width: 8,
              height: 8,
              rx: 2,
              transform: `rotate(45 ${hp.x} ${hp.y})`
            })
            this.overlay.append(handle)
          }
        }
      }
    }

    for (const id of state.selected) {
      const node = doc.nodes.find(n => n.id === id)
      if (!node) continue
      const p = this.toScreen(node.x, node.y)
      const box = el('rect')
      box.classList.add('canvas-sel-box')
      setAttrs(box, { x: p.x, y: p.y, width: node.w * scale, height: node.h * scale })
      this.overlay.append(box)
    }

    // 单选才给 8 个手柄(多选缩放留到后续版本)
    if (state.selected.size === 1) {
      const id = state.selected.values().next().value
      const node = doc.nodes.find(n => n.id === id)
      if (node) {
        const p = this.toScreen(node.x, node.y)
        const w = node.w * scale
        const h = node.h * scale
        const handles: [string, number, number][] = [
          ['nw', p.x, p.y],
          ['n', p.x + w / 2, p.y],
          ['ne', p.x + w, p.y],
          ['e', p.x + w, p.y + h / 2],
          ['se', p.x + w, p.y + h],
          ['s', p.x + w / 2, p.y + h],
          ['sw', p.x, p.y + h],
          ['w', p.x, p.y + h / 2]
        ]
        for (const [name, x, y] of handles) {
          const handle = el('rect')
          handle.classList.add('canvas-handle')
          handle.setAttribute('data-handle', name)
          setAttrs(handle, { x: x - 4, y: y - 4, width: 8, height: 8 })
          this.overlay.append(handle)
        }
      }
    }

    if (state.marquee) {
      const a = this.toScreen(state.marquee.x, state.marquee.y)
      const box = el('rect')
      box.classList.add('canvas-marquee')
      setAttrs(box, {
        x: a.x,
        y: a.y,
        width: state.marquee.w * scale,
        height: state.marquee.h * scale
      })
      this.overlay.append(box)
    }

    if (state.createRect) {
      // 按选中的形状画预览:把形状几何放进一个按视口缩放的组里,
      // 笔画由 CSS 统一成 1px 虚线(见 .canvas-create-preview-shape)。
      const rect = state.createRect
      const a = this.toScreen(rect.x, rect.y)
      const group = el('g')
      group.classList.add('canvas-create-preview-shape')
      group.setAttribute('transform', `translate(${a.x} ${a.y}) scale(${scale})`)
      const preview: CanvasNode = {
        id: '__create__',
        shape: state.createShape ?? 'roundRect',
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        text: '',
        style: newNodeStyle()
      }
      const parts = shapeParts(preview)
      if (parts.length === 0) {
        // 文本等没有几何体的形状:退回一个虚线框
        const box = el('rect')
        setAttrs(box, { x: 0, y: 0, width: rect.w, height: rect.h, rx: 6 })
        group.append(box)
      } else {
        for (const part of parts) {
          const child = el(part.tag as 'rect')
          setAttrs(child, part.attrs)
          group.append(child)
        }
      }
      this.overlay.append(group)
    }

    for (const guide of state.guides) {
      const line = el('line')
      line.classList.add('canvas-guide')
      if (guide.axis === 'x') {
        const p = this.toScreen(guide.value, 0)
        setAttrs(line, { x1: p.x, y1: 0, x2: p.x, y2: this.size.h })
      } else {
        const p = this.toScreen(0, guide.value)
        setAttrs(line, { x1: 0, y1: p.y, x2: this.size.w, y2: p.y })
      }
      this.overlay.append(line)
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.svg.remove()
    this.nodeEls.clear()
    this.edgeEls.clear()
    this.labelEls.clear()
  }
}
