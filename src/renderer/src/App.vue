<script setup lang="ts">
/**
 * iDraw 独立应用的整个外壳。
 *
 * 启动先进入仓库选择页,有三种使用方式:
 *  - 打开一个目录作为仓库:目录里的 `.svg` 是多张画布,编辑后自动保存;
 *  - 临时画布:只在当前会话里存在,手动保存到文件后才开始自动保存;
 *  - 打开单个 SVG 文件:与临时画布一样手动保存。
 *
 * 一份画布一个 CanvasRuntime:切换/新建/打开时重建运行时,CanvasPane 用
 * `:key` 跟着重建。这里负责文件生命周期、自动保存队列、窗口标题与菜单路由;
 * 画布引擎本身不知道文件系统。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { FilePlus2, LayoutGrid } from 'lucide-vue-next'
import CanvasPane from './components/CanvasPane.vue'
import GlobalMenu from './components/GlobalMenu.vue'
import StatusBar from './components/StatusBar.vue'
import ThemeToggle from './components/ThemeToggle.vue'
import ThemedDialogHost from './components/ThemedDialogHost.vue'
import WindowControls from './components/WindowControls.vue'
import WorkspacePicker from './components/WorkspacePicker.vue'
import WorkspaceSidebar from './components/WorkspaceSidebar.vue'
import { createCanvasRuntime, type CanvasRuntime } from '../../engine/runtime'
import { emptyDoc } from '../../engine/model'
import { serializeCanvas } from '../../engine/serialize'
import { api, type MenuCommand } from '../../host/windowApi'
import { dismissToast, notifyError, pushNotice, toasts } from '../../editor/notice'
import { dirNameOf, fileNameOf, joinPath, relativePathOf } from '@shared/path'
import type { WorkspaceCanvasEntry, WorkspaceInfo } from '@shared/api'
import { desktopHost, workspaceApi } from './host'
import { showDialog } from './dialog'
import { nextCanvasName, type CanvasMutationResult, type SaveStatus } from './workspaceTypes'
import {
  autoSaveDelayMs,
  getAutoSaveMode,
  nestedCanvasesEnabled,
  setAutoSaveDelayMs,
  setAutoSaveMode,
  setNestedCanvasesEnabled,
  type AutoSaveMode
} from './workspacePrefs'

const BLANK_SVG = serializeCanvas(emptyDoc())
/** Windows/Linux 用自定义按钮;macOS 保留原生交通灯 */
const showWindowControls =
  !!api.platform && api.platform !== 'darwin' && !!api.minimizeWindow && !!api.closeWindow

type View = 'picker' | 'workspace' | 'standalone'

const view = ref<View>('picker')
// 打开任意画布/仓库视图时最大化(保留 Windows 任务栏);回到选择页时还原
watch(view, value => {
  if (value === 'picker') api.unmaximizeWindow?.()
  else api.maximizeWindow?.()
})
const workspace = ref<WorkspaceInfo | null>(null)
const runtime = shallowRef<CanvasRuntime | null>(null)
const docKey = ref(0)
const dirty = ref(false)
const saveStatus = ref<SaveStatus>('idle')
const currentPath = ref<string | null>(null)
const currentName = ref('未命名.svg')
const autoSaveOn = ref(false)
const activeRelPath = ref<string | null>(null)
/** 仓库页左侧目录栏是否收起(收起后画布占满宽度) */
const sidebarCollapsed = ref(false)
/** 仓库列表是否递归显示子目录里的画布(设置 → 布局) */
const nestedCanvases = ref(nestedCanvasesEnabled())
/** 自动保存间隔(秒),设置面板「编辑器 → 自动保存」可调 */
const autoSaveDelaySec = ref(autoSaveDelayMs() / 1000)
/** 自动保存模式:定时保存 / 关闭 */
const autoSaveMode = ref<AutoSaveMode>(getAutoSaveMode())

/**
 * 空仓库(一个画布都没有)时,中央引导卡片是唯一的鼠标入口:
 * 侧栏和状态栏暂时禁用,避免还能点「新建画布 / 返回画布总览」。
 */
const workspaceEmptyModal = computed(
  () => !!workspace.value && !runtime.value && workspace.value.canvases.length === 0
)

/** 全局菜单的 props/事件:状态栏内和选择页悬浮各用一份 */
const globalMenuProps = computed(() => ({
  hasDocument: !!runtime.value,
  hasWorkspace: !!workspace.value,
  readOnly: runtime.value?.readOnly ?? false,
  canSave: !!runtime.value && !runtime.value.readOnly && runtime.value.ui.dirty,
  canUndo: runtime.value?.ui.canUndo ?? false,
  canRedo: runtime.value?.ui.canRedo ?? false,
  canBack: view.value !== 'picker',
  gridVisible: runtime.value?.ui.gridVisible ?? null,
  snap: runtime.value?.ui.snap ?? null,
  showNestedCanvases: nestedCanvases.value,
  autoSaveDelaySec: autoSaveDelaySec.value,
  autoSaveMode: autoSaveMode.value,
  // 仓库画布始终自动保存;临时画布(还没有路径)和落盘后的临时画布也显示这项设置
  showAutoSave: !!workspace.value || autoSaveOn.value || (!!runtime.value && !currentPath.value)
}))

const globalMenuHandlers: Record<string, (...args: unknown[]) => void> = {
  save: () => handleFileAction('save'),
  'export-png': () => handleFileAction('export-png'),
  undo: () => runtime.value?.undo(),
  redo: () => runtime.value?.redo(),
  'toggle-grid': () => toggleGridFromMenu(),
  'toggle-snap': () => toggleSnapFromMenu(),
  'toggle-nested-canvases': () => toggleNestedCanvases(),
  'set-auto-save-delay': value => {
    const seconds = Number(value)
    if (!Number.isFinite(seconds)) return
    setAutoSaveDelayMs(seconds * 1000)
    autoSaveDelaySec.value = autoSaveDelayMs() / 1000
    if (autoSaveMode.value === 'delay' && autoSaveOn.value && dirty.value) scheduleAutoSave()
  },
  'set-auto-save-mode': value => {
    const mode: AutoSaveMode = value === 'off' ? 'off' : 'delay'
    setAutoSaveMode(mode)
    autoSaveMode.value = mode
    if (mode === 'off') {
      cancelAutoSave()
      if (dirty.value) saveStatus.value = 'dirty'
    } else if (autoSaveOn.value && dirty.value) {
      scheduleAutoSave()
    }
  },
  'back-to-overview': () => backToPicker()
}
/** 只有用户主动「新建画布」时才展示模板卡片;打开已有画布/临时画布不弹 */
const showWelcome = ref(false)
const dragging = ref(false)

let busy = false
let dragDepth = 0
/** 窗口关闭确认通过后,放行 beforeunload */
let allowUnload = false
/** 避免用户连点关闭时叠加多个确认弹窗 */
let closePromptOpen = false
let unsubscribeClose: (() => void) | null = null
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
/** 自动保存串行队列:同一时刻只写一次,后到的保存排队读取最新场景 */
let saveChain: Promise<boolean> = Promise.resolve(true)
/** 连续失败只提示一次,避免磁盘满/权限错误时每个停顿都弹气泡 */
let autoSaveErrorNotified = false
let unsubscribeMenu: (() => void) | null = null
let unsubscribeOpen: (() => void) | null = null

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error:\s*/, '')
}

function updateTitle(): void {
  if (view.value === 'picker') {
    document.title = 'iDraw'
    return
  }
  const mark = dirty.value ? '● ' : ''
  if (view.value === 'workspace' && workspace.value) {
    document.title = runtime.value
      ? `${mark}${currentName.value} — ${workspace.value.name} — iDraw`
      : `${workspace.value.name} — iDraw`
    return
  }
  document.title = `${mark}${currentName.value} — iDraw`
}

// ---------- 自动保存 ----------

function cancelAutoSave(): void {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }
}

function scheduleAutoSave(): void {
  if (!autoSaveOn.value || autoSaveMode.value !== 'delay') return
  cancelAutoSave()
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null
    void requestWorkspaceSave()
  }, autoSaveDelayMs())
}

/** 把当前画布最新内容写回仓库;返回是否已经处于已保存状态 */
async function performWorkspaceSave(): Promise<boolean> {
  const rt = runtime.value
  const target = currentPath.value
  if (!rt || !autoSaveOn.value || !target || rt.readOnly) return true
  if (!rt.isDirty()) {
    if (saveStatus.value !== 'saving') saveStatus.value = 'idle'
    return true
  }
  saveStatus.value = 'saving'
  try {
    rt.flush()
    const text = rt.text()
    await api.writeFile(target, text)
    autoSaveErrorNotified = false
    if (runtime.value === rt) {
      rt.markSaved(text)
      dirty.value = rt.isDirty()
      saveStatus.value = dirty.value ? 'dirty' : 'idle'
      updateTitle()
      if (dirty.value) scheduleAutoSave()
    }
    return true
  } catch (err) {
    if (runtime.value === rt) {
      saveStatus.value = 'error'
      if (!autoSaveErrorNotified) {
        autoSaveErrorNotified = true
        notifyError('自动保存', err)
      }
    }
    return false
  }
}

function requestWorkspaceSave(): Promise<boolean> {
  cancelAutoSave()
  const run = saveChain.then(() => performWorkspaceSave())
  saveChain = run.catch(() => false)
  return run
}

/**
 * 关闭窗口前的同步落盘。beforeunload 里等不了 Promise,
 * 自动保存的最后一笔只能走 sendSync;写成功就不必再弹「未保存」确认。
 */
function flushWorkspaceSync(): boolean {
  const rt = runtime.value
  const target = currentPath.value
  if (!rt || !autoSaveOn.value || !target || rt.readOnly) return true
  if (!rt.isDirty()) return true
  // 异步保存还在写盘时不要插队:两次写入的先后无法保证
  if (saveStatus.value === 'saving' || !api.writeFileSync) return false
  try {
    rt.flush()
    const text = rt.text()
    api.writeFileSync(target, text)
    autoSaveErrorNotified = false
    rt.markSaved(text)
    dirty.value = rt.isDirty()
    saveStatus.value = dirty.value ? 'dirty' : 'idle'
    return !dirty.value
  } catch (err) {
    console.error('[iDraw] 关闭前同步保存失败:', err)
    return false
  }
}

// ---------- 文档生命周期 ----------

/** 只清掉当前文档状态,不改视图(调用方决定停在仓库还是回到选择页) */
function clearDocument(): void {
  cancelAutoSave()
  autoSaveErrorNotified = false
  runtime.value?.dispose()
  runtime.value = null
  currentPath.value = null
  currentName.value = '未命名.svg'
  autoSaveOn.value = false
  activeRelPath.value = null
  dirty.value = false
  saveStatus.value = 'idle'
}

function mountDocument(
  text: string,
  path: string | null,
  name: string,
  options: { autoSave: boolean; relPath: string | null; welcome: boolean }
): void {
  cancelAutoSave()
  // 先释放旧运行时:dispose 会把正在编辑的文字收进旧文档,
  // 这时 autoSaveOn 还是旧文档的值,不会误触发新文档的保存
  runtime.value?.dispose()
  runtime.value = null
  cancelAutoSave()
  autoSaveErrorNotified = false
  autoSaveOn.value = options.autoSave
  activeRelPath.value = options.relPath
  showWelcome.value = options.welcome
  const next = createCanvasRuntime({
    path,
    fileName: name,
    text,
    host: desktopHost,
    onDirtyChange: value => {
      dirty.value = value
      if (value) {
        saveStatus.value = 'dirty'
        if (autoSaveOn.value) scheduleAutoSave()
      } else if (saveStatus.value !== 'saving') {
        saveStatus.value = 'idle'
      }
      updateTitle()
    }
  })
  runtime.value = next
  currentPath.value = path
  currentName.value = name
  dirty.value = false
  saveStatus.value = 'idle'
  view.value = options.autoSave ? 'workspace' : 'standalone'
  docKey.value += 1
  updateTitle()
}

/** 有未保存改动时先问用户;返回 false 表示用户取消了当前操作 */
async function canLeave(): Promise<boolean> {
  // 先把正在编辑的文字/拖拽收进文档,再判断脏标记
  runtime.value?.flush()
  if (autoSaveOn.value && autoSaveMode.value === 'delay' && runtime.value) {
    // 自动保存开启时,有文件落点的画布先尝试落盘,失败才走「保存 / 不保存 / 取消」
    const saved = await requestWorkspaceSave()
    if (saved && !dirty.value) return true
  }
  if (!dirty.value) return true
  const choice = await showDialog({
    title: '未保存的修改',
    message: `是否保存对“${currentName.value}”的修改？`,
    detail: '如果不保存，这些修改会丢失。',
    icon: 'warning',
    buttons: [
      { label: '取消', value: 'cancel' },
      { label: '不保存', value: 'discard', kind: 'danger' },
      { label: '保存', value: 'save', kind: 'primary' }
    ],
    cancelValue: 'cancel'
  })
  if (choice === 'cancel') return false
  if (choice === 'discard') return true
  return save(false)
}

async function save(saveAs: boolean): Promise<boolean> {
  const rt = runtime.value
  if (!rt) return false
  if (rt.readOnly) {
    pushNotice('外部 SVG 为只读预览，不能保存。')
    return false
  }

  if (autoSaveOn.value) {
    if (!saveAs) return requestWorkspaceSave()
    // 仓库画布的「另存为」只是导出一份副本,不改变当前画布在仓库里的身份
    if (busy) return false
    busy = true
    try {
      rt.flush()
      const text = rt.text()
      const target = await api.saveFileDialog({
        defaultName: currentName.value,
        defaultDir: currentPath.value ? dirNameOf(currentPath.value) : workspace.value?.dir,
        kind: 'svg'
      })
      if (!target) return false
      await api.writeFile(target, text)
      pushNotice(`已另存为：${fileNameOf(target)}`)
      return true
    } catch (err) {
      notifyError('另存为', err)
      return false
    } finally {
      busy = false
    }
  }

  if (busy) return false
  // 临时画布第一次手动落盘后,后续编辑也自动写回这个文件
  const wasTemporary = !currentPath.value
  busy = true
  try {
    rt.flush()
    const text = rt.text()
    let target = currentPath.value
    if (!target || saveAs) {
      target = await api.saveFileDialog({
        defaultName: currentName.value,
        defaultDir: currentPath.value ? dirNameOf(currentPath.value) : undefined,
        kind: 'svg'
      })
      if (!target) return false
    }
    await api.writeFile(target, text)
    rt.markSaved(text)
    currentPath.value = target
    currentName.value = fileNameOf(target)
    rt.setPath(target, currentName.value)
    if (wasTemporary) autoSaveOn.value = true
    dirty.value = rt.isDirty()
    saveStatus.value = dirty.value ? 'dirty' : 'idle'
    updateTitle()
    // 手动保存后这张画布也进入「最近打开」,下次启动页可以直接点开
    try {
      await workspaceApi.touchFile(target)
    } catch (err) {
      console.error('[iDraw] 更新最近打开失败:', err)
    }
    return true
  } catch (err) {
    saveStatus.value = 'error'
    notifyError('保存', err)
    return false
  } finally {
    busy = false
  }
}

// ---------- 仓库 ----------

async function refreshWorkspace(silent = false): Promise<void> {
  const info = workspace.value
  if (!info) return
  try {
    workspace.value = await workspaceApi.read(info.dir, { recursive: nestedCanvases.value })
    updateTitle()
  } catch (err) {
    if (silent) console.error('[iDraw] 刷新仓库失败:', err)
    else notifyError('刷新仓库', err)
  }
}

async function openWorkspace(dir: string): Promise<void> {
  if (busy) return
  if (!(await canLeave())) return
  busy = true
  let info: WorkspaceInfo
  try {
    info = await workspaceApi.read(dir, { recursive: nestedCanvases.value })
  } catch (err) {
    notifyError('打开仓库', err)
    busy = false
    return
  }
  busy = false
  // 最近列表只是便利功能,写不进去不影响打开仓库
  try {
    await workspaceApi.touchWorkspace(info.dir)
  } catch (err) {
    console.error('[iDraw] 更新最近打开失败:', err)
  }
  workspace.value = info
  view.value = 'workspace'
  clearDocument()
  updateTitle()
  if (info.canvases[0]) await openWorkspaceCanvas(info.canvases[0])
}

async function openWorkspaceCanvas(
  entry: WorkspaceCanvasEntry,
  welcome = false
): Promise<void> {
  const info = workspace.value
  if (!info) return
  if (activeRelPath.value === entry.relPath && runtime.value) return
  if (!(await canLeave())) return
  try {
    const path = joinPath(info.dir, entry.relPath)
    const text = await api.readFile(path)
    mountDocument(text, path, entry.name, {
      autoSave: true,
      relPath: entry.relPath,
      welcome
    })
  } catch (err) {
    notifyError('打开画布', err)
  }
}

async function openStandalonePath(path: string): Promise<void> {
  if (busy) return
  if (!(await canLeave())) return
  try {
    const text = await api.readFile(path)
    // 先记入最近打开,用户马上返回选择页时也能看到这张画的缩略图
    try {
      await workspaceApi.touchFile(path)
    } catch (err) {
      console.error('[iDraw] 更新最近打开失败:', err)
    }
    workspace.value = null
    mountDocument(text, path, fileNameOf(path), {
      autoSave: false,
      relPath: null,
      welcome: false
    })
  } catch (err) {
    notifyError('打开文件', err)
  }
}

/** 拖入/双击带来的路径:在当前仓库里就当作仓库画布打开,否则按单独文件打开 */
async function openPathSmart(path: string): Promise<void> {
  const info = workspace.value
  if (info) {
    const rel = relativePathOf(info.dir, path)
    if (rel) {
      const relPath = rel.replace(/\\/g, '/')
      await refreshWorkspace(true)
      const entry = workspace.value?.canvases.find(item => item.relPath === relPath)
      await openWorkspaceCanvas(entry ?? { relPath, name: fileNameOf(path) })
      return
    }
  }
  await openStandalonePath(path)
}

function openTemporary(): void {
  void (async () => {
    if (busy) return
    if (!(await canLeave())) return
    workspace.value = null
    mountDocument(BLANK_SVG, null, '未命名.svg', {
      autoSave: false,
      relPath: null,
      // 从选择页进入临时画布时也先展示空白/模板选择
      welcome: true
    })
  })()
}

function newDocument(): void {
  void (async () => {
    if (busy) return
    if (view.value === 'picker') return
    if (view.value === 'workspace') {
      const info = workspace.value
      if (!info) return
      // 画布工具栏的「新建画布」:用默认名称建一个文件,并弹出空白/模板选择
      const result = await createCanvasInWorkspace(nextCanvasName(info.canvases))
      if (!result.ok && !result.cancelled) pushNotice(result.error ?? '新建画布失败', 'error')
      return
    }
    if (!(await canLeave())) return
    mountDocument(BLANK_SVG, null, '未命名.svg', {
      autoSave: false,
      relPath: null,
      welcome: true
    })
  })()
}

function backToPicker(): void {
  void (async () => {
    if (busy) return
    if (!(await canLeave())) return
    clearDocument()
    workspace.value = null
    view.value = 'picker'
    updateTitle()
  })()
}

// ---------- 仓库内的文件操作 ----------

async function createCanvasInWorkspace(name: string): Promise<CanvasMutationResult> {
  const info = workspace.value
  if (!info) return { ok: false, error: '没有打开的仓库' }
  try {
    const entry = await workspaceApi.createCanvas(info.dir, name, BLANK_SVG)
    await refreshWorkspace()
    await openWorkspaceCanvas(entry, true)
    return { ok: true, entry }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

async function renameCanvasInWorkspace(
  entry: WorkspaceCanvasEntry,
  name: string
): Promise<CanvasMutationResult> {
  const info = workspace.value
  if (!info) return { ok: false, error: '没有打开的仓库' }
  const rt = runtime.value
  const wasActive = activeRelPath.value === entry.relPath
  try {
    if (wasActive) {
      // 先把写盘队列排空,避免重命名后又有一个旧路径的自动保存把文件写回来。
      // 写盘期间又改了内容时再排一次,最多三轮;还脏就放弃这次重命名。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const saved = await requestWorkspaceSave()
        if (!saved) return { ok: false, error: '自动保存失败，暂时不能重命名' }
        if (!dirty.value) break
      }
      if (dirty.value) return { ok: false, error: '画布还在修改中，请稍后再重命名' }
      // 写盘过程中可能又排了一个自动保存定时器
      cancelAutoSave()
    }
    const next = await workspaceApi.renameCanvas(info.dir, entry.relPath, name)
    await refreshWorkspace()
    if (wasActive && rt && runtime.value === rt && activeRelPath.value === entry.relPath) {
      const path = joinPath(info.dir, next.relPath)
      activeRelPath.value = next.relPath
      currentPath.value = path
      currentName.value = next.name
      rt.setPath(path, next.name)
      updateTitle()
    }
    return { ok: true, entry: next }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

async function deleteCanvasInWorkspace(entry: WorkspaceCanvasEntry): Promise<CanvasMutationResult> {
  const info = workspace.value
  if (!info) return { ok: false, error: '没有打开的仓库' }
  const choice = await showDialog({
    title: '删除画布',
    message: `删除“${entry.name}”？`,
    detail: '文件会移到系统回收站，可以从回收站恢复。',
    icon: 'warning',
    buttons: [
      { label: '取消', value: 'cancel' },
      { label: '移到回收站', value: 'delete', kind: 'danger' }
    ],
    cancelValue: 'cancel'
  })
  if (choice !== 'delete') return { ok: false, cancelled: true }

  const deletingActive = activeRelPath.value === entry.relPath
  try {
    if (deletingActive) {
      // 停掉定时器,并等正在写的自动保存结束,避免删除之后又被写回来
      cancelAutoSave()
      await saveChain.catch(() => undefined)
      // 正在写的那次保存如果又检测到脏,会重新排一个定时器
      cancelAutoSave()
    }
    await workspaceApi.deleteCanvas(info.dir, entry.relPath)
    if (deletingActive) {
      clearDocument()
      updateTitle()
    }
    await refreshWorkspace()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

// ---------- 菜单 / 拖放 ----------

function openDialog(): void {
  void (async () => {
    if (busy) return
    try {
      const path = await api.openFileDialog()
      if (path) await openPathSmart(path)
    } catch (err) {
      notifyError('打开文件', err)
    }
  })()
}

function handleFileAction(action: 'new' | 'open' | 'save' | 'export-png' | 'back'): void {
  if (action === 'new') newDocument()
  else if (action === 'open') openDialog()
  else if (action === 'save') void save(false)
  else if (action === 'export-png') void runtime.value?.exportPng()
  else backToPicker()
}

/** 设置面板里的编辑器开关:只作用于当前画布 */
function toggleNestedCanvases(): void {
  nestedCanvases.value = !nestedCanvases.value
  setNestedCanvasesEnabled(nestedCanvases.value)
  // 当前正打开着仓库时立即按新偏好重扫一遍
  if (workspace.value) void refreshWorkspace()
}

function toggleGridFromMenu(): void {
  const rt = runtime.value
  if (rt) rt.setGridVisible(!rt.ui.gridVisible)
}

function toggleSnapFromMenu(): void {
  const rt = runtime.value
  if (rt) rt.setSnap(!rt.ui.snap)
}

function handleMenuCommand(command: MenuCommand): void {
  // 选择页没有文档:除了「打开文件」与「重新加载」,文件/编辑命令一律忽略
  if (view.value === 'picker' && command !== 'file:open' && command !== 'app:reload') return
  const rt = runtime.value
  switch (command) {
    case 'file:new':
      newDocument()
      break
    case 'file:open':
      openDialog()
      break
    case 'file:open-workspace':
      backToPicker()
      break
    case 'file:save':
      void save(false)
      break
    case 'file:save-as':
      void save(true)
      break
    case 'file:export-png':
      void rt?.exportPng()
      break
    case 'edit:undo':
      rt?.undo()
      break
    case 'edit:redo':
      rt?.redo()
      break
    case 'edit:select-all':
      rt?.selectAll()
      break
    case 'edit:delete':
      rt?.deleteSelection()
      break
    case 'app:reload':
      void reloadApp()
      break
  }
}

/** 重新加载:走主题化确认弹窗,而不是原生 beforeunload 对话框 */
async function reloadApp(): Promise<void> {
  if (busy) return
  if (!(await canLeave())) return
  allowUnload = true
  location.reload()
}

/**
 * 主进程拦截窗口关闭后调用。
 * 仓库画布先同步落盘;其余有未保存修改的画布用主题化弹窗确认。
 */
async function handleWindowClose(): Promise<void> {
  if (closePromptOpen) return
  runtime.value?.flush()
  if (
    autoSaveOn.value &&
    autoSaveMode.value === 'delay' &&
    runtime.value &&
    flushWorkspaceSync()
  ) {
    allowUnload = true
    api.confirmClose?.(true)
    return
  }
  if (!dirty.value) {
    allowUnload = true
    api.confirmClose?.(true)
    return
  }
  closePromptOpen = true
  try {
    const choice = await showDialog({
      title: '当前画布有未保存的修改',
      message: `“${currentName.value}”尚未保存。`,
      detail: '关闭后这些修改会丢失。',
      icon: 'warning',
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '放弃修改并退出', value: 'discard', kind: 'danger' },
        { label: '保存', value: 'save', kind: 'primary' }
      ],
      cancelValue: 'cancel'
    })
    if (choice === 'discard') {
      allowUnload = true
      api.confirmClose?.(true)
    } else if (choice === 'save') {
      const saved = await save(false)
      if (saved) {
        allowUnload = true
        api.confirmClose?.(true)
      }
    }
  } finally {
    closePromptOpen = false
  }
}

function onDragEnter(e: DragEvent): void {
  if (!e.dataTransfer?.types.includes('Files')) return
  dragDepth += 1
  dragging.value = true
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDrop(e: DragEvent): void {
  dragDepth = 0
  dragging.value = false
  const file = e.dataTransfer?.files[0]
  if (!file) return
  const path = api.getPathForFile(file)
  if (!path) return
  if (!/\.svg$/i.test(path)) {
    pushNotice('只能打开 .svg 画布文件。')
    return
  }
  void openPathSmart(path)
}

function beforeUnload(e: BeforeUnloadEvent): void {
  // 自定义关闭/重载流程已经确认过,直接放行
  if (allowUnload) return
  // 正在编辑的文字/拖拽先收进文档,否则脏标记可能还没亮起来
  runtime.value?.flush()
  if (!dirty.value) return
  // 自动保存的画布先同步落盘;成功就直接关闭,不弹「未保存」确认
  if (autoSaveOn.value && autoSaveMode.value === 'delay' && flushWorkspaceSync()) return
  e.preventDefault()
  e.returnValue = ''
}

function onWindowBlur(): void {
  if (autoSaveOn.value && autoSaveMode.value === 'delay' && dirty.value) {
    void requestWorkspaceSave()
  }
}

function onWindowFocus(): void {
  if (view.value === 'workspace' && workspace.value) void refreshWorkspace(true)
}

/** 空仓库(还没打开画布)时,Esc 返回画布总览;菜单/弹窗打开时先让它们处理 */
function onWorkspaceEmptyKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (!workspace.value || runtime.value) return
  if (document.querySelector('.idraw-corner-menu, [role="dialog"]')) return
  backToPicker()
}

onMounted(() => {
  document.title = 'iDraw'
  unsubscribeMenu = api.onMenuCommand(handleMenuCommand)
  unsubscribeOpen = api.onOpenFile(path => void openPathSmart(path))
  unsubscribeClose = api.onCloseRequested?.(() => void handleWindowClose()) ?? null
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('keydown', onWorkspaceEmptyKeydown)
  void api.takePendingOpenFile().then(path => {
    // 双击文件启动时直接打开它,不经过仓库选择页
    if (path) void openStandalonePath(path)
  })
})

onBeforeUnmount(() => {
  unsubscribeMenu?.()
  unsubscribeOpen?.()
  unsubscribeClose?.()
  window.removeEventListener('beforeunload', beforeUnload)
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('keydown', onWorkspaceEmptyKeydown)
  clearDocument()
})
</script>

<template>
  <div
    class="idraw-app"
    :class="{
      'has-workspace': !!workspace,
      'sidebar-collapsed': !!workspace && sidebarCollapsed,
      'workspace-empty-modal': workspaceEmptyModal
    }"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <WorkspacePicker
      v-if="view === 'picker'"
      @open-workspace="openWorkspace"
      @temporary="openTemporary"
      @open-file="openStandalonePath"
    />

    <template v-else>
      <div class="idraw-body">
        <WorkspaceSidebar
          v-if="workspace"
          :info="workspace"
          :active-rel-path="activeRelPath"
          :active-dirty="dirty"
          :active-saving="saveStatus === 'saving'"
          :collapsed="sidebarCollapsed"
          :create-canvas="createCanvasInWorkspace"
          :rename-canvas="renameCanvasInWorkspace"
          :delete-canvas="deleteCanvasInWorkspace"
          @open="openWorkspaceCanvas"
          @refresh="refreshWorkspace()"
          @toggle-collapse="sidebarCollapsed = !sidebarCollapsed"
        />

        <div class="idraw-stage">
          <CanvasPane
            v-if="runtime"
            :key="docKey"
            :runtime="runtime"
            :welcome="showWelcome"
            :show-back="!workspace"
            @file-action="handleFileAction"
          />
          <div v-else-if="workspace" class="workspace-empty">
            <div class="workspace-empty-card">
              <span class="workspace-empty-icon"><LayoutGrid :size="26" /></span>
              <h2>{{ workspace.name }}</h2>
              <p v-if="workspace.canvases.length">从左侧选择一张画布，或新建一张。</p>
              <p v-else>这个仓库里还没有画布。新建的画布会保存在此文件夹，编辑后自动保存。</p>
              <button class="workspace-empty-btn" @click="newDocument()">
                <FilePlus2 :size="16" />
                新建画布
              </button>
            </div>
          </div>
        </div>
      </div>

      <StatusBar
        :workspace-name="workspace?.name ?? null"
        :doc-name="runtime ? currentName : null"
        :auto-save="autoSaveOn && autoSaveMode === 'delay'"
        :has-path="!!currentPath"
        :read-only="runtime?.readOnly ?? false"
        :status="saveStatus"
      >
        <template #actions>
          <GlobalMenu inline v-bind="globalMenuProps" v-on="globalMenuHandlers" />
        </template>
      </StatusBar>
    </template>

    <!-- 仓库选择页没有状态栏,左下角只保留深色/浅色主题切换;
         设置入口在打开画布后的状态栏菜单里 -->
    <ThemeToggle v-if="view === 'picker'" />
    <WindowControls v-if="showWindowControls" />
    <ThemedDialogHost />

    <div class="idraw-toasts" aria-live="polite">
      <button
        v-for="toast in toasts.list"
        :key="toast.id"
        class="idraw-toast"
        :class="toast.level"
        type="button"
        @click="dismissToast(toast.id)"
      >
        {{ toast.message }}
      </button>
    </div>

    <div v-if="dragging" class="idraw-drop">
      <div class="idraw-drop-card">松开以打开 SVG 画布</div>
    </div>
  </div>
</template>
