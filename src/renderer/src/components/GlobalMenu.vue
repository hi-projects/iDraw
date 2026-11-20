<script setup lang="ts">
/**
 * 左下角全局菜单 + 设置面板。
 *
 * 菜单里保留画布操作(保存/导出/撤销/重做),并作为设置入口。
 * 设置面板采用左侧分区 + 右侧内容的布局,包含外观、编辑器、关于;
 * 其中「布局」分区只在打开了目录(仓库)时出现。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Check,
  Cog,
  Download,
  Github,
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
import imarkIcon from '../../../../build/imark.svg'
import { api } from '../../../host/windowApi'
import { notifyError } from '../../../editor/notice'
import { getThemePreference, setThemePreference, type ThemePreference } from '../theme'
import {
  MAX_AUTO_SAVE_DELAY_MS,
  MIN_AUTO_SAVE_DELAY_MS,
  type AutoSaveMode
} from '../workspacePrefs'

type SettingsSection = 'appearance' | 'editor' | 'layout' | 'about'

const props = defineProps<{
  hasDocument: boolean
  /** 当前是否打开了目录(仓库);「布局」分区只在这种情况下出现 */
  hasWorkspace: boolean
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
  /** 自动保存间隔(秒) */
  autoSaveDelaySec: number
  /** 自动保存模式:定时保存 / 关闭 */
  autoSaveMode: AutoSaveMode
  /** 是否展示自动保存模块(仓库模式,或临时画布手动保存后) */
  showAutoSave: boolean
  /** 嵌在底部状态栏里(而非左下角悬浮) */
  inline?: boolean
}>()

const emit = defineEmits<{
  (e: 'save'): void
  (e: 'export-png'): void
  (e: 'undo'): void
  (e: 'redo'): void
  (e: 'toggle-grid'): void
  (e: 'toggle-snap'): void
  (e: 'toggle-nested-canvases'): void
  (e: 'set-auto-save-delay', seconds: number): void
  (e: 'set-auto-save-mode', mode: AutoSaveMode): void
  (e: 'back-to-overview'): void
}>()

const autoSaveMinSec = MIN_AUTO_SAVE_DELAY_MS / 1000
const autoSaveMaxSec = MAX_AUTO_SAVE_DELAY_MS / 1000
/** 「定时保存」的常用档位,覆盖 1 秒到 1 分钟 */
const AUTO_SAVE_PRESETS = [
  { sec: 1, label: '1 秒' },
  { sec: 5, label: '5 秒' },
  { sec: 30, label: '30 秒' },
  { sec: 60, label: '1 分钟' }
]

interface FamilyApp {
  key: string
  name: string
  description: string
  icon: string
  /** 应用主页,点击卡片时用系统浏览器打开 */
  url: string
}

/** 应用矩阵:目前只有 iMark,后续新增应用往数组里加一项即可 */
const FAMILY_APPS: FamilyApp[] = [
  {
    key: 'imark',
    name: 'iMark',
    description: '专注文字创作，内容与版式即时呈现',
    icon: imarkIcon,
    url: 'https://github.com/hi-projects/iMark'
  }
]

async function openAppPage(item: FamilyApp): Promise<void> {
  try {
    await api.openExternal?.(item.url)
  } catch (err) {
    notifyError('打开链接', err)
  }
}

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

// 目录关闭后「布局」分区不再展示,避免停留在已隐藏的分区上
watch(
  () => props.hasWorkspace,
  hasWorkspace => {
    if (!hasWorkspace && activeSection.value === 'layout') activeSection.value = 'appearance'
  }
)

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

function onAutoSaveDelayChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const raw = Number(input.value)
  if (!Number.isFinite(raw)) {
    input.value = String(props.autoSaveDelaySec)
    return
  }
  // 按整秒取整后再夹到允许区间,输入框里显示规范化后的值
  const seconds = Math.round(Math.min(autoSaveMaxSec, Math.max(autoSaveMinSec, raw)))
  input.value = String(seconds)
  emit('set-auto-save-delay', seconds)
}

function chooseAutoSaveMode(mode: AutoSaveMode): void {
  emit('set-auto-save-mode', mode)
}

function chooseAutoSavePreset(seconds: number): void {
  emit('set-auto-save-delay', seconds)
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
  <div class="idraw-global-menu" :class="{ 'is-inline': inline }">
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
      <Cog :size="inline ? 14 : 19" />
    </button>

    <!-- 状态栏模式下:返回画布总览是齿轮右边的独立图标 -->
    <button
      v-if="inline && canBack"
      class="idraw-status-icon-btn"
      type="button"
      data-action="back-overview"
      title="返回画布总览"
      aria-label="返回画布总览"
      @click="chooseBackToOverview"
    >
      <LayoutGrid :size="14" />
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
              v-if="hasWorkspace"
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
                <div class="idraw-settings-section-head">
                  <h3 class="idraw-settings-section-title">基础颜色</h3>
                  <p class="idraw-settings-section-desc">
                    设置界面主题，选择后立即生效
                  </p>
                </div>

                <div class="idraw-settings-group idraw-settings-card-pad">
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
                </div>
              </div>
            </template>

            <template v-else-if="activeSection === 'editor'">
              <div class="idraw-settings-section">
                <div class="idraw-settings-section-head">
                  <h3 class="idraw-settings-section-title">网格</h3>
                </div>

                <div class="idraw-settings-group">
                  <div class="idraw-settings-row">
                    <div>
                      <div class="idraw-settings-row-label">显示网格</div>
                      <div class="idraw-settings-row-hint">在画布背景中显示点阵网格</div>
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
                      <div class="idraw-settings-row-hint">操作自动对齐到网格</div>
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
                </div>

                <p v-if="gridVisible === null" class="idraw-settings-hint">
                  打开一张画布后可以调整这些选项。
                </p>
              </div>

              <!-- 仓库画布始终支持自动保存;临时画布手动落盘后也开始支持,可在卡内关闭 -->
              <div v-if="showAutoSave" class="idraw-settings-section" data-section="autosave">
                <div class="idraw-settings-section-head">
                  <h3 class="idraw-settings-section-title">自动保存</h3>
                </div>

                <div class="idraw-settings-group" role="radiogroup" aria-label="自动保存">
                  <div
                    class="idraw-autosave-mode"
                    :class="{ active: autoSaveMode === 'delay' }"
                  >
                    <button
                      class="idraw-autosave-pick"
                      type="button"
                      role="radio"
                      :aria-checked="autoSaveMode === 'delay'"
                      data-field="auto-save-mode-delay"
                      @click="chooseAutoSaveMode('delay')"
                    >
                      <span class="idraw-autosave-radio" aria-hidden="true" />
                      <span class="idraw-autosave-body">
                        <span class="idraw-autosave-title">定时保存</span>
                        <span class="idraw-autosave-desc">
                          停止输入 {{ autoSaveDelaySec }} 秒后保存
                        </span>
                      </span>
                    </button>

                    <div v-if="autoSaveMode === 'delay'" class="idraw-autosave-delay">
                      <span class="idraw-settings-presets">
                        <button
                          v-for="preset in AUTO_SAVE_PRESETS"
                          :key="preset.sec"
                          class="idraw-settings-preset"
                          :class="{ active: autoSaveDelaySec === preset.sec }"
                          type="button"
                          @click="chooseAutoSavePreset(preset.sec)"
                        >
                          {{ preset.label }}
                        </button>
                      </span>
                      <label class="idraw-settings-number">
                        <input
                          type="number"
                          :min="autoSaveMinSec"
                          :max="autoSaveMaxSec"
                          step="1"
                          :value="autoSaveDelaySec"
                          data-field="auto-save-delay"
                          aria-label="自动保存间隔(秒)"
                          @change="onAutoSaveDelayChange"
                        />
                        <span>秒</span>
                      </label>
                    </div>
                  </div>

                  <div
                    class="idraw-autosave-mode"
                    :class="{ active: autoSaveMode === 'off' }"
                  >
                    <button
                      class="idraw-autosave-pick"
                      type="button"
                      role="radio"
                      :aria-checked="autoSaveMode === 'off'"
                      data-field="auto-save-mode-off"
                      @click="chooseAutoSaveMode('off')"
                    >
                      <span class="idraw-autosave-radio" aria-hidden="true" />
                      <span class="idraw-autosave-body">
                        <span class="idraw-autosave-title">关闭</span>
                        <span class="idraw-autosave-desc">手动保存（Ctrl+S）</span>
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </template>

            <template v-else-if="activeSection === 'layout'">
              <div class="idraw-settings-section">
                <div class="idraw-settings-section-head">
                  <h3 class="idraw-settings-section-title">画布列表</h3>
                </div>

                <div class="idraw-settings-group">
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
              </div>
            </template>

            <template v-else>
              <!-- 第一部分:本应用 -->
              <div class="idraw-settings-section">
                <div class="idraw-settings-section-head">
                  <h3 class="idraw-settings-section-title">本应用</h3>
                </div>

                <div class="idraw-settings-group idraw-settings-card-pad">
                  <div class="idraw-settings-about">
                    <img :src="appIcon" alt="" draggable="false" />
                    <div>
                      <h3>iDraw</h3>
                      <p>版本 0.1.0</p>
                    </div>
                  </div>
                  <p class="idraw-settings-about-desc">
                    专注绘制流程图与示意图，作品可在各类软件中自由打开与继续编辑
                  </p>
                </div>
              </div>

              <!-- 第二部分:应用矩阵,后续新增应用往 FAMILY_APPS 里加一项即可 -->
              <div class="idraw-settings-section">
                <div class="idraw-settings-section-head">
                  <h3 class="idraw-settings-section-title">应用矩阵</h3>
                </div>

                <div class="idraw-settings-group">
                  <div
                    v-for="item in FAMILY_APPS"
                    :key="item.key"
                    class="idraw-family-app"
                    :data-app="item.key"
                  >
                    <img
                      class="idraw-family-app-icon"
                      :src="item.icon"
                      :alt="item.name"
                      draggable="false"
                    />
                    <div class="idraw-family-app-body">
                      <div class="idraw-family-app-name">{{ item.name }}</div>
                      <div class="idraw-family-app-desc">{{ item.description }}</div>
                    </div>
                    <button
                      class="idraw-family-app-link"
                      type="button"
                      :title="`在 GitHub 上查看 ${item.name}`"
                      :aria-label="`在 GitHub 上查看 ${item.name}`"
                      @click="openAppPage(item)"
                    >
                      <Github :size="16" />
                    </button>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
