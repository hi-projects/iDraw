import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { IPC } from '@shared/ipc'
import type { DiscardChoice, MenuCommand, SaveFileDialogOptions } from '@shared/api'
import iconPath from '../../build/icon.png?asset'

app.setName('iDraw')

let mainWindow: BrowserWindow | null = null
let pendingOpenFile: string | null = null
let lastDir: string | null = null

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
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: send('file:new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: send('file:open') },
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
        { role: 'reload', label: '重新加载' },
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
      properties: ['openFile' as const]
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
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'iDraw',
    icon: windowIcon(),
    backgroundColor: '#f4f4f7',
    /*
     * Windows / Linux:去掉原生标题栏,把最小化/最大化/关闭画成覆盖层贴在工具栏右侧。
     * 顶部只剩画布工具栏,不再有一条与主题无关的标题栏白边。macOS 保留原生标题栏
     * (交通灯位置需要单独适配)。
     */
    ...(process.platform === 'win32' || process.platform === 'linux'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#ffffff',
            symbolColor: '#60626c',
            height: 52
          }
        }
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

  // 默认铺满整个屏幕:内容就绪后先最大化再显示,避免窗口先以小尺寸闪一下
  win.on('ready-to-show', () => {
    win.maximize()
    win.show()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
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
