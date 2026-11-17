import type { CanvasRuntimeHost } from '../engine/host'
import { notifyError } from '../editor/notice'
import { api } from '../host/windowApi'

/** iMark 插件:同一个 WindowApi,但请求由 bridge 转给 iMark 主进程 */
export const imarkHost: CanvasRuntimeHost = {
  async savePng({ defaultName, defaultDir, bytes }) {
    const target = await api.saveFileDialog({ defaultName, defaultDir, kind: 'png' })
    if (!target) return
    await api.writeFileBytes(target, bytes)
  },
  notifyError
}
