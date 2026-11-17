#!/usr/bin/env node
/**
 * 把 iDraw 打包成 iMark 扩展包(.imkpkg.json)。
 *
 * 两步:
 *   1. Vite 把整个画布应用打成 `imark-plugin/webview/canvas.js` + `canvas.css`;
 *   2. 用 iMark 自己的 `src/shared/extensionPackage.ts` 校验清单并生成信封。
 *
 * 第 2 步刻意**不重写**校验与 integrity 规则:脚本用 esbuild 把那份共享模块打成
 * 无依赖 ESM,再通过 data: URL import。这样打包器与 iMark 应用对“什么算合法包”
 * 永远只有一份实现。
 *
 *   npm run plugin:build
 *   IMARK_ROOT=/path/to/iMark-main npm run plugin:build
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'imark-plugin')
const OUT_DIR = join(ROOT, 'dist', 'imark')
const IMARK_ROOT = resolve(process.env.IMARK_ROOT || join(ROOT, '..', 'iMark-main'))
const SHARED_SOURCE = join(IMARK_ROOT, 'src', 'shared', 'extensionPackage.ts')

if (!existsSync(SHARED_SOURCE)) {
  console.error(
    `[plugin] 找不到 iMark 的共享校验模块：${SHARED_SOURCE}\n` +
      '        请把 iMark 仓库放在 iDraw 的同级目录，或设置 IMARK_ROOT。'
  )
  process.exit(1)
}

const imarkRequire = createRequire(join(IMARK_ROOT, 'package.json'))
const esbuild = imarkRequire('esbuild')

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', '.cache'])
const EXCLUDE_FILE = /(^|\/)(package\.json|tsconfig[^/]*\.json|.*\.(ts|tsx|mts|cts|map))$/

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function buildWebview() {
  const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(vite)) throw new Error(`找不到 Vite：${vite}，请先 npm install`)
  execFileSync(process.execPath, [vite, 'build', '--config', 'vite.webview.config.ts'], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  for (const name of ['canvas.js', 'canvas.css']) {
    const file = join(PLUGIN, 'webview', name)
    if (!existsSync(file)) throw new Error(`webview 构建没有产出 ${name}`)
  }
}

async function bundleMain() {
  const result = await esbuild.build({
    entryPoints: [join(PLUGIN, 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
    // 宿主注入的虚拟模块
    external: ['imark'],
    packages: 'external',
    legalComments: 'eof',
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  return Buffer.from(result.outputFiles[0].text, 'utf8')
}

async function loadSharedValidator() {
  const result = await esbuild.build({
    entryPoints: [SHARED_SOURCE],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    charset: 'utf8',
    loader: { '.json': 'json' }
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)
}

function collectStatic(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name) || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      collectStatic(full, base, out)
      continue
    }
    const rel = relative(base, full).split(/[/\\]/).join('/')
    if (EXCLUDE_FILE.test(rel)) continue
    out.push(rel)
  }
  return out
}

function normalizeEol(name, buf, textExtensions) {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (!textExtensions.has(ext)) return buf
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

const shared = await loadSharedValidator()
const TEXT_EXT = new Set(shared.EXTENSION_TEXT_EXTENSIONS)
const LIMITS = shared.EXTENSION_LIMITS

console.log('[plugin] 构建 webview…')
buildWebview()

const rawManifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
const checked = shared.validateManifest(rawManifest)
for (const warning of checked.warnings ?? []) console.warn(`[plugin] 警告：${warning}`)
if (!checked.ok) {
  console.error(`[plugin] package.json 校验失败：\n  - ${checked.errors.join('\n  - ')}`)
  process.exit(1)
}
const manifest = checked.value
const id = shared.extensionIdOf(manifest)
const entry = shared.entryFileOf(manifest)
const icon = shared.iconFileOf(manifest)

const contents = {}
if (entry) contents[entry] = await bundleMain()
for (const rel of collectStatic(PLUGIN)) contents[rel] = readFileSync(join(PLUGIN, rel))

const files = {}
const data = {}
for (const name of Object.keys(contents).sort()) {
  if (!shared.isSafeRelPath(name)) throw new Error(`非法文件路径 ${name}`)
  const buf = normalizeEol(name, contents[name], TEXT_EXT)
  const limit =
    name === 'README.md'
      ? LIMITS.readmeBytes
      : name === icon
        ? LIMITS.iconBytes
        : LIMITS.fileBytes
  if (buf.byteLength > limit) throw new Error(`${name} 超过 ${limit} 字节上限`)
  files[name] = { encoding: 'base64', size: buf.byteLength, sha256: sha256(buf) }
  data[name] = buf.toString('base64')
}

const integrity = sha256(shared.stableIntegrityInput(manifest, files))
const envelope = {
  format: shared.PACKAGE_FORMAT,
  formatVersion: shared.PACKAGE_FORMAT_VERSION,
  manifest,
  files,
  data,
  integrity
}

const verified = shared.validateEnvelope(envelope)
if (!verified.ok) {
  console.error(`[plugin] 生成的扩展包未通过校验：\n  - ${verified.errors.join('\n  - ')}`)
  process.exit(1)
}

const json = JSON.stringify(envelope)
if (Buffer.byteLength(json) > LIMITS.envelopeBytes) throw new Error('扩展包超过体积上限')

mkdirSync(OUT_DIR, { recursive: true })
const target = join(OUT_DIR, `${id}.imkpkg.json`)
writeFileSync(target, JSON.stringify(envelope, null, 2) + '\n', 'utf8')

console.log(
  `[plugin] ${id} ${manifest.version}\n` +
    `         文件 ${Object.keys(files).join(', ')}\n` +
    `         体积 ${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)} MB\n` +
    `         integrity ${integrity}\n` +
    `         输出 ${relative(ROOT, target)}`
)
