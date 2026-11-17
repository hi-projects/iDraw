/**
 * 画布引擎需要宿主提供的能力。
 *
 * 引擎只负责生成内容(例如 PNG bytes),保存到哪个对话框、用什么错误提示由
 * 独立版 / iMark 插件各自实现。这样 `src/engine` 不依赖任何应用外壳。
 */

export interface SavePngRequest {
  /** 默认文件名,含 `.png` */
  defaultName: string
  /** 当前画布所在目录;没有当前文件时省略 */
  defaultDir?: string
  bytes: Uint8Array
}

export interface CanvasRuntimeHost {
  /** 选保存位置并写入;用户取消时正常返回 */
  savePng(request: SavePngRequest): Promise<void>
  notifyError(action: string, err: unknown): void
}
