/**
 * iDraw 在 iMark 插件 webview 里的宿主桥。
 *
 * 应用主体(以及它 import 的 `host/windowApi.ts`)完全不知道自己在 iframe 里:
 * 这里在模块求值阶段把 `window.idraw` 装好,接口与 Electron preload 暴露的
 * `WindowApi` 逐项一致,区别只是每个请求都变成一条 postMessage。
 *
 * 消息外层与 iMark 的 webview 约定一致:
 *   页面 → 宿主  window.parent.postMessage({ type: 'imark:message', message })
 *   宿主 → 页面  window.addEventListener('message') 里取 data.message
 *
 * 页面就绪用 `imark:ready` 通知;宿主在此之前发来的消息由渲染层排队,
 * 插件侧不需要自己重试。
 */
import type {
  DiscardChoice,
  DocumentStateReport,
  MenuCommand,
  SaveFileDialogOptions,
  WindowApi
} from '@shared/api'
import {
  HOST_MENU,
  HOST_NEW,
  HOST_OPEN,
  HOST_REQUEST,
  HOST_RESPONSE,
  type HostMethod,
  type HostRequestMap,
  type HostToWebviewMessage
} from '@shared/hostBridge'

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

const pending = new Map<number, Pending>()
const menuListeners = new Set<(command: MenuCommand) => void>()
const openListeners = new Set<(path: string) => void>()
const newListeners = new Set<(path: string) => void>()
const pendingMenus: MenuCommand[] = []
let pendingOpen: string | null = null
let pendingNew: string | null = null
let seq = 0

function postToHost(message: unknown): void {
  // 独立运行时不会加载这个模块;判一下,避免在普通页面里抛错
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'imark:message', message }, '*')
  }
}

function request<M extends HostMethod>(
  method: M,
  args: HostRequestMap[M]['args']
): Promise<HostRequestMap[M]['result']> {
  seq += 1
  const id = seq
  return new Promise<HostRequestMap[M]['result']>((resolve, reject) => {
    pending.set(id, {
      resolve: value => resolve(value as HostRequestMap[M]['result']),
      reject
    })
    postToHost({ type: HOST_REQUEST, id, method, args })
  })
}

/** 不需要结果的单向通知(目前只有 report);仍然发 request 让宿主复用同一入口 */
function notify<M extends HostMethod>(method: M, args: HostRequestMap[M]['args']): void {
  seq += 1
  postToHost({ type: HOST_REQUEST, id: seq, method, args })
}

function flushMenus(): void {
  while (pendingMenus.length) {
    const command = pendingMenus.shift()!
    for (const listener of [...menuListeners]) listener(command)
  }
}

function flushOpen(): void {
  const path = pendingOpen
  if (!path || openListeners.size === 0) return
  pendingOpen = null
  for (const listener of [...openListeners]) listener(path)
}

function flushNew(): void {
  const path = pendingNew
  if (!path || newListeners.size === 0) return
  pendingNew = null
  for (const listener of [...newListeners]) listener(path)
}

function onHostMessage(data: HostToWebviewMessage): void {
  if (data.type === HOST_RESPONSE) {
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.ok) entry.resolve(data.value)
    else entry.reject(new Error(data.error || '宿主操作失败'))
    return
  }
  if (data.type === HOST_MENU) {
    if (menuListeners.size === 0) pendingMenus.push(data.command)
    else for (const listener of [...menuListeners]) listener(data.command)
    return
  }
  if (data.type === HOST_OPEN) {
    if (openListeners.size === 0) pendingOpen = data.path
    else for (const listener of [...openListeners]) listener(data.path)
    return
  }
  if (data.type === HOST_NEW) {
    if (newListeners.size === 0) pendingNew = data.path
    else for (const listener of [...newListeners]) listener(data.path)
  }
}

interface HostTheme {
  kind?: unknown
  colors?: unknown
}

/** 把 iMark 的主题色写成 CSS 变量,插件外壳直接跟随宿主亮/暗主题 */
function applyTheme(raw: unknown): void {
  const theme = (raw ?? {}) as HostTheme
  document.documentElement.dataset.theme = theme.kind === 'dark' ? 'dark' : 'light'
  const colors = theme.colors
  if (!colors || typeof colors !== 'object') return
  for (const [name, value] of Object.entries(colors as Record<string, unknown>)) {
    if (typeof value === 'string' && value) {
      document.documentElement.style.setProperty(name, value)
    }
  }
}

window.addEventListener('message', event => {
  const outer = event.data as
    | { type?: unknown; message?: unknown; theme?: unknown }
    | null
    | undefined
  if (!outer || typeof outer !== 'object') return
  if (outer.type === 'imark:bootstrap' || outer.type === 'imark:theme') {
    applyTheme(outer.theme)
    return
  }
  if (outer.type !== 'imark:message') return
  const message = outer.message as HostToWebviewMessage | undefined
  if (!message || typeof message !== 'object') return
  onHostMessage(message)
})

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

const api: WindowApi = {
  openFileDialog: () => request('open-dialog', undefined),
  saveFileDialog: (options: SaveFileDialogOptions) => request('save-dialog', { options }),
  readFile: path => request('read', { path }),
  writeFile: (path, content) => request('write', { path, content }).then(() => undefined),
  writeFileBytes: (path, data) =>
    request('write-bytes', { path, base64: toBase64(data) }).then(() => undefined),
  confirmDiscard: (fileName): Promise<DiscardChoice> => request('confirm', { fileName }),
  // 拖进来的文件在跨源 iframe 里拿不到绝对路径;返回空串让应用忽略这次拖放
  getPathForFile: () => '',
  onMenuCommand: cb => {
    menuListeners.add(cb)
    flushMenus()
    return () => menuListeners.delete(cb)
  },
  newCanvasDialog: () => request('new-dialog', undefined),
  // 新面板的文件由宿主发 `idraw:open` / `idraw:new` 事件;这个入口保持与独立版一致但永远为空
  takePendingOpenFile: () => request('take-pending', undefined),
  onOpenFile: cb => {
    openListeners.add(cb)
    flushOpen()
    return () => openListeners.delete(cb)
  },
  onNewFile: cb => {
    newListeners.add(cb)
    flushNew()
    return () => newListeners.delete(cb)
  },
  reportDocument: (state: DocumentStateReport) => notify('report', { state })
}

;(window as unknown as { idraw?: WindowApi }).idraw = api

// 告诉宿主可以开始投递消息了;已就绪前宿主发来的内容由渲染层排队
window.parent.postMessage({ type: 'imark:ready' }, '*')

export {}
