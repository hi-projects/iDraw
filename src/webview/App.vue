<script setup lang="ts">
/**
 * iMark 插件的应用外壳。
 *
 * 与独立版分离:这里不提供窗口标题、原生菜单和拖放打开,只负责把画布运行时的
 * 文件状态上报给 iMark,并响应 iMark 转来的菜单命令。画布引擎与编辑本体来自
 * `src/engine` / `src/editor`,两边共用同一份实现。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import CanvasToolbar from './CanvasToolbar.vue'
import CanvasView from '../editor/CanvasView.vue'
import { createCanvasRuntime, type CanvasRuntime } from '../engine/runtime'
import { emptyDoc } from '../engine/model'
import { serializeCanvas } from '../engine/serialize'
import { api, type MenuCommand } from '../host/windowApi'
import { dismissToast, notifyError, pushNotice, toasts } from '../editor/notice'
import { dirNameOf, fileNameOf } from '@shared/path'
import { imarkHost } from './host'

const BLANK_SVG = serializeCanvas(emptyDoc())

const runtime = shallowRef<CanvasRuntime | null>(null)
const docKey = ref(0)
const dirty = ref(false)

let currentPath: string | null = null
let currentName = '未命名.svg'
let busy = false
let reportTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeMenu: (() => void) | null = null
let unsubscribeOpen: (() => void) | null = null
let unsubscribeNew: (() => void) | null = null

function updateTitle(): void {
  scheduleReport()
}

function reportDocument(withText: boolean): void {
  if (!api.reportDocument) return
  const rt = runtime.value
  let text: string | undefined
  if (withText && dirty.value && rt && !rt.readOnly) {
    try {
      rt.flush()
      text = rt.text()
    } catch {
      text = undefined
    }
  }
  api.reportDocument({ path: currentPath, name: currentName, dirty: dirty.value, text })
}

/**
 * 立即同步文件身份与脏标记;正文文本延迟上报,避免每一步操作都序列化整张画布。
 * 关闭面板/页面卸载时会再发一次带文本的版本(见 beforeUnload)。
 */
function scheduleReport(): void {
  if (!api.reportDocument) return
  reportDocument(false)
  if (reportTimer) {
    clearTimeout(reportTimer)
    reportTimer = null
  }
  if (!dirty.value) return
  reportTimer = setTimeout(() => {
    reportTimer = null
    reportDocument(true)
  }, 1200)
}

function mountDocument(text: string, path: string | null, name: string): void {
  runtime.value?.dispose()
  const next = createCanvasRuntime({
    path,
    fileName: name,
    text,
    host: imarkHost,
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

/** 名称已由宿主问过:先写一张空白骨架,文件从创建那一刻就存在(与新建文件一致) */
async function createAt(path: string): Promise<void> {
  busy = true
  try {
    await api.writeFile(path, BLANK_SVG)
    mountDocument(BLANK_SVG, path, fileNameOf(path))
  } catch (err) {
    notifyError('新建画布', err)
  } finally {
    busy = false
  }
}

function newDocument(): void {
  void (async () => {
    if (busy || !(await canLeave())) return
    // 插件里先弹名称输入框,确认后才建画布;独立版仍是未命名画布 + 保存时选路径
    if (api.newCanvasDialog) {
      const path = await api.newCanvasDialog()
      if (path) await createAt(path)
      return
    }
    mountDocument(BLANK_SVG, null, '未命名.svg')
  })()
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
  await rt.exportPng()
}

/** 插件 webview 没有 Electron 菜单,把 iMark 菜单的快捷键补在页面内 */
function onKeydown(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const key = e.key.toLowerCase()
  if (key === 's') {
    e.preventDefault()
    void save(e.shiftKey)
  } else if (key === 'o') {
    e.preventDefault()
    openDialog()
  } else if (key === 'n' && !e.shiftKey) {
    e.preventDefault()
    newDocument()
  } else if (key === 'e' && e.shiftKey) {
    e.preventDefault()
    void exportPng()
  }
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

function beforeUnload(e: BeforeUnloadEvent): void {
  // 宿主关闭面板/应用时,iframe 可能不会得到第二次机会;先同步交出最新文本
  reportDocument(true)
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

onMounted(() => {
  mountDocument(BLANK_SVG, null, '未命名.svg')
  unsubscribeMenu = api.onMenuCommand(handleMenuCommand)
  unsubscribeOpen = api.onOpenFile(path => void openPath(path))
  unsubscribeNew =
    api.onNewFile?.(path => {
      void (async () => {
        if (busy || !(await canLeave())) return
        await createAt(path)
      })()
    }) ?? null
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('keydown', onKeydown)
  void api.takePendingOpenFile().then(path => {
    if (path) void openPath(path)
  })
})

onBeforeUnmount(() => {
  if (reportTimer) clearTimeout(reportTimer)
  reportDocument(true)
  unsubscribeMenu?.()
  unsubscribeOpen?.()
  unsubscribeNew?.()
  window.removeEventListener('beforeunload', beforeUnload)
  window.removeEventListener('keydown', onKeydown)
  runtime.value?.dispose()
  runtime.value = null
})
</script>

<template>
  <div class="imark-app">
    <div v-if="runtime" :key="docKey" class="canvas-pane" data-idraw-canvas-pane>
      <CanvasToolbar v-if="!runtime.readOnly" :runtime="runtime" />
      <CanvasView :runtime="runtime" />
    </div>
    <div v-else class="idraw-loading">正在准备画布…</div>

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
  </div>
</template>
