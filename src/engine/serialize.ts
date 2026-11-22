/**
 * 场景 ↔ SVG 文件。
 *
 * 存的是**标准 SVG**:所有样式写成 presentation attributes(不用 `<style>`、
 * 不用 class),几何用 `<rect>/<ellipse>/<polygon>/<path>/<text>/<tspan>`,
 * 浏览器、Inkscape、Illustrator、Office 都能直接打开。iDraw 自己的额外信息
 * 全在 `data-idraw-*` 属性里 —— 别的软件忽略未知属性,看到的仍是一张完整的图。
 *
 * 解析只读属性,从不把外部 SVG 的 markup 塞进 innerHTML/DOMParser 的渲染结果:
 * 文件来自磁盘,里面可能有 `<script>`、`<foreignObject>` 或外链引用。
 */
import {
  type AnchorSide,
  type ArrowMode,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type EdgeRouting,
  type NodeStyle,
  type ShapeKind,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  defaultEdgeStyle,
  newEdgeStyle,
  defaultNodeStyle,
  emptyDoc
} from './model'
import {
  computedViewBox,
  edgeGeometry,
  edgeLabelPoint,
  edgeLabelPos,
  fitViewBox
} from './geometry'
import { layoutNodeText, shapeParts, textAttrs } from './shapes'
import { fontFamily, fontOf, lineHeightOf, wrapText } from './textMetrics'

const SVG_NS = 'http://www.w3.org/2000/svg'
export const CANVAS_VERSION = 1

/** 属性值转义;换行另行处理(见 escapeTextAttr) */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 属性里的换行:XML 解析会把字面换行归一成空格,只能用字符引用 */
function escAttrText(value: string): string {
  return esc(value).replace(/\r\n/g, '\n').replace(/\n/g, '&#10;')
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** free 端点的相对比例:两位小数会在宽形状上跳动,用四位 */
function num4(n: number): string {
  return String(Math.round(n * 10000) / 10000)
}

function endCoord(value: number, bound: boolean): string {
  return bound ? num4(value) : num(value)
}

/** 文本节点内容转义(保留换行;换行由 tspan 拆分) */
function escText(value: string): string {
  return esc(value.replace(/\r\n/g, '\n'))
}

function markerId(color: string, start: boolean, hollow = false, size = 9): string {
  const safe = color.replace(/[^0-9a-zA-Z]/g, '') || 'default'
  const style = hollow ? 'hollow-' : ''
  const suffix = `-${size}`
  return start ? `idraw-arrow-start-${style}${safe}${suffix}` : `idraw-arrow-${style}${safe}${suffix}`
}

function markerDefs(stroke: string, hollow: boolean, size: number): string {
  // orient="auto" + 单独的反向 marker:有些导入器不认 auto-start-reverse
  // 空心箭头用白底 + 描边,把穿进箭头里的连线盖住
  const fill = hollow ? '#ffffff' : esc(stroke)
  const outline = hollow ? ` stroke="${esc(stroke)}" stroke-width="1.2" stroke-linejoin="round"` : ''
  const end = `<marker id="${markerId(stroke, false, hollow, size)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${num(size)}" markerHeight="${num(size)}" markerUnits="strokeWidth" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="${fill}"${outline}/>
    </marker>`
  const start = `<marker id="${markerId(stroke, true, hollow, size)}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="${num(size)}" markerHeight="${num(size)}" markerUnits="strokeWidth" orient="auto">
      <path d="M10,0 L0,5 L10,10 z" fill="${fill}"${outline}/>
    </marker>`
  return end + '\n    ' + start
}

function partMarkup(tag: string, attrs: Record<string, string | number>): string {
  const list = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${typeof v === 'number' ? num(v) : esc(String(v))}"`)
    .join(' ')
  return `<${tag} ${list}/>`
}

function nodeMarkup(node: CanvasNode): string {
  const attrs: string[] = [
    `data-idraw-node="${esc(node.id)}"`,
    `data-idraw-shape="${node.shape}"`,
    `data-idraw-x="${num(node.x)}"`,
    `data-idraw-y="${num(node.y)}"`,
    `data-idraw-w="${num(node.w)}"`,
    `data-idraw-h="${num(node.h)}"`,
    `data-idraw-align="${node.style.align}"`,
    `data-idraw-valign="${node.style.valign}"`,
    `data-idraw-radius="${num(node.style.radius)}"`,
    `transform="translate(${num(node.x)} ${num(node.y)})"`
  ]
  const parts = shapeParts(node).map(p => partMarkup(p.tag, p.attrs)).join('\n      ')

  let text = ''
  if (node.text) {
    const layout = layoutNodeText(node)
    const tattrs = textAttrs(layout)
    const tspans = layout.lines
      .map((line, i) => `<tspan x="${num(layout.x)}" y="${num(layout.y + i * layout.lineHeight)}">${escText(line)}</tspan>`)
      .join('')
    text = `\n      <text ${Object.entries(tattrs)
      .map(([k, v]) => `${k}="${typeof v === 'number' ? num(v) : esc(String(v))}"`)
      .join(' ')} data-idraw-text="${escAttrText(node.text)}">${tspans}</text>`
  } else {
    // 空文字也留一个空的 data-idraw-text,解析时能区分"没有文字"与"外部编辑过"
    text = `\n      <text data-idraw-text="" x="0" y="0" fill="none"></text>`
  }
  const body = parts ? `\n      ${parts}${text}` : text
  return `    <g ${attrs.join(' ')}>${body}
    </g>`
}

function edgeMarkup(edge: CanvasEdge, doc: CanvasDoc): string {
  const g = edgeGeometry(edge, doc)
  const attrs: string[] = [
    `data-idraw-edge="${esc(edge.id)}"`,
    `data-idraw-from-node="${edge.from.node ? esc(edge.from.node) : ''}"`,
    `data-idraw-from-anchor="${edge.from.anchor}"`,
    `data-idraw-to-node="${edge.to.node ? esc(edge.to.node) : ''}"`,
    `data-idraw-to-anchor="${edge.to.anchor}"`
  ]
  // free 端点需要坐标:绑定时是相对节点的比例,自由端点是世界坐标
  if (!edge.from.node || edge.from.anchor === 'free') {
    attrs.push(
      `data-idraw-from-x="${endCoord(edge.from.x, !!edge.from.node)}"`,
      `data-idraw-from-y="${endCoord(edge.from.y, !!edge.from.node)}"`
    )
  }
  if (!edge.to.node || edge.to.anchor === 'free') {
    attrs.push(
      `data-idraw-to-x="${endCoord(edge.to.x, !!edge.to.node)}"`,
      `data-idraw-to-y="${endCoord(edge.to.y, !!edge.to.node)}"`
    )
  }
  const labelPos = edgeLabelPos(edge)
  if (Math.abs(labelPos - 0.5) > 1e-6) {
    attrs.push(`data-idraw-label-pos="${num(labelPos)}"`)
  }
  const waypoints = (edge.waypoints ?? []).filter(
    p => Number.isFinite(p.x) && Number.isFinite(p.y)
  )
  if (waypoints.length > 0) {
    attrs.push(
      `data-idraw-waypoints="${waypoints.map(p => `${num(p.x)},${num(p.y)}`).join(' ')}"`
    )
  }
  attrs.push(
    `data-idraw-routing="${edge.routing}"`,
    `data-idraw-arrow="${edge.arrow}"`,
    `data-idraw-arrow-style="${edge.arrowStyle}"`,
    `data-idraw-arrow-size="${num(edge.arrowSize)}"`,
    `d="${g.d}"`,
    'fill="none"',
    `stroke="${esc(edge.style.stroke)}"`,
    `stroke-width="${num(edge.style.strokeWidth)}"`
  )
  if (edge.style.dash) {
    attrs.push(`stroke-dasharray="${num(edge.style.strokeWidth * 3)} ${num(edge.style.strokeWidth * 2)}"`)
  }
  const hollow = edge.arrowStyle === 'hollow'
  if (edge.arrow === 'end' || edge.arrow === 'both') {
    attrs.push(`marker-end="url(#${markerId(edge.style.stroke, false, hollow, edge.arrowSize)})"`)
  }
  if (edge.arrow === 'start' || edge.arrow === 'both') {
    attrs.push(`marker-start="url(#${markerId(edge.style.stroke, true, hollow, edge.arrowSize)})"`)
  }

  let label = ''
  if (edge.label) {
    const at = edgeLabelPoint(edge, doc)
    const lines = edge.label.split('\n')
    const lh = lineHeightOf(edge.style.fontSize)
    // 与编辑器渲染保持一致:文字块中心对齐标签锚点
    const baseline = edge.style.fontSize * 0.35 - ((lines.length - 1) * lh) / 2
    const startY = at.y + baseline
    const tspans = lines
      .map((line, i) => `<tspan x="${num(at.x)}" y="${num(startY + i * lh)}">${escText(line)}</tspan>`)
      .join('')
    label = `
      <text data-idraw-edge-label="${esc(edge.id)}" data-idraw-label="${escAttrText(edge.label)}" x="${num(at.x)}" y="${num(startY)}" text-anchor="middle" font-family="${esc(fontFamily())}" font-size="${num(edge.style.fontSize)}" font-weight="${edge.style.bold ? 600 : 400}" font-style="${edge.style.italic ? 'italic' : 'normal'}" fill="${esc(edge.style.color)}" stroke="#ffffff" stroke-width="4" paint-order="stroke" stroke-linejoin="round">${tspans}</text>`
  }
  return `    <path ${attrs.join(' ')}/>${label}`
}

/** 场景 → SVG 文本 */
export function serializeCanvas(doc: CanvasDoc): string {
  const vb = computedViewBox(doc)
  const fit = fitViewBox(doc)
  const markers = new Map<string, { stroke: string; hollow: boolean; size: number }>()
  for (const e of doc.edges) {
    if (e.arrow === 'none') continue
    const hollow = e.arrowStyle === 'hollow'
    markers.set(`${e.style.stroke}|${hollow}|${e.arrowSize}`, {
      stroke: e.style.stroke,
      hollow,
      size: e.arrowSize
    })
  }
  const defs = [...markers.values()]
    .map(m => markerDefs(m.stroke, m.hollow, m.size))
    .join('\n    ')
  const edges = doc.edges.map(e => edgeMarkup(e, doc)).join('\n')
  const nodes = doc.nodes.map(n => nodeMarkup(n)).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NS}" width="${num(vb.w)}" height="${num(vb.h)}" viewBox="${num(vb.x)} ${num(vb.y)} ${num(vb.w)} ${num(vb.h)}" data-idraw-canvas="1" data-idraw-version="${CANVAS_VERSION}" data-idraw-fit="${num(fit.x)} ${num(fit.y)} ${num(fit.w)} ${num(fit.h)}">
  <defs>
    ${defs}
  </defs>
  <rect data-idraw-page="1" x="${num(vb.x)}" y="${num(vb.y)}" width="${num(vb.w)}" height="${num(vb.h)}" fill="#ffffff"/>
  <g data-idraw-layer="edges">
${edges}
  </g>
  <g data-idraw-layer="nodes">
${nodes}
  </g>
</svg>
`
}

// ---------- 解析 ----------

export type ParseResult =
  | { kind: 'canvas'; doc: CanvasDoc }
  | { kind: 'foreign' }
  | { kind: 'error'; message: string }

const SHAPES: ReadonlySet<string> = new Set<ShapeKind>([
  'rect',
  'roundRect',
  'ellipse',
  'diamond',
  'parallelogram',
  'hexagon',
  'cylinder',
  'document',
  'triangle',
  'rightTriangle',
  'pentagon',
  'octagon',
  'star',
  'arrow',
  'plus',
  'text'
])
const ANCHORS: ReadonlySet<string> = new Set<AnchorSide>(['auto', 'n', 'e', 's', 'w', 'free'])
const ROUTINGS: ReadonlySet<string> = new Set<EdgeRouting>(['straight', 'orthogonal', 'curve'])
const ARROWS: ReadonlySet<string> = new Set<ArrowMode>(['none', 'start', 'end', 'both'])

function attr(el: Element, name: string): string {
  return el.getAttribute(name) ?? ''
}

function fnum(value: string | null, fallback: number): number {
  if (value === null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function shapeOf(el: Element): ShapeKind {
  const s = attr(el, 'data-idraw-shape')
  return SHAPES.has(s) ? (s as ShapeKind) : 'roundRect'
}

function firstChildTag(el: Element, tags: ReadonlySet<string>): Element | null {
  for (const child of Array.from(el.children)) {
    const name = child.localName
    if (tags.has(name)) return child
  }
  return null
}

function strAttr(el: Element | null, name: string, fallback: string): string {
  if (!el) return fallback
  const v = el.getAttribute(name)
  return v === null || v === '' ? fallback : v
}

/** 文字的对齐:优先读 group 上的 data-idraw-align(精确),退回 text-anchor */
function readAlign(group: Element, textEl: Element | null): NodeStyle['align'] {
  const stored = attr(group, 'data-idraw-align')
  if (stored === 'left' || stored === 'center' || stored === 'right') return stored
  const anchor = textEl ? attr(textEl, 'text-anchor') : ''
  if (anchor === 'start') return 'left'
  if (anchor === 'end') return 'right'
  return 'center'
}

function readValign(group: Element): NodeStyle['valign'] {
  const stored = attr(group, 'data-idraw-valign')
  return stored === 'top' || stored === 'bottom' ? stored : 'middle'
}

function parseTranslate(transform: string): { x: number; y: number } | null {
  const m = /translate\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*\)/.exec(transform)
  if (!m) return null
  return { x: Number(m[1]), y: Number(m[2]) }
}

function parseNode(el: Element): CanvasNode {
  const shape = shapeOf(el)
  const shapeEl = firstChildTag(el, new Set(['rect', 'ellipse', 'polygon', 'path']))
  const textEl = firstChildTag(el, new Set(['text']))
  const translate = parseTranslate(attr(el, 'transform'))
  const x = fnum(el.getAttribute('data-idraw-x'), translate?.x ?? 0)
  const y = fnum(el.getAttribute('data-idraw-y'), translate?.y ?? 0)
  const base = defaultNodeStyle()
  // 尺寸:data 属性是权威;外部工具改了几何时以它为准(刻意取舍,见计划)
  let w = fnum(el.getAttribute('data-idraw-w'), -1)
  if (w < 0) {
    const childW = shapeEl?.getAttribute('width')
    const rx = fnum(shapeEl?.getAttribute('rx') ?? null, 0)
    w = childW ? fnum(childW, 160) : rx > 0 ? rx * 2 : 160
  }
  let h = fnum(el.getAttribute('data-idraw-h'), -1)
  if (h < 0) {
    h = fnum(shapeEl?.getAttribute('height') ?? null, 64)
  }
  const style: NodeStyle = {
    ...base,
    fill: strAttr(shapeEl, 'fill', base.fill),
    stroke: strAttr(shapeEl, 'stroke', base.stroke),
    strokeWidth: fnum(shapeEl?.getAttribute('stroke-width') ?? null, base.strokeWidth),
    dash: !!strAttr(shapeEl, 'stroke-dasharray', ''),
    radius: fnum(el.getAttribute('data-idraw-radius'), fnum(shapeEl?.getAttribute('rx') ?? null, base.radius)),
    fontSize: fnum(textEl?.getAttribute('font-size') ?? null, base.fontSize),
    color: strAttr(textEl, 'fill', base.color),
    bold: /bold|[6-9]00/.test(strAttr(textEl, 'font-weight', '')),
    italic: strAttr(textEl, 'font-style', '') === 'italic',
    align: readAlign(el, textEl),
    valign: readValign(el)
  }
  // 文本形状不该有填充色块:读到 fill 也忽略
  if (shape === 'text') {
    style.fill = 'none'
    style.stroke = 'none'
    style.strokeWidth = 0
  }
  const text = textEl ? (textEl.getAttribute('data-idraw-text') ?? textEl.textContent ?? '') : ''
  return {
    id: attr(el, 'data-idraw-node'),
    shape,
    x,
    y,
    w: Math.max(1, w),
    h: Math.max(1, h),
    text,
    style
  }
}

function readEnd(el: Element, which: 'from' | 'to'): CanvasEdge['from'] {
  const node = attr(el, `data-idraw-${which}-node`) || null
  const anchorRaw = attr(el, `data-idraw-${which}-anchor`)
  const anchor = ANCHORS.has(anchorRaw) ? (anchorRaw as AnchorSide) : 'auto'
  return {
    node,
    anchor,
    x: fnum(el.getAttribute(`data-idraw-${which}-x`), 0),
    y: fnum(el.getAttribute(`data-idraw-${which}-y`), 0)
  }
}

function parseEdge(el: Element, label: string, labelEl: Element | null): CanvasEdge {
  const routingRaw = attr(el, 'data-idraw-routing')
  const arrowRaw = attr(el, 'data-idraw-arrow')
  const base = defaultEdgeStyle()
  const labelPosRaw = el.getAttribute('data-idraw-label-pos')
  const labelPosNum = labelPosRaw === null ? NaN : Number(labelPosRaw)
  const waypointsRaw = attr(el, 'data-idraw-waypoints').trim()
  const waypoints = waypointsRaw
    ? waypointsRaw
        .split(/\s+/)
        .map(part => part.split(',').map(Number))
        .filter(pair => pair.length === 2 && pair.every(n => Number.isFinite(n)))
        .map(pair => ({ x: pair[0]!, y: pair[1]! }))
    : []
  return {
    id: attr(el, 'data-idraw-edge'),
    from: readEnd(el, 'from'),
    to: readEnd(el, 'to'),
    routing: ROUTINGS.has(routingRaw) ? (routingRaw as EdgeRouting) : 'orthogonal',
    arrow: ARROWS.has(arrowRaw) ? (arrowRaw as ArrowMode) : 'end',
    arrowStyle: attr(el, 'data-idraw-arrow-style') === 'hollow' ? 'hollow' : 'solid',
    arrowSize: Math.min(20, Math.max(2, fnum(el.getAttribute('data-idraw-arrow-size'), 9))),
    label,
    labelPos: Number.isFinite(labelPosNum) ? Math.min(1, Math.max(0, labelPosNum)) : undefined,
    waypoints: waypoints.length > 0 ? waypoints : undefined,
    style: {
      ...base,
      stroke: strAttr(el, 'stroke', base.stroke),
      strokeWidth: fnum(el.getAttribute('stroke-width'), base.strokeWidth),
      dash: !!strAttr(el, 'stroke-dasharray', ''),
      fontSize: fnum(labelEl?.getAttribute('font-size') ?? null, base.fontSize),
      // 旧文件的默认灰色标签跟随新的主题默认(深色下为白色)
      color: (() => {
        const raw = strAttr(labelEl, 'fill', base.color)
        return raw === '#4b5563' || raw === '#a6a7b3' ? newEdgeStyle().color : raw
      })(),
      bold: /bold|[6-9]00/.test(strAttr(labelEl, 'font-weight', '')),
      italic: strAttr(labelEl, 'font-style', '') === 'italic'
    }
  }
}

function parseViewBox(root: Element): CanvasDoc['viewBox'] {
  const raw = attr(root, 'viewBox').trim()
  if (raw) {
    const parts = raw.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(n => Number.isFinite(n)) && parts[2]! > 0 && parts[3]! > 0) {
      return { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! }
    }
  }
  return {
    x: 0,
    y: 0,
    w: fnum(root.getAttribute('width'), PAGE_WIDTH),
    h: fnum(root.getAttribute('height'), PAGE_HEIGHT)
  }
}

/** SVG 文本 → 场景;不是 iDraw 文件时返回 foreign(只读预览) */
export function parseCanvasSvg(text: string): ParseResult {
  let parsed: Document
  try {
    parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  const errEl = parsed.getElementsByTagName('parsererror')[0]
  if (errEl || parsed.documentElement?.localName === 'parsererror') {
    return { kind: 'error', message: 'SVG 解析失败' }
  }
  const root = parsed.documentElement
  if (!root || root.localName !== 'svg') return { kind: 'foreign' }
  if (attr(root, 'data-idraw-canvas') !== '1') return { kind: 'foreign' }

  const labelEls = new Map<string, Element>()
  for (const el of Array.from(parsed.getElementsByTagName('text'))) {
    const id = el.getAttribute('data-idraw-edge-label')
    if (id) labelEls.set(id, el)
  }

  const nodes: CanvasNode[] = []
  for (const el of Array.from(parsed.getElementsByTagName('g'))) {
    if (!el.hasAttribute('data-idraw-node')) continue
    const node = parseNode(el)
    if (node.id) nodes.push(node)
  }
  const nodeIds = new Set(nodes.map(n => n.id))

  const edges: CanvasEdge[] = []
  for (const el of Array.from(parsed.getElementsByTagName('path'))) {
    const id = el.getAttribute('data-idraw-edge')
    if (!id) continue
    const labelEl = labelEls.get(id) ?? null
    const label = labelEl?.getAttribute('data-idraw-label') ?? labelEl?.textContent ?? ''
    const edge = parseEdge(el, label, labelEl)
    // 指向不存在节点的端点退化成自由端点,别让一条坏边把整张图拖垮
    if (edge.from.node && !nodeIds.has(edge.from.node)) {
      const g = safeEndpoint(parsed, el, 'from')
      edge.from = { node: null, anchor: 'auto', x: g.x, y: g.y }
    }
    if (edge.to.node && !nodeIds.has(edge.to.node)) {
      const g = safeEndpoint(parsed, el, 'to')
      edge.to = { node: null, anchor: 'auto', x: g.x, y: g.y }
    }
    edges.push(edge)
  }

  return { kind: 'canvas', doc: { viewBox: parseViewBox(root), nodes, edges } }
}

/** 指向已删除节点的边:用 path 的端点兜底,不猜 */
function safeEndpoint(_parsed: Document, pathEl: Element, which: 'from' | 'to'): { x: number; y: number } {
  const d = attr(pathEl, 'd')
  if (!d) return { x: 0, y: 0 }
  const numbers = d.match(/-?[\d.]+/g)?.map(Number) ?? []
  if (numbers.length < 4) return { x: 0, y: 0 }
  return which === 'from'
    ? { x: numbers[0]!, y: numbers[1]! }
    : { x: numbers[numbers.length - 2]!, y: numbers[numbers.length - 1]! }
}

// ---------- 文件骨架 ----------

/**
 * 新建画布的初始文件内容。放在这里而不是 runtime:新建画布文件只需要一段
 * 固定文本,不该为它加载整个画布编辑器(见 vaultService.createCanvasFile)。
 */
export const EMPTY_CANVAS_SVG = serializeCanvas(emptyDoc())

/** 模板/测试用:把一段文字排成节点文本时用到的字体串 */
export function nodeFont(node: CanvasNode): string {
  return fontOf(node.style.fontSize, node.style.bold, node.style.italic)
}

/** 边标签折行(导出与编辑浮层共用的宽度口径) */
export function wrapLabel(label: string, fontSize: number, maxWidth = 180): string[] {
  return wrapText(label, maxWidth, fontOf(fontSize, false, false))
}
