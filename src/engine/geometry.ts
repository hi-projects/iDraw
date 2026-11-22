/**
 * 画布几何:锚点、连线路由、命中测试、内容边界。
 *
 * 所有坐标都是世界坐标。屏幕坐标只在 runtime/render 的边界上转换一次
 * (见 runtime.ts 的 `toWorld` / `toScreen`),这里不出现缩放/平移。
 */
import {
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type EdgeEnd,
  type EdgeSide,
  CONTENT_MARGIN,
  findNode
} from './model'
import { shapeParts } from './shapes'

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

// ---------- 形状轮廓(端点吸附到边缘用) ----------

function parsePointList(raw: string): Point[] {
  const nums = raw.trim().split(/[\s,]+/).map(Number)
  const points: Point[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i]
    const y = nums[i + 1]
    if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x, y })
    }
  }
  return points
}

function rectOutline(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h }
  ]
}

/** 圆角矩形的轮廓采样(只在圆角处多取点) */
function roundRectOutline(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  ry: number
): Point[] {
  const cx = Math.max(0, Math.min(rx, w / 2))
  const cy = Math.max(0, Math.min(ry, h / 2))
  if (cx === 0 || cy === 0) return rectOutline(x, y, w, h)
  const points: Point[] = []
  const arc = (ox: number, oy: number, from: number, to: number): void => {
    const steps = 6
    for (let i = 0; i <= steps; i++) {
      const angle = from + ((to - from) * i) / steps
      points.push({ x: ox + Math.cos(angle) * cx, y: oy + Math.sin(angle) * cy })
    }
  }
  points.push({ x: x + cx, y })
  points.push({ x: x + w - cx, y })
  arc(x + w - cx, y + cy, -Math.PI / 2, 0)
  points.push({ x: x + w, y: y + h - cy })
  arc(x + w - cx, y + h - cy, 0, Math.PI / 2)
  points.push({ x: x + cx, y: y + h })
  arc(x + cx, y + h - cy, Math.PI / 2, Math.PI)
  points.push({ x, y: y + cy })
  arc(x + cx, y + cy, Math.PI, (Math.PI * 3) / 2)
  return points
}

function ellipseOutline(cx: number, cy: number, rx: number, ry: number): Point[] {
  const points: Point[] = []
  const steps = 64
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2
    points.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry })
  }
  return points
}

/** 轮廓只依赖形状/尺寸/圆角;按这些键缓存本地坐标,避免每次移动都重算 */
const outlineCache = new Map<string, Point[][]>()
const OUTLINE_CACHE_LIMIT = 512

/** 节点在本地坐标(0..w / 0..h)里的闭合轮廓;一段形状可能由多条轮廓组成 */
function nodeOutlineLocal(node: CanvasNode): Point[][] {
  const key = `${node.shape}|${node.w}|${node.h}|${node.style.radius}`
  const cached = outlineCache.get(key)
  if (cached) return cached

  const outlines: Point[][] = []
  for (const part of shapeParts(node)) {
    const a = part.attrs
    if (part.tag === 'rect') {
      const x = Number(a.x ?? 0)
      const y = Number(a.y ?? 0)
      const w = Number(a.width ?? node.w)
      const h = Number(a.height ?? node.h)
      const rx = Number(a.rx ?? 0)
      const ry = Number(a.ry ?? rx)
      outlines.push(rx > 0 || ry > 0 ? roundRectOutline(x, y, w, h, rx, ry) : rectOutline(x, y, w, h))
    } else if (part.tag === 'ellipse') {
      outlines.push(ellipseOutline(Number(a.cx), Number(a.cy), Number(a.rx), Number(a.ry)))
    } else if (part.tag === 'polygon') {
      const points = parsePointList(String(a.points ?? ''))
      if (points.length >= 2) outlines.push(points)
    } else if (part.tag === 'path') {
      // 圆柱/文档这类曲线形状按外接框近似,误差与描边宽度同量级
      outlines.push(rectOutline(0, 0, node.w, node.h))
    }
  }
  // 文本等没有几何体的节点:用外接框,仍然是"形状边缘"
  if (outlines.length === 0) outlines.push(rectOutline(0, 0, node.w, node.h))

  if (outlineCache.size >= OUTLINE_CACHE_LIMIT) {
    const oldest = outlineCache.keys().next().value
    if (oldest !== undefined) outlineCache.delete(oldest)
  }
  outlineCache.set(key, outlines)
  return outlines
}

function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return a
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return { x: a.x + dx * t, y: a.y + dy * t }
}

/** 形状轮廓上离 p 最近的点(世界坐标);点的距离同时返回,供吸附阈值判断 */
export function closestPointOnNode(
  node: CanvasNode,
  p: Point
): { point: Point; distance: number } | null {
  let best: Point | null = null
  let bestDist = Infinity
  const local = { x: p.x - node.x, y: p.y - node.y }
  for (const outline of nodeOutlineLocal(node)) {
    if (outline.length === 0) continue
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!
      const b = outline[(i + 1) % outline.length]!
      const q = closestOnSegment(local, a, b)
      const dist = Math.hypot(q.x - local.x, q.y - local.y)
      if (dist < bestDist) {
        bestDist = dist
        best = { x: node.x + q.x, y: node.y + q.y }
      }
    }
  }
  return best ? { point: best, distance: bestDist } : null
}

/** 锚点在世界坐标里的位置;`auto`/`free` 不能直接取,先经 resolveSides */
export function anchorPoint(node: CanvasNode, side: EdgeSide): Point {
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
export function normalOf(side: EdgeSide): Point {
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

export function isHorizontal(side: EdgeSide): boolean {
  return side === 'e' || side === 'w'
}

/** 从一个点指向另一个点的方向(路由方向用) */
export function sideToward(from: Point, to: Point): EdgeSide {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'e' : 'w'
  return dy >= 0 ? 's' : 'n'
}

/** 端点在节点上的相对位置(0–1);拖动时存这个比例,移动/缩放节点后端点仍跟着走 */
export function pointRatio(node: CanvasNode, p: Point): Point {
  return {
    x: (p.x - node.x) / Math.max(1, node.w),
    y: (p.y - node.y) / Math.max(1, node.h)
  }
}

/**
 * 任意位置端点该从哪一侧离开节点。
 *
 * - 先取离端点最近的那条外框边,保证路由**垂直于轮廓**离开,不会顺着长边和
 *   形状轮廓重合;
 * - 再在这条边的垂直轴上,选朝向另一个端点的一侧 —— 否则正交路由会先绕到
 *   端点外侧再折回来,终点箭头看起来正好和线的前进方向相反。
 */
export function sideOfPoint(node: CanvasNode, p: Point, toward?: Point): EdgeSide {
  const dW = Math.abs(p.x - node.x)
  const dE = Math.abs(p.x - (node.x + node.w))
  const dN = Math.abs(p.y - node.y)
  const dS = Math.abs(p.y - (node.y + node.h))
  const min = Math.min(dW, dE, dN, dS)
  const nearest: EdgeSide[] = []
  if (dN === min) nearest.push('n')
  if (dS === min) nearest.push('s')
  if (dW === min) nearest.push('w')
  if (dE === min) nearest.push('e')
  let side: EdgeSide
  if (nearest.length === 1) {
    side = nearest[0]!
  } else {
    // 角点会有两条边同样近:用中心指向端点的方向挑一条朝外的
    const outward = sideToward(nodeCenter(node), p)
    side = nearest.includes(outward) ? outward : nearest[0]!
  }
  if (!toward) return side
  if (side === 'n' || side === 's') return toward.y <= p.y ? 'n' : 's'
  return toward.x <= p.x ? 'w' : 'e'
}

/**
 * 选路由用的两侧:
 * 固定侧原样使用;`free` 端点按它落在节点上的方向算;`auto` 按两端位置挑。
 */
export function resolveSides(edge: CanvasEdge, doc: CanvasDoc): { from: EdgeSide; to: EdgeSide } {
  const fromNode = edge.from.node ? findNode(doc, edge.from.node) : null
  const toNode = edge.to.node ? findNode(doc, edge.to.node) : null
  const fromPoint = endPoint(edge.from, fromNode)
  const toPoint = endPoint(edge.to, toNode)
  // auto 比较的是"两端代表位置":节点用中心,自由端点用自身坐标
  const fromRef = fromNode ? nodeCenter(fromNode) : fromPoint
  const toRef = toNode ? nodeCenter(toNode) : toPoint
  return {
    from: resolveSide(edge.from, fromNode, fromPoint, fromRef, toRef, toPoint),
    to: resolveSide(edge.to, toNode, toPoint, toRef, fromRef, fromPoint)
  }
}

function resolveSide(
  end: EdgeEnd,
  node: CanvasNode | null,
  point: Point,
  ref: Point,
  otherRef: Point,
  otherPoint: Point
): EdgeSide {
  if (end.anchor === 'n' || end.anchor === 'e' || end.anchor === 's' || end.anchor === 'w') {
    return end.anchor
  }
  // 任意位置挂在节点上:垂直于最近的轮廓边离开,方向朝另一端;正好落在中心时退回朝另一端
  if (node && end.anchor === 'free') {
    const c = nodeCenter(node)
    if (Math.abs(point.x - c.x) < 0.5 && Math.abs(point.y - c.y) < 0.5) {
      return sideToward(ref, otherRef)
    }
    return sideOfPoint(node, point, otherPoint)
  }
  return sideToward(ref, otherRef)
}

/**
 * 一端的坐标:
 * - 节点端点:free 用存下的比例,其余用锚点;
 * - 自由端点:用存下的世界坐标。
 * `side` 是 resolveSides 的结果,节点端点的 auto 由它落位。
 */
export function endPoint(end: EdgeEnd, node: CanvasNode | null, side?: EdgeSide): Point {
  if (node) {
    if (end.anchor === 'free') {
      return { x: node.x + end.x * node.w, y: node.y + end.y * node.h }
    }
    const placed = end.anchor === 'auto' ? (side ?? 'e') : end.anchor
    return anchorPoint(node, placed)
  }
  return { x: end.x, y: end.y }
}

export interface EdgeGeometry {
  from: Point
  to: Point
  fromSide: EdgeSide
  toSide: EdgeSide
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
function orthogonalRoute(from: Point, to: Point, fromSide: EdgeSide, toSide: EdgeSide): Point[] {
  const stub = 20
  const fn = normalOf(fromSide)
  const tn = normalOf(toSide)
  const a = { x: from.x + fn.x * stub, y: from.y + fn.y * stub }
  const b = { x: to.x + tn.x * stub, y: to.y + tn.y * stub }
  const fh = isHorizontal(fromSide)
  const th = isHorizontal(toSide)

  if (fh !== th) {
    // 一横一竖:两段拐角就够
    const points = dedupe([from, { x: a.x, y: b.y }, b, to])
    // 若最后一段先越过端点再折回来(固定锚点常见),去掉折返点:
    // 路径仍垂直于端点所在边,但箭头会沿线的前进方向,不会指回线身。
    if (points.length >= 4) {
      const prev = points[points.length - 3]!
      const stubPoint = points[points.length - 2]!
      const end = points[points.length - 1]!
      const inX = stubPoint.x - prev.x
      const inY = stubPoint.y - prev.y
      const outX = end.x - stubPoint.x
      const outY = end.y - stubPoint.y
      if (inX * outX + inY * outY < 0) points.splice(points.length - 2, 1)
    }
    return points
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

/**
 * 手动折点:按折点逐段转成直角折线,保持正交风格。
 * 折点本身会保留为路径顶点;两个折点不在同一水平/垂直线上时插入一个拐角。
 */
function manualRoute(
  from: Point,
  to: Point,
  waypoints: Array<{ x: number; y: number }>,
  fromSide: EdgeSide,
  toSide: EdgeSide
): Point[] {
  const points: Point[] = [from]
  let lastHorizontal = isHorizontal(fromSide)
  const append = (target: Point): void => {
    const current = points[points.length - 1]!
    const dx = target.x - current.x
    const dy = target.y - current.y
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return
    if (Math.abs(dx) < 0.01 || Math.abs(dy) < 0.01) {
      points.push({ x: target.x, y: target.y })
      lastHorizontal = Math.abs(dx) >= 0.01
      return
    }
    if (lastHorizontal) {
      points.push({ x: current.x, y: target.y }, { x: target.x, y: target.y })
      lastHorizontal = true
    } else {
      points.push({ x: target.x, y: current.y }, { x: target.x, y: target.y })
      lastHorizontal = false
    }
  }
  for (const p of waypoints) append(p)
  // 最后一段按端点所在边对齐,箭头进入节点的方向保持正交
  const last = points[points.length - 1]!
  if (isHorizontal(toSide)) {
    if (Math.abs(last.y - to.y) > 0.01) points.push({ x: last.x, y: to.y })
  } else if (Math.abs(last.x - to.x) > 0.01) {
    points.push({ x: to.x, y: last.y })
  }
  points.push(to)
  return dedupe(points)
}

/** 曲线:两端各沿法向伸出一段控制柄 */
function curveRoute(from: Point, to: Point, fromSide: EdgeSide, toSide: EdgeSide): { d: string; points: Point[]; mid: Point } {
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
  const from = endPoint(edge.from, fromNode, sides.from)
  const to = endPoint(edge.to, toNode, sides.to)

  const manualPoints = (edge.waypoints ?? []).filter(
    p => Number.isFinite(p.x) && Number.isFinite(p.y)
  )

  if (edge.routing === 'curve') {
    const curve = curveRoute(from, to, sides.from, sides.to)
    // 曲线下折点就是贝塞尔控制点:拖动两端的手柄即可改变弧度
    if (manualPoints.length > 0) {
      const c1 = manualPoints[0]!
      const c2 = manualPoints[1] ?? { x: curve.points[2]!.x, y: curve.points[2]!.y }
      const d = `M${fmt(from.x)},${fmt(from.y)} C${fmt(c1.x)},${fmt(c1.y)} ${fmt(c2.x)},${fmt(c2.y)} ${fmt(to.x)},${fmt(to.y)}`
      const mid = {
        x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
        y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8
      }
      return {
        from,
        to,
        fromSide: sides.from,
        toSide: sides.to,
        d,
        mid,
        points: [from, c1, c2, to]
      }
    }
    return { from, to, fromSide: sides.from, toSide: sides.to, ...curve }
  }

  // 有手动折点时走手动路径
  if (manualPoints.length > 0) {
    const points =
      edge.routing === 'straight'
        ? dedupe([from, ...manualPoints.map(p => ({ x: p.x, y: p.y })), to])
        : manualRoute(from, to, manualPoints, sides.from, sides.to)
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)},${fmt(p.y)}`).join(' ')
    return { from, to, fromSide: sides.from, toSide: sides.to, d, mid: polylineMid(points), points }
  }
  if (edge.routing === 'orthogonal') {
    const points = orthogonalRoute(from, to, sides.from, sides.to)
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)},${fmt(p.y)}`).join(' ')
    return { from, to, fromSide: sides.from, toSide: sides.to, d, mid: polylineMid(points), points }
  }
  const d = `M${fmt(from.x)},${fmt(from.y)} L${fmt(to.x)},${fmt(to.y)}`
  return { from, to, fromSide: sides.from, toSide: sides.to, d, mid: polylineMid([from, to]), points: [from, to] }
}

export const DEFAULT_EDGE_LABEL_POS = 0.5

/** 标签在路径上的位置比例(0=起点,1=终点);缺省中点 */
export function edgeLabelPos(edge: CanvasEdge): number {
  const value = edge.labelPos
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_EDGE_LABEL_POS
  return Math.min(1, Math.max(0, value))
}

function cubicAt(points: Point[], t: number): Point {
  const [p0, p1, p2, p3] = points
  if (!p0 || !p1 || !p2 || !p3) return p0 ?? { x: 0, y: 0 }
  const mt = 1 - t
  return {
    x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
    y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y
  }
}

/** 折线上按累计长度取比例位置 */
function pointOnPolyline(points: Point[], fraction: number): Point {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return points[0]!
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
  }
  if (total === 0) return points[0]!
  let target = Math.min(1, Math.max(0, fraction)) * total
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (target <= len || i === points.length - 1) {
      const t = len === 0 ? 0 : target / len
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    target -= len
  }
  return points[points.length - 1]!
}

/** 标签锚点:按 labelPos 落在路径上;曲线按贝塞尔参数,正交/直线按折线长度 */
export function edgeLabelPoint(edge: CanvasEdge, doc: CanvasDoc): Point {
  const g = edgeGeometry(edge, doc)
  const f = edgeLabelPos(edge)
  if (edge.routing === 'curve') return cubicAt(g.points, f)
  return pointOnPolyline(g.points, f)
}

/** 指针在边路径上的最近位置比例(拖动标签时用) */
export function nearestFractionOnEdge(edge: CanvasEdge, doc: CanvasDoc, p: Point): number {
  const g = edgeGeometry(edge, doc)
  if (edge.routing === 'curve') {
    let best = 0
    let bestDist = Infinity
    const steps = 80
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const q = cubicAt(g.points, t)
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d < bestDist) {
        bestDist = d
        best = t
      }
    }
    return best
  }
  const points = g.points
  if (points.length < 2) return edgeLabelPos(edge)
  let total = 0
  const lens: number[] = []
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
    lens.push(len)
    total += len
  }
  if (total === 0) return edgeLabelPos(edge)
  let bestDist = Infinity
  let bestAlong = 0
  let walked = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    const t =
      lenSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
    const qx = a.x + dx * t
    const qy = a.y + dy * t
    const d = Math.hypot(qx - p.x, qy - p.y)
    if (d < bestDist) {
      bestDist = d
      bestAlong = walked + lens[i - 1]! * t
    }
    walked += lens[i - 1]!
  }
  return Math.min(1, Math.max(0, bestAlong / total))
}

/** 临时预览(从锚点拖出、还没落到节点上) */
export function previewGeometry(from: Point, to: Point, routing: CanvasEdge['routing'], fromSide: EdgeSide = 'e', toSide: EdgeSide = 'w'): EdgeGeometry {
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
      const at = edgeLabelPoint(e, doc)
      if (
        Math.abs(point.x - at.x) <= Math.max(20, width / 2) &&
        Math.abs(point.y - at.y) <= Math.max(12, height / 2)
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

/**
 * 显示用的紧凑 viewBox:只包住内容边界(各留 CONTENT_MARGIN),不包含整张页面。
 *
 * 保存进文件的仍是页面(见 computedViewBox),画布编辑器的页面尺寸不变;
 * 这个值只作为 `data-idraw-fit` 写进根节点,供笔记里的图片、缩略图按内容收边。
 * 空画布没有内容,退回页面本身。
 */
export function fitViewBox(doc: CanvasDoc): { x: number; y: number; w: number; h: number } {
  const content = contentBounds(doc)
  if (!content) return { ...doc.viewBox }
  return {
    x: content.x - CONTENT_MARGIN,
    y: content.y - CONTENT_MARGIN,
    w: content.w + CONTENT_MARGIN * 2,
    h: content.h + CONTENT_MARGIN * 2
  }
}

/** 网格吸附 */
export function snapToGrid(value: number, size: number): number {
  return Math.round(value / size) * size
}
