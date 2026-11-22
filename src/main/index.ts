import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { IPC } from '@shared/ipc'
import type {
  DiscardChoice,
  MenuCommand,
  RecentKind,
  SaveFileDialogOptions,
  WorkspaceDirListing,
  WorkspaceInfo
} from '@shared/api'
import {
  createWorkspaceCanvas,
  deleteWorkspaceCanvas,
  readWorkspace,
  renameWorkspaceCanvas
} from './workspace'
import {
  forgetRecent,
  pruneRecentEntries,
  recentEntries,
  touchFile,
  touchWorkspace
} from './workspaceRecents'
import iconPath from '../../build/icon.png?asset'

app.setName('iDraw')

// Linux 的 dock/任务栏名称来自 X11 的 WM_CLASS,它默认取 package.json 的小写 name。
// setDesktopName 必须在 ready 之前调用,把 WM_CLASS 改成和窗口标题一致的 iDraw。
if (process.platform === 'linux') app.setDesktopName('iDraw.desktop')

let mainWindow: BrowserWindow | null = null
let pendingOpenFile: string | null = null
let lastDir: string | null = null
/** 记录窗口是否是被「进入画布」自动最大化的,避免把用户手动最大化也还原掉 */
let autoMaximized = false
/** 渲染层确认可以关闭后,放行窗口的 close 事件 */
let allowWindowClose = false

function sendMenuCommand(command: MenuCommand): void {
  mainWindow?.webContents.send(IPC.MenuCommand, command)
}

/**
 * 窗口与任务栏图标。三处候选,顺序即优先级:
 *   1. electron-vite 的 `?asset` —— 文件被复制进产物目录,打包后唯一保证命中;
 *   2. 直接从源码目录跑时的仓库内 build/icon.png;
 *   3. electron-builder 打包后放进 resources 的那份。
 * 都不存在就返回 undefined,退回 Electron 默认图标 —— 总好过递一个不存在的路径。
 */
function windowIcon(): string | undefined {
  const candidates = [
    iconPath,
    join(app.getAppPath(), 'build', 'icon.png'),
    join(process.resourcesPath ?? '', 'icon.png')
  ]
  return candidates.find(p => existsSync(p))
}

function fileFromArgv(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    if (!/\.svg$/i.test(arg)) continue
    const path = isAbsolute(arg) ? arg : resolve(arg)
    if (existsSync(path)) return path
  }
  return null
}

function deliverOpenFile(path: string): void {
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send(IPC.OpenFile, path)
  } else {
    pendingOpenFile = path
  }
}

function ensureExtension(path: string, kind: 'svg' | 'png'): string {
  const ext = kind === 'png' ? '.png' : '.svg'
  return path.toLowerCase().endsWith(ext) ? path : path + ext
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, data)
    await rename(temp, path)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** beforeunload 里用:同步写盘,保证自动保存的最后一笔不丢 */
function writeAtomicSync(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, data)
    renameSync(temp, path)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const send = (command: MenuCommand) => (): void => sendMenuCommand(command)

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新建画布', accelerator: 'CmdOrCtrl+N', click: send('file:new') },
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: send('file:open') },
        {
          label: '仓库选择…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: send('file:open-workspace')
        },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: send('file:save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: send('file:save-as') },
        { label: '导出 PNG…', accelerator: 'CmdOrCtrl+Shift+E', click: send('file:export-png') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        // 不挂加速键:Ctrl+Z / Ctrl+A 要留给画布自己的键盘状态机
        { label: '撤销', click: send('edit:undo') },
        { label: '重做', click: send('edit:redo') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { label: '全选', click: send('edit:select-all') },
        { label: '删除', click: send('edit:delete') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: send('app:reload') },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 iDraw',
          click: (): void => {
            const options = {
              type: 'info' as const,
              title: '关于 iDraw',
              message: 'iDraw',
              detail:
                '用标准 SVG 画流程图与示意图。\n文件可以在浏览器、Inkscape、Illustrator 中直接打开。'
            }
            if (mainWindow) void dialog.showMessageBox(mainWindow, options)
            else void dialog.showMessageBox(options)
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  ipcMain.handle(IPC.FileOpenDialog, async (): Promise<string | null> => {
    const options = {
      title: '打开画布',
      defaultPath: lastDir ?? undefined,
      filters: [{ name: 'SVG 画布', extensions: ['svg'] }],
      // showHiddenFiles:让文件对话框显示点前缀文件(Linux 走 GTK 的 show-hidden)
      properties: ['openFile' as const, 'showHiddenFiles' as const]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    lastDir = dirname(result.filePaths[0])
    return result.filePaths[0]
  })

  ipcMain.handle(
    IPC.FileSaveDialog,
    async (_event, options: SaveFileDialogOptions): Promise<string | null> => {
      const filters =
        options.kind === 'png'
          ? [{ name: 'PNG 图片', extensions: ['png'] }]
          : [{ name: 'SVG 画布', extensions: ['svg'] }]
      const dir = options.defaultDir ?? lastDir ?? app.getPath('documents')
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, {
            title: options.kind === 'png' ? '导出 PNG' : '保存画布',
            defaultPath: join(dir, options.defaultName),
            filters
          })
        : await dialog.showSaveDialog({
            title: options.kind === 'png' ? '导出 PNG' : '保存画布',
            defaultPath: join(dir, options.defaultName),
            filters
          })
      if (result.canceled || !result.filePath) return null
      const path = ensureExtension(result.filePath, options.kind)
      lastDir = dirname(path)
      return path
    }
  )

  ipcMain.handle(IPC.FileRead, async (_event, path: string): Promise<string> => {
    if (typeof path !== 'string' || !path) throw new Error('文件路径为空')
    return readFile(path, 'utf8')
  })

  ipcMain.handle(
    IPC.FileWrite,
    async (_event, payload: { path: string; content: string }): Promise<void> => {
      await writeAtomic(payload.path, payload.content)
    }
  )

  ipcMain.handle(
    IPC.FileWriteBytes,
    async (_event, payload: { path: string; data: Uint8Array }): Promise<void> => {
      await writeAtomic(payload.path, Buffer.from(payload.data))
    }
  )

  // 同步通道只给 beforeunload 用;sendSync 会阻塞主进程,不适合普通保存
  ipcMain.on(IPC.FileWriteSync, (event, payload: { path: string; content: string }) => {
    try {
      writeAtomicSync(payload.path, payload.content)
      event.returnValue = true
    } catch (err) {
      console.error('[iDraw] 关闭前同步保存失败:', err)
      event.returnValue = false
    }
  })

  ipcMain.handle(
    IPC.ConfirmDiscard,
    async (_event, payload: { fileName: string }): Promise<DiscardChoice> => {
      const options = {
        type: 'warning' as const,
        buttons: ['保存', '不保存', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        message: `是否保存对“${payload.fileName}”的修改？`,
        detail: '如果不保存，这些修改会丢失。'
      }
      const choice = mainWindow
        ? dialog.showMessageBoxSync(mainWindow, options)
        : dialog.showMessageBoxSync(options)
      return choice === 0 ? 'save' : choice === 1 ? 'discard' : 'cancel'
    }
  )

  ipcMain.handle(IPC.TakePendingOpenFile, (): string | null => {
    const path = pendingOpenFile
    pendingOpenFile = null
    return path
  })

  // 应用矩阵里的 GitHub 链接:交给系统默认浏览器打开
  ipcMain.handle(IPC.OpenExternal, async (_event, url: string): Promise<void> => {
    try {
      const target = new URL(url)
      // 只放行 http(s),避免 file:// 之类链接借外部程序执行
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return
      await shell.openExternal(target.toString())
    } catch {
      // 非法 URL 直接忽略
    }
  })

  // 自定义标题栏只保留最小化与关闭(Windows/Linux)
  ipcMain.on(IPC.WindowMinimize, () => mainWindow?.minimize())
  ipcMain.on(IPC.WindowClose, () => mainWindow?.close())
  // 打开画布/仓库时最大化(保留 Windows 任务栏),回选择页时还原
  ipcMain.on(IPC.WindowMaximize, () => {
    const win = mainWindow
    if (!win) return
    autoMaximized = !win.isMaximized()
    if (autoMaximized) win.maximize()
  })
  ipcMain.on(IPC.WindowUnmaximize, () => {
    if (!mainWindow) return
    if (autoMaximized) mainWindow.unmaximize()
    autoMaximized = false
  })
  ipcMain.on(IPC.WindowCloseDecision, (_event, allow: boolean) => {
    if (!allow || !mainWindow) return
    allowWindowClose = true
    mainWindow.close()
  })

  // ---------- 仓库(工作区) ----------

  ipcMain.handle(IPC.WorkspacePickDirectory, async (): Promise<string | null> => {
    const options = {
      title: '打开仓库文件夹',
      defaultPath: lastDir ?? app.getPath('documents'),
      // createDirectory 让 macOS 的对话框也能新建文件夹;Windows/Linux 自带新建按钮。
      // showHiddenFiles 只在 macOS/Windows 有效:Electron 43 起已移除 Linux 支持,
      // 所以「打开文件夹」默认改走应用内浏览器(IPC.WorkspaceListDirs)。
      properties: ['openDirectory' as const, 'createDirectory' as const, 'showHiddenFiles' as const]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    lastDir = result.filePaths[0]
    return result.filePaths[0]
  })

  /**
   * 应用内文件夹浏览器:列出一级子目录,包含点前缀的隐藏目录。
   * 原生对话框在 Linux 上无法默认显示隐藏目录,仓库选择走这条 IPC。
   */
  ipcMain.handle(
    IPC.WorkspaceListDirs,
    async (_event, dir: string | null): Promise<WorkspaceDirListing> => {
      const root = resolve(dir || lastDir || app.getPath('documents'))
      try {
        const info = await stat(root)
        if (!info.isDirectory()) throw new Error('不是文件夹')
      } catch {
        throw new Error(`无法打开文件夹:${root}`)
      }
      const entries = await readdir(root, { withFileTypes: true })
      const byName = (a: { name: string }, b: { name: string }): number =>
        a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
      const dirs = entries
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => ({
          name: entry.name,
          path: join(root, entry.name),
          hidden: entry.name.startsWith('.')
        }))
        .sort(byName)
      // 同一层的 .svg 文件也列出来:进入隐藏子目录后可以直接把画布打开
      const files = entries
        .filter(entry => entry.isFile() && /\.svg$/i.test(entry.name))
        .map(entry => ({
          name: entry.name,
          path: join(root, entry.name),
          hidden: entry.name.startsWith('.')
        }))
        .sort(byName)
      lastDir = root
      const parent = dirname(root)
      return { dir: root, parent: parent === root ? null : parent, dirs, files }
    }
  )

  ipcMain.handle(
    IPC.WorkspaceRead,
    async (_event, payload: { dir: string; recursive?: boolean }): Promise<WorkspaceInfo> => {
      return readWorkspace(payload.dir, { recursive: payload.recursive === true })
    }
  )

  ipcMain.handle(
    IPC.WorkspaceCreateCanvas,
    async (_event, payload: { dir: string; name: string; content: string }) => {
      return createWorkspaceCanvas(payload.dir, payload.name, payload.content)
    }
  )

  ipcMain.handle(
    IPC.WorkspaceRenameCanvas,
    async (_event, payload: { dir: string; from: string; name: string }) => {
      return renameWorkspaceCanvas(payload.dir, payload.from, payload.name)
    }
  )

  ipcMain.handle(
    IPC.WorkspaceDeleteCanvas,
    async (_event, payload: { dir: string; relPath: string }): Promise<void> => {
      await deleteWorkspaceCanvas(payload.dir, payload.relPath)
    }
  )

  ipcMain.handle(
    IPC.WorkspaceConfirmDelete,
    async (_event, payload: { name: string }): Promise<boolean> => {
      const options = {
        type: 'warning' as const,
        buttons: ['移到回收站', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: `删除“${payload.name || '画布'}”？`,
        detail: '文件会移到系统回收站，可以从回收站恢复。'
      }
      const choice = mainWindow
        ? dialog.showMessageBoxSync(mainWindow, options)
        : dialog.showMessageBoxSync(options)
      return choice === 0
    }
  )

  ipcMain.handle(IPC.WorkspaceRecents, () => recentEntries())
  ipcMain.handle(IPC.WorkspacePruneRecents, () => pruneRecentEntries())
  ipcMain.handle(
    IPC.WorkspaceTouch,
    async (_event, payload: { dir: string }): Promise<void> => {
      await touchWorkspace(payload.dir)
    }
  )
  ipcMain.handle(
    IPC.WorkspaceTouchFile,
    async (_event, payload: { path: string }): Promise<void> => {
      await touchFile(payload.path)
    }
  )
  ipcMain.handle(
    IPC.WorkspaceForget,
    async (_event, payload: { kind: RecentKind; path: string }): Promise<void> => {
      await forgetRecent(payload.kind, payload.path)
    }
  )
}

function createWindow(): void {
  // 选择页用普通窗口居中显示(约屏幕工作区的 82%),打开画布后再最大化
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(1280, Math.max(900, Math.round(workArea.width * 0.82)))
  const height = Math.min(820, Math.max(600, Math.round(workArea.height * 0.82)))
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'iDraw',
    icon: windowIcon(),
    backgroundColor: '#edf1ef',
    /*
     * Windows / Linux:去掉原生标题栏,由渲染层在右上角画最小化/关闭按钮
     * (不提供最大化按钮)。macOS 保留原生标题栏(交通灯位置需要单独适配)。
     */
    ...(process.platform === 'win32' || process.platform === 'linux'
      ? { titleBarStyle: 'hidden' as const }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  mainWindow = win

  /*
   * 隐藏原生菜单栏(文件/编辑/视图/帮助),让工具栏直接贴在标题栏下方,不再留一条白边。
   * 菜单对象仍挂在窗口上,所以 Ctrl+N/O/S 等加速键照常生效;不要改成
   * Menu.setApplicationMenu(null),那样会把快捷键一并丢掉。
   */
  win.setMenuBarVisibility(false)

  // 内容就绪后居中显示普通窗口;画布视图由渲染层请求最大化
  win.on('ready-to-show', () => {
    win.center()
    win.show()
  })
  allowWindowClose = false
  // 关闭前先交给渲染层做未保存确认;确认后通过 IPC 放行
  win.on('close', event => {
    // 页面还在加载时没有未保存内容,直接放行
    if (allowWindowClose || win.webContents.isDestroyed() || win.webContents.isLoading()) {
      return
    }
    event.preventDefault()
    win.webContents.send(IPC.WindowCloseRequested)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    autoMaximized = false
    allowWindowClose = false
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())

  // 渲染层有未保存改动时会在 beforeunload 里取消关闭;这里把决定权交给原生对话框
  win.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['放弃修改并退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: '当前画布有未保存的修改',
      detail: '关闭后这些修改会丢失。'
    })
    // 第一个按钮:忽略 beforeunload,允许窗口关闭
    if (choice === 0) event.preventDefault()
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  const startupFile = fileFromArgv(process.argv)
  if (startupFile) pendingOpenFile = startupFile

  app.on('second-instance', (_event, argv) => {
    const path = fileFromArgv(argv)
    if (path) deliverOpenFile(path)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    deliverOpenFile(path)
  })

  void app.whenReady().then(() => {
    registerIpc()
    buildMenu()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
