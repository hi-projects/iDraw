/**
 * 画布指针 / 键盘状态机。
 *
 * 一次拖拽从 pointerdown 开始、pointerup 结束,期间**不重建场景**:只更新被
 * 影响的节点坐标与相关边的路径(runtime.renderFast),松手时提交一次历史。
 * 所有坐标在进入本模块时已经是世界坐标,缩放只出现在屏幕距离的换算上。
 */
import {
  type AnchorSide,
  type CanvasDoc,
  type CanvasNode,
  type CanvasTool,
  type ShapeKind,
  DEFAULT_SIZE,
  GRID_SIZE,
  cloneNode,
  cloneEdge,
  edgesOf,
  newEdgeStyle,
  newId
} from './model'
import {
  type Point,
  type Rect,
  anchorPoint,
  hitEdge,
  hitNode,
  previewGeometry,
  snapToGrid
} from './geometry'
import { type Patch, nodeDiffPatches } from './history'
import type { CanvasRenderer, Guide, Viewport } from './render'

export type Side = 'n' | 'e' | 's' | 'w'

export interface CanvasTextTarget {
  kind: 'node' | 'edge'
  id: string
}

export interface InteractionHost {
  readonly element: HTMLElement
  readonly renderer: CanvasRenderer
  readonly doc: CanvasDoc
  readonly viewport: Viewport
  readonly selected: ReadonlySet<string>
  readonly readOnly: boolean
  readonly tool: CanvasTool
  readonly pendingShape: ShapeKind | null
  snapEnabled(): boolean
  setViewport(viewport: Viewport): void
  setSelection(ids: Iterable<string>, mode?: 'replace' | 'add' | 'toggle'): void
  setTool(tool: CanvasTool): void
  setPendingShape(shape: ShapeKind | null): void
  setCursor(cursor: string): void
  renderAll(): void
  renderFast(nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): void
  renderOverlay(): void
  setGuides(guides: Guide[]): void
  setCreateRect(rect: Rect | null): void
  setMarquee(rect: Rect | null): void
  setPreview(path: string | null, anchorNode: CanvasNode | null): void
  /** 记录一次已作用到场景上的修改(不再重复应用 redo) */
  commitApplied(undo: Patch[], redo: Patch[]): void
  /** 把新节点加进场景(不记历史),返回节点 */
  addNode(shape: ShapeKind, rect: Rect, text?: string): CanvasNode
  beginTextEdit(target: CanvasTextTarget): void
  deleteSelection(): void
  copySelection(data: DataTransfer | null): void
  cutSelection(data: DataTransfer | null): void
  pasteText(text: string, at: Point): void
  duplicateSelection(): void
  undo(): void
  redo(): void
  selectAll(): void
  focus(): void
  setHoverEdge(id: string | null): void
}

/** 拖拽中状态;`none` 只是为了让 switch 穷尽 */
type Drag =
  | null
  | {
      kind: 'pan'
      clientX: number
      clientY: number
      viewport: Viewport
    }
  | {
      kind: 'move'
      start: Point
      before: CanvasNode[]
      orig: Map<string, { x: number; y: number }>
      primary: string
      edgeIds: Set<string>
      moved: boolean
    }
  | {
      kind: 'resize'
      handle: string
      start: Point
      before: CanvasNode
      edgeIds: Set<string>
      moved: boolean
    }
  | {
      kind: 'marquee'
      start: Point
      current: Point
      base: string[]
      additive: boolean
    }
  | {
      kind: 'connect'
      from: Point
      fromNode: CanvasNode | null
      fromSide: Side
      target: CanvasNode | null
      targetSide: Side
      startWorld: Point
    }
  | {
      kind: 'create'
      start: Point
      current: Point
      moved: boolean
    }

const HANDLES: Array<[string, number, number]> = [
  ['nw', 0, 0],
  ['n', 0.5, 0],
  ['ne', 1, 0],
  ['e', 1, 0.5],
  ['se', 1, 1],
  ['s', 0.5, 1],
  ['sw', 0, 1],
  ['w', 0, 0.5]
]

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y)
  }
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function nodeRect(n: CanvasNode): Rect {
  return { x: n.x, y: n.y, w: n.w, h: n.h }
}

function shiftedBounds(nodes: CanvasNode[], dx: number, dy: number): Rect | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x + dx)
    minY = Math.min(minY, n.y + dy)
    maxX = Math.max(maxX, n.x + n.w + dx)
    maxY = Math.max(maxY, n.y + n.h + dy)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function nearestSide(node: CanvasNode, p: Point): Side {
  const sides: Side[] = ['n', 'e', 's', 'w']
  let best: Side = 'e'
  let bestDist = Infinity
  for (const side of sides) {
    const a = anchorPoint(node, side)
    const d = Math.hypot(a.x - p.x, a.y - p.y)
    if (d < bestDist) {
      bestDist = d
      best = side
    }
  }
  return best
}

/** 对齐吸附:移动中的包围盒与其它节点的边/中心差在阈值内就贴上去 */
function alignSnap(
  moving: CanvasNode[],
  dx: number,
  dy: number,
  doc: CanvasDoc,
  exclude: ReadonlySet<string>,
  threshold: number
): { dx: number; dy: number; guides: Guide[] } {
  const box = shiftedBounds(moving, dx, dy)
  if (!box) return { dx, dy, guides: [] }
  let bestX: number | null = null
  let bestY: number | null = null
  const mineX = [box.x, box.x + box.w / 2, box.x + box.w]
  const mineY = [box.y, box.y + box.h / 2, box.y + box.h]
  for (const n of doc.nodes) {
    if (exclude.has(n.id)) continue
    const otherX = [n.x, n.x + n.w / 2, n.x + n.w]
    const otherY = [n.y, n.y + n.h / 2, n.y + n.h]
    for (const ov of otherX) {
      for (const mv of mineX) {
        const diff = ov - mv
        if (Math.abs(diff) <= threshold && (bestX === null || Math.abs(diff) < Math.abs(bestX))) {
          bestX = diff
        }
      }
    }
    for (const ov of otherY) {
      for (const mv of mineY) {
        const diff = ov - mv
        if (Math.abs(diff) <= threshold && (bestY === null || Math.abs(diff) < Math.abs(bestY))) {
          bestY = diff
        }
      }
    }
  }
  const nx = dx + (bestX ?? 0)
  const ny = dy + (bestY ?? 0)
  return { dx: nx, dy: ny, guides: collectGuides(moving, nx, ny, doc, exclude) }
}

function collectGuides(
  moving: CanvasNode[],
  dx: number,
  dy: number,
  doc: CanvasDoc,
  exclude: ReadonlySet<string>
): Guide[] {
  const box = shiftedBounds(moving, dx, dy)
  if (!box) return []
  const guides: Guide[] = []
  const seen = new Set<string>()
  const mineX = [box.x, box.x + box.w / 2, box.x + box.w]
  const mineY = [box.y, box.y + box.h / 2, box.y + box.h]
  for (const n of doc.nodes) {
    if (exclude.has(n.id)) continue
    for (const ox of [n.x, n.x + n.w / 2, n.x + n.w]) {
      if (mineX.some(mx => Math.abs(mx - ox) < 0.01) && !seen.has(`x${ox}`)) {
        seen.add(`x${ox}`)
        guides.push({ axis: 'x', value: ox })
      }
    }
    for (const oy of [n.y, n.y + n.h / 2, n.y + n.h]) {
      if (mineY.some(my => Math.abs(my - oy) < 0.01) && !seen.has(`y${oy}`)) {
        seen.add(`y${oy}`)
        guides.push({ axis: 'y', value: oy })
      }
    }
  }
  return guides
}

export class Interactions {
  private host: InteractionHost
  private el: HTMLElement
  private drag: Drag = null
  private spaceDown = false
  private hoverNodeId: string | null = null
  private hoverEdgeId: string | null = null
  private lastWorld: Point = { x: 0, y: 0 }
  private destroyed = false

  constructor(host: InteractionHost) {
    this.host = host
    this.el = host.element
    this.el.addEventListener('pointerdown', this.onPointerDown)
    this.el.addEventListener('pointermove', this.onPointerMove)
    this.el.addEventListener('pointerup', this.onPointerUp)
    this.el.addEventListener('pointercancel', this.onPointerUp)
    this.el.addEventListener('pointerleave', this.onPointerLeave)
    this.el.addEventListener('lostpointercapture', this.onLostPointerCapture)
    // 指针捕获只是锦上添花:捕获失效或在窗口外松手时,pointerup 可能到不了画布。
    // 挂到 window 上兜底,并在窗口失焦时收尾,避免框选矩形之类的临时覆盖层卡住。
    window.addEventListener('pointerup', this.onWindowPointerUp)
    window.addEventListener('pointercancel', this.onWindowPointerUp)
    window.addEventListener('blur', this.onWindowBlur)
    this.el.addEventListener('dblclick', this.onDblClick)
    this.el.addEventListener('wheel', this.onWheel, { passive: false })
    this.el.addEventListener('keydown', this.onKeyDown)
    this.el.addEventListener('keyup', this.onKeyUp)
    this.el.addEventListener('copy', this.onCopy)
    this.el.addEventListener('cut', this.onCut)
    this.el.addEventListener('paste', this.onPaste)
    this.el.addEventListener('contextmenu', this.onContextMenu)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.el.removeEventListener('pointerdown', this.onPointerDown)
    this.el.removeEventListener('pointermove', this.onPointerMove)
    this.el.removeEventListener('pointerup', this.onPointerUp)
    this.el.removeEventListener('pointercancel', this.onPointerUp)
    this.el.removeEventListener('pointerleave', this.onPointerLeave)
    this.el.removeEventListener('lostpointercapture', this.onLostPointerCapture)
    window.removeEventListener('pointerup', this.onWindowPointerUp)
    window.removeEventListener('pointercancel', this.onWindowPointerUp)
    window.removeEventListener('blur', this.onWindowBlur)
    this.el.removeEventListener('dblclick', this.onDblClick)
    this.el.removeEventListener('wheel', this.onWheel)
    this.el.removeEventListener('keydown', this.onKeyDown)
    this.el.removeEventListener('keyup', this.onKeyUp)
    this.el.removeEventListener('copy', this.onCopy)
    this.el.removeEventListener('cut', this.onCut)
    this.el.removeEventListener('paste', this.onPaste)
    this.el.removeEventListener('contextmenu', this.onContextMenu)
    this.host.setGuides([])
    this.host.setPreview(null, null)
    this.host.setCreateRect(null)
  }

  // ---------- 指针 ----------

  private world(e: PointerEvent | MouseEvent): Point {
    return this.host.renderer.toWorld(e.clientX, e.clientY)
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1) return
    const target = e.target as Element | null
    // 文字浮层/工具栏按钮的点击不归画布管
    if (target?.closest('textarea, input, button, .canvas-ui')) return
    this.host.focus()
    e.preventDefault()
    const p = this.world(e)
    this.lastWorld = p
    // 合成 PointerEvent(验收 harness)没有真实指针,捕获会抛 NotFoundError;
    // 捕获只是锦上添花,失败也不该让整个手势作废
    try {
      this.el.setPointerCapture?.(e.pointerId)
    } catch {
      /* 没有活动指针 */
    }

    const wantPan = e.button === 1 || this.spaceDown || this.host.tool === 'pan'
    if (wantPan) {
      this.drag = {
        kind: 'pan',
        clientX: e.clientX,
        clientY: e.clientY,
        viewport: { ...this.host.viewport }
      }
      this.host.setCursor('grabbing')
      return
    }

    if (!this.host.readOnly && this.host.tool === 'shape' && this.host.pendingShape) {
      this.drag = { kind: 'create', start: p, current: p, moved: false }
      this.host.setCursor('crosshair')
      return
    }

    if (!this.host.readOnly && this.host.tool === 'text') {
      this.createTextAt(p)
      return
    }

    if (!this.host.readOnly) {
      const handle = this.handleAt(e)
      if (handle) {
        const id = this.host.selected.values().next().value
        const node = id ? this.host.doc.nodes.find(n => n.id === id) : null
        if (node) {
          this.drag = {
            kind: 'resize',
            handle: handle.name,
            start: p,
            before: cloneNode(node),
            edgeIds: new Set(edgesOf(this.host.doc, new Set([node.id])).map(x => x.id)),
            moved: false
          }
          this.host.setCursor(`${handle.name}-resize`)
          return
        }
      }
    }

    // 锚点:只有当前悬浮节点画了锚点,点到的才是它
    if (!this.host.readOnly) {
      const hover = this.hoverNodeId ? this.host.doc.nodes.find(n => n.id === this.hoverNodeId) : null
      if (hover) {
        const side = this.anchorAt(hover, p)
        if (side) {
          this.drag = {
            kind: 'connect',
            from: anchorPoint(hover, side),
            fromNode: hover,
            fromSide: side,
            target: null,
            targetSide: 'n',
            startWorld: p
          }
          this.host.setCursor('crosshair')
          return
        }
      }
    }

    const node = hitNode(this.host.doc, p)
    if (node) {
      if (!this.host.readOnly && this.host.tool === 'edge') {
        const side = nearestSide(node, p)
        this.drag = {
          kind: 'connect',
          from: anchorPoint(node, side),
          fromNode: node,
          fromSide: side,
          target: null,
          targetSide: 'n',
          startWorld: p
        }
        this.host.setCursor('crosshair')
        return
      }
      if (e.shiftKey) {
        this.host.setSelection([node.id], 'toggle')
        return
      }
      if (!this.host.selected.has(node.id)) this.host.setSelection([node.id])
      // 只读预览里可以选中查看,但不能拖
      if (this.host.readOnly) return
      const ids = new Set(this.host.selected)
      const before = this.host.doc.nodes.filter(n => ids.has(n.id)).map(cloneNode)
      if (before.length === 0) return
      this.drag = {
        kind: 'move',
        start: p,
        before,
        orig: new Map(before.map(n => [n.id, { x: n.x, y: n.y }])),
        primary: node.id,
        edgeIds: new Set(edgesOf(this.host.doc, ids).map(x => x.id)),
        moved: false
      }
      this.host.setCursor('move')
      return
    }

    const edge = hitEdge(this.host.doc, p, 6 / this.host.viewport.scale)
    if (edge) {
      this.host.setSelection([edge.id], e.shiftKey ? 'toggle' : 'replace')
      return
    }

    if (!e.shiftKey) this.host.setSelection([])
    this.drag = {
      kind: 'marquee',
      start: p,
      current: p,
      base: e.shiftKey ? [...this.host.selected] : [],
      additive: e.shiftKey
    }
    this.host.setCursor('crosshair')
  }

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.world(e)
    this.lastWorld = p
    const drag = this.drag

    if (!drag) {
      this.updateHover(e, p)
      return
    }
    // 鼠标键已经松开却没收到 pointerup(常见于在窗口外松手):用按键状态兜底收尾
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      this.endDrag(p)
      return
    }
    switch (drag.kind) {
      case 'pan': {
        const dx = e.clientX - drag.clientX
        const dy = e.clientY - drag.clientY
        this.host.setViewport({ ...drag.viewport, tx: drag.viewport.tx + dx, ty: drag.viewport.ty + dy })
        this.host.renderOverlay()
        break
      }
      case 'move': {
        const rawDx = p.x - drag.start.x
        const rawDy = p.y - drag.start.y
        let dx = rawDx
        let dy = rawDy
        const primaryOrig = drag.orig.get(drag.primary)
        if (primaryOrig && this.host.snapEnabled()) {
          dx = snapToGrid(primaryOrig.x + rawDx, GRID_SIZE) - primaryOrig.x
          dy = snapToGrid(primaryOrig.y + rawDy, GRID_SIZE) - primaryOrig.y
          const snap = alignSnap(
            drag.before,
            dx,
            dy,
            this.host.doc,
            new Set(drag.before.map(n => n.id)),
            6 / this.host.viewport.scale
          )
          dx = snap.dx
          dy = snap.dy
          this.host.setGuides(snap.guides)
        } else {
          this.host.setGuides([])
        }
        for (const n of drag.before) {
          const node = this.host.doc.nodes.find(x => x.id === n.id)
          if (!node) continue
          node.x = Math.round((n.x + dx) * 100) / 100
          node.y = Math.round((n.y + dy) * 100) / 100
        }
        drag.moved = true
        this.host.renderFast(
          new Set(drag.before.map(n => n.id)),
          drag.edgeIds
        )
        break
      }
      case 'resize': {
        const node = this.host.doc.nodes.find(n => n.id === drag.before.id)
        if (!node) break
        const dx = p.x - drag.start.x
        const dy = p.y - drag.start.y
        const orig = drag.before
        const minSize = 20
        let left = orig.x
        let top = orig.y
        let right = orig.x + orig.w
        let bottom = orig.y + orig.h
        if (drag.handle.includes('w')) left = orig.x + dx
        if (drag.handle.includes('e')) right = orig.x + orig.w + dx
        if (drag.handle.includes('n')) top = orig.y + dy
        if (drag.handle.includes('s')) bottom = orig.y + orig.h + dy
        if (this.host.snapEnabled()) {
          if (drag.handle.includes('w')) left = snapToGrid(left, GRID_SIZE)
          if (drag.handle.includes('e')) right = snapToGrid(right, GRID_SIZE)
          if (drag.handle.includes('n')) top = snapToGrid(top, GRID_SIZE)
          if (drag.handle.includes('s')) bottom = snapToGrid(bottom, GRID_SIZE)
        }
        if (right - left < minSize) {
          if (drag.handle.includes('w')) left = right - minSize
          else right = left + minSize
        }
        if (bottom - top < minSize) {
          if (drag.handle.includes('n')) top = bottom - minSize
          else bottom = top + minSize
        }
        node.x = Math.round(left * 100) / 100
        node.y = Math.round(top * 100) / 100
        node.w = Math.round((right - left) * 100) / 100
        node.h = Math.round((bottom - top) * 100) / 100
        drag.moved = true
        this.host.renderFast(new Set([node.id]), drag.edgeIds)
        this.host.renderOverlay()
        break
      }
      case 'marquee': {
        drag.current = p
        // 框选过程中不重建场景(那样每帧都是全量 DOM),只更新覆盖层;
        // 选中集合在 pointerup 时一次结算
        this.host.setMarquee(normalizeRect(drag.start, p))
        this.host.renderOverlay()
        break
      }
      case 'connect': {
        const target = hitNode(
          this.host.doc,
          p,
          Math.max(0, 4 / this.host.viewport.scale)
        )
        const from = drag.from
        if (target && target.id === drag.fromNode?.id) {
          drag.target = null
        } else {
          drag.target = target
        }
        const to = drag.target
          ? anchorPoint(drag.target, nearestSide(drag.target, p))
          : p
        if (drag.target) drag.targetSide = nearestSide(drag.target, p)
        // 自由端没有形状可依,按方向取一个朝向对方的边:横向走 w/e,纵向走 n/s
        const freeSide: Side =
          Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
            ? to.x >= from.x
              ? 'w'
              : 'e'
            : to.y >= from.y
              ? 'n'
              : 's'
        const geometry = previewGeometry(
          from,
          to,
          'orthogonal',
          drag.fromSide,
          drag.target ? drag.targetSide : freeSide
        )
        this.host.setPreview(geometry.d, drag.target ?? drag.fromNode)
        break
      }
      case 'create': {
        drag.current = p
        drag.moved = Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4
        if (drag.moved) {
          let rect = normalizeRect(drag.start, p)
          if (this.host.snapEnabled()) {
            rect = {
              x: snapToGrid(rect.x, GRID_SIZE),
              y: snapToGrid(rect.y, GRID_SIZE),
              w: Math.max(GRID_SIZE, snapToGrid(rect.w, GRID_SIZE)),
              h: Math.max(GRID_SIZE, snapToGrid(rect.h, GRID_SIZE))
            }
          }
          this.host.setCreateRect(rect)
        }
        this.host.renderOverlay()
        break
      }
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    const p = this.world(e)
    this.lastWorld = p
    const drag = this.drag
    // 先清 drag 再释放捕获:releasePointerCapture 会同步触发 lostpointercapture,
    // 那里不该再按“意外丢失”处理一遍
    this.drag = null
    try {
      this.el.releasePointerCapture?.(e.pointerId)
    } catch {
      /* 没捕获过(合成事件) */
    }
    if (!drag) return
    this.host.setGuides([])
    this.host.setCreateRect(null)
    this.finishDrag(drag, p)
  }

  /** 任何来源的「手势结束」都走这里:拖拽状态与临时覆盖层一起清掉 */
  private endDrag(p: Point): void {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    this.host.setGuides([])
    this.host.setCreateRect(null)
    this.finishDrag(drag, p)
  }

  /** 画布外的 pointerup(或捕获失效):元素监听收不到时由 window 兜底 */
  private onWindowPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return
    this.endDrag(this.world(e))
  }

  private onLostPointerCapture = (): void => {
    // 正常 pointerup 会先置空 drag 再释放捕获;走到这里说明捕获是意外丢失的
    if (!this.drag) return
    this.endDrag(this.lastWorld)
  }

  private onWindowBlur = (): void => {
    this.spaceDown = false
    this.endDrag(this.lastWorld)
  }

  /**
   * 结束当前手势(保存/切标签时由 runtime.flush 调用):没有 pointerup 事件
   * 也要把拖动中的位置收进历史,否则保存写下的坐标无法撤销。
   */
  finishGesture(): void {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    this.host.setGuides([])
    this.host.setCreateRect(null)
    this.host.setMarquee(null)
    this.finishDrag(drag, this.lastWorld)
  }

  private finishDrag(drag: NonNullable<Drag>, p: Point): void {
    // 先无条件清掉拖拽期间的临时覆盖层再处理手势结果:后面无论走哪条分支、
    // 甚至某条分支抛错,框选矩形都不会留在屏幕上
    this.host.setMarquee(null)
    this.host.setPreview(null, null)
    this.host.renderOverlay()
    switch (drag.kind) {
      case 'pan':
        this.host.setCursor(this.host.tool === 'pan' ? 'grab' : 'default')
        break
      case 'move': {
        const after = drag.before
          .map(n => this.host.doc.nodes.find(x => x.id === n.id))
          .filter((n): n is CanvasNode => !!n)
          .map(cloneNode)
        if (drag.moved) {
          const diff = nodeDiffPatches(drag.before, after)
          this.host.commitApplied(diff.undo, diff.redo)
          this.host.renderAll()
        }
        this.host.setCursor('default')
        break
      }
      case 'resize': {
        const node = this.host.doc.nodes.find(n => n.id === drag.before.id)
        if (node && drag.moved) {
          const diff = nodeDiffPatches([drag.before], [cloneNode(node)])
          this.host.commitApplied(diff.undo, diff.redo)
          this.host.renderAll()
        }
        this.host.setCursor('default')
        break
      }
      case 'marquee':
        this.host.setSelection(this.marqueeSelection({ ...drag, current: p }), drag.additive ? 'add' : 'replace')
        this.host.setCursor('default')
        break
      case 'connect': {
        this.host.setPreview(null, null)
        if (drag.target && drag.target.id !== drag.fromNode?.id) {
          this.createEdge(drag, drag.target, p)
        } else if (!drag.target && Math.hypot(p.x - drag.startWorld.x, p.y - drag.startWorld.y) > 8) {
          this.createEdge(drag, null, p)
        }
        this.host.setCursor('default')
        break
      }
      case 'create':
        this.finishCreate(drag, p)
        this.host.setCursor('default')
        break
    }
  }

  private onPointerLeave = (): void => {
    if (this.drag) return
    this.setHoverNode(null)
    this.setHoverEdge(null)
    this.host.setCursor(this.host.tool === 'pan' ? 'grab' : 'default')
  }

  private updateHover(_e: PointerEvent, p: Point): void {
    if (this.host.tool === 'shape' || this.host.tool === 'text') {
      this.setHoverNode(null)
      this.setHoverEdge(null)
      this.host.setCursor('crosshair')
      return
    }
    const node = hitNode(this.host.doc, p)
    const changed = (node?.id ?? null) !== this.hoverNodeId
    this.setHoverNode(node)
    if (changed) {
      // 悬浮节点变了才重画锚点,避免每次 mousemove 都重建一组 circle
      this.host.setPreview(null, node && this.host.tool !== 'pan' ? node : null)
    }
    if (!node) {
      const edge = hitEdge(this.host.doc, p, 6 / this.host.viewport.scale)
      this.setHoverEdge(edge?.id ?? null)
      this.host.setCursor(this.host.tool === 'pan' ? 'grab' : 'default')
    } else {
      this.setHoverEdge(null)
      if (this.host.tool === 'edge') {
        this.host.setCursor('crosshair')
      } else if (!this.host.readOnly && this.anchorAt(node, p)) {
        this.host.setCursor('crosshair')
      } else {
        this.host.setCursor(this.host.readOnly ? 'default' : 'move')
      }
    }
  }

  private setHoverNode(node: CanvasNode | null): void {
    const id = node?.id ?? null
    if (id === this.hoverNodeId) return
    this.hoverNodeId = id
    if (!node) this.host.setPreview(null, null)
  }

  private setHoverEdge(id: string | null): void {
    if (id === this.hoverEdgeId) return
    this.hoverEdgeId = id
    this.host.setHoverEdge(id)
  }

  // ---------- 新建 / 连线 ----------

  private createTextAt(p: Point): void {
    const size = DEFAULT_SIZE.text
    const node = this.host.addNode('text', {
      x: Math.round(p.x - size.w / 2),
      y: Math.round(p.y - size.h / 2),
      w: size.w,
      h: size.h
    }, '文字')
    this.host.commitApplied([{ op: 'delNode', id: node.id }], [
      { op: 'addNode', index: this.host.doc.nodes.length - 1, node: cloneNode(node) }
    ])
    this.host.setSelection([node.id])
    this.host.setTool('select')
    this.host.renderAll()
    this.host.beginTextEdit({ kind: 'node', id: node.id })
  }

  private createEdge(drag: Extract<Drag, { kind: 'connect' }>, target: CanvasNode | null, end: Point): void {
    const doc = this.host.doc
    const edge = {
      id: newId(doc, 'e'),
      from: {
        node: drag.fromNode?.id ?? null,
        anchor: (drag.fromNode ? drag.fromSide : 'auto') as AnchorSide,
        x: drag.from.x,
        y: drag.from.y
      },
      to: {
        node: target?.id ?? null,
        anchor: (target ? drag.targetSide : 'auto') as AnchorSide,
        x: end.x,
        y: end.y
      },
      routing: 'orthogonal' as const,
      arrow: 'end' as const,
      label: '',
      style: newEdgeStyle()
    }
    doc.edges.push(edge)
    this.host.setSelection([edge.id])
    this.host.commitApplied([{ op: 'delEdge', id: edge.id }], [
      { op: 'addEdge', index: doc.edges.length - 1, edge: cloneEdge(edge) }
    ])
    this.host.renderAll()
  }

  private finishCreate(drag: Extract<Drag, { kind: 'create' }>, p: Point): void {
    const shape = this.host.pendingShape
    if (!shape) return
    let rect: Rect
    if (drag.moved) {
      rect = normalizeRect(drag.start, p)
      rect.w = Math.max(20, rect.w)
      rect.h = Math.max(20, rect.h)
    } else {
      const size = DEFAULT_SIZE[shape]
      rect = {
        x: Math.round(drag.start.x - size.w / 2),
        y: Math.round(drag.start.y - size.h / 2),
        w: size.w,
        h: size.h
      }
    }
    if (this.host.snapEnabled() && !drag.moved) {
      rect.x = snapToGrid(rect.x, GRID_SIZE)
      rect.y = snapToGrid(rect.y, GRID_SIZE)
    }
    const node = this.host.addNode(shape, rect)
    this.host.commitApplied([{ op: 'delNode', id: node.id }], [
      { op: 'addNode', index: this.host.doc.nodes.length - 1, node: cloneNode(node) }
    ])
    this.host.setSelection([node.id])
    this.host.setPendingShape(null)
    this.host.setTool('select')
    this.host.renderAll()
  }

  // ---------- 命中 ----------

  private handleAt(e: PointerEvent): { name: string } | null {
    if (this.host.selected.size !== 1) return null
    const id = this.host.selected.values().next().value
    const node = id ? this.host.doc.nodes.find(n => n.id === id) : null
    if (!node) return null
    const rect = this.el.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    for (const [name, fx, fy] of HANDLES) {
      const p = this.host.renderer.screenOf(node.x + node.w * fx, node.y + node.h * fy)
      if (Math.abs(cx - p.x) <= 6 && Math.abs(cy - p.y) <= 6) return { name }
    }
    return null
  }

  private anchorAt(node: CanvasNode, p: Point): Side | null {
    const tol = 9 / this.host.viewport.scale
    for (const side of ['n', 'e', 's', 'w'] as Side[]) {
      const a = anchorPoint(node, side)
      if (Math.hypot(a.x - p.x, a.y - p.y) <= tol) return side
    }
    return null
  }

  private marqueeSelection(drag: Extract<Drag, { kind: 'marquee' }>): string[] {
    const rect = normalizeRect(drag.start, drag.current)
    const picked = this.host.doc.nodes.filter(n => rectsIntersect(rect, nodeRect(n))).map(n => n.id)
    return drag.additive ? [...new Set([...drag.base, ...picked])] : picked
  }

  // ---------- 双击 / 滚轮 ----------

  private onDblClick = (e: MouseEvent): void => {
    if (this.host.readOnly) return
    const p = this.world(e)
    const node = hitNode(this.host.doc, p)
    if (node) {
      this.host.setSelection([node.id])
      this.host.beginTextEdit({ kind: 'node', id: node.id })
      return
    }
    const edge = hitEdge(this.host.doc, p, 6 / this.host.viewport.scale)
    if (edge) {
      this.host.setSelection([edge.id])
      this.host.beginTextEdit({ kind: 'edge', id: edge.id })
      return
    }
    // 空白处双击 = 新建一个文本节点并立即输入
    const size = DEFAULT_SIZE.text
    const created = this.host.addNode('text', {
      x: Math.round(p.x - size.w / 2),
      y: Math.round(p.y - size.h / 2),
      w: size.w,
      h: size.h
    }, '')
    this.host.commitApplied([{ op: 'delNode', id: created.id }], [
      { op: 'addNode', index: this.host.doc.nodes.length - 1, node: cloneNode(created) }
    ])
    this.host.setSelection([created.id])
    this.host.renderAll()
    this.host.beginTextEdit({ kind: 'node', id: created.id })
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const vp = this.host.viewport
    if (e.ctrlKey || e.metaKey) {
      const rect = this.el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const worldX = (cx - vp.tx) / vp.scale
      const worldY = (cy - vp.ty) / vp.scale
      const next = clamp(vp.scale * Math.exp(-e.deltaY * 0.0015), 0.1, 4)
      this.host.setViewport({
        scale: next,
        tx: cx - worldX * next,
        ty: cy - worldY * next
      })
    } else {
      this.host.setViewport({
        ...vp,
        tx: vp.tx - e.deltaX,
        ty: vp.ty - e.deltaY
      })
    }
    this.host.renderOverlay()
    this.updateHoverForLastWorld()
  }

  private updateHoverForLastWorld(): void {
    // 缩放/平移后锚点提示可能落在别处;用最近一次指针位置重算一次
    const p = this.lastWorld
    this.setHoverNode(hitNode(this.host.doc, p))
  }

  // ---------- 键盘 / 剪贴板 ----------

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
    const mod = e.ctrlKey || e.metaKey

    if (e.code === 'Space' && !e.repeat) {
      this.spaceDown = true
      e.preventDefault()
      return
    }

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.host.redo()
      else this.host.undo()
      return
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      this.host.redo()
      return
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      this.host.selectAll()
      return
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      this.host.duplicateSelection()
      return
    }
    // 复制/剪切/粘贴交给原生 copy/cut/paste 事件:菜单里的 role 与键盘
    // 走的是同一条路,不需要两套实现

    if (this.host.readOnly) return

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.host.selected.size) {
        e.preventDefault()
        this.host.deleteSelection()
      }
      return
    }
    if (e.key === 'Escape') {
      if (this.drag?.kind === 'connect') {
        this.drag = null
        this.host.setPreview(null, null)
      } else if (this.drag?.kind === 'create') {
        this.drag = null
        this.host.setCreateRect(null)
        this.host.renderOverlay()
      } else if (this.host.selected.size) {
        this.host.setSelection([])
      } else if (this.host.tool !== 'select') {
        this.host.setTool('select')
        this.host.setPendingShape(null)
      }
      return
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      const id = this.host.selected.values().next().value
      if (!id) return
      const node = this.host.doc.nodes.find(n => n.id === id)
      if (node) {
        e.preventDefault()
        this.host.beginTextEdit({ kind: 'node', id: node.id })
        return
      }
      const edge = this.host.doc.edges.find(x => x.id === id)
      if (edge) {
        e.preventDefault()
        this.host.beginTextEdit({ kind: 'edge', id: edge.id })
      }
      return
    }
    const step = e.shiftKey ? 10 : 1
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    }
    const delta = deltas[e.key]
    if (delta && this.host.selected.size) {
      e.preventDefault()
      this.nudge(delta[0], delta[1])
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') {
      this.spaceDown = false
      if (!this.drag) this.host.setCursor(this.host.tool === 'pan' ? 'grab' : 'default')
    }
  }

  private nudge(dx: number, dy: number): void {
    const ids = new Set(this.host.selected)
    const before = this.host.doc.nodes.filter(n => ids.has(n.id)).map(cloneNode)
    if (before.length === 0) return
    for (const n of before) {
      const node = this.host.doc.nodes.find(x => x.id === n.id)
      if (!node) continue
      node.x += dx
      node.y += dy
    }
    const after = before
      .map(n => this.host.doc.nodes.find(x => x.id === n.id))
      .filter((n): n is CanvasNode => !!n)
      .map(cloneNode)
    const diff = nodeDiffPatches(before, after)
    this.host.commitApplied(diff.undo, diff.redo)
    const edgeIds = new Set(edgesOf(this.host.doc, ids).map(e => e.id))
    this.host.renderFast(ids, edgeIds)
    this.host.renderOverlay()
  }

  private onCopy = (e: ClipboardEvent): void => {
    if (this.host.selected.size === 0) return
    // 由 runtime 写 text/plain(内部 JSON),这里阻止浏览器再按 DOM 选区复制一份
    this.host.copySelection(e.clipboardData)
    e.preventDefault()
  }

  private onCut = (e: ClipboardEvent): void => {
    if (this.host.readOnly || this.host.selected.size === 0) return
    this.host.cutSelection(e.clipboardData)
    e.preventDefault()
  }

  private onPaste = (e: ClipboardEvent): void => {
    if (this.host.readOnly) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    this.host.pasteText(text, this.lastWorld)
    e.preventDefault()
  }

  private onContextMenu = (e: MouseEvent): void => {
    // 画布没有原生右键菜单;右键拖动与 Electron 默认菜单都关掉
    e.preventDefault()
  }
}

