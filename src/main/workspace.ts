import { shell } from 'electron'
import { readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { WorkspaceCanvasEntry, WorkspaceInfo } from '@shared/api'

/** 仓库扫描时跳过的目录:画布不会被藏在这种地方,递归进去只会拖慢打开速度 */
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.git',
  '.svn',
  '.hg',
  '.vscode',
  '.idea',
  '.obsidian'
])

const MAX_DEPTH = 8
const INVALID_NAME = /[\\/:*?"<>|\u0000-\u001f]/
/** Windows 保留设备名:CON.svg / PRN.svg 之类在 Windows 上无法创建 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

async function walkCanvasFiles(
  root: string,
  relDir: string,
  out: WorkspaceCanvasEntry[],
  depth: number,
  recursive: boolean
): Promise<void> {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = await readdir(join(root, relDir), { withFileTypes: true })
  } catch {
    // 子目录不可读(权限/竞态删除)时按空目录处理,不影响仓库里其他画布
    return
  }
  for (const entry of entries) {
    // 不按点前缀过滤:仓库里可能有 `.foo.svg` 或 `.assets/` 这类隐藏文件/目录,
    // 用户需要能在画布列表里看到它们。真正跳过的只有 IGNORED_DIRS 里的工具目录。
    // 不跟随符号链接:仓库根目录之外的文件不应该出现在列表里
    if (entry.isSymbolicLink()) continue
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (recursive && !IGNORED_DIRS.has(entry.name)) {
        await walkCanvasFiles(root, relPath, out, depth + 1, recursive)
      }
    } else if (entry.isFile() && /\.svg$/i.test(entry.name)) {
      out.push({ relPath, name: entry.name })
    }
  }
}

/**
 * 列出仓库里的 `.svg` 画布;目录不存在或不是目录时抛错。
 * 默认只读仓库当前目录;`recursive` 为 true 时才递归子目录
 * (设置 → 布局 → 显示子目录中的 SVG)。
 */
export async function readWorkspace(
  dir: string,
  options?: { recursive?: boolean }
): Promise<WorkspaceInfo> {
  const root = resolve(dir)
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('选择的路径不是文件夹')
  const canvases: WorkspaceCanvasEntry[] = []
  await walkCanvasFiles(root, '', canvases, 0, options?.recursive === true)
  canvases.sort((a, b) =>
    a.relPath.localeCompare(b.relPath, 'zh-CN', { numeric: true, sensitivity: 'base' })
  )
  return { dir: root, name: basename(root) || root, canvases }
}

/** 把用户输入整理成合法的画布文件名(允许省略 `.svg`) */
export function canvasFileName(raw: string): string {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) throw new Error('画布名称不能为空')
  const name = /\.svg$/i.test(trimmed) ? trimmed : `${trimmed}.svg`
  if (name.startsWith('.') || INVALID_NAME.test(name)) {
    throw new Error('画布名称不能包含 \\ / : * ? " < > | 等字符')
  }
  if (RESERVED_NAME.test(name)) throw new Error(`“${name}”是系统保留名称，请换一个`)
  if (name.length > 120) throw new Error('画布名称过长')
  return name
}

/** 把仓库内的相对路径解析成绝对路径,并拒绝跳出仓库的 `..` */
function resolveInWorkspace(root: string, relPath: string): string {
  if (!relPath || isAbsolute(relPath)) throw new Error('画布路径不合法')
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, relPath)
  const rel = relative(resolvedRoot, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('画布路径不在仓库内')
  }
  return target
}

function toRelPath(root: string, absolute: string): string {
  return relative(resolve(root), absolute).replace(/\\/g, '/')
}

async function ensureWorkspaceDir(dir: string): Promise<string> {
  const root = resolve(dir)
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('选择的路径不是文件夹')
  return root
}

/** 在仓库根目录新建画布;目标已存在时拒绝覆盖 */
export async function createWorkspaceCanvas(
  dir: string,
  name: string,
  content: string
): Promise<WorkspaceCanvasEntry> {
  const root = await ensureWorkspaceDir(dir)
  const fileName = canvasFileName(name)
  const target = join(root, fileName)
  try {
    await writeFile(target, content, { flag: 'wx', encoding: 'utf8' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`已存在同名画布:${fileName}`)
    }
    throw err
  }
  return { relPath: toRelPath(root, target), name: fileName }
}

/** 重命名画布:保持所在子目录不变;只改大小写的重命名在 Windows 上允许 */
export async function renameWorkspaceCanvas(
  dir: string,
  fromRelPath: string,
  newName: string
): Promise<WorkspaceCanvasEntry> {
  const root = await ensureWorkspaceDir(dir)
  const source = resolveInWorkspace(root, fromRelPath)
  const fileName = canvasFileName(newName)
  const target = join(dirname(source), fileName)
  if (target === source) {
    return { relPath: toRelPath(root, source), name: basename(source) }
  }
  try {
    await stat(target)
    // 大小写不敏感的文件系统上,「只改大小写」的目标其实就是同一个文件
    const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin'
    const sameFile =
      caseInsensitiveFs && resolve(source).toLowerCase() === resolve(target).toLowerCase()
    if (!sameFile) throw new Error(`已存在同名画布:${fileName}`)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }
  await rename(source, target)
  return { relPath: toRelPath(root, target), name: fileName }
}

/** 删除画布:移到系统回收站,而不是永久删除 */
export async function deleteWorkspaceCanvas(dir: string, relPath: string): Promise<void> {
  const root = await ensureWorkspaceDir(dir)
  await shell.trashItem(resolveInWorkspace(root, relPath))
}
