<script setup lang="ts">
/**
 * 应用内文件夹浏览器。
 *
 * 原生 GTK 选择器在 Linux 上无法默认显示点前缀目录(Electron 43 起移除了
 * showHiddenFiles 支持),而仓库经常藏在 `.assets` 这类隐藏目录里。这里自己
 * 列一级子目录:隐藏目录默认也显示,并用淡色 + 「隐藏」标记区分。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowUp, ChevronRight, FileImage, Folder, Loader2, X } from 'lucide-vue-next'
import type { WorkspaceDirListing } from '@shared/api'
import { workspaceApi } from '../host'

const props = defineProps<{ startDir?: string | null }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select', dir: string): void
  (e: 'open-file', path: string): void
}>()

const listing = ref<WorkspaceDirListing | null>(null)
const pathInput = ref('')
const loading = ref(false)
const error = ref('')

async function load(dir: string | null): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const info = await workspaceApi.listDirectories(dir)
    listing.value = info
    pathInput.value = info.dir
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function enter(path: string): void {
  void load(path)
}

function goUp(): void {
  const parent = listing.value?.parent
  if (parent) void load(parent)
}

function submitPath(): void {
  const value = pathInput.value.trim()
  if (value) void load(value)
}

function choose(): void {
  if (listing.value) emit('select', listing.value.dir)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  emit('close')
}

onMounted(() => {
  void load(props.startDir ?? null)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="dir-browser-mask" @click.self="emit('close')">
    <section class="dir-browser" role="dialog" aria-modal="true" aria-label="打开仓库文件夹">
      <header class="dir-browser-head">
        <h2>打开仓库文件夹</h2>
        <button class="dir-browser-close" type="button" title="关闭" @click="emit('close')">
          <X :size="16" />
        </button>
      </header>

      <div class="dir-browser-pathrow">
        <button
          class="dir-browser-up"
          type="button"
          title="上一级"
          :disabled="!listing?.parent"
          @click="goUp"
        >
          <ArrowUp :size="15" />
        </button>
        <input
          v-model="pathInput"
          class="dir-browser-path"
          spellcheck="false"
          placeholder="输入文件夹路径"
          @keydown.enter.prevent="submitPath"
        />
        <button class="dir-browser-go" type="button" @click="submitPath">前往</button>
      </div>

      <p v-if="error" class="dir-browser-error">{{ error }}</p>

      <div class="dir-browser-list">
        <div v-if="loading" class="dir-browser-loading">
          <Loader2 :size="18" class="workspace-spin" />
        </div>
        <template v-else>
          <button
            v-for="entry in listing?.dirs ?? []"
            :key="entry.path"
            class="dir-browser-item"
            :class="{ hidden: entry.hidden }"
            type="button"
            :title="entry.path"
            @click="enter(entry.path)"
          >
            <Folder :size="15" class="dir-browser-icon" />
            <span class="dir-browser-name">{{ entry.name }}</span>
            <span v-if="entry.hidden" class="dir-browser-badge">隐藏</span>
            <ChevronRight :size="14" class="dir-browser-arrow" />
          </button>
          <button
            v-for="file in listing?.files ?? []"
            :key="file.path"
            class="dir-browser-item dir-browser-file"
            :class="{ hidden: file.hidden }"
            type="button"
            :title="file.path"
            @click="emit('open-file', file.path)"
          >
            <FileImage :size="15" class="dir-browser-icon" />
            <span class="dir-browser-name">{{ file.name }}</span>
            <span v-if="file.hidden" class="dir-browser-badge">隐藏</span>
          </button>
          <div
            v-if="!(listing?.dirs.length || listing?.files.length)"
            class="dir-browser-empty"
          >
            这个文件夹里没有子文件夹或 SVG
          </div>
        </template>
      </div>

      <footer class="dir-browser-foot">
        <span class="dir-browser-current" :title="listing?.dir ?? ''">
          {{ listing?.dir ?? '' }}
        </span>
        <div class="dir-browser-actions">
          <button class="dir-browser-cancel" type="button" @click="emit('close')">取消</button>
          <button
            class="dir-browser-select"
            type="button"
            :disabled="!listing"
            @click="choose"
          >
            选择此文件夹
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
