<script setup lang="ts">
/**
 * 启动页 / 最近打开。
 *
 * 上下结构:顶部只留应用图标,主体是最近画布缩略图,下方固定一条入口栏。
 * 仓库卡片最多拼 4 张画布缩略图(1 张铺满、2 张并排、3 张一大多小、4 张 2x2),
 * 单个 SVG 卡片直接显示自身缩略图。缩略图由渲染层读取 SVG 文本后转成 data URL,
 * 交给 <img> 缩放 —— 不执行 SVG 里的脚本,也不需要主进程做离屏渲染。
 */
import { onMounted, ref } from 'vue'
import {
  FileImage,
  FolderOpen,
  Loader2,
  Plus,
  Sparkles,
  X
} from 'lucide-vue-next'
import type { RecentEntry } from '@shared/api'
import { fileNameOf, joinPath } from '@shared/path'
import { api } from '../../../host/windowApi'
import { notifyError } from '../../../editor/notice'
import { workspaceApi } from '../host'
import { nestedCanvasesEnabled } from '../workspacePrefs'
import DirectoryBrowser from './DirectoryBrowser.vue'
import appIcon from '../../../../build/icon.png'

const emit = defineEmits<{
  (e: 'open-workspace', dir: string): void
  (e: 'temporary'): void
  (e: 'open-file', path: string): void
}>()

interface PreviewItem {
  key: string
  name: string
  src: string | null
}

interface RecentCard {
  key: string
  kind: RecentEntry['kind']
  path: string
  name: string
  previews: PreviewItem[]
  loading: boolean
  failed: boolean
}

const PREVIEW_LIMIT = 4
/** 过大的 SVG 不生成缩略图,避免一次读取/编码几十 MB 的文本 */
const MAX_PREVIEW_TEXT = 3_000_000

const cards = ref<RecentCard[]>([])
const loading = ref(true)
const pickingFile = ref(false)
/** 「+」卡片下的三个入口 */
const menuOpen = ref(false)
/** 应用内文件夹浏览器(原生对话框在 Linux 上看不到隐藏目录) */
const browsing = ref(false)

function basename(path: string): string {
  return fileNameOf(path) || path
}

/** 中文/CJK 字形在同字号下视觉偏大,缩略图标签里略微收一点 */
function hasCjk(text: string): boolean {
  return /[㐀-鿿豈-﫿]/.test(text)
}

function svgDataUrl(text: string): string | null {
  if (!text || text.length > MAX_PREVIEW_TEXT) return null
  // 预览去掉文件自带的白色页面,露出单元格背景,让缩略图跟随主题变深
  const preview = text.replace(/<rect\b[^>]*\bdata-idraw-page="1"[^>]*\/>/i, '')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview || text)}`
}

async function readPreview(path: string, name: string, key: string): Promise<PreviewItem> {
  try {
    const text = await api.readFile(path)
    return { key, name, src: svgDataUrl(text) }
  } catch {
    // 单个缩略图失败只影响这一格,不让整张卡片变成错误状态
    return { key, name, src: null }
  }
}

function makeCard(entry: RecentEntry): RecentCard {
  return {
    key: `${entry.kind}:${entry.path}`,
    kind: entry.kind,
    path: entry.path,
    name: basename(entry.path) || entry.path,
    previews: [],
    loading: true,
    failed: false
  }
}

async function loadPreview(card: RecentCard): Promise<void> {
  if (card.kind === 'workspace') {
    try {
      const info = await workspaceApi.read(card.path, { recursive: nestedCanvasesEnabled() })
      const picks = info.canvases.slice(0, PREVIEW_LIMIT)
      card.previews = await Promise.all(
        picks.map(item => readPreview(joinPath(card.path, item.relPath), item.name, item.relPath))
      )
    } catch {
      card.previews = []
      card.failed = true
    }
  } else {
    card.previews = [await readPreview(card.path, card.name, card.path)]
  }
  card.loading = false
}

onMounted(async () => {
  try {
    const entries = await workspaceApi.pruneRecents()
    cards.value = entries.map(makeCard)
  } catch (err) {
    notifyError('读取最近打开', err)
  } finally {
    loading.value = false
  }

  // 三路并发读取缩略图:够快,又不会一次扑上去打开几十个文件
  const queue = [...cards.value]
  const worker = async (): Promise<void> => {
    for (;;) {
      const card = queue.shift()
      if (!card) return
      await loadPreview(card)
    }
  }
  await Promise.all([worker(), worker(), worker()])
})

function onDirectorySelected(dir: string): void {
  browsing.value = false
  emit('open-workspace', dir)
}

function onDirectoryFileSelected(path: string): void {
  browsing.value = false
  emit('open-file', path)
}

function chooseTemporary(): void {
  menuOpen.value = false
  emit('temporary')
}

function chooseFile(): void {
  menuOpen.value = false
  void openSvgFile()
}

function chooseWorkspace(): void {
  menuOpen.value = false
  browsing.value = true
}

async function openSvgFile(): Promise<void> {
  if (pickingFile.value) return
  pickingFile.value = true
  try {
    const path = await api.openFileDialog()
    if (path) emit('open-file', path)
  } catch (err) {
    notifyError('打开文件', err)
  } finally {
    pickingFile.value = false
  }
}

function openCard(card: RecentCard): void {
  if (card.kind === 'workspace') emit('open-workspace', card.path)
  else emit('open-file', card.path)
}

function onCardKeydown(event: KeyboardEvent, card: RecentCard): void {
  // 卡片里的「移除」按钮获得焦点时,Enter 不应该同时打开卡片
  if (event.target !== event.currentTarget) return
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  openCard(card)
}

async function forget(card: RecentCard): Promise<void> {
  try {
    await workspaceApi.forget(card.kind, card.path)
    cards.value = cards.value.filter(item => item.key !== card.key)
  } catch (err) {
    notifyError('移除最近打开', err)
  }
}
</script>

<template>
  <div class="workspace-picker">
    <header class="workspace-picker-head">
      <div class="workspace-picker-head-inner">
        <img class="workspace-picker-logo" :src="appIcon" alt="iDraw" draggable="false" />
        <span class="workspace-picker-app-name">iDraw</span>
      </div>
    </header>

    <main class="workspace-picker-body">
      <div class="workspace-picker-body-inner">
        <div v-if="loading" class="workspace-recent-loading">
          <Loader2 :size="18" class="workspace-spin" />
        </div>

        <div v-else class="workspace-recent-grid">
          <div class="workspace-recent-add-slot">
            <div class="workspace-recent-add-frame">
              <div class="workspace-recent-add-anchor">
                <button
                  class="workspace-recent-add-button"
                  :class="{ active: menuOpen }"
                  type="button"
                  title="创建或打开画布"
                  aria-haspopup="menu"
                  :aria-expanded="menuOpen"
                  @click="menuOpen = !menuOpen"
                  @keydown.esc.prevent="menuOpen = false"
                >
                  <Plus :size="32" />
                </button>

                <div
                  v-if="menuOpen"
                  class="workspace-recent-empty-mask"
                  @click="menuOpen = false"
                />
                <div v-if="menuOpen" class="workspace-recent-empty-menu" role="menu">
                  <button
                    class="workspace-recent-empty-menu-item"
                    type="button"
                    data-action="temporary-canvas"
                    @click="chooseTemporary"
                  >
                    <Sparkles :size="26" class="workspace-recent-empty-menu-icon" />
                    <span>新建画布</span>
                  </button>
                  <button
                    class="workspace-recent-empty-menu-item"
                    type="button"
                    data-action="open-file"
                    :disabled="pickingFile"
                    @click="chooseFile"
                  >
                    <Loader2
                      v-if="pickingFile"
                      :size="26"
                      class="workspace-spin workspace-recent-empty-menu-icon"
                    />
                    <FileImage v-else :size="26" class="workspace-recent-empty-menu-icon" />
                    <span>打开文件</span>
                  </button>
                  <button
                    class="workspace-recent-empty-menu-item"
                    type="button"
                    data-action="open-workspace"
                    @click="chooseWorkspace"
                  >
                    <FolderOpen :size="26" class="workspace-recent-empty-menu-icon" />
                    <span>打开文件夹</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div
            v-for="card in cards"
            :key="card.key"
            class="workspace-recent-card"
            :data-action="card.kind === 'workspace' ? 'recent-workspace' : 'recent-file'"
            role="button"
            tabindex="0"
            :title="card.path"
            @click="openCard(card)"
            @keydown="onCardKeydown($event, card)"
          >
            <div
              class="workspace-recent-cover"
              :class="`count-${Math.max(1, card.previews.length)}`"
            >
              <div v-if="card.loading" class="workspace-recent-cover-state">
                <Loader2 :size="18" class="workspace-spin" />
              </div>
              <div v-else-if="card.previews.length === 0" class="workspace-recent-cover-state">
                <FolderOpen v-if="card.kind === 'workspace' && !card.failed" :size="22" />
                <FileImage v-else :size="22" />
                <span>{{ card.kind === 'workspace' && !card.failed ? '无画布' : '无法预览' }}</span>
              </div>
              <template v-else>
                <div
                  v-for="preview in card.previews"
                  :key="preview.key"
                  class="workspace-recent-cell"
                >
                  <img
                    v-if="preview.src"
                    :src="preview.src"
                    :alt="preview.name"
                    draggable="false"
                  />
                  <span v-else class="workspace-recent-cell-empty"><FileImage :size="16" /></span>
                </div>
              </template>

              <button
                class="workspace-recent-remove"
                title="从最近打开中移除"
                @click.stop="forget(card)"
              >
                <X :size="13" />
              </button>
            </div>

            <div class="workspace-recent-meta">
              <FolderOpen v-if="card.kind === 'workspace'" :size="15" class="workspace-recent-type" />
              <FileImage v-else :size="15" class="workspace-recent-type" />
              <span class="workspace-recent-name" :class="{ 'is-cjk': hasCjk(card.name) }">
                {{ card.name }}
              </span>
            </div>
          </div>
        </div>

      </div>
    </main>

    <DirectoryBrowser
      v-if="browsing"
      @close="browsing = false"
      @select="onDirectorySelected"
      @open-file="onDirectoryFileSelected"
    />
  </div>
</template>
