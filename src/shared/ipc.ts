/** IPC 通道名。主进程与 preload 共用这一份,避免字符串各写一遍。 */
export const IPC = {
  FileOpenDialog: 'file:open-dialog',
  FileSaveDialog: 'file:save-dialog',
  FileRead: 'file:read',
  FileWrite: 'file:write',
  FileWriteBytes: 'file:write-bytes',
  ConfirmDiscard: 'app:confirm-discard',
  TakePendingOpenFile: 'app:take-pending-open-file',
  MenuCommand: 'app:menu-command',
  OpenFile: 'app:open-file'
} as const
