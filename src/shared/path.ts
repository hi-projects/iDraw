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

/** 拼接目录与相对路径;分隔符跟随目录本身的风格 */
export function joinPath(dir: string, relPath: string): string {
  const base = dir.replace(/[\\/]+$/, '')
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base}${sep}${relPath.replace(/[\\/]+/g, sep)}`
}

/**
 * `child` 在 `parent` 里时返回相对路径(保持原大小写,`/` 分隔),否则返回 null。
 * 只做字符串比较,不碰文件系统 —— 拖放文件和判断当前画布是否属于仓库时用。
 */
export function relativePathOf(parent: string, child: string): string | null {
  const p = parent.replace(/\\/g, '/').replace(/\/+$/, '')
  const c = child.replace(/\\/g, '/').replace(/\/+$/, '')
  // Windows 路径大小写不敏感;Unix 上保留大小写比较
  const caseInsensitive = /^[a-zA-Z]:\//.test(p)
  const pp = caseInsensitive ? p.toLowerCase() : p
  const cc = caseInsensitive ? c.toLowerCase() : c
  if (cc === pp) return ''
  if (!cc.startsWith(`${pp}/`)) return null
  return c.slice(p.length + 1)
}
