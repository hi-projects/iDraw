<script setup lang="ts">
/**
 * 仓库选择页左下角的深色/浅色主题切换。
 *
 * 只做 light <-> dark 两档直接切换(「跟随系统」仍在设置面板里选)。
 * 图标显示的是「点击后会切到的主题」:深色时显示太阳,浅色时显示月亮。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Moon, Sun } from 'lucide-vue-next'
import { getThemePreference, setThemePreference } from '../theme'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const effective = ref<'light' | 'dark'>('light')

function sync(): void {
  effective.value = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function toggle(): void {
  setThemePreference(effective.value === 'dark' ? 'light' : 'dark')
  sync()
}

function onSystemThemeChange(): void {
  // 偏好仍是「跟随系统」时,系统主题变了图标也要跟着换
  if (getThemePreference() === 'system') sync()
}

onMounted(() => {
  sync()
  darkQuery.addEventListener('change', onSystemThemeChange)
})

onBeforeUnmount(() => darkQuery.removeEventListener('change', onSystemThemeChange))

const isDark = computed(() => effective.value === 'dark')
const label = computed(() => (isDark.value ? '切换到浅色主题' : '切换到深色主题'))
</script>

<template>
  <button
    class="idraw-corner-btn"
    type="button"
    data-action="toggle-theme"
    :title="label"
    :aria-label="label"
    @click="toggle"
  >
    <Sun v-if="isDark" :size="19" />
    <Moon v-else :size="19" />
  </button>
</template>
