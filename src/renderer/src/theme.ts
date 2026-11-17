/**
 * 独立版主题。
 *
 * 插件里主题由 iMark 宿主通过 postMessage 写入 data-theme;独立版则用
 * localStorage 记住「跟随系统 / 浅色 / 深色」。在挂载 Vue 之前先应用一次,
 * 避免打开窗口时先闪一下浅色。
 */
export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'idraw-theme'
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

let current: ThemePreference = 'system'
let listening = false

function resolve(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'system') return darkQuery.matches ? 'dark' : 'light'
  return preference
}

function apply(): void {
  document.documentElement.dataset.theme = resolve(current)
}

export function getThemePreference(): ThemePreference {
  return current
}

export function setThemePreference(preference: ThemePreference): void {
  current = preference
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // 存储不可用时仍然立即应用,只是下次启动会回到系统默认
  }
  apply()
}

export function initTheme(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'system' || stored === 'light' || stored === 'dark') {
      current = stored
    }
  } catch {
    // 读不到就按跟随系统启动
  }
  apply()
  if (!listening) {
    listening = true
    darkQuery.addEventListener('change', () => {
      if (current === 'system') apply()
    })
  }
}
