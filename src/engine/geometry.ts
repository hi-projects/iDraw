/**
 * 画布几何:锚点、连线路由、命中测试、内容边界。
 *
 * 所有坐标都是世界坐标。屏幕坐标只在 runtime/render 的边界上转换一次
 * (见 runtime.ts 的 `toWorld` / `toScreen`),这里不出现缩放/平移。
 */
import {
  type AnchorSide,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type EdgeEnd,
  CONTENT_MARGIN,
  findNode
} from './model'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function nodeCenter(node: CanvasNode): Point {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 }
}

export function nodeRect(node: CanvasNode): Rect {
  return { x: node.x, y: node.y, w: node.w, h: node.h }
}

/** 锚点在世界坐标里的位置;`auto` 不能直接取,先经 resolveSides */
export function anchorPoint(node: CanvasNode, side: Exclude<AnchorSide, 'auto'>): Point {
  switch (side) {
    case 'n':
      return { x: node.x + node.w / 2, y: node.y }
    case 'e':
      return { x: node.x + node.w, y: node.y + node.h / 2 }
    case 's':
      return { x: node.x + node.w / 2, y: node.y + node.h }
    case 'w':
      return { x: node.x, y: node.y + node.h / 2 }
  }
}

/** 该侧向外的单位法向(正交路由与曲线控制柄都按它伸出去) */
export function normalOf(side: Exclude<AnchorSide, 'auto'>): Point {
  switch (side) {
    case 'n':
      return { x: 0, y: -1 }
    case 'e':
      return { x: 1, y: 0 }
    case 's':
      return { x: 0, y: 1 }
    case 'w':
      return { x: -1, y: 0 }
  }
}

export function isHorizontal(side: Exclude<AnchorSide, 'auto'>): boolean {
  return side === 'e' || side === 'w'
}

/**
 * `auto` 选边:比较两节点中心的水平/垂直距离,取更近的那一对侧。
 * 两端都固定时原样返回。
 */
export function resolveSides(
  edge: CanvasEdge,
  doc: CanvasDoc
): { from: Exclude<AnchorSide, 'auto'>; to: Exclude<AnchorSide, 'auto'> } {
  const fromNode = edge.from.node ? findNode(doc, edge.from.node) : null
  const toNode = edge.to.node ? findNode(doc, edge.to.node) : null
  let from = edge.from.anchor
  let to = edge.to.anchor
  if (fromNode && toNode && (from === 'auto' || to === 'auto')) {
    const a = nodeCenter(fromNode)
    const b = nodeCenter(toNode)
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (from === 'auto') from = dx >= 0 ? 'e' : 'w'
      if (to === 'auto') to = dx >= 0 ? 'w' : 'e'
    } else {
      if (from === 'auto') from = dy >= 0 ? 's' : 'n'
      if (to === 'auto') to = dy >= 0 ? 'n' : 's'
    }
  }
  // 只剩一端是节点、另一端自由时,固定端按"朝向自由点"挑边
  if (from === 'auto') {
    const p = endPoint(edge.to, toNode)
    const c = fromNode ? nodeCenter(fromNode) : p
    from = Math.abs(p.x - c.x) >= Math.abs(p.y - c.y) ? (p.x >= c.x ? 'e' : 'w') : p.y >= c.y ? 's' : 'n'
  }
  if (to === 'auto') {
    const p = endPoint(edge.from, fromNode)
    const c = toNode ? nodeCenter(toNode) : p
    to = Math.abs(p.x - c.x) >= Math.abs(p.y - c.y) ? (p.x >= c.x ? 'e' : 'w') : p.y >= c.y ? 's' : 'n'
  }
  return { from: from as Exclude<AnchorSide, 'auto'>, to: to as Exclude<AnchorSide, 'auto'> }
}

/** 一端的坐标:节点端点取锚点,自由端点取存下的坐标 */
export function endPoint(end: EdgeEnd, node: CanvasNode | null): Point {
  if (node) {
    const side = end.anchor === 'auto' ? 'e' : end.anchor
    return anchorPoint(node, side)
  }
  return { x: end.x, y: end.y }
}

export interface EdgeGeometry {
  from: Point
  to: Point
  fromSide: Exclude<AnchorSide, 'auto'>
  toSide: Exclude<AnchorSide, 'auto'>
  /** SVG path 的 d */
  d: string
  /** 路径中点(边标签位置) */
  mid: Point
  /** 折线顶点(命中测试与中点计算用);曲线只有四个控制点 */
  points: Point[]
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** 去掉连续重复的点(正交路由里很容易出现) */
function dedupe(points: Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue
    out.push(p)
  }
  return out
}

function polylineMid(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 }
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
  }
  let walked = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (walked + len >= total / 2) {
      const t = len === 0 ? 0 : (total / 2 - walked) / len
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    walked += len
  }
  return points[points.length - 1]!
}

/** 正交路由:直进直出,两端各留一小段让线离开形状 */
function orthogonalRoute(from: Point, to: Point, fromSide: Exclude<AnchorSide, 'auto'>, toSide: Exclude<AnchorSide, 'auto'>): Point[] {
  const stub = 20
  const fn = normalOf(fromSide)
  const tn = normalOf(toSide)
  const a = { x: from.x + fn.x * stub, y: from.y + fn.y * stub }
  const b = { x: to.x + tn.x * stub, y: to.y + tn.y * stub }
  const fh = isHorizontal(fromSide)
  const th = isHorizontal(toSide)

  if (fh !== th) {
    // 一横一竖:两段拐角就够
    return dedupe([from, { x: a.x, y: b.y }, b, to])
  }

  if (fh) {
    // 都是横的:同向要绕出去,反向走中线
    let mx: number
    if (fromSide === toSide) {
      mx = fromSide === 'e' ? Math.max(a.x, b.x) + stub : Math.min(a.x, b.x) - stub
    } else if (fromSide === 'e' && to.x > from.x) {
      mx = (from.x + to.x) / 2
    } else if (fromSide === 'w' && to.x < from.x) {
      mx = (from.x + to.x) / 2
    } else {
      mx = fromSide === 'e' ? Math.max(a.x, b.x) + stub : Math.min(a.x, b.x) - stub
    }
    return dedupe([from, { x: mx, y: from.y }, { x: mx, y: to.y }, to])
  }

  // 都是竖的
  let my: number
  if (fromSide === toSide) {
    my = fromSide === 's' ? Math.max(a.y, b.y) + stub : Math.min(a.y, b.y) - stub
  } else if (fromSide === 's' && to.y > from.y) {
    my = (from.y + to.y) / 2
  } else if (fromSide === 'n' && to.y < from.y) {
    my = (from.y + to.y) / 2
  } else {
    my = fromSide === 's' ? Math.max(a.y, b.y) + stub : Math.min(a.y, b.y) - stub
  }
  return dedupe([from, { x: from.x, y: my }, { x: to.x, y: my }, to])
}

/** 曲线:两端各沿法向伸出一段控制柄 */
function curveRoute(from: Point, to: Point, fromSide: Exclude<AnchorSide, 'auto'>, toSide: Exclude<AnchorSide, 'auto'>): { d: string; points: Point[]; mid: Point } {
  const k = Math.max(40, Math.min(160, Math.hypot(to.x - from.x, to.y - from.y) * 0.45))
  const fn = normalOf(fromSide)
  const tn = normalOf(toSide)
  const c1 = { x: from.x + fn.x * k, y: from.y + fn.y * k }
  const c2 = { x: to.x + tn.x * k, y: to.y + tn.y * k }
  const d = `M${fmt(from.x)},${fmt(from.y)} C${fmt(c1.x)},${fmt(c1.y)} ${fmt(c2.x)},${fmt(c2.y)} ${fmt(to.x)},${fmt(to.y)}`
  const mid = {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8
  }
  return { d, points: [from, c1, c2, to], mid }
}

/** 求出整条边的可绘制几何(不修改文档) */
export function edgeGeometry(edge: CanvasEdge, doc: CanvasDoc): EdgeGeometry {
  const fromNode = edge.from.node ? findNode(doc, edge.from.node) : null
  const toNode = edge.to.node ? findNode(doc, edge.to.node) : null
  const sides = resolveSides(edge, doc)
  const from = fromNode ? anchorPoint(fromNode, sides.from) : { x: edge.from.x, y: edge.from.y }
  const to = toNode ? anchorPoint(toNode, sides.to) : { x: edge.to.x, y: edge.to.y }

  if (edge.routing === 'curve') {
    const curve = curveRoute(from, to, sides.from, sides.to)
    return { from, to, fromSide: sides.from, toSide: sides.to, ...curve }
  }
  if (edge.routing === 'orthogonal') {
    const points = orthogonalRoute(from, to, sides.from, sides.to)
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)},${fmt(p.y)}`).join(' ')
    return { from, to, fromSide: sides.from, toSide: sides.to, d, mid: polylineMid(points), points }
  }
  const d = `M${fmt(from.x)},${fmt(from.y)} L${fmt(to.x)},${fmt(to.y)}`
  return { from, to, fromSide: sides.from, toSide: sides.to, d, mid: polylineMid([from, to]), points: [from, to] }
}

/** 临时预览(从锚点拖出、还没落到节点上) */
export function previewGeometry(from: Point, to: Point, routing: CanvasEdge['routing'], fromSide: Exclude<AnchorSide, 'auto'> = 'e', toSide: Exclude<AnchorSide, 'auto'> = 'w'): EdgeGeometry {
  if (routing === 'curve') {
    const curve = curveRoute(from, to, fromSide, toSide)
    return { from, to, fromSide, toSide, ...curve }
  }
  if (routing === 'orthogonal') {
    const points = orthogonalRoute(from, to, fromSide, toSide)
    return {
      from,
      to,
      fromSide,
      toSide,
      d: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)},${fmt(p.y)}`).join(' '),
      mid: polylineMid(points),
      points
    }
  }
  return {
    from,
    to,
    fromSide,
    toSide,
    d: `M${fmt(from.x)},${fmt(from.y)} L${fmt(to.x)},${fmt(to.y)}`,
    mid: polylineMid([from, to]),
    points: [from, to]
  }
}

/** 点到线段的距离 */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

export function hitNode(doc: CanvasDoc, point: Point, tolerance = 0): CanvasNode | null {
  for (let i = doc.nodes.length - 1; i >= 0; i--) {
    const n = doc.nodes[i]!
    if (
      point.x >= n.x - tolerance &&
      point.x <= n.x + n.w + tolerance &&
      point.y >= n.y - tolerance &&
      point.y <= n.y + n.h + tolerance
    ) {
      return n
    }
  }
  return null
}

export function hitEdge(doc: CanvasDoc, point: Point, tolerance = 6): CanvasEdge | null {
  for (let i = doc.edges.length - 1; i >= 0; i--) {
    const e = doc.edges[i]!
    const g = edgeGeometry(e, doc)
    const points = g.points
    for (let j = 1; j < points.length; j++) {
      if (distanceToSegment(point, points[j - 1]!, points[j]!) <= tolerance) return e
    }
    if (e.label) {
      const lines = e.label.split('\n')
      const width = Math.max(...lines.map(l => l.length), 1) * e.style.fontSize * 0.9
      const height = lines.length * e.style.fontSize * 1.4
      if (
        Math.abs(point.x - g.mid.x) <= Math.max(20, width / 2) &&
        Math.abs(point.y - g.mid.y) <= Math.max(12, height / 2)
      ) {
        return e
      }
    }
  }
  return null
}

/** 所有节点的包围盒;没有节点时为 null */
export function nodesBounds(nodes: CanvasNode[]): Rect | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * 内容边界(节点 + 自由端点 + 边标签中心)。保存时页面至少罩住它,
 * 免得节点拖到页面外之后,别的查看器打开是一张被裁掉一半的图。
 */
export function contentBounds(doc: CanvasDoc): Rect | null {
  const base = nodesBounds(doc.nodes)
  let minX = base ? base.x : Infinity
  let minY = base ? base.y : Infinity
  let maxX = base ? base.x + base.w : -Infinity
  let maxY = base ? base.y + base.h : -Infinity
  for (const e of doc.edges) {
    const g = edgeGeometry(e, doc)
    const pts = [g.from, g.to, g.mid]
    for (const p of pts) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * 保存时的 viewBox:页面本身与内容边界(各留 CONTENT_MARGIN)的并集。
 * 不收缩 —— 用户把节点拖回页面内之后,画布尺寸不该莫名变小。
 */
export function computedViewBox(doc: CanvasDoc): { x: number; y: number; w: number; h: number } {
  const vb = doc.viewBox
  let minX = vb.x
  let minY = vb.y
  let maxX = vb.x + vb.w
  let maxY = vb.y + vb.h
  const content = contentBounds(doc)
  if (content) {
    minX = Math.min(minX, content.x - CONTENT_MARGIN)
    minY = Math.min(minY, content.y - CONTENT_MARGIN)
    maxX = Math.max(maxX, content.x + content.w + CONTENT_MARGIN)
    maxY = Math.max(maxY, content.y + content.h + CONTENT_MARGIN)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 网格吸附 */
export function snapToGrid(value: number, size: number): number {
  return Math.round(value / size) * size
}
