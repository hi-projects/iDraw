import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '@shared/ipc'
import type { DiscardChoice, MenuCommand, SaveFileDialogOptions, WindowApi } from '@shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener as never)
  return () => ipcRenderer.removeListener(channel, listener as never)
}

/** 主进程抛出的错误跨进程会被包一层;界面上只留真正的原因 */
function humanizeIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return (
    raw
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^[A-Za-z_$][\w$]*Error:\s*/, '') || raw
  )
}

async function request<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    throw new Error(humanizeIpcError(err))
  }
}

const api: WindowApi = {
  openFileDialog: () => request<string | null>(IPC.FileOpenDialog),
  saveFileDialog: (o: SaveFileDialogOptions) => request<string | null>(IPC.FileSaveDialog, o),
  readFile: (path: string) => request<string>(IPC.FileRead, path),
  writeFile: (path: string, content: string) => request<void>(IPC.FileWrite, { path, content }),
  writeFileBytes: (path: string, data: Uint8Array) => request<void>(IPC.FileWriteBytes, { path, data }),
  confirmDiscard: (fileName: string) => request<DiscardChoice>(IPC.ConfirmDiscard, { fileName }),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onMenuCommand: (cb: (command: MenuCommand) => void) =>
    subscribe<MenuCommand>(IPC.MenuCommand, cb),
  takePendingOpenFile: () => request<string | null>(IPC.TakePendingOpenFile),
  onOpenFile: (cb: (path: string) => void) => subscribe<string>(IPC.OpenFile, cb)
}

contextBridge.exposeInMainWorld('idraw', api)
