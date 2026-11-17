import { app } from 'electron'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { RecentEntry, RecentKind } from '@shared/api'

/**
 * 最近打开的仓库与单张画布。
 *
 * 存在 userData 下,和窗口状态一样属于「这台机器上的使用习惯」,不放仓库目录里 ——
 * 画布文件本身要保持干净,不能多出应用私有的列表文件。
 */
interface RecentsFile {
  entries?: RecentEntry[]
  /** 旧版本只记仓库目录,读取时迁移成 entries */
  workspaces?: string[]
}

const MAX_RECENTS = 20
let cache: RecentEntry[] | null = null
/** 串行化写盘:同时发生的打开/移除不会互相覆盖 */
let writeChain: Promise<void> = Promise.resolve()

function storePath(): string {
  return join(app.getPath('userData'), 'workspaces.json')
}

function normalizeKey(entry: RecentEntry): string {
  const path = resolve(entry.path)
  return `${entry.kind}:${process.platform === 'win32' ? path.toLowerCase() : path}`
}

function normalizeEntry(raw: unknown): RecentEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const kind = (raw as { kind?: unknown }).kind
  const path = (raw as { path?: unknown }).path
  if ((kind !== 'workspace' && kind !== 'file') || typeof path !== 'string' || !path) {
    return null
  }
  return { kind, path: resolve(path) }
}

function dedupe(entries: RecentEntry[]): RecentEntry[] {
  const seen = new Set<string>()
  const out: RecentEntry[] = []
  for (const entry of entries) {
    const key = normalizeKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

async function load(): Promise<RecentEntry[]> {
  if (cache) return cache
  try {
    const raw = await readFile(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as RecentsFile
    if (Array.isArray(parsed.entries)) {
      cache = dedupe(
        parsed.entries
          .map(normalizeEntry)
          .filter((entry): entry is RecentEntry => entry !== null)
      ).slice(0, MAX_RECENTS)
    } else if (Array.isArray(parsed.workspaces)) {
      // 旧格式迁移:当时只会记录仓库目录
      cache = dedupe(
        parsed.workspaces
          .filter(path => typeof path === 'string' && path)
          .map(path => ({ kind: 'workspace' as const, path: resolve(path) }))
      ).slice(0, MAX_RECENTS)
    } else {
      cache = []
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      // 文件损坏时按空列表启动,不要让它阻止应用打开仓库选择页
      console.error('[iDraw] 读取最近打开失败:', err)
    }
    cache = []
  }
  return cache
}

function persist(): Promise<void> {
  const snapshot = [...(cache ?? [])]
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      const target = storePath()
      await mkdir(dirname(target), { recursive: true })
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`
      try {
        await writeFile(temp, JSON.stringify({ entries: snapshot }, null, 2), 'utf8')
        await rename(temp, target)
      } catch (err) {
        await rm(temp, { force: true }).catch(() => undefined)
        console.error('[iDraw] 保存最近打开失败:', err)
      }
    })
  return writeChain
}

async function push(entry: RecentEntry): Promise<void> {
  const normalized: RecentEntry = { kind: entry.kind, path: resolve(entry.path) }
  const list = await load()
  const key = normalizeKey(normalized)
  cache = [normalized, ...list.filter(item => normalizeKey(item) !== key)].slice(0, MAX_RECENTS)
  await persist()
}

export async function recentEntries(): Promise<RecentEntry[]> {
  return [...(await load())]
}

/** 打开仓库时调用:移到列表最前;目录不存在时报错,不写入列表 */
export async function touchWorkspace(dir: string): Promise<void> {
  const path = resolve(dir)
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error('选择的路径不是文件夹')
  await push({ kind: 'workspace', path })
}

/** 单独打开一张画布时调用:移到列表最前;文件不存在时报错 */
export async function touchFile(file: string): Promise<void> {
  const path = resolve(file)
  const info = await stat(path)
  if (!info.isFile()) throw new Error('选择的路径不是文件')
  await push({ kind: 'file', path })
}

export async function forgetRecent(kind: RecentKind, path: string): Promise<void> {
  const list = await load()
  const key = normalizeKey({ kind, path })
  const next = list.filter(item => normalizeKey(item) !== key)
  if (next.length === list.length) return
  cache = next
  await persist()
}

/**
 * 清理已经不存在的项。
 *
 * 只有 ENOENT / ENOTDIR 算「没了」;EACCES、EBUSY、网络盘超时这类无法判定的
 * 错误必须保留原条目 —— 一次临时故障不该把用户记了很久的仓库删掉。
 */
export async function pruneRecentEntries(): Promise<RecentEntry[]> {
  const list = await load()
  const missing = await Promise.all(
    list.map(entry =>
      stat(entry.path).then(
        info => (entry.kind === 'workspace' ? !info.isDirectory() : !info.isFile()),
        (err: NodeJS.ErrnoException) => err.code === 'ENOENT' || err.code === 'ENOTDIR'
      )
    )
  )
  const next = list.filter((_, i) => !missing[i])
  if (next.length !== list.length) {
    cache = next
    await persist()
  }
  return [...next]
}
