/**
 * 仓库画布列表的显示偏好。
 *
 * 默认只列仓库当前目录的 SVG;「设置 → 布局」里打开开关后,才递归列出
 * 所有子目录里的画布(打开 `/home/byd` 这种大目录时不会被回收站、
 * 编辑器扩展里的 SVG 刷屏)。偏好存 localStorage,重启后保留。
 */
const STORAGE_KEY = 'idraw-workspace-recursive'

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
