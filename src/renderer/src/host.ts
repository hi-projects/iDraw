import type { CanvasRuntimeHost } from '../../engine/host'
import { notifyError } from '../../editor/notice'
import { api } from '../../host/windowApi'

/** 独立版:PNG 走系统保存对话框与本地文件写入 */
export const desktopHost: CanvasRuntimeHost = {
  async savePng({ defaultName, defaultDir, bytes }) {
    const target = await api.saveFileDialog({ defaultName, defaultDir, kind: 'png' })
    if (!target) return
    await api.writeFileBytes(target, bytes)
  },
  notifyError
}
