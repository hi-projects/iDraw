/**
 * 内置模板。
 *
 * 模板只生成场景对象(与手工拖出来的完全一样),不生成 SVG 文本:插进当前
 * 画布后还能继续拖、改、撤销,而不是变成一张图片。
 */
import {
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type NodeStyle,
  type ShapeKind,
  DEFAULT_SIZE,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  defaultEdgeStyle,
  defaultNodeStyle,
  emptyDoc
} from './model'

export type TemplateKind = 'blank' | 'flowchart' | 'architecture' | 'gantt'

export interface TemplateInfo {
  kind: TemplateKind
  title: string
  description: string
}

export const TEMPLATES: TemplateInfo[] = [
  { kind: 'blank', title: '空白画布', description: '一张干净的页面,从第一个形状开始' },
  { kind: 'flowchart', title: '流程图', description: '开始 / 判断 / 处理 / 结束的经典结构' },
  { kind: 'gantt', title: '甘特图', description: '按周排期的任务时间轴' },
  { kind: 'architecture', title: '架构图', description: '客户端、网关、服务与存储的分层示意' }
]

function node(
  id: string,
  shape: ShapeKind,
  text: string,
  x: number,
  y: number,
  extra?: Partial<Pick<CanvasNode, 'w' | 'h'>> & { fill?: string }
): CanvasNode {
  const size = DEFAULT_SIZE[shape]
  return {
    id,
    shape,
    x,
    y,
    w: extra?.w ?? size.w,
    h: extra?.h ?? size.h,
    text,
    style: { ...defaultNodeStyle(), ...(extra?.fill ? { fill: extra.fill } : {}) }
  }
}

function edge(
  id: string,
  from: string,
  to: string,
  opts?: { label?: string; fromAnchor?: CanvasEdge['from']['anchor']; toAnchor?: CanvasEdge['to']['anchor'] }
): CanvasEdge {
  return {
    id,
    from: { node: from, anchor: opts?.fromAnchor ?? 'auto', x: 0, y: 0 },
    to: { node: to, anchor: opts?.toAnchor ?? 'auto', x: 0, y: 0 },
    routing: 'orthogonal',
    arrow: 'end',
    label: opts?.label ?? '',
    style: { ...defaultEdgeStyle() }
  }
}

function flowchart(): CanvasDoc {
  const x = 720
  return {
    viewBox: { x: 0, y: 0, w: PAGE_WIDTH, h: PAGE_HEIGHT },
    nodes: [
      node('n1', 'ellipse', '开始', x, 100, { fill: '#e6f4f1' }),
      node('n2', 'roundRect', '读取输入', x, 220),
      node('n3', 'diamond', '是否有效?', x - 10, 340, { w: 180, h: 100, fill: '#fef9c3' }),
      node('n4', 'roundRect', '处理数据', x, 500),
      node('n5', 'ellipse', '结束', x, 620, { fill: '#e6f4f1' })
    ],
    edges: [
      edge('e1', 'n1', 'n2'),
      edge('e2', 'n2', 'n3'),
      edge('e3', 'n3', 'n4', { label: '是' }),
      edge('e4', 'n3', 'n5', { label: '否', fromAnchor: 'e', toAnchor: 'e' })
    ]
  }
}

function architecture(): CanvasDoc {
  return {
    viewBox: { x: 0, y: 0, w: PAGE_WIDTH, h: PAGE_HEIGHT },
    nodes: [
      node('n1', 'roundRect', '客户端', 120, 420, { fill: '#e6f4f1' }),
      node('n2', 'hexagon', 'API 网关', 400, 420),
      node('n3', 'rect', '业务服务', 690, 340),
      node('n4', 'rect', '数据服务', 690, 500),
      node('n5', 'cylinder', '数据库', 960, 340, { fill: '#f0f9ff' }),
      node('n6', 'cylinder', '缓存', 960, 500, { fill: '#f0f9ff' })
    ],
    edges: [
      edge('e1', 'n1', 'n2'),
      edge('e2', 'n2', 'n3'),
      edge('e3', 'n2', 'n4'),
      edge('e4', 'n3', 'n5'),
      edge('e5', 'n4', 'n6')
    ]
  }
}

/** 甘特图:左侧任务名 + 五列周计划 + 彩色进度条 */
function gantt(): CanvasDoc {
  const nodes: CanvasNode[] = []
  let seq = 0
  const add = (
    shape: ShapeKind,
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    style: Partial<NodeStyle> = {}
  ): void => {
    nodes.push({
      id: `n${++seq}`,
      shape,
      x,
      y,
      w,
      h,
      text,
      style: { ...defaultNodeStyle(), ...style }
    })
  }

  const edges: CanvasEdge[] = []
  let edgeSeq = 0
  /** 网格/分隔线用连线表示:它们落在边层,不会被「插入模板后全选」选中 */
  const line = (x1: number, y1: number, x2: number, y2: number): void => {
    edges.push({
      id: `e${++edgeSeq}`,
      from: { node: null, anchor: 'auto', x: x1, y: y1 },
      to: { node: null, anchor: 'auto', x: x2, y: y2 },
      routing: 'straight',
      arrow: 'none',
      label: '',
      style: { ...defaultEdgeStyle(), stroke: '#eef0f5', strokeWidth: 1, dash: false }
    })
  }

  const gridX = [400, 600, 800, 1000, 1200, 1400]
  const rowTop = 200
  const rowH = 84
  const rowCount = 5
  const left = 120
  const right = 1420
  const muted = '#8b90a0'
  const label = '#374151'
  const plain: Partial<NodeStyle> = { fill: 'none', stroke: 'none', strokeWidth: 0 }

  // 背景网格与行分隔线
  for (const x of gridX) line(x, 168, x, 168 + rowH * rowCount + 4)
  for (let i = 0; i <= rowCount; i++) line(left, rowTop + i * rowH, right, rowTop + i * rowH)

  // 标题
  add('text', '产品迭代计划', left, 72, 560, 40, {
    ...plain,
    fontSize: 24,
    bold: true,
    color: '#111827',
    align: 'left'
  })
  add('text', '示例：5 个任务 · 按周排期', left, 116, 560, 24, {
    ...plain,
    fontSize: 13,
    color: muted,
    align: 'left'
  })

  // 表头
  add('text', '任务', left, 158, 260, 30, { ...plain, fontSize: 13, color: muted, align: 'left' })
  const days = ['周一', '周二', '周三', '周四', '周五']
  days.forEach((day, i) => {
    add('text', day, 400 + i * 200, 158, 200, 30, {
      ...plain,
      fontSize: 13,
      color: muted,
      align: 'center'
    })
  })

  const rows: { name: string; start: number; span: number; fill: string; color: string; label: string }[] = [
    { name: '需求调研', start: 0, span: 1, fill: '#e0e7ff', color: '#3730a3', label: '100%' },
    { name: '方案设计', start: 0, span: 1.5, fill: '#dbeafe', color: '#1e40af', label: '80%' },
    { name: '原型开发', start: 1, span: 2, fill: '#dcfce7', color: '#166534', label: '60%' },
    { name: '联调测试', start: 2, span: 1.5, fill: '#fef3c7', color: '#92400e', label: '40%' },
    { name: '上线发布', start: 3, span: 1, fill: '#ffe4e6', color: '#9f1239', label: '待开始' }
  ]

  rows.forEach((row, i) => {
    const y = rowTop + i * rowH
    add('text', row.name, left, y + 26, 260, 32, {
      ...plain,
      fontSize: 14,
      color: label,
      align: 'left'
    })
    add('rect', row.label, 400 + row.start * 200, y + 18, row.span * 200 - 12, 48, {
      fill: row.fill,
      stroke: 'none',
      strokeWidth: 0,
      radius: 10,
      fontSize: 13,
      color: row.color
    })
  })

  return {
    viewBox: { x: 0, y: 0, w: PAGE_WIDTH, h: PAGE_HEIGHT },
    nodes,
    edges
  }
}

export function templateDoc(kind: TemplateKind): CanvasDoc {
  if (kind === 'flowchart') return flowchart()
  if (kind === 'architecture') return architecture()
  if (kind === 'gantt') return gantt()
  return emptyDoc()
}
