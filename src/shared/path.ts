/** 路径与文件名的小工具。文件系统路径可能来自 Windows,分隔符两种都要认。 */

export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function dirNameOf(path: string): string | undefined {
  const i = path.search(/[\\/][^\\/]*$/)
  return i < 0 ? undefined : path.slice(0, i)
}

/** `流程图.svg` → `流程图`;没有扩展名时原样返回 */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}
