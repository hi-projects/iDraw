/**
 * iDraw 的 iMark 插件入口。
 *
 * 插件只做两件事:
 *   1. 把 iMark 专用的插件页面放进一个编辑区标签页（presentation: 'tab'）,
 *      与文件标签并列,标题与未保存圆点都由 iMark 的标签栏绘制;
 *   2. 用 iMark 的扩展 API 实现 webview 需要的文件/对话框能力。
 *
 * 画布引擎、SVG 序列化、撤销栈都在 webview 里,宿主进程不碰场景对象。
 * 插件外壳与独立版分开,但共用 `src/engine` / `src/editor`,画布行为只有一套。
 */
import * as imark from 'imark'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import {
  HOST_MENU,
  HOST_NEW,
  HOST_OPEN,
  HOST_REQUEST,
  HOST_RESPONSE,
  type HostMethod
} from '../src/shared/hostBridge'
import type { DiscardChoice, DocumentStateReport, MenuCommand, SaveFileDialogOptions } from '../src/shared/api'

const VIEW_TYPE = 'idraw.canvas'

const CMD_OPEN = 'idraw.canvas.open'
const CMD_NEW = 'idraw.canvas.new'
const CMD_SAVE = 'idraw.canvas.save'
const CMD_SAVE_AS = 'idraw.canvas.saveAs'
const CMD_EXPORT_PNG = 'idraw.canvas.exportPng'
const CMD_UNDO = 'idraw.canvas.undo'
const CMD_REDO = 'idraw.canvas.redo'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'out',
  'dist',
  'build',
  '.cache',
  '.idea',
  '.vscode'
])
const MAX_SVG_ITEMS = 800

interface CanvasPickItem extends imark.QuickPickItem {
  path?: string
  manual?: boolean
}

interface DocState {
  path: string | null
  name: string
  dirty: boolean
  text?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeRel(value: string): string | null {
  const parts = value
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part.length > 0 && part !== '.')
  if (parts.length === 0) return null
  if (parts.some(part => part === '..')) return null
  return parts.join('/')
}

function withExtension(value: string, kind: 'svg' | 'png'): string {
  const ext = kind === 'png' ? '.png' : '.svg'
  return value.toLowerCase().endsWith(ext) ? value : value + ext
}

function inside(root: string, target: string): string | null {
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(/[/\\]/).join('/')
}

export class CanvasPlugin {
  private panel: imark.WebviewPanel | null = null
  private readonly docs = new WeakMap<imark.WebviewPanel, DocState>()
  private lastDoc: DocState | null = null
  private disposed = false

  constructor(private readonly context: imark.ExtensionContext) {}

  start(): void {
    this.context.subscriptions.push(
      imark.commands.registerCommand(CMD_OPEN, () => this.openCommand()),
      imark.commands.registerCommand(CMD_NEW, () => this.newCommand()),
      imark.commands.registerCommand(CMD_SAVE, () => this.sendMenu('file:save')),
      imark.commands.registerCommand(CMD_SAVE_AS, () => this.sendMenu('file:save-as')),
      imark.commands.registerCommand(CMD_EXPORT_PNG, () => this.sendMenu('file:export-png')),
      imark.commands.registerCommand(CMD_UNDO, () => this.sendMenu('edit:undo')),
      imark.commands.registerCommand(CMD_REDO, () => this.sendMenu('edit:redo')),
      imark.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state) => this.restorePanel(panel, state)
      })
    )
  }

  async deactivate(): Promise<void> {
    this.disposed = true
    // 应用退出时面板可能没机会走关闭确认;把最后一份草稿写盘,下次可手动恢复
    if (this.lastDoc?.dirty && this.lastDoc.text) {
      await this.writeRecovery(this.lastDoc).catch(() => undefined)
    }
  }

  // ---------- 命令 ----------

  private async openCommand(): Promise<void> {
    const path = await this.pickCanvas()
    if (!path) return
    this.ensurePanel()
    await this.panel?.webview.postMessage({ type: HOST_OPEN, path })
  }

  /**
   * 新建画布:先问名称,确认后才建面板。
   *
   * 与 iMark 新建文件一致 —— 名字先定下来,文件从创建那一刻就存在;画布打开时
   * 已经绑定这个路径,保存不再弹路径框。
   */
  private async newCommand(): Promise<void> {
    const path = await this.askNewPath()
    if (!path) return
    const panel = this.ensurePanel()
    panel.title = basename(path)
    await panel.webview.postMessage({ type: HOST_NEW, path })
  }

  private sendMenu(command: MenuCommand): void {
    if (!this.panel) {
      void imark.window.showInformationMessage('先打开一张画布，再使用这个命令。')
      return
    }
    this.panel.reveal()
    void this.panel.webview.postMessage({ type: HOST_MENU, command })
  }

  // ---------- 面板 ----------

  private ensurePanel(): imark.WebviewPanel {
    if (this.panel) {
      this.panel.reveal()
      return this.panel
    }
    const panel = imark.window.createWebviewPanel(
      VIEW_TYPE,
      // 标签标题由下面的 report() 立刻换成文件名;这个初值只在第一帧可见
      '未命名.svg',
      { viewColumn: imark.ViewColumn.One },
      {
        enableScripts: true,
        // 切到别的文件标签时只隐藏 iframe:场景、撤销栈、缩放位置都保留
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
        // 与文件标签并列在标签栏里,而不是盖住整个编辑区的 overlay
        imark: { presentation: 'tab' }
      }
    )
    this.adoptPanel(panel)
    panel.webview.html = this.panelHtml(panel)
    return panel
  }

  private restorePanel(panel: imark.WebviewPanel, state: unknown): void {
    this.adoptPanel(panel)
    panel.webview.html = this.panelHtml(panel)
    const saved = asRecord(state)
    const path = str(saved.path)
    if (path) void panel.webview.postMessage({ type: HOST_OPEN, path })
  }

  private adoptPanel(panel: imark.WebviewPanel): void {
    if (this.disposed) {
      panel.dispose()
      return
    }
    if (this.panel && this.panel !== panel) this.panel.dispose()
    this.panel = panel
    this.context.subscriptions.push(
      panel.webview.onDidReceiveMessage(message => {
        void this.onMessage(panel, message).catch(err => {
          const text = err instanceof Error ? err.message : String(err)
          void imark.window.showErrorMessage(`iDraw: ${text}`)
        })
      }),
      panel.onDidDispose(() => this.onPanelDisposed(panel))
    )
  }

  private onPanelDisposed(panel: imark.WebviewPanel): void {
    const doc = this.docs.get(panel)
    this.docs.delete(panel)
    if (this.panel === panel) this.panel = null
    if (!doc || !doc.dirty || !doc.text || this.disposed) return
    void this.offerRecovery(doc)
  }

  private panelHtml(panel: imark.WebviewPanel): string {
    const csp = panel.webview.cspSource
    const script = panel.webview.asWebviewUri(
      imark.Uri.joinPath(this.context.extensionUri, 'webview', 'canvas.js')
    )
    const style = panel.webview.asWebviewUri(
      imark.Uri.joinPath(this.context.extensionUri, 'webview', 'canvas.css')
    )
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; font-src ${csp} data:; style-src ${csp} 'unsafe-inline'; script-src ${csp}; connect-src 'none'; frame-src 'none'; worker-src 'none';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body, #app { height: 100%; margin: 0; }
  body { overflow: hidden; background: var(--bg-app, #f8f9fb); }
</style>
<link rel="stylesheet" href="${style.toString()}" />
<title>iDraw</title>
</head>
<body>
<div id="app"></div>
<script src="${script.toString()}"></script>
</body>
</html>`
  }

  // ---------- webview 消息 ----------

  private async onMessage(panel: imark.WebviewPanel, raw: unknown): Promise<void> {
    const message = asRecord(raw)
    // iMark 的菜单命令（Ctrl+S / Ctrl+Shift+S / 全选）在标签页模式下会先到扩展宿主，
    // 由这里转发给画布页面；页面里的 window keydown 收不到被原生菜单吃掉的按键。
    if (message.type === 'imark:command') {
      const command = str(message.command) as MenuCommand
      if (command) await panel.webview.postMessage({ type: HOST_MENU, command })
      return
    }
    if (message.type !== HOST_REQUEST) return
    const id = typeof message.id === 'number' ? message.id : -1
    const method = str(message.method) as HostMethod
    if (!id || !method) return
    try {
      const value = await this.handleRequest(panel, method, message.args)
      await panel.webview.postMessage({ type: HOST_RESPONSE, id, ok: true, value })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      await panel.webview.postMessage({ type: HOST_RESPONSE, id, ok: false, error: text })
    }
  }

  private handleRequest(panel: imark.WebviewPanel, method: HostMethod, rawArgs: unknown): unknown {
    const args = asRecord(rawArgs)
    switch (method) {
      case 'open-dialog':
        return this.pickCanvas()
      case 'save-dialog':
        return this.askSavePath(asRecord(args.options) as unknown as SaveFileDialogOptions)
      case 'new-dialog':
        return this.askNewPath()
      case 'read':
        return this.readText(str(args.path))
      case 'write':
        return this.writeText(str(args.path), str(args.content))
      case 'write-bytes':
        return this.writeBytes(str(args.path), str(args.base64))
      case 'confirm':
        return this.confirmDiscard(str(args.fileName))
      case 'take-pending':
        return null
      case 'report':
        this.report(panel, asRecord(args.state) as unknown as DocumentStateReport)
        return null
      default:
        throw new Error(`不支持的操作：${String(method)}`)
    }
  }

  private report(panel: imark.WebviewPanel, state: DocumentStateReport): void {
    const previous = this.docs.get(panel)
    const sameFile = previous && previous.path === state.path && previous.name === state.name
    const next: DocState = {
      path: state.path ?? null,
      name: state.name || '未命名.svg',
      dirty: state.dirty === true,
      // 换文件时丢掉旧文本,避免恢复草稿把上一张画布写回来
      text: typeof state.text === 'string' ? state.text : sameFile ? previous?.text : undefined
    }
    this.docs.set(panel, next)
    this.lastDoc = next

    // 标签栏负责画未保存圆点:标题只放文件名,脏标记走 setDirty
    if (panel.title !== next.name) panel.title = next.name
    panel.imark.setDirty?.(next.dirty)

    if (!previous || previous.path !== next.path || previous.name !== next.name) {
      void panel.webview.setState({ path: next.path, name: next.name })
    }
  }

  // ---------- 文件 ----------

  private workspaceRoot(): imark.Uri | null {
    return imark.workspace.workspaceFolders?.[0]?.uri ?? null
  }

  private async listSvg(root: imark.Uri): Promise<CanvasPickItem[]> {
    const out: CanvasPickItem[] = []
    const walk = async (dir: imark.Uri, prefix: string, depth: number): Promise<void> => {
      if (depth > 8 || out.length >= MAX_SVG_ITEMS) return
      let entries: readonly [string, imark.FileType][]
      try {
        entries = await imark.workspace.fs.readDirectory(dir)
      } catch {
        return
      }
      for (const [name, type] of entries) {
        if (out.length >= MAX_SVG_ITEMS) return
        if (name.startsWith('.')) continue
        const child = imark.Uri.joinPath(dir, name)
        const rel = prefix ? `${prefix}/${name}` : name
        if (type & imark.FileType.Directory) {
          if (!SKIP_DIRS.has(name)) await walk(child, rel, depth + 1)
        } else if (type & imark.FileType.File && /\.svg$/i.test(name)) {
          out.push({ label: rel, description: 'SVG 画布', path: child.fsPath })
        }
      }
    }
    await walk(root, '', 0)
    out.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
    return out
  }

  private async pickCanvas(): Promise<string | null> {
    const root = this.workspaceRoot()
    if (root) {
      const items = await this.listSvg(root)
      const choices: CanvasPickItem[] = [
        { label: '输入路径…', description: '工作区内的相对路径', manual: true },
        ...items
      ]
      const picked = await imark.window.showQuickPick(choices, {
        title: '打开画布',
        placeHolder: items.length ? '选择仓库里的 .svg 画布' : '仓库里还没有 .svg 文件',
        matchOnDescription: true
      })
      if (!picked) return null
      if (picked.manual) return this.askOpenPath(root)
      return picked.path ?? null
    }
    return this.askOpenPath(null)
  }

  private async askOpenPath(root: imark.Uri | null): Promise<string | null> {
    const value = await imark.window.showInputBox({
      title: '打开画布',
      prompt: root ? '输入工作区内的相对路径' : '输入 SVG 文件的绝对路径',
      placeHolder: root ? '流程图.svg' : '/home/me/流程图.svg',
      validateInput: text => (text.trim() ? undefined : '路径不能为空')
    })
    if (!value) return null
    let path: string | null = null
    if (root) {
      const rel = normalizeRel(value)
      if (!rel) {
        await imark.window.showWarningMessage('路径必须位于当前工作区内，且不能包含 ..')
        return null
      }
      path = this.uriFromRel(root, rel).fsPath
    } else {
      if (!isAbsolute(value.trim())) {
        await imark.window.showWarningMessage('工作区未打开，请输入绝对路径。')
        return null
      }
      path = value.trim()
    }
    if (!(await this.exists(path))) {
      const withExt = withExtension(path, 'svg')
      if (await this.exists(withExt)) path = withExt
      else {
        await imark.window.showWarningMessage(`找不到文件：${path}`)
        return null
      }
    }
    return path
  }

  /**
   * 新建画布的名称输入。
   *
   * 名字按仓库内的相对路径处理(可以带子目录),扩展名固定 `.svg`;同名文件
   * 已存在时换名而不是覆盖 —— 这是「新建」,不该毁掉已有画布。
   */
  private async askNewPath(): Promise<string | null> {
    const root = this.workspaceRoot()
    if (!root) {
      await imark.window.showWarningMessage('请先打开一个仓库，新建的画布会保存在仓库里。')
      return null
    }
    const value = await imark.window.showInputBox({
      title: '新建画布',
      prompt: '输入画布名称，会保存为仓库里的 SVG 文件',
      placeHolder: '流程图.svg',
      validateInput: text =>
        normalizeRel(withExtension(text.trim(), 'svg')) ? undefined : '名称不能为空，且不能包含 ..'
    })
    if (!value) return null
    const rel = normalizeRel(withExtension(value.trim(), 'svg'))
    if (!rel) return null
    const target = this.uriFromRel(root, rel)
    if (await this.exists(target.fsPath)) {
      await imark.window.showWarningMessage(`“${basename(target.fsPath)}”已存在，换一个名称。`)
      return null
    }
    return target.fsPath
  }

  private async askSavePath(options: SaveFileDialogOptions): Promise<string | null> {
    const kind = options?.kind === 'png' ? 'png' : 'svg'
    const base = withExtension(
      basename(options?.defaultName || (kind === 'png' ? '画布.png' : '未命名.svg')),
      kind
    )
    const root = this.workspaceRoot()

    if (!root) {
      const value = await imark.window.showInputBox({
        title: kind === 'png' ? '导出 PNG' : '保存画布',
        prompt: '工作区未打开，请输入绝对路径',
        value: options?.defaultDir ? resolve(options.defaultDir, base) : base,
        validateInput: text => (isAbsolute(text.trim()) ? undefined : '请输入绝对路径')
      })
      if (!value) return null
      return this.confirmTarget(withExtension(value.trim(), kind), kind)
    }

    const dirRel = options?.defaultDir ? inside(root.fsPath, options.defaultDir) : null
    const initial = dirRel ? `${dirRel}/${base}` : base
    const value = await imark.window.showInputBox({
      title: kind === 'png' ? '导出 PNG' : '保存画布',
      prompt: '输入工作区内的相对路径，可以包含子目录',
      value: initial,
      validateInput: text => (normalizeRel(text) ? undefined : '路径必须位于工作区内，且不能包含 ..')
    })
    if (!value) return null
    const rel = normalizeRel(value)
    if (!rel) return null
    const target = this.uriFromRel(root, withExtension(rel, kind))
    return this.confirmTarget(target.fsPath, kind)
  }

  private async confirmTarget(path: string, kind: 'svg' | 'png'): Promise<string | null> {
    if (!(await this.exists(path))) return path
    const choice = await imark.window.showWarningMessage(
      `“${basename(path)}”已存在`,
      { modal: true, detail: '继续会覆盖这个文件。' },
      kind === 'png' ? '覆盖图片' : '覆盖画布',
      '取消'
    )
    return choice === (kind === 'png' ? '覆盖图片' : '覆盖画布') ? path : null
  }

  private uriFromRel(root: imark.Uri, rel: string): imark.Uri {
    const parts = rel.split('/').filter(Boolean)
    return imark.Uri.joinPath(root, ...parts)
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const info = await imark.workspace.fs.stat(imark.Uri.file(path))
      return (info.type & imark.FileType.File) !== 0
    } catch {
      return false
    }
  }

  private async readText(path: string): Promise<string> {
    if (!path) throw new Error('文件路径为空')
    const bytes = await imark.workspace.fs.readFile(imark.Uri.file(path))
    return Buffer.from(bytes).toString('utf8')
  }

  private async writeText(path: string, content: string): Promise<null> {
    if (!path) throw new Error('文件路径为空')
    await this.prepare(path)
    await imark.workspace.fs.writeFile(imark.Uri.file(path), Buffer.from(content, 'utf8'))
    return null
  }

  private async writeBytes(path: string, base64: string): Promise<null> {
    if (!path) throw new Error('文件路径为空')
    await this.prepare(path)
    await imark.workspace.fs.writeFile(imark.Uri.file(path), Buffer.from(base64, 'base64'))
    return null
  }

  private async prepare(path: string): Promise<void> {
    await imark.workspace.fs.createDirectory(imark.Uri.file(dirname(path)))
  }

  private async confirmDiscard(fileName: string): Promise<DiscardChoice> {
    const choice = await imark.window.showWarningMessage(
      `是否保存对“${fileName}”的修改？`,
      { modal: true, detail: '如果不保存，这些修改会丢失。' },
      '保存',
      '不保存',
      '取消'
    )
    if (choice === '保存') return 'save'
    if (choice === '不保存') return 'discard'
    return 'cancel'
  }

  // ---------- 未保存草稿 ----------

  private async writeRecovery(doc: DocState): Promise<string | null> {
    if (!doc.text) return null
    const dir = imark.Uri.joinPath(this.context.globalStorageUri, 'recovery')
    await imark.workspace.fs.createDirectory(dir)
    const safe =
      doc.name
        .replace(/[^\w一-鿿.-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 80) || 'canvas.svg'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = imark.Uri.joinPath(dir, `${stamp}-${withExtension(safe, 'svg')}`)
    await imark.workspace.fs.writeFile(target, Buffer.from(doc.text, 'utf8'))
    return target.fsPath
  }

  private async offerRecovery(doc: DocState): Promise<void> {
    try {
      const path = await this.writeRecovery(doc)
      if (!path) return
      const choice = await imark.window.showWarningMessage(
        `画布“${doc.name}”有未保存的修改`,
        { detail: `已保留恢复文件：${path}` },
        '打开恢复文件',
        '稍后处理'
      )
      if (choice === '打开恢复文件') {
        this.ensurePanel()
        await this.panel?.webview.postMessage({ type: HOST_OPEN, path })
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      void imark.window.showErrorMessage(`保留画布草稿失败：${text}`)
    }
  }
}

let instance: CanvasPlugin | null = null

export function activate(context: imark.ExtensionContext): void {
  instance = new CanvasPlugin(context)
  instance.start()
}

export async function deactivate(): Promise<void> {
  await instance?.deactivate()
  instance = null
}
