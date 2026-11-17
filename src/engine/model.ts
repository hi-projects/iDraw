/**
 * 画布文档模型。
 *
 * 场景是**普通 JS 对象**,不进 Vue 响应式(见 services/tabs.ts 的响应式边界说明):
 * 一个几百节点的流程图,让 Vue 深度代理它既没必要,每个属性访问还会多一层开销。
 * 界面上的"选中了什么/当前工具/缩放"另有一套轻量状态(见 runtime.ts 的 ui)。
 *
 * 坐标一律是世界坐标(与 SVG 的 `viewBox` 同一套),节点 (x, y) 是左上角。
 */

/** 当前指针工具:`shape` 时用 pendingShape 决定画什么 */
export type CanvasTool = 'select' | 'pan' | 'shape' | 'edge' | 'text'

export type ShapeKind =
  | 'rect'
  | 'roundRect'
  | 'ellipse'
  | 'diamond'
  | 'parallelogram'
  | 'hexagon'
  | 'cylinder'
  | 'document'
  | 'triangle'
  | 'rightTriangle'
  | 'pentagon'
  | 'octagon'
  | 'star'
  | 'arrow'
  | 'plus'
  | 'text'

export interface NodeStyle {
  fill: string
  stroke: string
  strokeWidth: number
  /** 虚线边框 */
  dash: boolean
  /** 圆角半径(圆角矩形;其它形状忽略) */
  radius: number
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
}

export interface CanvasNode {
  id: string
  shape: ShapeKind
  x: number
  y: number
  w: number
  h: number
  /** 逻辑文字,换行是 `\n`;显示换行由测量结果决定 */
  text: string
  style: NodeStyle
}

/** 连接点:auto = 打开时继续按两端位置挑边 */
export type AnchorSide = 'auto' | 'n' | 'e' | 's' | 'w'

export type EdgeRouting = 'straight' | 'orthogonal' | 'curve'
export type ArrowMode = 'none' | 'start' | 'end' | 'both'

export interface EdgeEnd {
  /** 节点 id;null = 自由端点(坐标在 x/y) */
  node: string | null
  anchor: AnchorSide
  x: number
  y: number
}

export interface EdgeStyle {
  stroke: string
  strokeWidth: number
  dash: boolean
  fontSize: number
  color: string
}

export interface CanvasEdge {
  id: string
  from: EdgeEnd
  to: EdgeEnd
  routing: EdgeRouting
  arrow: ArrowMode
  label: string
  style: EdgeStyle
}

export interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasDoc {
  /** 页面(viewBox);内容超出时保存会自动扩展它,不收缩 */
  viewBox: ViewBox
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

/** 新画布的页面尺寸:与常见流程图导出的画布比例一致 */
export const PAGE_WIDTH = 1600
export const PAGE_HEIGHT = 1000

/** 保存时内容边界外留出的空白 */
export const CONTENT_MARGIN = 40

/** 网格吸附步长 */
export const GRID_SIZE = 20

/** 新建节点的默认尺寸 */
export const DEFAULT_SIZE: Record<ShapeKind, { w: number; h: number }> = {
  rect: { w: 160, h: 64 },
  roundRect: { w: 160, h: 64 },
  ellipse: { w: 160, h: 64 },
  diamond: { w: 160, h: 64 },
  parallelogram: { w: 160, h: 64 },
  hexagon: { w: 160, h: 64 },
  cylinder: { w: 140, h: 80 },
  document: { w: 160, h: 72 },
  triangle: { w: 160, h: 80 },
  rightTriangle: { w: 160, h: 80 },
  pentagon: { w: 120, h: 120 },
  octagon: { w: 120, h: 120 },
  star: { w: 120, h: 120 },
  arrow: { w: 160, h: 64 },
  plus: { w: 100, h: 100 },
  text: { w: 140, h: 40 }
}

export const NODE_DEFAULTS: NodeStyle = {
  fill: '#ffffff',
  stroke: '#4b5563',
  strokeWidth: 1.5,
  dash: false,
  radius: 8,
  fontSize: 14,
  color: '#1f2328',
  bold: false,
  italic: false,
  align: 'center',
  valign: 'middle'
}

export const EDGE_DEFAULTS: EdgeStyle = {
  stroke: '#4b5563',
  strokeWidth: 1.5,
  dash: false,
  fontSize: 13,
  color: '#4b5563'
}

export function defaultNodeStyle(): NodeStyle {
  return { ...NODE_DEFAULTS }
}

export function defaultEdgeStyle(): EdgeStyle {
  return { ...EDGE_DEFAULTS }
}

/** 深色画布上新插入形状的描边/文字默认值;填充统一为 none,见 newNodeStyle */
export const DARK_NODE_DEFAULTS: NodeStyle = {
  ...NODE_DEFAULTS,
  fill: '#2a2c35',
  stroke: '#8f94a3',
  color: '#ececf1'
}

export const DARK_EDGE_DEFAULTS: EdgeStyle = {
  ...EDGE_DEFAULTS,
  stroke: '#8f94a3',
  color: '#a6a7b3'
}

function isDarkTheme(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
}

/** 新建节点时按当前主题取默认样式(打开的文件仍保留文件里的颜色) */
export function newNodeStyle(): NodeStyle {
  // 默认不填充:形状靠描边识别,主题切换时也不会出现一块与环境冲突的实色
  return { ...(isDarkTheme() ? DARK_NODE_DEFAULTS : NODE_DEFAULTS), fill: 'none' }
}

/** 新建连线时按当前主题取默认样式 */
export function newEdgeStyle(): EdgeStyle {
  return { ...(isDarkTheme() ? DARK_EDGE_DEFAULTS : EDGE_DEFAULTS) }
}

export function emptyDoc(): CanvasDoc {
  return {
    viewBox: { x: 0, y: 0, w: PAGE_WIDTH, h: PAGE_HEIGHT },
    nodes: [],
    edges: []
  }
}

/** 文档里已用的 id(解析/粘贴时用来避开冲突) */
function usedIds(doc: CanvasDoc): Set<string> {
  const set = new Set<string>()
  for (const n of doc.nodes) set.add(n.id)
  for (const e of doc.edges) set.add(e.id)
  return set
}

/**
 * 生成一个文档内唯一 id:前缀 + 递增数字。
 *
 * 不用随机串:同一个操作在不同时间重放会得到不同 id,保存出的 SVG 里 id 一变,
 * diff 与外部工具的引用都会失效。
 */
export function newId(doc: CanvasDoc, prefix: 'n' | 'e'): string {
  const used = usedIds(doc)
  let i = 1
  while (used.has(`${prefix}${i}`)) i++
  return `${prefix}${i}`
}

export function findNode(doc: CanvasDoc, id: string): CanvasNode | null {
  return doc.nodes.find(n => n.id === id) ?? null
}

export function findEdge(doc: CanvasDoc, id: string): CanvasEdge | null {
  return doc.edges.find(e => e.id === id) ?? null
}

export function cloneNode(node: CanvasNode): CanvasNode {
  return { ...node, style: { ...node.style } }
}

export function cloneEdge(edge: CanvasEdge): CanvasEdge {
  return {
    ...edge,
    from: { ...edge.from },
    to: { ...edge.to },
    style: { ...edge.style }
  }
}

/** 与这些节点相连的全部边 */
export function edgesOf(doc: CanvasDoc, nodeIds: ReadonlySet<string>): CanvasEdge[] {
  return doc.edges.filter(
    e => (e.from.node !== null && nodeIds.has(e.from.node)) || (e.to.node !== null && nodeIds.has(e.to.node))
  )
}
