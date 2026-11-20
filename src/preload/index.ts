import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  DiscardChoice,
  MenuCommand,
  RecentEntry,
  RecentKind,
  SaveFileDialogOptions,
  WindowApi,
  WorkspaceApi,
  WorkspaceCanvasEntry,
  WorkspaceDirListing,
  WorkspaceInfo
} from '@shared/api'

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

const workspace: WorkspaceApi = {
  selectDirectory: () => request<string | null>(IPC.WorkspacePickDirectory),
  listDirectories: (dir: string | null) =>
    request<WorkspaceDirListing>(IPC.WorkspaceListDirs, dir),
  read: (dir: string, options?: { recursive?: boolean }) =>
    request<WorkspaceInfo>(IPC.WorkspaceRead, { dir, recursive: options?.recursive === true }),
  createCanvas: (dir: string, name: string, content: string) =>
    request<WorkspaceCanvasEntry>(IPC.WorkspaceCreateCanvas, { dir, name, content }),
  renameCanvas: (dir: string, from: string, name: string) =>
    request<WorkspaceCanvasEntry>(IPC.WorkspaceRenameCanvas, { dir, from, name }),
  deleteCanvas: (dir: string, relPath: string) =>
    request<void>(IPC.WorkspaceDeleteCanvas, { dir, relPath }),
  confirmDeleteCanvas: (name: string) =>
    request<boolean>(IPC.WorkspaceConfirmDelete, { name }),
  recents: () => request<RecentEntry[]>(IPC.WorkspaceRecents),
  pruneRecents: () => request<RecentEntry[]>(IPC.WorkspacePruneRecents),
  touchWorkspace: (dir: string) => request<void>(IPC.WorkspaceTouch, { dir }),
  touchFile: (path: string) => request<void>(IPC.WorkspaceTouchFile, { path }),
  forget: (kind: RecentKind, path: string) =>
    request<void>(IPC.WorkspaceForget, { kind, path })
}

const api: WindowApi = {
  openFileDialog: () => request<string | null>(IPC.FileOpenDialog),
  saveFileDialog: (o: SaveFileDialogOptions) => request<string | null>(IPC.FileSaveDialog, o),
  readFile: (path: string) => request<string>(IPC.FileRead, path),
  writeFile: (path: string, content: string) => request<void>(IPC.FileWrite, { path, content }),
  writeFileSync: (path: string, content: string) => {
    const ok = ipcRenderer.sendSync(IPC.FileWriteSync, { path, content })
    if (!ok) throw new Error('同步保存失败')
  },
  writeFileBytes: (path: string, data: Uint8Array) => request<void>(IPC.FileWriteBytes, { path, data }),
  confirmDiscard: (fileName: string) => request<DiscardChoice>(IPC.ConfirmDiscard, { fileName }),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openExternal: (url: string) => request<void>(IPC.OpenExternal, url),
  platform: process.platform,
  minimizeWindow: () => ipcRenderer.send(IPC.WindowMinimize),
  closeWindow: () => ipcRenderer.send(IPC.WindowClose),
  maximizeWindow: () => ipcRenderer.send(IPC.WindowMaximize),
  unmaximizeWindow: () => ipcRenderer.send(IPC.WindowUnmaximize),
  onCloseRequested: (cb: () => void) => subscribe(IPC.WindowCloseRequested, cb),
  confirmClose: (allow: boolean) => ipcRenderer.send(IPC.WindowCloseDecision, allow),
  workspace,
  onMenuCommand: (cb: (command: MenuCommand) => void) =>
    subscribe<MenuCommand>(IPC.MenuCommand, cb),
  takePendingOpenFile: () => request<string | null>(IPC.TakePendingOpenFile),
  onOpenFile: (cb: (path: string) => void) => subscribe<string>(IPC.OpenFile, cb)
}

contextBridge.exposeInMainWorld('idraw', api)
