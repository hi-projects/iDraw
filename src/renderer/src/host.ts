import type { WorkspaceApi } from '@shared/api'
import type { CanvasRuntimeHost } from '../../engine/host'
import { notifyError } from '../../editor/notice'
import { api } from '../../host/windowApi'

/**
 * 独立版的 preload 一定提供仓库能力;插件 webview 里这个模块根本不会加载。
 * 集中在这里断言,组件里就不用到处写 `api.workspace!`。
 */
export const workspaceApi: WorkspaceApi = api.workspace as WorkspaceApi

/** 独立版:PNG 走系统保存对话框与本地文件写入 */
export const desktopHost: CanvasRuntimeHost = {
  async savePng({ defaultName, defaultDir, bytes }) {
    const target = await api.saveFileDialog({ defaultName, defaultDir, kind: 'png' })
    if (!target) return
    await api.writeFileBytes(target, bytes)
  },
  notifyError
}
