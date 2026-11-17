import { reactive } from 'vue'

export interface Toast {
  id: number
  message: string
  level: 'info' | 'error'
}

/** 右下角气泡。只用来报告不需要用户当场做决定的事(保存失败、导出失败)。 */
export const toasts = reactive<{ list: Toast[] }>({ list: [] })

let seq = 0

export function pushNotice(message: string, level: Toast['level'] = 'info'): void {
  const text = String(message ?? '').trim()
  if (!text) return
  const toast: Toast = { id: ++seq, message: text, level }
  toasts.list.push(toast)
  const lifetime = level === 'error' ? 9000 : 3500
  window.setTimeout(() => {
    const i = toasts.list.findIndex(t => t.id === toast.id)
    if (i >= 0) toasts.list.splice(i, 1)
  }, lifetime)
}

export function dismissToast(id: number): void {
  const i = toasts.list.findIndex(t => t.id === id)
  if (i >= 0) toasts.list.splice(i, 1)
}

export function notifyError(action: string, err: unknown): void {
  const text = (err instanceof Error ? err.message : String(err)).replace(/^Error:\s*/, '')
  pushNotice(`${action}失败：${text}`, 'error')
}
