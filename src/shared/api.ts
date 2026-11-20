/** 主进程与渲染层共享的桥接口。 */

export type MenuCommand =
  | 'file:new'
  | 'file:open'
  | 'file:open-workspace'
  | 'file:save'
  | 'file:save-as'
  | 'file:export-png'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:select-all'
  | 'edit:delete'
  | 'app:reload'

export interface SaveFileDialogOptions {
  /** 默认文件名(含扩展名) */
  defaultName: string
  /** 默认目录;没有当前文件时省略 */
  defaultDir?: string
  kind: 'svg' | 'png'
}

export type DiscardChoice = 'save' | 'discard' | 'cancel'

/** 仓库里的一张画布。相对路径统一使用 `/` 分隔,方便跨平台展示。 */
export interface WorkspaceCanvasEntry {
  relPath: string
  name: string
}

export interface WorkspaceInfo {
  /** 仓库绝对路径 */
  dir: string
  /** 目录名 */
  name: string
  canvases: WorkspaceCanvasEntry[]
}

/** 应用内文件夹浏览器里的一级子目录。 */
export interface WorkspaceDirEntry {
  name: string
  path: string
  /** 点前缀的隐藏目录(默认也显示) */
  hidden: boolean
}

/** 文件夹浏览器里当前目录下的 SVG 文件,点开可直接编辑。 */
export interface WorkspaceDirFile {
  name: string
  path: string
  hidden: boolean
}

export interface WorkspaceDirListing {
  /** 当前目录绝对路径 */
  dir: string
  /** 上一级目录;已经在根目录时为 null */
  parent: string | null
  dirs: WorkspaceDirEntry[]
  files: WorkspaceDirFile[]
}

export type RecentKind = 'workspace' | 'file'

/** 最近打开列表的一项:整个仓库,或单个 SVG 画布。 */
export interface RecentEntry {
  kind: RecentKind
  path: string
}

/**
 * 只由独立应用提供的仓库能力。
 *
 * 插件 webview 里没有仓库概念(文件由 iMark 宿主管理),所以挂在
 * `WindowApi.workspace` 下作为可选能力,不影响插件桥的接口实现。
 */
export interface WorkspaceApi {
  /** 选择目录作为仓库;取消时返回 null */
  selectDirectory(): Promise<string | null>
  /** 列出目录下的子目录(含隐藏目录),供应用内文件夹浏览器使用 */
  listDirectories(dir: string | null): Promise<WorkspaceDirListing>
  /** 读取仓库信息与画布列表;recursive 为 true 时才扫描子目录(默认只读当前目录) */
  read(dir: string, options?: { recursive?: boolean }): Promise<WorkspaceInfo>
  /** 在仓库根目录新建画布;重名时报错 */
  createCanvas(dir: string, name: string, content: string): Promise<WorkspaceCanvasEntry>
  /** 重命名画布(保持所在子目录不变) */
  renameCanvas(dir: string, from: string, name: string): Promise<WorkspaceCanvasEntry>
  /** 删除画布(移到系统回收站) */
  deleteCanvas(dir: string, relPath: string): Promise<void>
  /** 删除前的原生确认框 */
  confirmDeleteCanvas(name: string): Promise<boolean>
  /** 最近打开的仓库与单张画布(最新的在前) */
  recents(): Promise<RecentEntry[]>
  /** 清理已经不存在/类型不符的项并返回剩下的列表 */
  pruneRecents(): Promise<RecentEntry[]>
  /** 打开仓库时把它移到最近列表最前 */
  touchWorkspace(dir: string): Promise<void>
  /** 单独打开一张画布时把它移到最近列表最前 */
  touchFile(path: string): Promise<void>
  /** 从最近列表移除(不会删除磁盘上的文件) */
  forget(kind: RecentKind, path: string): Promise<void>
}

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
  /**
   * 只由独立应用提供:同步写盘。
   * 窗口关闭前的 beforeunload 里等不了 Promise,自动保存的最后一笔靠它落盘。
   */
  writeFileSync?(path: string, content: string): void
  writeFileBytes(path: string, data: Uint8Array): Promise<void>
  /** 有未保存改动时询问:保存 / 不保存 / 取消 */
  confirmDiscard(fileName: string): Promise<DiscardChoice>
  /** 拖入窗口的文件 → 绝对路径(Electron 44 的 webUtils) */
  getPathForFile(file: File): string
  /** 只由独立应用提供:用系统默认浏览器打开 http(s) 链接 */
  openExternal?(url: string): Promise<void>
  /**
   * 只由独立应用 preload 提供:运行平台。
   * Windows/Linux 用渲染层画的自定义窗口按钮,macOS 保留原生标题栏。
   */
  platform?: string
  /** 只由独立应用提供:自定义标题栏的最小化 / 关闭 */
  minimizeWindow?(): void
  closeWindow?(): void
  /** 只由独立应用提供:打开画布时最大化(保留 Windows 任务栏),回选择页时还原 */
  maximizeWindow?(): void
  unmaximizeWindow?(): void
  /** 主进程拦截关闭后通知渲染层;渲染层确认完再调用 confirmClose */
  onCloseRequested?(cb: () => void): () => void
  confirmClose?(allow: boolean): void
  /** 只由独立应用提供:仓库(工作区)管理;插件里为 undefined */
  workspace?: WorkspaceApi
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
