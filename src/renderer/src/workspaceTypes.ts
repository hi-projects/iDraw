/** 仓库界面的状态与回调类型(只属于独立版外壳)。 */
import type { WorkspaceCanvasEntry } from '@shared/api'

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'error'

export type CanvasMutationResult =
  | { ok: true; entry?: WorkspaceCanvasEntry }
  | { ok: false; error?: string; cancelled?: boolean }

/** 仓库里下一个可用的默认画布名(不含 .svg) */
export function nextCanvasName(canvases: readonly WorkspaceCanvasEntry[]): string {
  const used = new Set(canvases.map(item => item.name.toLowerCase()))
  let index = 1
  let name = '未命名画布'
  while (used.has(`${name}.svg`.toLowerCase())) {
    index += 1
    name = `未命名画布 ${index}`
  }
  return name
}
