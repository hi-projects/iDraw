<script setup lang="ts">
/**
 * 左下角全局菜单 + 设置面板。
 *
 * 菜单里保留画布操作(保存/导出/撤销/重做),并作为设置入口。
 * 设置面板采用左侧分区 + 右侧内容的布局,目前包含外观、编辑器、关于。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  Check,
  Cog,
  Download,
  Info,
  LayoutGrid,
  Palette,
  Redo2,
  Save,
  Settings2,
  SlidersHorizontal,
  Undo2,
  X
} from 'lucide-vue-next'
import appIcon from '../../../../build/icon.png'
import { getThemePreference, setThemePreference, type ThemePreference } from '../theme'

type SettingsSection = 'appearance' | 'editor' | 'layout' | 'about'

defineProps<{
  hasDocument: boolean
  readOnly: boolean
  canSave: boolean
  canUndo: boolean
  canRedo: boolean
  /** 是否显示「返回画布总览」(已经停在总览页时为 false) */
  canBack: boolean
  /** null = 当前没有打开画布 */
  gridVisible: boolean | null
  snap: boolean | null
  /** 仓库列表是否递归显示子目录中的画布 */
  showNestedCanvases: boolean
}>()

const emit = defineEmits<{
  (e: 'save'): void
  (e: 'export-png'): void
  (e: 'undo'): void
  (e: 'redo'): void
  (e: 'toggle-grid'): void
  (e: 'toggle-snap'): void
  (e: 'toggle-nested-canvases'): void
  (e: 'back-to-overview'): void
}>()

const menuOpen = ref(false)
const settingsOpen = ref(false)
const activeSection = ref<SettingsSection>('appearance')
const theme = ref<ThemePreference>(getThemePreference())
const sectionTitle = computed(() => {
  if (activeSection.value === 'editor') return '编辑器'
  if (activeSection.value === 'layout') return '布局'
  if (activeSection.value === 'about') return '关于'
  return '外观'
})

function chooseSave(): void {
  menuOpen.value = false
  emit('save')
}

function chooseExportPng(): void {
  menuOpen.value = false
  emit('export-png')
}

function chooseUndo(): void {
  menuOpen.value = false
  emit('undo')
}

function chooseRedo(): void {
  menuOpen.value = false
  emit('redo')
}

function openSettings(): void {
  menuOpen.value = false
  settingsOpen.value = true
}

function chooseBackToOverview(): void {
  menuOpen.value = false
  emit('back-to-overview')
}

function chooseTheme(value: ThemePreference): void {
  theme.value = value
  setThemePreference(value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (settingsOpen.value) {
    event.preventDefault()
    settingsOpen.value = false
  } else if (menuOpen.value) {
    event.preventDefault()
    menuOpen.value = false
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="idraw-global-menu">
    <div v-if="menuOpen" class="idraw-corner-mask" @click="menuOpen = false" />
    <div v-if="menuOpen" class="idraw-corner-menu" role="menu">
      <!-- 文档操作始终显示:没有打开画布 / 只读预览时置灰,而不是整组消失 -->
      <button
        class="idraw-corner-menu-item"
        type="button"
        data-action="menu-save"
        :disabled="!canSave"
        @click="chooseSave"
      >
        <Save :size="14" />
        保存
      </button>
      <button
        class="idraw-corner-menu-item"
        type="button"
        data-action="menu-export-png"
        :disabled="!hasDocument || readOnly"
        @click="chooseExportPng"
      >
        <Download :size="14" />
        导出 PNG
      </button>

      <div class="idraw-corner-sep" role="separator"></div>

      <button
        class="idraw-corner-menu-item"
        type="button"
        data-action="menu-undo"
        :disabled="!canUndo"
        @click="chooseUndo"
      >
        <Undo2 :size="14" />
        撤销
      </button>
      <button
        class="idraw-corner-menu-item"
        type="button"
        data-action="menu-redo"
        :disabled="!canRedo"
        @click="chooseRedo"
      >
        <Redo2 :size="14" />
        重做
      </button>

      <div class="idraw-corner-sep" role="separator"></div>

      <button
        v-if="canBack"
        class="idraw-corner-menu-item"
        type="button"
        data-action="menu-back-overview"
        @click="chooseBackToOverview"
      >
        <LayoutGrid :size="14" />
        返回画布总览
      </button>

      <button
        class="idraw-corner-menu-item"
        type="button"
        data-action="open-settings"
        @click="openSettings"
      >
        <Settings2 :size="14" />
        设置
      </button>
    </div>

    <button
      class="idraw-corner-btn"
      :class="{ active: menuOpen || settingsOpen }"
      type="button"
      data-action="global-menu"
      title="菜单"
      aria-label="菜单"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      @click="menuOpen = !menuOpen"
    >
      <Cog :size="19" />
    </button>

    <div v-if="settingsOpen" class="idraw-settings-overlay" @click.self="settingsOpen = false">
      <section class="idraw-settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
        <aside class="idraw-settings-sidebar">
          <div class="idraw-settings-nav-group">
            <div class="idraw-settings-nav-label">选项</div>
            <button
              class="idraw-settings-nav-item"
              :class="{ active: activeSection === 'appearance' }"
              type="button"
              @click="activeSection = 'appearance'"
            >
              <Palette :size="15" />
              外观
            </button>
            <button
              class="idraw-settings-nav-item"
              :class="{ active: activeSection === 'editor' }"
              type="button"
              @click="activeSection = 'editor'"
            >
              <SlidersHorizontal :size="15" />
              编辑器
            </button>
            <button
              class="idraw-settings-nav-item"
              :class="{ active: activeSection === 'layout' }"
              type="button"
              data-section="layout"
              @click="activeSection = 'layout'"
            >
              <LayoutGrid :size="15" />
              布局
            </button>
          </div>

          <div class="idraw-settings-nav-group">
            <div class="idraw-settings-nav-label">应用</div>
            <button
              class="idraw-settings-nav-item"
              :class="{ active: activeSection === 'about' }"
              type="button"
              @click="activeSection = 'about'"
            >
              <Info :size="15" />
              关于
            </button>
          </div>
        </aside>

        <div class="idraw-settings-content">
          <header class="idraw-settings-content-head">
            <h2>{{ sectionTitle }}</h2>
            <button
              class="idraw-settings-close"
              type="button"
              title="关闭"
              aria-label="关闭"
              @click="settingsOpen = false"
            >
              <X :size="16" />
            </button>
          </header>

          <div class="idraw-settings-content-body">
            <template v-if="activeSection === 'appearance'">
              <div class="idraw-settings-section">
                <h3 class="idraw-settings-section-title">基础颜色</h3>
                <p class="idraw-settings-section-desc">
                  设置界面主题。选择后立即生效，并保存到本地设置。
                </p>

                <div class="idraw-settings-themes">
                  <button
                    class="idraw-theme-option"
                    :class="{ active: theme === 'system' }"
                    type="button"
                    data-theme="system"
                    @click="chooseTheme('system')"
                  >
                    <span class="idraw-theme-preview system">
                      <span class="idraw-theme-shot">
                        <span class="idraw-theme-bar wide"></span>
                        <span class="idraw-theme-bar"></span>
                      </span>
                    </span>
                    <span class="idraw-theme-label">跟随系统</span>
                    <span v-if="theme === 'system'" class="idraw-theme-check">
                      <Check :size="12" />
                    </span>
                  </button>

                  <button
                    class="idraw-theme-option"
                    :class="{ active: theme === 'light' }"
                    type="button"
                    data-theme="light"
                    @click="chooseTheme('light')"
                  >
                    <span class="idraw-theme-preview light">
                      <span class="idraw-theme-shot">
                        <span class="idraw-theme-bar wide"></span>
                        <span class="idraw-theme-bar"></span>
                      </span>
                    </span>
                    <span class="idraw-theme-label">浅色</span>
                    <span v-if="theme === 'light'" class="idraw-theme-check">
                      <Check :size="12" />
                    </span>
                  </button>

                  <button
                    class="idraw-theme-option"
                    :class="{ active: theme === 'dark' }"
                    type="button"
                    data-theme="dark"
                    @click="chooseTheme('dark')"
                  >
                    <span class="idraw-theme-preview dark">
                      <span class="idraw-theme-shot">
                        <span class="idraw-theme-bar wide"></span>
                        <span class="idraw-theme-bar"></span>
                      </span>
                    </span>
                    <span class="idraw-theme-label">深色</span>
                    <span v-if="theme === 'dark'" class="idraw-theme-check">
                      <Check :size="12" />
                    </span>
                  </button>
                </div>

                <p class="idraw-settings-hint">主题会立即生效，并记住你的选择。</p>
              </div>
            </template>

            <template v-else-if="activeSection === 'editor'">
              <div class="idraw-settings-section">
                <div class="idraw-settings-row">
                  <div>
                    <div class="idraw-settings-row-label">显示网格</div>
                    <div class="idraw-settings-row-hint">在画布背景显示点阵网格。</div>
                  </div>
                  <button
                    class="idraw-settings-switch"
                    :class="{ on: gridVisible }"
                    type="button"
                    role="switch"
                    :aria-checked="!!gridVisible"
                    :disabled="gridVisible === null"
                    @click="emit('toggle-grid')"
                  >
                    <span />
                  </button>
                </div>

                <div class="idraw-settings-row">
                  <div>
                    <div class="idraw-settings-row-label">网格吸附</div>
                    <div class="idraw-settings-row-hint">拖动与创建形状时对齐到 20px 网格。</div>
                  </div>
                  <button
                    class="idraw-settings-switch"
                    :class="{ on: snap }"
                    type="button"
                    role="switch"
                    :aria-checked="!!snap"
                    :disabled="snap === null"
                    @click="emit('toggle-snap')"
                  >
                    <span />
                  </button>
                </div>

                <p v-if="gridVisible === null" class="idraw-settings-hint">
                  打开一张画布后可以调整这些选项。
                </p>
              </div>
            </template>

            <template v-else-if="activeSection === 'layout'">
              <div class="idraw-settings-section">
                <div class="idraw-settings-row">
                  <div>
                    <div class="idraw-settings-row-label">显示子目录中的 SVG</div>
                    <div class="idraw-settings-row-hint">
                      开启后,仓库左侧列表会递归显示所有子目录里的画布;默认只显示当前目录,避免打开大目录时混入回收站、扩展缓存里的文件。
                    </div>
                  </div>
                  <button
                    class="idraw-settings-switch"
                    :class="{ on: showNestedCanvases }"
                    type="button"
                    role="switch"
                    data-field="show-nested-canvases"
                    :aria-checked="showNestedCanvases"
                    @click="emit('toggle-nested-canvases')"
                  >
                    <span />
                  </button>
                </div>
              </div>
            </template>

            <template v-else>
              <div class="idraw-settings-about">
                <img :src="appIcon" alt="" draggable="false" />
                <div>
                  <h3>iDraw</h3>
                  <p>版本 0.1.0</p>
                </div>
              </div>
              <p class="idraw-settings-about-desc">
                用标准 SVG 画流程图与示意图，文件可以直接在浏览器、Inkscape、Illustrator 中打开。
              </p>

              <div class="idraw-settings-section">
                <h3 class="idraw-settings-section-title">文件格式</h3>
                <p class="idraw-settings-section-desc">
                  画布保存为 .svg 文件，文字和形状仍是可编辑的矢量元素。
                </p>
              </div>
            </template>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
