/**
 * 应用内确认弹窗。
 *
 * 原生 message box 跟不了主题;这里用一个 Promise 化的共享弹窗状态,
 * 由 App 根部的 ThemedDialogHost 渲染。同一时刻只保留一个弹窗。
 */
import { reactive } from 'vue'

export type DialogButtonKind = 'default' | 'primary' | 'danger'

export interface DialogButton {
  label: string
  value: string
  kind?: DialogButtonKind
}

export interface DialogOptions {
  title: string
  message: string
  detail?: string
  icon?: 'warning' | 'info'
  buttons: DialogButton[]
  /** 点遮罩 / 按 Esc 时返回的值,默认 cancel */
  cancelValue?: string
}

interface DialogState {
  options: DialogOptions | null
  resolve: ((value: string) => void) | null
}

export const dialogState = reactive<DialogState>({ options: null, resolve: null })

export function showDialog(options: DialogOptions): Promise<string> {
  // 连续弹窗时先按取消结束上一个,避免调用方永远等不到结果
  if (dialogState.resolve) {
    const previous = dialogState.resolve
    const cancelValue = dialogState.options?.cancelValue ?? 'cancel'
    dialogState.options = null
    dialogState.resolve = null
    previous(cancelValue)
  }
  return new Promise<string>(resolve => {
    dialogState.options = options
    dialogState.resolve = resolve
  })
}

export function resolveDialog(value: string): void {
  const resolve = dialogState.resolve
  dialogState.options = null
  dialogState.resolve = null
  resolve?.(value)
}
