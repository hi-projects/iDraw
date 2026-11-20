/**
 * 仓库相关的本地偏好。
 *
 * - 画布列表默认只列仓库当前目录的 SVG;「设置 → 布局」里打开开关后,
 *   才递归列出所有子目录里的画布(打开 `/home/byd` 这种大目录时不会被
 *   回收站、编辑器扩展里的 SVG 刷屏)。
 * - 自动保存:可选择「定时保存」(停止编辑后等待一段时间写回)或直接「关闭」;
 *   间隔范围 1–60 秒,「设置 → 编辑器 → 自动保存」可调。
 *
 * 偏好存 localStorage,重启后保留。
 */
const STORAGE_KEY = 'idraw-workspace-recursive'
const AUTO_SAVE_DELAY_KEY = 'idraw-autosave-delay-ms'
const AUTO_SAVE_MODE_KEY = 'idraw-autosave-mode'

export type AutoSaveMode = 'delay' | 'off'

export const MIN_AUTO_SAVE_DELAY_MS = 1000
export const MAX_AUTO_SAVE_DELAY_MS = 60_000
const DEFAULT_AUTO_SAVE_DELAY_MS = 1000

let nested = false
try {
  nested = localStorage.getItem(STORAGE_KEY) === '1'
} catch {
  // 读不到 storage 就按默认(不递归)
}

export function nestedCanvasesEnabled(): boolean {
  return nested
}

export function setNestedCanvasesEnabled(value: boolean): void {
  nested = value
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // 存储不可用时只影响下次启动
  }
}

let autoSaveDelay = DEFAULT_AUTO_SAVE_DELAY_MS
try {
  const stored = Number(localStorage.getItem(AUTO_SAVE_DELAY_KEY))
  if (
    Number.isFinite(stored) &&
    stored >= MIN_AUTO_SAVE_DELAY_MS &&
    stored <= MAX_AUTO_SAVE_DELAY_MS
  ) {
    autoSaveDelay = stored
  }
} catch {
  // 读不到 storage 就按默认间隔
}

/** 自动保存间隔(毫秒),每次排定保存时读取,修改后立即对下一笔生效 */
export function autoSaveDelayMs(): number {
  return autoSaveDelay
}

export function setAutoSaveDelayMs(value: number): void {
  if (!Number.isFinite(value)) return
  autoSaveDelay = Math.min(MAX_AUTO_SAVE_DELAY_MS, Math.max(MIN_AUTO_SAVE_DELAY_MS, Math.round(value)))
  try {
    localStorage.setItem(AUTO_SAVE_DELAY_KEY, String(autoSaveDelay))
  } catch {
    // 存储不可用时只影响下次启动
  }
}

let autoSaveMode: AutoSaveMode = 'delay'
try {
  if (localStorage.getItem(AUTO_SAVE_MODE_KEY) === 'off') autoSaveMode = 'off'
} catch {
  // 读不到 storage 就按定时保存
}

export function getAutoSaveMode(): AutoSaveMode {
  return autoSaveMode
}

export function setAutoSaveMode(value: AutoSaveMode): void {
  autoSaveMode = value === 'off' ? 'off' : 'delay'
  try {
    localStorage.setItem(AUTO_SAVE_MODE_KEY, autoSaveMode)
  } catch {
    // 存储不可用时只影响下次启动
  }
}
