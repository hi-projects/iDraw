/**
 * 一张画布的运行时。
 *
 * 场景(doc)是普通对象,撤销栈(history)与视口/选区也不进 Vue 响应式;
 * 只有工具栏/属性面板要读的那点摘要放在 `ui`(reactive)里。渲染走
 * render.ts 的命令式 DOM,拖拽时不碰 Vue,也不重建整棵树。
 *
 * 打开另一个文件时旧运行时被销毁:视图 detach,DOM 与监听器释放掉。
 */
import { reactive } from 'vue'
import {
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type CanvasTool,
  type EdgeRouting,
  type EdgeStyle,
  type NodeStyle,
  type ShapeKind,
  DEFAULT_SIZE,
  cloneEdge,
  cloneNode,
  defaultNodeStyle,
  emptyDoc,
  findEdge,
  findNode,
  newId
} from './model'
import { CanvasRenderer, type Guide, type RenderState, type Viewport } from './render'
import { Interactions, type CanvasTextTarget, type InteractionHost } from './interactions'
import { History, applyPatches, nodeDiffPatches, type Patch } from './history'
import { parseCanvasSvg, serializeCanvas } from './serialize'
import { computedViewBox, contentBounds, edgeGeometry, nodesBounds } from './geometry'
import {
  copySelection as buildClipboard,
  insertPayload,
  parseClipboard,
  serializeClipboard,
  type ClipboardPayload
} from './clipboard'
import { renderPng } from './png'
import { templateDoc, type TemplateKind } from './templates'
import { textPadding } from './shapes'
import { lineHeightOf } from './textMetrics'
import type { CanvasRuntimeHost } from './host'
import { stripExtension } from '@shared/path'

export type CanvasAlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
export type CanvasDistributeMode = 'h' | 'v'
export type CanvasOrderMode = 'front' | 'back' | 'forward' | 'backward'

/** 网格显示偏好:同一会话内新建/切换文档时沿用 */
let gridPreference = true

export interface CanvasUiState {
  tool: CanvasTool
  pendingShape: ShapeKind | null
  /** 当前缩放(1 = 100%) */
  scale: number
  readOnly: boolean
  /** 只读原因或解析错误 */
  reason: string | null
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  snap: boolean
  /** 是否显示背景网格 */
  gridVisible: boolean
  selectedNodeCount: number
  selectedEdgeCount: number
  selectedCount: number
  /** 属性面板用的样式快照(不是场景对象的引用,避免面板写穿场景) */
  nodeStyle: NodeStyle | null
  edgeStyle: EdgeStyle | null
  shape: ShapeKind | null
  nodeCount: number
  edgeCount: number
  editing: CanvasTextTarget | null
}

/** 画布文件里无法编辑(外部 SVG / 解析失败)时,界面仍要能查看原图 */
export interface CanvasReadOnlyInfo {
  reason: string
}

export interface CanvasRuntimeOptions {
  path: string | null
  fileName: string
  text: string
  /** 独立版与插件各自实现;引擎不直接碰宿主 API */
  host: CanvasRuntimeHost
  /** 脏标记变化时通知应用(同步窗口标题与关闭确认) */
  onDirtyChange?: (dirty: boolean) => void
}

interface RenderSnapshot {
  guides: Guide[]
  createRect: RenderState['createRect']
  marquee: RenderState['marquee']
  previewPath: string | null
  previewAnchor: CanvasNode | null
  hoverEdge: string | null
}

export class CanvasRuntime {
  path: string | null
  fileName: string
  readonly ui: CanvasUiState
  readonly readOnly: boolean
  readonly readOnlyInfo: CanvasReadOnlyInfo | null

  private doc: CanvasDoc
  private history = new History(100)
  private viewport: Viewport = { scale: 1, tx: 0, ty: 0 }
  private selection = new Set<string>()
  private editing: CanvasTextTarget | null = null
  private textarea: HTMLTextAreaElement | null = null
  private textCache: string | null = null
  private originalText = ''
  private readonly opts: CanvasRuntimeOptions
  private readonly snap = { enabled: true } // ui.snap 是响应式镜像,这里存权威值
  private gridVisible = gridPreference
  private renderer: CanvasRenderer | null = null
  private interactions: Interactions | null = null
  private hostEl: HTMLElement | null = null
  private resizeObserver: ResizeObserver | null = null
  /** 上一次的容器尺寸;窗口最大化/分屏等导致尺寸变化时用来保持画面中心不动 */
  private lastSurfaceSize: { w: number; h: number } | null = null
  private viewportInitialized = false
  private disposed = false
  private snapshot: RenderSnapshot = {
    guides: [],
    createRect: null,
    marquee: null,
    previewPath: null,
    previewAnchor: null,
    hoverEdge: null
  }

  constructor(opts: CanvasRuntimeOptions) {
    this.opts = opts
    this.path = opts.path
    this.fileName = opts.fileName

    const parsed = parseCanvasSvg(opts.text)
    if (parsed.kind === 'canvas') {
      this.doc = parsed.doc
      this.readOnly = false
      this.readOnlyInfo = null
      this.history.reset(true)
    } else {
      this.doc = emptyDoc()
      this.readOnly = true
      this.originalText = opts.text
      this.history.reset(true)
      this.readOnlyInfo = {
        reason:
          parsed.kind === 'foreign'
            ? '这是一个外部 SVG 文件，iDraw 只作只读预览。用「新建画布」创建的文件才能编辑。'
            : `无法用 iDraw 打开：${parsed.message}`
      }
    }

    this.ui = reactive<CanvasUiState>({
      tool: 'select',
      pendingShape: null,
      scale: 1,
      readOnly: this.readOnly,
      reason: this.readOnlyInfo?.reason ?? null,
      dirty: false,
      canUndo: false,
      canRedo: false,
      snap: this.snap.enabled,
      gridVisible: this.gridVisible,
      selectedNodeCount: 0,
      selectedEdgeCount: 0,
      selectedCount: 0,
      nodeStyle: null,
      edgeStyle: null,
      shape: null,
      nodeCount: this.doc.nodes.length,
      edgeCount: this.doc.edges.length,
      editing: null
    })
    this.syncUi()
  }

  // ---------- InteractionHost 的形状 ----------

  /**
   * interactions 用的是一个只读桥:它需要 `doc`/`selected` 这些名字,而运行时
   * 里同名的字段是私有的。桥保证外部模块只能通过方法改动状态,不能直接改场景。
   */
  private interactionHost(): InteractionHost {
    const self = this
    return {
      get element() {
        return self.hostEl!
      },
      get renderer() {
        return self.renderer!
      },
      get doc() {
        return self.doc
      },
      get viewport() {
        return self.viewport
      },
      get selected() {
        return self.selection
      },
      get readOnly() {
        return self.readOnly
      },
      get tool() {
        return self.ui.tool
      },
      get pendingShape() {
        return self.ui.pendingShape
      },
      snapEnabled: () => self.snap.enabled,
      setViewport: v => self.setViewport(v),
      setSelection: (ids, mode) => self.setSelection(ids, mode),
      setTool: t => self.setTool(t),
      setPendingShape: s => self.setPendingShape(s),
      setCursor: c => self.setCursor(c),
      renderAll: () => self.renderAll(),
      renderFast: (n, e) => self.renderFast(n, e),
      renderOverlay: () => self.renderOverlay(),
      setGuides: g => {
        self.snapshot.guides = g
      },
      setCreateRect: r => {
        self.snapshot.createRect = r
      },
      setMarquee: r => {
        self.snapshot.marquee = r
      },
      setPreview: (path, node) => self.setPreview(path, node),
      commitApplied: (undo, redo) => self.commit(undo, redo, true),
      addNode: (shape, rect, text) => self.addNode(shape, rect, text),
      beginTextEdit: t => self.beginTextEdit(t),
      deleteSelection: () => self.deleteSelection(),
      copySelection: data => self.copySelection(data),
      cutSelection: data => self.cutSelection(data),
      pasteText: (text, at) => self.pasteText(text, at),
      duplicateSelection: () => self.duplicateSelection(),
      undo: () => self.undo(),
      redo: () => self.redo(),
      selectAll: () => self.selectAll(),
      focus: () => self.focus(),
      setHoverEdge: id => {
        self.snapshot.hoverEdge = id
        self.renderer?.setHoverEdge(id)
      }
    }
  }

  // ---------- 视图挂载 ----------

  attachView(host: HTMLElement): void {
    if (this.disposed) return
    if (this.hostEl === host) return
    this.detachView()
    this.hostEl = host
    // 外部 SVG 只读预览由 CanvasPane 直接画 <img>,不需要 SVG 渲染器
    if (this.readOnly) return
    host.setAttribute('tabindex', '0')
    host.style.outline = 'none'
    this.renderer = new CanvasRenderer(host)
    this.renderer.setGridVisible(this.gridVisible)
    this.interactions = new Interactions(this.interactionHost())
    if (!this.viewportInitialized) {
      this.viewportInitialized = true
      this.fitScreen()
    } else {
      this.renderer.setViewport(this.viewport)
      this.lastSurfaceSize = this.renderer.size
      this.renderAll()
    }
    // 窗口大小(最大化、分屏、工具栏高度)变化时保持视口中心不变
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleSurfaceResize())
      this.resizeObserver.observe(host)
    }
    this.focus()
  }

  detachView(): void {
    if (!this.hostEl) return
    // 切走前把正在编辑的文字收进场景,别丢用户刚敲的那几个字
    this.flush()
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.lastSurfaceSize = null
    this.interactions?.destroy()
    this.interactions = null
    this.renderer?.destroy()
    this.renderer = null
    if (this.hostEl) {
      this.hostEl.style.cursor = ''
      this.hostEl.removeAttribute('tabindex')
    }
    this.hostEl = null
  }

  deactivate(): void {
    this.flush()
    this.clearEditing(false)
    this.snapshot.previewPath = null
    this.snapshot.previewAnchor = null
    this.snapshot.guides = []
    this.snapshot.createRect = null
    this.snapshot.marquee = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detachView()
    this.selection.clear()
  }

  /** 保存/另存为之后更新当前文件的身份(导出 PNG 的默认名用) */
  setPath(path: string | null, fileName: string): void {
    this.path = path
    this.fileName = fileName
  }

  focus(): void {
    this.hostEl?.focus({ preventScroll: true })
  }

  // ---------- 文档 ----------

  text(): string {
    if (this.readOnly) return this.originalText
    this.flush()
    if (this.textCache === null) this.textCache = serializeCanvas(this.doc)
    return this.textCache
  }

  isDirty(): boolean {
    return this.readOnly ? false : this.history.isDirty()
  }

  markSaved(text: string): void {
    if (this.readOnly) return
    // 写盘期间用户可能又改了:只有当前内容正好是刚写的那份才清脏
    if (serializeCanvas(this.doc) !== text) {
      this.syncUi()
      return
    }
    this.history.markSaved()
    this.syncUi()
  }

  reload(text: string): void {
    if (this.readOnly) {
      this.originalText = text
      return
    }
    const parsed = parseCanvasSvg(text)
    if (parsed.kind !== 'canvas') {
      this.ui.reason =
        parsed.kind === 'error'
          ? `外部修改后解析失败:${parsed.message}`
          : '外部修改后不再是可以编辑的 iDraw 文件'
      return
    }
    this.flush()
    this.doc = parsed.doc
    this.selection.clear()
    this.history.reset(true)
    this.textCache = null
    this.syncUi()
    this.renderAll()
  }

  flush(): void {
    if (this.editing) {
      this.commitTextEdit()
      return
    }
    this.interactions?.finishGesture()
  }

  undo(): void {
    if (this.readOnly) return
    this.flush()
    if (!this.history.undo(this.doc)) return
    this.textCache = null
    this.pruneSelection()
    this.afterChange()
    this.renderAll()
  }

  redo(): void {
    if (this.readOnly) return
    this.flush()
    if (!this.history.redo(this.doc)) return
    this.textCache = null
    this.pruneSelection()
    this.afterChange()
    this.renderAll()
  }

  selectAll(): void {
    this.setSelection(this.doc.nodes.map(n => n.id), 'replace')
  }

  copy(): void {
    this.copySelection(null)
  }

  cut(): void {
    this.cutSelection(null)
  }

  paste(): void {
    void this.pasteFromSystemClipboard()
  }

  async exportPng(): Promise<void> {
    if (this.readOnly) return
    this.flush()
    const base = this.fileName ? stripExtension(this.fileName) : '画布'
    // 默认目录与默认文件名分开给:有些系统会把整条路径当成默认文件名
    const dir = this.path ? this.path.replace(/[\\/][^\\/]*$/, '') : undefined
    try {
      const { bytes } = await renderPng(this.doc, 2)
      await this.opts.host.savePng({
        defaultName: `${base}.png`,
        defaultDir: dir,
        bytes
      })
    } catch (err) {
      this.opts.host.notifyError('导出 PNG', err)
    }
  }

  // ---------- 工具 / 视口 ----------

  setTool(tool: CanvasTool): void {
    if (this.readOnly) return
    this.ui.tool = tool
    if (tool !== 'shape') this.ui.pendingShape = null
    this.setCursor(tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair')
  }

  setPendingShape(shape: ShapeKind | null): void {
    this.ui.pendingShape = shape
    this.ui.tool = shape ? 'shape' : 'select'
    this.setCursor(shape ? 'crosshair' : 'default')
  }

  setSnap(enabled: boolean): void {
    this.snap.enabled = enabled
    this.ui.snap = enabled
  }

  setGridVisible(visible: boolean): void {
    gridPreference = visible
    this.gridVisible = visible
    this.ui.gridVisible = visible
    this.renderer?.setGridVisible(visible)
  }

  setCursor(cursor: string): void {
    if (this.hostEl) this.hostEl.style.cursor = cursor
  }

  setViewport(viewport: Viewport): void {
    this.viewport = {
      scale: Math.max(0.1, Math.min(4, viewport.scale)),
      tx: viewport.tx,
      ty: viewport.ty
    }
    this.ui.scale = this.viewport.scale
    this.renderer?.setViewport(this.viewport)
  }

  zoomBy(factor: number): void {
    const size = this.renderer?.size ?? { w: 1, h: 1 }
    const cx = size.w / 2
    const cy = size.h / 2
    const worldX = (cx - this.viewport.tx) / this.viewport.scale
    const worldY = (cy - this.viewport.ty) / this.viewport.scale
    const next = Math.max(0.1, Math.min(4, this.viewport.scale * factor))
    this.setViewport({ scale: next, tx: cx - worldX * next, ty: cy - worldY * next })
    this.renderOverlay()
  }

  zoomIn(): void {
    this.zoomBy(1.2)
  }

  zoomOut(): void {
    this.zoomBy(1 / 1.2)
  }

  resetZoom(): void {
    this.fitScreen()
  }

  /** 适应页面(默认) */
  fitScreen(): void {
    const vb = computedViewBox(this.doc)
    this.fitRect(vb.x, vb.y, vb.w, vb.h)
  }

  /** 适应内容;没有内容时回到页面 */
  fitContent(): void {
    const content = contentBounds(this.doc)
    if (!content) {
      this.fitScreen()
      return
    }
    this.fitRect(content.x, content.y, content.w, content.h)
  }

  private fitRect(x: number, y: number, w: number, h: number): void {
    const size = this.renderer?.size ?? { w: 1200, h: 800 }
    const margin = 48
    const scale = Math.max(
      0.1,
      Math.min(4, Math.min((size.w - margin * 2) / Math.max(1, w), (size.h - margin * 2) / Math.max(1, h)))
    )
    this.setViewport({
      scale,
      tx: (size.w - w * scale) / 2 - x * scale,
      ty: (size.h - h * scale) / 2 - y * scale
    })
    this.lastSurfaceSize = this.renderer ? size : null
    this.renderAll()
  }

  /**
   * 容器尺寸变化(窗口最大化/还原、分屏、菜单栏出现)时,让视口中心的世界坐标
   * 保持不动。否则画布只在挂载时 fit 过一次,窗口变大后整张图会偏到左上角。
   */
  private handleSurfaceResize(): void {
    if (this.disposed || !this.renderer) return
    const size = this.renderer.size
    const prev = this.lastSurfaceSize
    this.lastSurfaceSize = size
    if (!prev || prev.w <= 1 || prev.h <= 1) return
    if (prev.w === size.w && prev.h === size.h) return
    const worldX = (prev.w / 2 - this.viewport.tx) / this.viewport.scale
    const worldY = (prev.h / 2 - this.viewport.ty) / this.viewport.scale
    this.viewport = {
      scale: this.viewport.scale,
      tx: size.w / 2 - worldX * this.viewport.scale,
      ty: size.h / 2 - worldY * this.viewport.scale
    }
    this.renderer.setViewport(this.viewport)
    this.renderOverlay()
  }

  // ---------- 选区 ----------

  setSelection(ids: Iterable<string>, mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    const next = new Set<string>()
    if (mode === 'replace') {
      for (const id of ids) next.add(id)
    } else {
      for (const id of this.selection) next.add(id)
      for (const id of ids) {
        if (mode === 'toggle' && next.has(id)) next.delete(id)
        else next.add(id)
      }
    }
    if (next.size === this.selection.size && [...next].every(id => this.selection.has(id))) return
    this.selection = next
    this.syncUi()
    this.renderAll()
  }

  private pruneSelection(): void {
    const alive = new Set<string>()
    for (const id of this.selection) {
      if (findNode(this.doc, id) || findEdge(this.doc, id)) alive.add(id)
    }
    this.selection = alive
  }

  private selectedNodes(): CanvasNode[] {
    return this.doc.nodes.filter(n => this.selection.has(n.id))
  }

  private selectedEdges(): CanvasEdge[] {
    return this.doc.edges.filter(e => this.selection.has(e.id))
  }

  // ---------- 编辑操作 ----------

  addNode(shape: ShapeKind, rect: { x: number; y: number; w: number; h: number }, text = ''): CanvasNode {
    const node: CanvasNode = {
      id: newId(this.doc, 'n'),
      shape,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      text,
      style: defaultNodeStyle()
    }
    if (shape === 'text') {
      node.style.fill = 'none'
      node.style.stroke = 'none'
      node.style.strokeWidth = 0
      node.style.align = 'left'
    }
    this.doc.nodes.push(node)
    return node
  }

  /** 记录一次已应用在场景上的修改;`applied=false` 时先把 redo 应用到场景 */
  commit(undo: Patch[], redo: Patch[], applied = false): void {
    if (this.readOnly) return
    if (!applied) applyPatches(this.doc, redo)
    this.history.push(undo, redo)
    this.textCache = null
    this.afterChange()
  }

  deleteSelection(): void {
    if (this.readOnly || this.selection.size === 0) return
    const nodes = this.doc.nodes.filter(n => this.selection.has(n.id))
    const nodeIds = new Set(nodes.map(n => n.id))
    const edges = this.doc.edges.filter(
      e => this.selection.has(e.id) || (e.from.node !== null && nodeIds.has(e.from.node)) || (e.to.node !== null && nodeIds.has(e.to.node))
    )
    if (nodes.length === 0 && edges.length === 0) return

    const nodeIndex = new Map(nodes.map(n => [n.id, this.doc.nodes.findIndex(x => x.id === n.id)]))
    const edgeIndex = new Map(edges.map(e => [e.id, this.doc.edges.findIndex(x => x.id === e.id)]))

    const undo: Patch[] = []
    for (const n of [...nodes].sort((a, b) => (nodeIndex.get(a.id) ?? 0) - (nodeIndex.get(b.id) ?? 0))) {
      undo.push({ op: 'addNode', index: nodeIndex.get(n.id) ?? 0, node: cloneNode(n) })
    }
    for (const e of [...edges].sort((a, b) => (edgeIndex.get(a.id) ?? 0) - (edgeIndex.get(b.id) ?? 0))) {
      undo.push({ op: 'addEdge', index: edgeIndex.get(e.id) ?? 0, edge: cloneEdge(e) })
    }
    const redo: Patch[] = []
    for (const e of edges) redo.push({ op: 'delEdge', id: e.id })
    for (const n of nodes) redo.push({ op: 'delNode', id: n.id })

    for (const e of [...edges].sort((a, b) => (edgeIndex.get(b.id) ?? 0) - (edgeIndex.get(a.id) ?? 0))) {
      const i = this.doc.edges.findIndex(x => x.id === e.id)
      if (i >= 0) this.doc.edges.splice(i, 1)
    }
    for (const n of [...nodes].sort((a, b) => (nodeIndex.get(b.id) ?? 0) - (nodeIndex.get(a.id) ?? 0))) {
      const i = this.doc.nodes.findIndex(x => x.id === n.id)
      if (i >= 0) this.doc.nodes.splice(i, 1)
    }
    this.selection.clear()
    this.commit(undo, redo, true)
    this.renderAll()
  }

  // ---------- 剪贴板 ----------

  private clipboardPayload(): ClipboardPayload | null {
    return buildClipboard(this.doc, this.selection)
  }

  copySelection(data: DataTransfer | null): void {
    const payload = this.clipboardPayload()
    if (!payload) return
    this.lastInternalPayload = payload
    const text = serializeClipboard(payload)
    if (data) {
      data.setData('text/plain', text)
      return
    }
    void navigator.clipboard?.writeText(text).catch(err => {
      console.error('[iDraw] 复制画布内容失败', err)
    })
  }

  cutSelection(data: DataTransfer | null): void {
    if (this.readOnly) return
    this.copySelection(data)
    this.deleteSelection()
  }

  pasteText(text: string, at: { x: number; y: number }): void {
    if (this.readOnly) return
    const payload = parseClipboard(text)
    if (payload) {
      this.insertClipboard(payload, at)
      return
    }
    // 纯文本:落成一个文本节点,比"什么都不发生"有用
    const trimmed = text.replace(/\r\n/g, '\n')
    if (!trimmed.trim()) return
    const size = DEFAULT_SIZE.text
    const node = this.addNode('text', {
      x: Math.round(at.x - size.w / 2),
      y: Math.round(at.y - size.h / 2),
      w: size.w,
      h: size.h
    }, trimmed)
    node.style.fill = 'none'
    node.style.stroke = 'none'
    node.style.strokeWidth = 0
    this.selection = new Set([node.id])
    this.commit([{ op: 'delNode', id: node.id }], [
      { op: 'addNode', index: this.doc.nodes.length - 1, node: cloneNode(node) }
    ], true)
    this.renderAll()
  }

  private insertClipboard(payload: ClipboardPayload, at: { x: number; y: number } | null): void {
    const inserted = insertPayload(this.doc, payload, at)
    if (inserted.nodes.length === 0) return
    this.doc.nodes.push(...inserted.nodes)
    this.doc.edges.push(...inserted.edges)

    const undo: Patch[] = []
    for (const e of inserted.edges) undo.push({ op: 'delEdge', id: e.id })
    for (const n of inserted.nodes) undo.push({ op: 'delNode', id: n.id })
    const redo: Patch[] = []
    inserted.nodes.forEach((n, i) => {
      redo.push({ op: 'addNode', index: this.doc.nodes.length - inserted.nodes.length + i, node: cloneNode(n) })
    })
    inserted.edges.forEach((e, i) => {
      redo.push({ op: 'addEdge', index: this.doc.edges.length - inserted.edges.length + i, edge: cloneEdge(e) })
    })
    this.selection = new Set(inserted.nodes.map(n => n.id))
    this.commit(undo, redo, true)
    this.renderAll()
  }

  duplicateSelection(): void {
    const payload = this.clipboardPayload()
    if (!payload) return
    this.insertClipboard(payload, null)
  }

  private async pasteFromSystemClipboard(): Promise<void> {
    let text = ''
    try {
      text = (await navigator.clipboard?.readText()) ?? ''
    } catch (err) {
      console.error('[iDraw] 读取剪贴板失败', err)
    }
    if (!text) {
      // 没有读取权限时退回内部剪贴板;仍拿不到就静默(与编辑器一致)
      const payload = this.lastInternalPayload
      if (payload) this.insertClipboard(payload, this.viewCenterWorld())
      return
    }
    this.pasteText(text, this.viewCenterWorld())
  }

  private lastInternalPayload: ClipboardPayload | null = null

  private viewCenterWorld(): { x: number; y: number } {
    const size = this.renderer?.size ?? { w: 1200, h: 800 }
    return {
      x: (size.w / 2 - this.viewport.tx) / this.viewport.scale,
      y: (size.h / 2 - this.viewport.ty) / this.viewport.scale
    }
  }

  // ---------- 文字浮层 ----------

  beginTextEdit(target: CanvasTextTarget): void {
    if (this.readOnly || !this.hostEl) return
    this.flush()
    const node = target.kind === 'node' ? findNode(this.doc, target.id) : null
    const edge = target.kind === 'edge' ? findEdge(this.doc, target.id) : null
    if (!node && !edge) return
    this.editing = { kind: target.kind, id: target.id }
    this.ui.editing = { ...target }
    this.renderAll()

    const ta = document.createElement('textarea')
    ta.className = 'canvas-text-editor'
    ta.spellcheck = false
    const scale = this.viewport.scale
    let initial = ''
    let selectAll = false

    if (node) {
      const p = this.renderer!.screenOf(node.x, node.y)
      const pad = textPadding(node.shape)
      ta.style.left = `${p.x + pad.x * scale}px`
      ta.style.top = `${p.y + pad.y * scale}px`
      ta.style.width = `${Math.max(48, (node.w - pad.x * 2) * scale)}px`
      ta.style.height = `${Math.max(28, (node.h - pad.y * 2) * scale)}px`
      ta.style.fontSize = `${node.style.fontSize * scale}px`
      ta.style.lineHeight = `${lineHeightOf(node.style.fontSize) * scale}px`
      ta.style.textAlign = node.style.align
      ta.style.color = node.style.color
      ta.style.fontWeight = node.style.bold ? '600' : '400'
      ta.style.fontStyle = node.style.italic ? 'italic' : 'normal'
      initial = node.text
      selectAll = node.text === '' || node.text === '文字'
    } else if (edge) {
      const g = edgeGeometry(edge, this.doc)
      const p = this.renderer!.screenOf(g.mid.x, g.mid.y)
      ta.style.left = `${p.x - 90 * scale}px`
      ta.style.top = `${p.y - 16 * scale}px`
      ta.style.width = `${180 * scale}px`
      ta.style.height = `${32 * scale}px`
      ta.style.fontSize = `${edge.style.fontSize * scale}px`
      ta.style.lineHeight = `${lineHeightOf(edge.style.fontSize) * scale}px`
      ta.style.textAlign = 'center'
      ta.style.color = edge.style.color
      initial = edge.label
      selectAll = true
    }

    ta.value = initial
    ta.addEventListener('keydown', e => {
      // Esc 取消;Enter 正常换行(画布文字允许多行)
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.cancelTextEdit()
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        ta.blur()
      }
    })
    ta.addEventListener('blur', () => {
      if (this.editing) this.commitTextEdit()
    })
    this.hostEl.append(ta)
    this.textarea = ta
    ta.focus({ preventScroll: true })
    if (selectAll) ta.select()
    else ta.setSelectionRange(ta.value.length, ta.value.length)
  }

  private commitTextEdit(): void {
    const ta = this.textarea
    const target = this.editing
    if (!ta || !target) return
    const value = ta.value.replace(/\r\n/g, '\n')
    this.textarea = null
    this.editing = null
    this.ui.editing = null
    ta.remove()

    let undo: Patch | null = null
    let redo: Patch | null = null
    if (target.kind === 'node') {
      const node = findNode(this.doc, target.id)
      if (node && node.text !== value) {
        const before = cloneNode(node)
        node.text = value
        undo = { op: 'replaceNode', id: node.id, node: before }
        redo = { op: 'replaceNode', id: node.id, node: cloneNode(node) }
      }
    } else {
      const edge = findEdge(this.doc, target.id)
      if (edge && edge.label !== value) {
        const before = cloneEdge(edge)
        edge.label = value
        undo = { op: 'replaceEdge', id: edge.id, edge: before }
        redo = { op: 'replaceEdge', id: edge.id, edge: cloneEdge(edge) }
      }
    }
    if (undo && redo) this.commit([undo], [redo], true)
    this.renderAll()
  }

  private cancelTextEdit(): void {
    this.clearEditing(true)
  }

  private clearEditing(render: boolean): void {
    this.textarea?.remove()
    this.textarea = null
    this.editing = null
    this.ui.editing = null
    if (render) this.renderAll()
  }

  // ---------- 渲染 ----------

  renderAll(): void {
    this.syncUi()
    if (!this.renderer) return
    this.renderer.setViewport(this.viewport)
    this.renderer.renderScene(
      this.doc,
      this.selection,
      this.editing?.kind === 'node' ? this.editing.id : null,
      this.editing?.kind === 'edge' ? this.editing.id : null,
      this.snapshot.hoverEdge
    )
    this.renderer.renderPreview(this.snapshot.previewPath, this.snapshot.previewAnchor)
    this.renderOverlay()
  }

  renderFast(nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): void {
    this.renderer?.updateNodes(this.doc, nodeIds, edgeIds)
    this.renderOverlay()
  }

  renderOverlay(): void {
    this.renderer?.renderOverlay({
      doc: this.doc,
      viewport: this.viewport,
      selected: this.selection,
      editingNode: this.editing?.kind === 'node' ? this.editing.id : null,
      editingEdge: this.editing?.kind === 'edge' ? this.editing.id : null,
      marquee: this.snapshot.marquee,
      createRect: this.snapshot.createRect,
      guides: this.snapshot.guides,
      previewPath: this.snapshot.previewPath,
      anchorNode: this.snapshot.previewAnchor,
      hoverEdge: this.snapshot.hoverEdge
    })
  }

  setPreview(path: string | null, anchorNode: CanvasNode | null): void {
    this.snapshot.previewPath = path
    this.snapshot.previewAnchor = anchorNode
    this.renderer?.renderPreview(path, anchorNode)
  }

  setGuides(guides: Guide[]): void {
    this.snapshot.guides = guides
  }

  setMarquee(rect: RenderState['marquee']): void {
    this.snapshot.marquee = rect
  }

  setCreateRect(rect: RenderState['createRect']): void {
    this.snapshot.createRect = rect
  }

  setHoverEdge(id: string | null): void {
    this.snapshot.hoverEdge = id
    this.renderer?.setHoverEdge(id)
  }

  private syncUi(): void {
    const nodes = this.selectedNodes()
    const edges = this.selectedEdges()
    this.ui.selectedNodeCount = nodes.length
    this.ui.selectedEdgeCount = edges.length
    this.ui.selectedCount = nodes.length + edges.length
    this.ui.nodeStyle = nodes[0] ? { ...nodes[0].style } : null
    this.ui.edgeStyle = edges[0] ? { ...edges[0].style } : null
    this.ui.shape = nodes.length === 1 ? nodes[0]!.shape : null
    this.ui.nodeCount = this.doc.nodes.length
    this.ui.edgeCount = this.doc.edges.length
    this.ui.canUndo = this.history.canUndo()
    this.ui.canRedo = this.history.canRedo()
    this.ui.scale = this.viewport.scale
    const dirty = this.isDirty()
    this.ui.dirty = dirty
  }

  private afterChange(): void {
    this.syncUi()
    this.opts.onDirtyChange?.(this.isDirty())
  }

  // ---------- 样式 / 排列 ----------

  applyNodeStyle(patch: Partial<NodeStyle>): void {
    if (this.readOnly) return
    const nodes = this.selectedNodes()
    if (nodes.length === 0) return
    const before = nodes.map(cloneNode)
    for (const n of nodes) Object.assign(n.style, patch)
    const after = nodes.map(n => cloneNode(findNode(this.doc, n.id) ?? n))
    const diff = nodeDiffPatches(before, after)
    this.commit(diff.undo, diff.redo, true)
    this.renderAll()
  }

  applyEdgeStyle(patch: Partial<EdgeStyle>): void {
    if (this.readOnly) return
    const edges = this.selectedEdges()
    if (edges.length === 0) return
    const undo: Patch[] = []
    const redo: Patch[] = []
    for (const e of edges) {
      const before = cloneEdge(e)
      Object.assign(e.style, patch)
      undo.push({ op: 'replaceEdge', id: e.id, edge: before })
      redo.push({ op: 'replaceEdge', id: e.id, edge: cloneEdge(e) })
    }
    this.commit(undo, redo, true)
    this.renderAll()
  }

  setEdgeRouting(routing: EdgeRouting): void {
    if (this.readOnly) return
    const edges = this.selectedEdges()
    if (edges.length === 0) return
    const undo: Patch[] = []
    const redo: Patch[] = []
    for (const e of edges) {
      const before = cloneEdge(e)
      e.routing = routing
      undo.push({ op: 'replaceEdge', id: e.id, edge: before })
      redo.push({ op: 'replaceEdge', id: e.id, edge: cloneEdge(e) })
    }
    this.commit(undo, redo, true)
    this.renderAll()
  }

  setEdgeArrow(arrow: CanvasEdge['arrow']): void {
    if (this.readOnly) return
    const edges = this.selectedEdges()
    if (edges.length === 0) return
    const undo: Patch[] = []
    const redo: Patch[] = []
    for (const e of edges) {
      const before = cloneEdge(e)
      e.arrow = arrow
      undo.push({ op: 'replaceEdge', id: e.id, edge: before })
      redo.push({ op: 'replaceEdge', id: e.id, edge: cloneEdge(e) })
    }
    this.commit(undo, redo, true)
    this.renderAll()
  }

  align(mode: CanvasAlignMode): void {
    if (this.readOnly) return
    const nodes = this.selectedNodes()
    if (nodes.length < 2) return
    const bounds = nodesBounds(nodes)
    if (!bounds) return
    const before = nodes.map(cloneNode)
    for (const n of nodes) {
      switch (mode) {
        case 'left':
          n.x = bounds.x
          break
        case 'hcenter':
          n.x = bounds.x + (bounds.w - n.w) / 2
          break
        case 'right':
          n.x = bounds.x + bounds.w - n.w
          break
        case 'top':
          n.y = bounds.y
          break
        case 'vcenter':
          n.y = bounds.y + (bounds.h - n.h) / 2
          break
        case 'bottom':
          n.y = bounds.y + bounds.h - n.h
          break
      }
      n.x = Math.round(n.x * 100) / 100
      n.y = Math.round(n.y * 100) / 100
    }
    const after = nodes.map(n => cloneNode(n))
    const diff = nodeDiffPatches(before, after)
    this.commit(diff.undo, diff.redo, true)
    this.renderAll()
  }

  distribute(mode: CanvasDistributeMode): void {
    if (this.readOnly) return
    const nodes = this.selectedNodes()
    if (nodes.length < 3) return
    const before = nodes.map(cloneNode)
    if (mode === 'h') {
      const sorted = [...nodes].sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2))
      const first = sorted[0]!
      const last = sorted[sorted.length - 1]!
      const start = first.x + first.w / 2
      const end = last.x + last.w / 2
      const step = (end - start) / (sorted.length - 1)
      sorted.forEach((n, i) => {
        if (i === 0 || i === sorted.length - 1) return
        n.x = Math.round((start + step * i - n.w / 2) * 100) / 100
      })
    } else {
      const sorted = [...nodes].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))
      const first = sorted[0]!
      const last = sorted[sorted.length - 1]!
      const start = first.y + first.h / 2
      const end = last.y + last.h / 2
      const step = (end - start) / (sorted.length - 1)
      sorted.forEach((n, i) => {
        if (i === 0 || i === sorted.length - 1) return
        n.y = Math.round((start + step * i - n.h / 2) * 100) / 100
      })
    }
    const after = nodes.map(n => cloneNode(n))
    const diff = nodeDiffPatches(before, after)
    this.commit(diff.undo, diff.redo, true)
    this.renderAll()
  }

  order(mode: CanvasOrderMode): void {
    if (this.readOnly) return
    const selected = new Set(this.selectedNodes().map(n => n.id))
    if (selected.size === 0) return
    const beforeIds = this.doc.nodes.map(n => n.id)
    let order = [...this.doc.nodes]
    if (mode === 'front') {
      order = [...order.filter(n => !selected.has(n.id)), ...order.filter(n => selected.has(n.id))]
    } else if (mode === 'back') {
      order = [...order.filter(n => selected.has(n.id)), ...order.filter(n => !selected.has(n.id))]
    } else if (mode === 'forward') {
      for (let i = order.length - 2; i >= 0; i--) {
        if (selected.has(order[i]!.id) && !selected.has(order[i + 1]!.id)) {
          ;[order[i], order[i + 1]] = [order[i + 1]!, order[i]!]
        }
      }
    } else {
      for (let i = 1; i < order.length; i++) {
        if (selected.has(order[i]!.id) && !selected.has(order[i - 1]!.id)) {
          ;[order[i], order[i - 1]] = [order[i - 1]!, order[i]!]
        }
      }
    }
    const afterIds = order.map(n => n.id)
    if (afterIds.join('\n') === beforeIds.join('\n')) return
    this.doc.nodes = order
    this.commit([{ op: 'nodeOrder', ids: beforeIds }], [{ op: 'nodeOrder', ids: afterIds }], true)
    this.renderAll()
  }

  // ---------- 模板 ----------

  insertTemplate(kind: TemplateKind): void {
    if (this.readOnly || kind === 'blank') return
    this.flush()
    const tpl = templateDoc(kind)
    if (tpl.nodes.length === 0) return
    const empty = this.doc.nodes.length === 0 && this.doc.edges.length === 0
    const shift = empty ? 0 : 40

    // 模板里的 n1/e1 可能与现有 id 撞车:整批重发 id,并同步改边的端点
    const nodeMap = new Map<string, string>()
    const nodes: CanvasNode[] = []
    let nextNode = 1
    for (const n of tpl.nodes) {
      const node = cloneNode(n)
      while (
        this.doc.nodes.some(x => x.id === `n${nextNode}`) ||
        nodes.some(x => x.id === `n${nextNode}`)
      ) {
        nextNode++
      }
      node.id = `n${nextNode++}`
      node.x += shift
      node.y += shift
      nodeMap.set(n.id, node.id)
      nodes.push(node)
    }
    const edges: CanvasEdge[] = []
    let nextEdge = 1
    for (const e of tpl.edges) {
      const edge = cloneEdge(e)
      while (
        this.doc.edges.some(x => x.id === `e${nextEdge}`) ||
        edges.some(x => x.id === `e${nextEdge}`)
      ) {
        nextEdge++
      }
      edge.id = `e${nextEdge++}`
      edge.from.node = e.from.node ? (nodeMap.get(e.from.node) ?? null) : null
      edge.to.node = e.to.node ? (nodeMap.get(e.to.node) ?? null) : null
      edges.push(edge)
    }

    const startNode = this.doc.nodes.length
    const startEdge = this.doc.edges.length
    this.doc.nodes.push(...nodes)
    this.doc.edges.push(...edges)
    const undo: Patch[] = []
    for (const e of edges) undo.push({ op: 'delEdge', id: e.id })
    for (const n of nodes) undo.push({ op: 'delNode', id: n.id })
    const redo: Patch[] = []
    nodes.forEach((n, i) => redo.push({ op: 'addNode', index: startNode + i, node: cloneNode(n) }))
    edges.forEach((e, i) => redo.push({ op: 'addEdge', index: startEdge + i, edge: cloneEdge(e) }))
    this.selection = new Set(nodes.map(n => n.id))
    this.commit(undo, redo, true)
    this.renderAll()
  }
}

/** 打开/新建画布时创建运行时;参数变化(换文件)时由应用重建 */
export function createCanvasRuntime(opts: CanvasRuntimeOptions): CanvasRuntime {
  return new CanvasRuntime(opts)
}
