/**
 * 画布内部剪贴板。
 *
 * 序列化成一个带类型标记的 JSON,同时写进 `text/plain`:在 iDraw 的另一个窗口
 * 里粘贴靠 JSON,粘贴到普通文本框里则是一段看得懂(但不算优雅)的文本,
 * 不会像二进制格式那样粘出一串乱码。
 */
import {
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  cloneEdge,
  cloneNode
} from './model'

export interface ClipboardPayload {
  type: 'idraw-canvas'
  version: 1
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export interface PastedContent {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

/**
 * 复制选区:节点 + **两端都在选区内**的边。
 * 只选了一条边而没有选它的端点时,复制不了 —— 脱离节点的边没有意义。
 */
export function copySelection(
  doc: CanvasDoc,
  selected: ReadonlySet<string>
): ClipboardPayload | null {
  const nodes = doc.nodes.filter(n => selected.has(n.id)).map(cloneNode)
  if (nodes.length === 0) return null
  const ids = new Set(nodes.map(n => n.id))
  // 边只有在两端都被复制时才有意义;单独选中的边即使它的端点在别处,
  // 粘回来也只会是一条悬空的线
  const edges = doc.edges
    .filter(
      e => e.from.node !== null && ids.has(e.from.node) && e.to.node !== null && ids.has(e.to.node)
    )
    .map(cloneEdge)
  return { type: 'idraw-canvas', version: 1, nodes, edges }
}

export function serializeClipboard(payload: ClipboardPayload): string {
  return JSON.stringify(payload)
}

export function parseClipboard(text: string): ClipboardPayload | null {
  if (!text || text[0] !== '{') return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const obj = data as Partial<ClipboardPayload>
  if (obj.type !== 'idraw-canvas' || obj.version !== 1) return null
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) return null
  // 只接受形状正确的条目;坏数据宁可粘不进来,也不能把一个 undefined 塞进场景
  const nodes = obj.nodes.filter(
    (n): n is CanvasNode =>
      !!n && typeof n === 'object' && typeof n.id === 'string' && typeof n.x === 'number'
  )
  const edges = obj.edges.filter(
    (e): e is CanvasEdge =>
      !!e && typeof e === 'object' && typeof e.id === 'string' && !!e.from && !!e.to
  )
  return { type: 'idraw-canvas', version: 1, nodes: nodes.map(cloneNode), edges: edges.map(cloneEdge) }
}

/**
 * 把剪贴板内容并进场景,返回新建的节点与边(已经带好文档内唯一 id)。
 *
 * `at` 给定时把粘贴内容的包围盒**中心**挪到该点(鼠标处粘贴);否则在原位置
 * 偏移 24px,连续粘贴不会完全叠在一起。
 */
export function insertPayload(
  doc: CanvasDoc,
  payload: ClipboardPayload,
  at: { x: number; y: number } | null
): PastedContent {
  const nodes = payload.nodes.map(cloneNode)
  const edges = payload.edges.map(cloneEdge)
  if (nodes.length === 0) return { nodes: [], edges: [] }

  let dx = 24
  let dy = 24
  if (at) {
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
    dx = at.x - (minX + maxX) / 2
    dy = at.y - (minY + maxY) / 2
  }
  for (const n of nodes) {
    n.x = Math.round((n.x + dx) * 100) / 100
    n.y = Math.round((n.y + dy) * 100) / 100
  }

  // id 必须在"已经放进 doc 的那部分"之外生成:一次粘贴多个节点,newId 只看
  // doc 会在同一次调用里发出重复 id
  const nodeMap = new Map<string, string>()
  const usedInBatch = new Set<string>()
  const nextNodeId = (): string => {
    let i = 1
    while (true) {
      const candidate = `n${i}`
      if (!doc.nodes.some(n => n.id === candidate) && !usedInBatch.has(candidate)) {
        usedInBatch.add(candidate)
        return candidate
      }
      i++
    }
  }
  for (const n of nodes) {
    const id = nextNodeId()
    nodeMap.set(n.id, id)
    n.id = id
  }
  const usedEdgeIds = new Set(doc.edges.map(e => e.id))
  const nextEdgeId = (): string => {
    let i = 1
    while (usedEdgeIds.has(`e${i}`)) i++
    const id = `e${i}`
    usedEdgeIds.add(id)
    return id
  }
  for (const e of edges) {
    e.id = nextEdgeId()
    if (e.from.node) e.from.node = nodeMap.get(e.from.node) ?? null
    if (e.to.node) e.to.node = nodeMap.get(e.to.node) ?? null
  }
  return { nodes, edges }
}
