/** 主进程与渲染层共享的桥接口。 */

export type MenuCommand =
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:save-as'
  | 'file:export-png'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:select-all'
  | 'edit:delete'

export interface SaveFileDialogOptions {
  /** 默认文件名(含扩展名) */
  defaultName: string
  /** 默认目录;没有当前文件时省略 */
  defaultDir?: string
  kind: 'svg' | 'png'
}

export type DiscardChoice = 'save' | 'discard' | 'cancel'

/** 嵌入宿主(iMark 插件)时上报的文档状态;独立运行时不会用到 */
export interface DocumentStateReport {
  path: string | null
  name: string
  dirty: boolean
  /** 有未保存修改时的当前 SVG 文本;宿主用于关闭/崩溃后的恢复草稿 */
  text?: string
}

export interface WindowApi {
  openFileDialog(): Promise<string | null>
  saveFileDialog(options: SaveFileDialogOptions): Promise<string | null>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  writeFileBytes(path: string, data: Uint8Array): Promise<void>
  /** 有未保存改动时询问:保存 / 不保存 / 取消 */
  confirmDiscard(fileName: string): Promise<DiscardChoice>
  /** 拖入窗口的文件 → 绝对路径(Electron 44 的 webUtils) */
  getPathForFile(file: File): string
  onMenuCommand(cb: (command: MenuCommand) => void): () => void
  /**
   * 只由嵌入宿主提供:先弹名称输入框,返回用户要新建画布的绝对路径。
   * 独立运行时为 undefined,应用退回「未命名画布 + 保存时选路径」。
   */
  newCanvasDialog?(): Promise<string | null>
  /** 只由嵌入宿主提供:宿主已在别的入口问过名称,要求按这个路径新建空白画布 */
  onNewFile?(cb: (path: string) => void): () => void
  /** 启动参数 / 第二次启动 / macOS 访达里双击带进来的文件 */
  takePendingOpenFile(): Promise<string | null>
  onOpenFile(cb: (path: string) => void): () => void
  /**
   * 只由嵌入宿主提供:把当前文件、脏标记和(可选的)SVG 文本交给宿主。
   * 独立运行时为 undefined,应用据此判断自己是不是跑在插件里。
   */
  reportDocument?(state: DocumentStateReport): void
}
