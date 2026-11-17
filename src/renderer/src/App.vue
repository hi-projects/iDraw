<script setup lang="ts">
/**
 * iDraw 的整个应用外壳。
 *
 * 一份文档一个 CanvasRuntime:新建/打开/另存为时重建运行时,CanvasPane 用
 * `:key` 跟着重建。这里只负责文件生命周期(新建/打开/保存/另存为/导出)、
 * 窗口标题、未保存确认和菜单命令路由;画布本身不知道文件系统。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import CanvasPane from './components/CanvasPane.vue'
import CanvasWelcome from '../../editor/CanvasWelcome.vue'
import { createCanvasRuntime, type CanvasRuntime } from '../../engine/runtime'
import { emptyDoc } from '../../engine/model'
import { serializeCanvas } from '../../engine/serialize'
import { TEMPLATES, templateDoc } from '../../engine/templates'
import { api, type MenuCommand } from '../../host/windowApi'
import { dismissToast, notifyError, pushNotice, toasts } from '../../editor/notice'
import { dirNameOf, fileNameOf } from '@shared/path'
import { desktopHost } from './host'

const BLANK_SVG = serializeCanvas(emptyDoc())

const runtime = shallowRef<CanvasRuntime | null>(null)
const docKey = ref(0)
const dirty = ref(false)
const dragging = ref(false)

let currentPath: string | null = null
let currentName = '未命名.svg'
let busy = false
let dragDepth = 0
let unsubscribeMenu: (() => void) | null = null
let unsubscribeOpen: (() => void) | null = null

function updateTitle(): void {
  document.title = `${dirty.value ? '● ' : ''}${currentName} — iDraw`
}

function mountDocument(text: string, path: string | null, name: string): void {
  runtime.value?.dispose()
  const next = createCanvasRuntime({
    path,
    fileName: name,
    text,
    host: desktopHost,
    onDirtyChange: value => {
      dirty.value = value
      updateTitle()
    }
  })
  runtime.value = next
  currentPath = path
  currentName = name
  dirty.value = false
  docKey.value += 1
  updateTitle()
}

/** 有未保存改动时先问用户;返回 false 表示用户取消了当前操作 */
async function canLeave(): Promise<boolean> {
  if (!dirty.value) return true
  const choice = await api.confirmDiscard(currentName)
  if (choice === 'cancel') return false
  if (choice === 'discard') return true
  return save(false)
}

/** 回到启动页:此时什么都不存在,由用户选择「空白画布」或模板后再真正创建 */
function newDocument(): void {
  void (async () => {
    if (busy || !(await canLeave())) return
    runtime.value?.dispose()
    runtime.value = null
    currentPath = null
    currentName = '未命名.svg'
    dirty.value = false
    document.title = 'iDraw'
  })()
}

function createBlankDocument(): void {
  mountDocument(BLANK_SVG, null, '未命名.svg')
}

function createFromTemplate(kind: 'flowchart' | 'gantt'): void {
  const info = TEMPLATES.find(t => t.kind === kind)
  mountDocument(serializeCanvas(templateDoc(kind)), null, `${info?.title ?? '画布'}.svg`)
}

function notifyTemplateCommunity(): void {
  pushNotice('模板社区正在设计中，敬请期待。')
}

async function save(saveAs: boolean): Promise<boolean> {
  const rt = runtime.value
  if (!rt) return false
  if (rt.readOnly) {
    pushNotice('外部 SVG 为只读预览，不能保存。')
    return false
  }
  if (busy) return false
  busy = true
  try {
    rt.flush()
    const text = rt.text()
    let target = currentPath
    if (!target || saveAs) {
      target = await api.saveFileDialog({
        defaultName: currentName,
        defaultDir: currentPath ? dirNameOf(currentPath) : undefined,
        kind: 'svg'
      })
      if (!target) return false
    }
    await api.writeFile(target, text)
    rt.markSaved(text)
    currentPath = target
    currentName = fileNameOf(target)
    rt.setPath(target, currentName)
    dirty.value = rt.isDirty()
    updateTitle()
    return true
  } catch (err) {
    notifyError('保存', err)
    return false
  } finally {
    busy = false
  }
}

async function openPath(path: string): Promise<void> {
  if (busy || !(await canLeave())) return
  try {
    const text = await api.readFile(path)
    mountDocument(text, path, fileNameOf(path))
  } catch (err) {
    notifyError('打开文件', err)
  }
}

function openDialog(): void {
  void (async () => {
    if (busy) return
    const path = await api.openFileDialog()
    if (path) await openPath(path)
  })()
}

async function exportPng(): Promise<void> {
  const rt = runtime.value
  if (!rt) return
  if (rt.readOnly) {
    pushNotice('外部 SVG 为只读预览，无法导出。')
    return
  }
  try {
    await rt.exportPng()
  } catch (err) {
    notifyError('导出 PNG', err)
  }
}

function handleFileAction(action: 'new' | 'open' | 'save'): void {
  if (action === 'new') newDocument()
  else if (action === 'open') openDialog()
  else void save(false)
}

function handleMenuCommand(command: MenuCommand): void {
  const rt = runtime.value
  switch (command) {
    case 'file:new':
      newDocument()
      break
    case 'file:open':
      openDialog()
      break
    case 'file:save':
      void save(false)
      break
    case 'file:save-as':
      void save(true)
      break
    case 'file:export-png':
      void exportPng()
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
  void openPath(path)
}

function beforeUnload(e: BeforeUnloadEvent): void {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

onMounted(() => {
  // 启动时不创建文档:停留在纯白的启动页,等用户选择空白画布或模板
  document.title = 'iDraw'
  unsubscribeMenu = api.onMenuCommand(handleMenuCommand)
  unsubscribeOpen = api.onOpenFile(path => void openPath(path))
  window.addEventListener('beforeunload', beforeUnload)
  void api.takePendingOpenFile().then(path => {
    if (path) void openPath(path)
  })
})

onBeforeUnmount(() => {
  unsubscribeMenu?.()
  unsubscribeOpen?.()
  window.removeEventListener('beforeunload', beforeUnload)
  runtime.value?.dispose()
  runtime.value = null
})
</script>

<template>
  <div
    class="idraw-app"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <CanvasPane
      v-if="runtime"
      :key="docKey"
      :runtime="runtime"
      @file-action="handleFileAction"
    />
    <CanvasWelcome
      v-else
      @blank="createBlankDocument"
      @template="createFromTemplate"
      @import="notifyTemplateCommunity"
    />

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
