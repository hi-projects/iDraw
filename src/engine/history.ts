/**
 * 撤销 / 重做。
 *
 * 不存整份场景快照:一次拖十个节点,历史里只有这十个节点的前后状态;
 * 拖一下画布框架的上限是 100 步,内存不会随画布大小线性增长。
 *
 * 脏标记不比较文本,而是比较"当前停在哪个历史状态":
 * `currentKey !== savedKey`。撤销回到保存点会自动变干净,再往前一步又变脏;
 * 撤销后走新的分支会拿到新的 key,不会被误判成"回到了保存时的内容"。
 */
import type { CanvasDoc, CanvasEdge, CanvasNode, ViewBox } from './model'

export type Patch =
  | { op: 'addNode'; index: number; node: CanvasNode }
  | { op: 'delNode'; id: string }
  | { op: 'replaceNode'; id: string; node: CanvasNode }
  | { op: 'addEdge'; index: number; edge: CanvasEdge }
  | { op: 'delEdge'; id: string }
  | { op: 'replaceEdge'; id: string; edge: CanvasEdge }
  | { op: 'viewBox'; viewBox: ViewBox }
  /** 只存 id 顺序:层级调整不必复制整批节点 */
  | { op: 'nodeOrder'; ids: string[] }
  | { op: 'edgeOrder'; ids: string[] }

function reorderById<T extends { id: string }>(list: T[], ids: string[]): T[] {
  const byId = new Map(list.map(item => [item.id, item]))
  const out: T[] = []
  for (const id of ids) {
    const item = byId.get(id)
    if (item) {
      out.push(item)
      byId.delete(id)
    }
  }
  // 历史里没提到的(理论上不会发生)保留在末尾,不静默丢节点
  out.push(...byId.values())
  return out
}

function insertAt<T>(list: T[], index: number, item: T): void {
  const at = Math.max(0, Math.min(index, list.length))
  list.splice(at, 0, item)
}

export function applyPatches(doc: CanvasDoc, patches: readonly Patch[]): void {
  for (const patch of patches) {
    switch (patch.op) {
      case 'addNode':
        insertAt(doc.nodes, patch.index, patch.node)
        break
      case 'delNode': {
        const i = doc.nodes.findIndex(n => n.id === patch.id)
        if (i >= 0) doc.nodes.splice(i, 1)
        break
      }
      case 'replaceNode': {
        const i = doc.nodes.findIndex(n => n.id === patch.id)
        if (i >= 0) doc.nodes[i] = patch.node
        break
      }
      case 'addEdge':
        insertAt(doc.edges, patch.index, patch.edge)
        break
      case 'delEdge': {
        const i = doc.edges.findIndex(e => e.id === patch.id)
        if (i >= 0) doc.edges.splice(i, 1)
        break
      }
      case 'replaceEdge': {
        const i = doc.edges.findIndex(e => e.id === patch.id)
        if (i >= 0) doc.edges[i] = patch.edge
        break
      }
      case 'viewBox':
        doc.viewBox = { ...patch.viewBox }
        break
      case 'nodeOrder':
        doc.nodes = reorderById(doc.nodes, patch.ids)
        break
      case 'edgeOrder':
        doc.edges = reorderById(doc.edges, patch.ids)
        break
    }
  }
}

interface Entry {
  undo: Patch[]
  redo: Patch[]
}

export class History {
  private entries: Entry[] = []
  /** 每个"停靠位置"的稳定 id:长度恒为 entries.length + 1 */
  private ids: number[] = [0]
  private index = 0
  private nextId = 1
  private savedKey = 0
  readonly limit: number

  constructor(limit = 100) {
    this.limit = limit
  }

  get currentKey(): number {
    return this.ids[this.index] ?? 0
  }

  isDirty(): boolean {
    return this.currentKey !== this.savedKey
  }

  canUndo(): boolean {
    return this.index > 0
  }

  canRedo(): boolean {
    return this.index < this.entries.length
  }

  /** 记录一次改动;`undo` 把场景还原到改前,`redo` 再改回去 */
  push(undo: Patch[], redo: Patch[]): void {
    if (undo.length === 0 && redo.length === 0) return
    // 撤销后又做了新改动:旧分支不能留在重做栈里,否则重做会跳到一个不存在的世界
    this.entries.length = this.index
    this.ids.length = this.index + 1
    this.entries.push({ undo, redo })
    this.ids.push(this.nextId++)
    this.index = this.entries.length
    while (this.entries.length > this.limit) {
      this.entries.shift()
      this.ids.shift()
      this.index--
    }
  }

  undo(doc: CanvasDoc): boolean {
    if (!this.canUndo()) return false
    this.index--
    applyPatches(doc, this.entries[this.index]!.undo)
    return true
  }

  redo(doc: CanvasDoc): boolean {
    if (!this.canRedo()) return false
    applyPatches(doc, this.entries[this.index]!.redo)
    this.index++
    return true
  }

  markSaved(): void {
    this.savedKey = this.currentKey
  }

  /** 外部重载/新文档:整条历史作废 */
  reset(saved = false): void {
    this.entries = []
    this.ids = [0]
    this.index = 0
    this.nextId = 1
    this.savedKey = saved ? 0 : -1
  }
}

/**
 * 生成"移动/缩放若干节点"的正反两套 patch。
 * 调用方先保存改前的节点副本,再在场景上改,最后把结果传进来。
 */
export function nodeDiffPatches(before: CanvasNode[], after: CanvasNode[]): { undo: Patch[]; redo: Patch[] } {
  const undo: Patch[] = []
  const redo: Patch[] = []
  for (const old of before) {
    const now = after.find(n => n.id === old.id)
    if (!now) continue
    undo.push({ op: 'replaceNode', id: old.id, node: old })
    redo.push({ op: 'replaceNode', id: now.id, node: now })
  }
  return { undo, redo }
}

export function edgeDiffPatches(before: CanvasEdge[], after: CanvasEdge[]): { undo: Patch[]; redo: Patch[] } {
  const undo: Patch[] = []
  const redo: Patch[] = []
  for (const old of before) {
    const now = after.find(e => e.id === old.id)
    if (!now) continue
    undo.push({ op: 'replaceEdge', id: old.id, edge: old })
    redo.push({ op: 'replaceEdge', id: now.id, edge: now })
  }
  return { undo, redo }
}
