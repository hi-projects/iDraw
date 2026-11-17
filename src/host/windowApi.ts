import type { MenuCommand, SaveFileDialogOptions, WindowApi } from '@shared/api'

const bridge = (window as unknown as { idraw?: WindowApi }).idraw
if (!bridge) throw new Error('宿主桥不存在:preload 没有加载')

/** 渲染层访问主进程能力的唯一入口 */
export const api: WindowApi = bridge

export type { MenuCommand, SaveFileDialogOptions }
