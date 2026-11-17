/**
 * iDraw 被宿主(目前是 iMark 插件)嵌入时的消息协议。
 *
 * 独立运行时这层完全不存在:`preload` 暴露的 `window.idraw` 直接是 Electron IPC。
 * 插件 webview 里由 `src/webview/bridge.ts` 用 postMessage 实现同一套 `WindowApi`,
 * 宿主侧 `imark-plugin/main.ts` 再翻译成插件 API(工作区文件、输入框、确认框)。
 *
 * 这里只放两边共享的**类型与字符串常量**,不 import 任何运行时模块。
 */

import type {
  DiscardChoice,
  DocumentStateReport,
  MenuCommand,
  SaveFileDialogOptions
} from './api'

export const HOST_REQUEST = 'idraw:request'
export const HOST_RESPONSE = 'idraw:response'
export const HOST_MENU = 'idraw:menu'
export const HOST_OPEN = 'idraw:open'
export const HOST_NEW = 'idraw:new'

export interface HostRequestMap {
  'open-dialog': { args: undefined; result: string | null }
  'save-dialog': { args: { options: SaveFileDialogOptions }; result: string | null }
  /** 宿主询问画布名称并返回要新建的绝对路径;用户取消时返回 null */
  'new-dialog': { args: undefined; result: string | null }
  read: { args: { path: string }; result: string }
  write: { args: { path: string; content: string }; result: null }
  'write-bytes': { args: { path: string; base64: string }; result: null }
  confirm: { args: { fileName: string }; result: DiscardChoice }
  'take-pending': { args: undefined; result: string | null }
  report: { args: { state: DocumentStateReport }; result: null }
}

export type HostMethod = keyof HostRequestMap

export interface HostRequestMessage {
  type: typeof HOST_REQUEST
  id: number
  method: HostMethod
  args?: unknown
}

export interface HostResponseMessage {
  type: typeof HOST_RESPONSE
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

export interface HostMenuMessage {
  type: typeof HOST_MENU
  command: MenuCommand
}

export interface HostOpenMessage {
  type: typeof HOST_OPEN
  path: string
}

/** 宿主已问过名称:按这个路径新建空白画布并打开 */
export interface HostNewMessage {
  type: typeof HOST_NEW
  path: string
}

/** 宿主 → webview。浏览器 postMessage 的外层包装见 bridge.ts。 */
export type HostToWebviewMessage = HostResponseMessage | HostMenuMessage | HostOpenMessage | HostNewMessage
