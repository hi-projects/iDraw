<script setup lang="ts">
/**
 * 仓库侧栏:仓库信息、画布列表,以及新建/重命名/删除入口。
 *
 * 真正的文件操作通过 props 里的回调交给 App —— 在重命名/删除当前画布前,
 * App 需要先把自动保存的写盘队列排空,侧栏只负责界面与输入校验。
 */
import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  type ComponentPublicInstance
} from 'vue'
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  FileImage,
  FilePlus2,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2
} from 'lucide-vue-next'
import type { WorkspaceCanvasEntry, WorkspaceInfo } from '@shared/api'
import { pushNotice } from '../../../editor/notice'
import { nextCanvasName, type CanvasMutationResult } from '../workspaceTypes'

const props = defineProps<{
  info: WorkspaceInfo
  activeRelPath: string | null
  activeDirty: boolean
  activeSaving: boolean
  /** 目录侧栏是否收起 */
  collapsed: boolean
  createCanvas: (name: string) => Promise<CanvasMutationResult>
  renameCanvas: (entry: WorkspaceCanvasEntry, name: string) => Promise<CanvasMutationResult>
  deleteCanvas: (entry: WorkspaceCanvasEntry) => Promise<CanvasMutationResult>
}>()

const emit = defineEmits<{
  (e: 'open', entry: WorkspaceCanvasEntry): void
  (e: 'refresh'): void
  (e: 'toggle-collapse'): void
}>()

const INVALID_NAME = /[\\/:*?"<>|]/
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

const creating = ref(false)
const createName = ref('')
const createError = ref('')
const createBusy = ref(false)
const createInput = ref<HTMLInputElement | null>(null)
const createEditor = ref<HTMLElement | null>(null)
/** 点击新建时填入的默认名称,用来判断用户是否真的改了名字 */
const createDefaultName = ref('')

const renaming = ref<string | null>(null)
const renameName = ref('')
const renameError = ref('')
const renameBusy = ref(false)
const renameInput = ref<HTMLInputElement | null>(null)

function baseNameOf(entry: WorkspaceCanvasEntry): string {
  return entry.name.replace(/\.svg$/i, '')
}

function dirOf(entry: WorkspaceCanvasEntry): string {
  const i = entry.relPath.lastIndexOf('/')
  return i >= 0 ? entry.relPath.slice(0, i) : ''
}

function defaultNewName(): string {
  return nextCanvasName(props.info.canvases)
}

function validateName(raw: string): string | null {
  const name = raw.trim().replace(/\.svg$/i, '')
  if (!name) return '请输入画布名称'
  if (name.startsWith('.') || INVALID_NAME.test(name)) {
    return '名称不能包含 \\ / : * ? " < > | 等字符'
  }
  if (RESERVED_NAME.test(`${name}.svg`)) return '这个名称被系统保留，请换一个'
  return null
}

// ---------- 新建 ----------

function beginCreate(): void {
  if (creating.value) {
    createInput.value?.focus()
    createInput.value?.select()
    return
  }
  cancelRename()
  creating.value = true
  const initial = defaultNewName()
  createDefaultName.value = initial
  createName.value = initial
  createError.value = ''
  void nextTick(() => {
    createInput.value?.focus()
    createInput.value?.select()
  })
}

function cancelCreate(): void {
  creating.value = false
  createError.value = ''
}

/**
 * 输入框打开时点别处:
 * - 名字仍是默认的 → 取消;
 * - 已经改成其它有效名字 → 当作确认,直接创建文件,让点击继续落到目标上。
 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!creating.value || createBusy.value) return
  const target = event.target
  if (!(target instanceof Node)) return
  if (createEditor.value?.contains(target)) return
  const element = target instanceof Element ? target : target.parentElement
  if (element?.closest('[data-action="workspace-new-canvas"]')) return
  // 点到其它按钮/画布行:让它执行自己的动作,不要顺手再建一个文件
  if (element?.closest('button, .workspace-canvas-row')) {
    cancelCreate()
    return
  }

  const name = createName.value.trim().replace(/\.svg$/i, '')
  if (name !== createDefaultName.value && !validateName(createName.value)) {
    void submitCreate()
    return
  }
  cancelCreate()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})

function openEntry(entry: WorkspaceCanvasEntry): void {
  cancelCreate()
  emit('open', entry)
}

async function submitCreate(): Promise<void> {
  if (createBusy.value) return
  const error = validateName(createName.value)
  if (error) {
    createError.value = error
    return
  }
  createBusy.value = true
  createError.value = ''
  try {
    const result = await props.createCanvas(createName.value.trim().replace(/\.svg$/i, ''))
    if (!result.ok) {
      createError.value = result.error ?? '创建失败'
      return
    }
    creating.value = false
  } finally {
    createBusy.value = false
  }
}

// ---------- 重命名 ----------

function setRenameInput(el: Element | ComponentPublicInstance | null): void {
  renameInput.value = el instanceof HTMLInputElement ? el : null
}

function beginRename(entry: WorkspaceCanvasEntry): void {
  if (renaming.value === entry.relPath) return
  creating.value = false
  renaming.value = entry.relPath
  renameName.value = baseNameOf(entry)
  renameError.value = ''
  void nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}

function cancelRename(): void {
  renaming.value = null
  renameError.value = ''
}

async function submitRename(entry: WorkspaceCanvasEntry): Promise<void> {
  if (renameBusy.value) return
  const error = validateName(renameName.value)
  if (error) {
    renameError.value = error
    return
  }
  const nextName = renameName.value.trim().replace(/\.svg$/i, '')
  if (nextName === baseNameOf(entry)) {
    cancelRename()
    return
  }
  renameBusy.value = true
  renameError.value = ''
  try {
    const result = await props.renameCanvas(entry, nextName)
    if (!result.ok) {
      renameError.value = result.error ?? '重命名失败'
      return
    }
    renaming.value = null
  } finally {
    renameBusy.value = false
  }
}

function onRenameBlur(): void {
  if (!renameBusy.value && !renameError.value) cancelRename()
}

// ---------- 删除 ----------

async function removeEntry(entry: WorkspaceCanvasEntry): Promise<void> {
  const result = await props.deleteCanvas(entry)
  if (!result.ok && !result.cancelled) {
    pushNotice(result.error ?? '删除画布失败', 'error')
  }
}

</script>

<template>
  <aside class="workspace-sidebar" :class="{ collapsed }">
    <!-- 顶部不再单独放仓库名/路径,首行就是「新建画布」+ 刷新 -->
    <div class="workspace-sidebar-actions">
      <button
        class="workspace-new-canvas"
        data-action="workspace-new-canvas"
        title="新建画布"
        @click="beginCreate"
      >
        <FilePlus2 :size="15" />
        新建画布
      </button>
      <button
        class="workspace-icon-btn"
        title="刷新画布列表"
        data-action="workspace-refresh"
        @click="emit('refresh')"
      >
        <RefreshCw :size="14" />
      </button>
    </div>

    <div class="workspace-canvas-list">
      <div v-if="creating" ref="createEditor" class="workspace-canvas-editor">
        <FileImage :size="15" class="workspace-canvas-icon" />
        <span class="workspace-name-box">
          <input
            ref="createInput"
            v-model="createName"
            class="workspace-name-input"
            data-field="new-canvas-name"
            spellcheck="false"
            placeholder="文件名"
            @keydown.enter.prevent="submitCreate"
            @keydown.esc.prevent="cancelCreate"
          />
          <span class="workspace-name-ext">.svg</span>
          <Loader2 v-if="createBusy" :size="13" class="workspace-spin" />
        </span>
        <div v-if="createError" class="workspace-canvas-error">{{ createError }}</div>
      </div>

      <template v-for="entry in info.canvases" :key="entry.relPath">
        <div
          v-if="renaming === entry.relPath"
          class="workspace-canvas-editor"
        >
          <FileImage :size="15" class="workspace-canvas-icon" />
          <span class="workspace-name-box">
            <input
              :ref="setRenameInput"
              v-model="renameName"
              class="workspace-name-input"
              data-field="rename-canvas-name"
              spellcheck="false"
              @keydown.enter.prevent="submitRename(entry)"
              @keydown.esc.prevent="cancelRename"
              @blur="onRenameBlur"
            />
            <span class="workspace-name-ext">.svg</span>
            <Loader2 v-if="renameBusy" :size="13" class="workspace-spin" />
          </span>
          <div v-if="renameError" class="workspace-canvas-error">{{ renameError }}</div>
        </div>
        <div
          v-else
          class="workspace-canvas-row"
          :class="{ active: entry.relPath === activeRelPath }"
          :data-rel-path="entry.relPath"
          :title="entry.relPath"
          @click="openEntry(entry)"
        >
          <FileImage :size="15" class="workspace-canvas-icon" />
          <span class="workspace-canvas-text">
            <span class="workspace-canvas-name">{{ entry.name }}</span>
            <span v-if="dirOf(entry)" class="workspace-canvas-dir">{{ dirOf(entry) }}</span>
          </span>
          <!-- 状态位始终占位,避免切换画布时文件名左右跳动 -->
          <span
            class="workspace-canvas-state"
            :class="{ 'is-dirty': entry.relPath === activeRelPath && activeDirty }"
            :title="
              entry.relPath === activeRelPath
                ? activeSaving
                  ? '正在自动保存'
                  : activeDirty
                    ? '尚未保存'
                    : undefined
                : undefined
            "
          >
            <Loader2
              v-if="entry.relPath === activeRelPath && activeSaving"
              :size="13"
              class="workspace-spin"
            />
            <template v-else-if="entry.relPath === activeRelPath && activeDirty">●</template>
          </span>
          <span class="workspace-row-action" title="重命名" @click.stop="beginRename(entry)">
            <Pencil :size="13" />
          </span>
          <span class="workspace-row-action" title="删除到回收站" @click.stop="removeEntry(entry)">
            <Trash2 :size="13" />
          </span>
        </div>
      </template>

      <div v-if="!creating && info.canvases.length === 0" class="workspace-canvas-empty">
        还没有画布
      </div>
    </div>

    <footer class="workspace-sidebar-foot">
      <span>{{ info.canvases.length }} 张画布</span>
      <span class="workspace-autosave-hint"><Cloud :size="12" /> 自动保存</span>
    </footer>

    <!-- 贴在滚动条右侧边缘的收起/展开把手 -->
    <button
      class="workspace-sidebar-collapse"
      type="button"
      data-action="workspace-collapse"
      :title="collapsed ? '展开目录' : '收起目录'"
      :aria-expanded="!collapsed"
      @click="emit('toggle-collapse')"
    >
      <ChevronRight v-if="collapsed" :size="14" />
      <ChevronLeft v-else :size="14" />
    </button>
  </aside>
</template>
