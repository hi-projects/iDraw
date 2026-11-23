/*
 * iDraw 冒烟验收：直接加载构建好的渲染层页面，用桩 IPC 走一遍
 * 新建 → 画形状/连线 → 拖动 → 撤销/重做 → 保存 → 重开 → 外部 SVG 只读 → 导出 PNG。
 *
 * 运行：
 *   npm run build
 *   xvfb-run -a env -u ELECTRON_RUN_AS_NODE npx electron verify/smoke.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'idraw-smoke-'))
// 每次冒烟用干净的 userData,避免上一次留下的 localStorage 偏好影响断言
app.setPath('userData', path.join(TMP, 'userdata'))
const SAVED = path.join(TMP, 'diagram.svg')
const FOREIGN = path.join(TMP, 'foreign.svg')
const PNG = path.join(TMP, 'diagram.png')
const WORKSPACE = path.join(TMP, 'workspace')
fs.mkdirSync(WORKSPACE)
// 用于验证应用内文件夹浏览器默认能看到点前缀目录
// (目录里的 SVG 由 workspace:list-dirs 桩按需返回,避免影响仓库本身的画布数量)
fs.mkdirSync(path.join(WORKSPACE, '.hidden-dir'))
// 用于验证「是否显示子目录中的 SVG」设置
fs.mkdirSync(path.join(WORKSPACE, 'nested'))
fs.writeFileSync(
  path.join(WORKSPACE, 'nested', 'nested.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><circle cx="60" cy="40" r="30" fill="#0969da"/></svg>'
)

fs.writeFileSync(
  FOREIGN,
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><circle cx="60" cy="40" r="30" fill="#0969da"/></svg>'
)

let savedContent = null
let pngWritten = false
let writeCalls = 0
let recents = []

function readWorkspaceStub(dir, recursive = false) {
  const canvases = []
  const walk = (current, relDir) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      // 与主进程 readWorkspace 保持一致:隐藏文件/目录也列出来,
      // 且只有 recursive 打开时才进入子目录
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (recursive) walk(path.join(current, entry.name), relPath)
      } else if (entry.isFile() && /\.svg$/i.test(entry.name)) {
        canvases.push({ relPath, name: entry.name })
      }
    }
  }
  walk(dir, '')
  canvases.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { dir, name: path.basename(dir), canvases }
}

function canvasNameOf(raw) {
  return /\.svg$/i.test(raw) ? raw : `${raw}.svg`
}

ipcMain.handle('app:take-pending-open-file', () => null)
ipcMain.handle('app:confirm-discard', () => 'discard')
ipcMain.handle('file:open-dialog', () => FOREIGN)
ipcMain.handle('file:save-dialog', (_e, options) => (options.kind === 'png' ? PNG : SAVED))
ipcMain.handle('file:read', (_e, file) => fs.readFileSync(file, 'utf8'))
ipcMain.handle('file:write', (_e, payload) => {
  fs.writeFileSync(payload.path, payload.content)
  savedContent = payload.content
  writeCalls += 1
})
ipcMain.on('file:write-sync', (event, payload) => {
  fs.writeFileSync(payload.path, payload.content)
  event.returnValue = true
})
ipcMain.handle('file:write-bytes', (_e, payload) => {
  fs.writeFileSync(payload.path, Buffer.from(payload.data))
  pngWritten = true
})

// ---- 仓库 IPC 的桩实现:用真实文件系统,便于断言自动保存写盘 ----
ipcMain.handle('workspace:pick-directory', () => WORKSPACE)
ipcMain.handle('workspace:list-dirs', (_e, dir) => {
  const root = dir || WORKSPACE
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    /* 不存在就按空目录 */
  }
  const byName = (a, b) => a.name.localeCompare(b.name)
  const dirs = entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      name: entry.name,
      path: path.join(root, entry.name),
      hidden: entry.name.startsWith('.')
    }))
    .sort(byName)
  const files = entries
    .filter(entry => entry.isFile() && /\.svg$/i.test(entry.name))
    .map(entry => ({
      name: entry.name,
      path: path.join(root, entry.name),
      hidden: entry.name.startsWith('.')
    }))
    .sort(byName)
  if (path.basename(root) === '.hidden-dir') {
    files.push({ name: 'hidden.svg', path: path.join(root, 'hidden.svg'), hidden: false })
  }
  return { dir: root, parent: path.dirname(root), dirs, files }
})
ipcMain.handle('workspace:read', (_e, payload) =>
  readWorkspaceStub(payload.dir, payload.recursive === true)
)
ipcMain.handle('workspace:create-canvas', (_e, payload) => {
  const name = canvasNameOf(payload.name)
  fs.writeFileSync(path.join(payload.dir, name), payload.content, { flag: 'wx' })
  return { relPath: name, name }
})
ipcMain.handle('workspace:rename-canvas', (_e, payload) => {
  const name = canvasNameOf(payload.name)
  const target = path.join(payload.dir, name)
  fs.renameSync(path.join(payload.dir, payload.from), target)
  return { relPath: name, name }
})
ipcMain.handle('workspace:delete-canvas', (_e, payload) => {
  fs.unlinkSync(path.join(payload.dir, payload.relPath))
})
ipcMain.handle('workspace:confirm-delete', () => true)
ipcMain.handle('workspace:recents', () => recents)
ipcMain.handle('workspace:prune-recents', () =>
  recents.filter(entry => {
    try {
      const info = fs.statSync(entry.path)
      return entry.kind === 'workspace' ? info.isDirectory() : info.isFile()
    } catch {
      return false
    }
  })
)
ipcMain.handle('workspace:touch', (_e, payload) => {
  recents = [
    { kind: 'workspace', path: payload.dir },
    ...recents.filter(entry => !(entry.kind === 'workspace' && entry.path === payload.dir))
  ]
})
ipcMain.handle('workspace:touch-file', (_e, payload) => {
  recents = [
    { kind: 'file', path: payload.path },
    ...recents.filter(entry => !(entry.kind === 'file' && entry.path === payload.path))
  ]
})
ipcMain.handle('workspace:forget', (_e, payload) => {
  recents = recents.filter(
    entry => !(entry.kind === payload.kind && entry.path === payload.path)
  )
})

const failures = []
function check(name, ok, detail) {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`)
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(wc, expression, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await wc.executeJavaScript(expression)) return true
    await wait(50)
  }
  return false
}

function js(wc, code) {
  return wc.executeJavaScript(code, true)
}

async function main() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'out/preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const wc = win.webContents
  wc.on('console-message', (...args) => {
    const details = args[1]
    if (details && typeof details === 'object') {
      const d = details
      if (d.level === 'error' || d.level === 'warning') {
        console.log(`[renderer:${d.level}] ${d.message} @${d.lineNumber}`)
      }
    }
  })

  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'))
  await waitFor(wc, "!!document.querySelector('.workspace-picker')")

  console.log('[1] 启动:仓库选择页')
  check('启动页是仓库选择页', await waitFor(wc, "!!document.querySelector('.workspace-picker')"))
  check(
    '有新建/打开入口',
    await waitFor(wc, "!!document.querySelector('.workspace-recent-add-slot button')")
  )
  check('启动时还没有创建画布', await js(wc, "!document.querySelector('.canvas-surface')"))
  check('窗口标题为 iDraw', (await js(wc, 'document.title')).includes('iDraw'))

  console.log('[2] 临时画布:用形状工具创建 5 个节点')
  await js(wc, "document.querySelector('.workspace-recent-add-slot button').click()")
  check('加号菜单出现', await waitFor(wc, "!!document.querySelector('.workspace-recent-empty-menu')"))
  check(
    '选择页入口显示为新建画布',
    await js(
      wc,
      "document.querySelector('[data-action=temporary-canvas]').textContent.includes('新建画布')"
    )
  )
  await js(wc, "document.querySelector('[data-action=temporary-canvas]').click()")
  check('进入临时画布', await waitFor(wc, "!!document.querySelector('.canvas-surface')"))
  await wait(150)
  check(
    '进入临时画布默认显示新建画布界面',
    await waitFor(wc, "!!document.querySelector('.canvas-new-card')")
  )
  await js(wc, "document.querySelector('.canvas-blank-btn').click()")
  check(
    '选择空白画布后卡片收起',
    await waitFor(wc, "!document.querySelector('.canvas-new-card')")
  )
  check(
    '默认缩放为 100%',
    await waitFor(wc, "document.querySelector('.canvas-zoom-label')?.textContent.trim() === '100%'")
  )
  check(
    '临时画布不显示工具栏新建按钮',
    await js(wc, "!document.querySelector('.canvas-new-btn')")
  )
  check(
    '左上角应用菜单已移除',
    await js(wc, "!document.querySelector('.canvas-app-menu-btn')")
  )
  check(
    '状态栏有全局菜单按钮',
    await js(wc, "!!document.querySelector('.idraw-statusbar .idraw-status-actions .idraw-corner-btn')")
  )
  check(
    '状态栏有返回画布总览图标',
    await js(wc, "!!document.querySelector('.idraw-statusbar [data-action=back-overview]')")
  )
  check(
    '返回图标在齿轮右侧',
    await js(
      wc,
      `(() => {
        const actions = document.querySelector('.idraw-status-actions')
        const gear = actions?.querySelector('.idraw-corner-btn')
        const back = actions?.querySelector('[data-action=back-overview]')
        if (!gear || !back) return false
        return (gear.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      })()`
    )
  )
  await js(wc, "document.querySelector('.idraw-statusbar .idraw-corner-btn').click()")
  check('状态栏菜单出现', await waitFor(wc, "!!document.querySelector('.idraw-corner-menu')"))
  check(
    '菜单包含保存/导出/撤销/重做/设置',
    await js(wc, "document.querySelectorAll('.idraw-corner-menu-item').length === 5")
  )
  check(
    '菜单含设置入口',
    await js(wc, "!!document.querySelector('[data-action=open-settings]')")
  )
  check(
    '画布操作与设置之间有分隔线',
    await js(wc, "document.querySelectorAll('.idraw-corner-sep').length === 2")
  )
  await js(wc, "document.querySelector('.idraw-corner-mask').click()")
  check('点击空白处关闭菜单', await js(wc, "!document.querySelector('.idraw-corner-menu')"))

  await js(wc, `document.querySelector('[data-action=toggle-shapes]').click()`)
  check('左侧形状面板滑出', await waitFor(wc, "!!document.querySelector('.shape-panel')"))
  check(
    '形状面板包含新增形状',
    await js(
      wc,
      "['三角形','星形','箭头','十字'].every(label => [...document.querySelectorAll('.shape-item')].some(b => b.textContent.trim() === label))"
    )
  )
  await js(wc, "document.querySelector('.shape-panel-close').click()")
  check('关闭形状面板', await waitFor(wc, "!document.querySelector('.shape-panel')"))

  // 拖画时的预览要按选中的形状渲染(选菱形 → 预览是 polygon,不是矩形)
  await js(wc, "document.querySelector('[data-action=toggle-shapes]').click()")
  await waitFor(wc, "!!document.querySelector('.shape-panel')")
  await js(wc, `(() => {
    const item = [...document.querySelectorAll('.shape-item')].find(b => b.textContent.trim() === '菱形')
    item.click()
  })()`)
  await wait(80)
  const previewShape = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const r = surface.getBoundingClientRect()
      const x = r.left + 180, y = r.top + 160
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true, pointerType: 'mouse'
      }))
      fire('pointerdown', x, y, 1)
      fire('pointermove', x + 120, y + 80, 1)
      const host = document.querySelector('.canvas-create-preview-shape')
      const result = { preview: !!host, tag: host?.firstElementChild?.tagName ?? null }
      // Esc 取消这次拖画,不留下节点
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return result
    })()`
  )
  check(
    '拖画预览按选中形状渲染',
    previewShape.preview && previewShape.tag === 'polygon',
    previewShape
  )

  /** 选「形状 → 矩形」后在指定世界坐标点一下,生成一个默认尺寸的节点 */
  const placeRect = async (wx, wy) => {
    await js(wc, `document.querySelector('[data-action=toggle-shapes]').click()`)
    await waitFor(wc, "!!document.querySelector('.shape-panel')")
    await js(wc, `(() => {
      const item = [...document.querySelectorAll('.shape-item')].find(b => b.textContent.trim() === '矩形')
      item.click()
    })()`)
    await wait(80)
    await js(
      wc,
      `(() => {
        const surface = document.querySelector('.canvas-surface')
        const world = document.querySelector('.canvas-world')
        const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(world.getAttribute('transform'))
        const tx = +m[1], ty = +m[2], scale = +m[3]
        const r = surface.getBoundingClientRect()
        const x = r.left + tx + ${wx} * scale
        const y = r.top + ty + ${wy} * scale
        const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: px, clientY: py,
          button: 0, buttons, pointerId: 1, isPrimary: true, pointerType: 'mouse'
        }))
        fire('pointerdown', x, y, 1)
        fire('pointerup', x, y, 0)
      })()`
    )
    await wait(60)
  }

  for (const [wx, wy] of [[400, 200], [700, 200], [1000, 200], [400, 450], [700, 450]]) {
    await placeRect(wx, wy)
  }
  check(
    '创建了 5 个节点',
    await waitFor(wc, "document.querySelectorAll('[data-idraw-node]').length === 5")
  )

  /** 从第 a 个节点的东侧锚点拖到第 b 个节点中心,创建一条连线 */
  const connectNodes = async (a, b) => {
    await js(
      wc,
      `(() => {
        const surface = document.querySelector('.canvas-surface')
        const world = document.querySelector('.canvas-world')
        const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(world.getAttribute('transform'))
        const tx = +m[1], ty = +m[2], scale = +m[3]
        const r = surface.getBoundingClientRect()
        const toClient = (x, y) => ({ x: r.left + tx + x * scale, y: r.top + ty + y * scale })
        const info = el => {
          const mm = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(el.getAttribute('transform'))
          const box = el.getBBox()
          return { x: +mm[1], y: +mm[2], w: box.width, h: box.height }
        }
        const nodes = [...document.querySelectorAll('[data-idraw-node]')]
        const from = info(nodes[${a}])
        const to = info(nodes[${b}])
        const fire = (type, p, buttons) => surface.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
          button: 0, buttons, pointerId: 1, isPrimary: true, pointerType: 'mouse'
        }))
        // 先悬浮在东侧锚点上让锚点出现,再从该锚点拖到目标节点
        // (悬浮节点中心可能正好压着上一条连线的端点手柄)
        fire('pointermove', toClient(from.x + from.w, from.y + from.h / 2), 0)
        fire('pointerdown', toClient(from.x + from.w, from.y + from.h / 2), 1)
        fire('pointermove', toClient(to.x + to.w / 2, to.y + to.h / 2), 1)
        fire('pointerup', toClient(to.x + to.w / 2, to.y + to.h / 2), 0)
      })()`
    )
    await wait(60)
  }

  for (const [a, b] of [[0, 1], [1, 2], [0, 3], [3, 4]]) {
    await connectNodes(a, b)
  }
  check(
    '连接出 4 条连线',
    await waitFor(wc, "document.querySelectorAll('[data-idraw-edge]').length === 4")
  )
  check('修改后标题带脏点', (await js(wc, 'document.title')).startsWith('● '))

  console.log('[2.5] 连线属性面板')
  check(
    '连线面板分为连线/标签/箭头',
    await js(
      wc,
      `(() => {
        const titles = [...document.querySelectorAll('.canvas-style-section-title')].map(e => e.textContent.trim())
        return ['连线', '标签', '箭头'].every(t => titles.includes(t))
      })()`
    )
  )
  check(
    '连线方式显示为三个图标',
    await js(
      wc,
      "document.querySelectorAll('.canvas-style-seg[aria-label=\"连线方式\"] .canvas-style-toggle').length === 3"
    )
  )
  check(
    '箭头方向显示为四个图标',
    await js(
      wc,
      "document.querySelectorAll('.canvas-style-seg[aria-label=\"箭头方向\"] .canvas-style-toggle').length === 4"
    )
  )
  check(
    '箭头样式显示为两个图标',
    await js(
      wc,
      "document.querySelectorAll('.canvas-style-seg[aria-label=\"箭头样式\"] .canvas-style-toggle').length === 2"
    )
  )

  const clickInGroup = (group, label) =>
    js(
      wc,
      `document.querySelector('.canvas-style-seg[aria-label="${group}"] button[aria-label="${label}"]')?.click()`
    )
  const groupActive = (group) =>
    js(
      wc,
      `(() => {
        const seg = document.querySelector('.canvas-style-seg[aria-label="${group}"]')
        return [...(seg?.querySelectorAll('button') ?? [])]
          .filter(b => b.classList.contains('active'))
          .map(b => b.getAttribute('aria-label'))
      })()`
    )

  await clickInGroup('连线方式', '直线')
  await wait(250)
  let activeIcons = await groupActive('连线方式')
  check('切到直线后对应图标高亮', activeIcons.includes('直线') && !activeIcons.includes('正交'), activeIcons)

  await clickInGroup('箭头方向', '双向')
  await wait(250)
  activeIcons = await groupActive('箭头方向')
  check('切到双向后对应图标高亮', activeIcons.includes('双向'), activeIcons)
  check(
    '双向箭头同时有起点/终点 marker',
    await js(
      wc,
      `[...document.querySelectorAll('[data-idraw-edge]')].some(
        p => (p.getAttribute('marker-start') || '').includes('url') && (p.getAttribute('marker-end') || '').includes('url')
      )`
    )
  )

  await clickInGroup('箭头样式', '空心箭头')
  await wait(250)
  activeIcons = await groupActive('箭头样式')
  check('切到空心后对应图标高亮', activeIcons.includes('空心箭头'), activeIcons)
  check(
    '空心箭头使用 hollow marker',
    await js(wc, "!!document.querySelector('[data-idraw-edge][marker-end*=\"hollow\"]')")
  )

  check(
    '箭头大小默认为 9',
    await js(wc, "document.querySelector('.canvas-arrow-size')?.value === '9'")
  )

  await js(
    wc,
    `(() => {
      const input = document.querySelector('.canvas-arrow-size')
      if (!input) return false
      input.value = '14'
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  await wait(250)
  check(
    '箭头大小可调',
    await js(
      wc,
      `(() => {
        const path = [...document.querySelectorAll('[data-idraw-edge]')]
          .find(p => (p.getAttribute('marker-end') || '').includes('hollow'))
        if (!path) return false
        const id = (path.getAttribute('marker-end') || '').match(/#([^)]+)/)?.[1]
        return !!id && document.getElementById(id)?.getAttribute('markerWidth') === '14'
      })()`
    )
  )

  check(
    '标签支持加粗/倾斜',
    await js(
      wc,
      "!!document.querySelector('[aria-label=\"标签加粗\"]') && !!document.querySelector('[aria-label=\"标签倾斜\"]')"
    )
  )
  await js(wc, "document.querySelector('[aria-label=\"标签加粗\"]')?.click()")
  await wait(180)
  check(
    '标签加粗可切换',
    await js(wc, "document.querySelector('[aria-label=\"标签加粗\"]')?.classList.contains('active')")
  )
  await js(wc, "document.querySelector('[aria-label=\"标签倾斜\"]')?.click()")
  await wait(180)
  check(
    '标签倾斜可切换',
    await js(wc, "document.querySelector('[aria-label=\"标签倾斜\"]')?.classList.contains('active')")
  )

  console.log('[2.6] 拖动连线端点')
  // 点连线中点选中它,选中后应出现两端手柄
  await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const edge = document.querySelector('[data-idraw-edge]')
      if (!edge) return false
      const pt = edge.getPointAtLength(edge.getTotalLength() / 2)
      const screen = pt.matrixTransform(edge.getScreenCTM())
      const fire = (type, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: screen.x, clientY: screen.y,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', 1)
      fire('pointerup', 0)
      return true
    })()`
  )
  check(
    '选中连线后显示两个端点手柄',
    await waitFor(wc, "document.querySelectorAll('[data-edge-end]').length === 2")
  )

  // 拖动标签框:标签沿路径移动,路径本身不变
  const labelDrag = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const svg = document.querySelector('.canvas-surface svg')
      const box = document.querySelector('.canvas-edge-box')
      const edge = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      if (!svg || !box || !edge) return { ok: false, reason: 'no-box' }
      const br = svg.getBoundingClientRect()
      const boxRect = {
        x: Number(box.getAttribute('x')),
        y: Number(box.getAttribute('y')),
        w: Number(box.getAttribute('width')),
        h: Number(box.getAttribute('height'))
      }
      // 从标签框偏右的位置起拖:框中心可能与折点手柄重合,折点优先命中
      const start = {
        x: br.left + boxRect.x + boxRect.w / 2 + Math.min(12, boxRect.w / 4),
        y: br.top + boxRect.y + boxRect.h / 2
      }
      const target = edge.getPointAtLength(edge.getTotalLength() * 0.25)
      const ts = target.matrixTransform(edge.getScreenCTM())
      const dBefore = edge.getAttribute('d')
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', start.x, start.y, 1)
      fire('pointermove', ts.x, ts.y, 1)
      fire('pointerup', ts.x, ts.y, 0)
      const box2 = document.querySelector('.canvas-edge-box')
      const edge2 = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      if (!box2 || !edge2) return { ok: false, reason: 'lost' }
      const center = {
        x: Number(box2.getAttribute('x')) + Number(box2.getAttribute('width')) / 2,
        y: Number(box2.getAttribute('y')) + Number(box2.getAttribute('height')) / 2
      }
      return {
        ok: true,
        target: { x: ts.x - br.left, y: ts.y - br.top },
        center,
        pathUnchanged: dBefore === edge2.getAttribute('d')
      }
    })()`
  )
  check(
    '拖动标签框让标签沿路径移动',
    labelDrag.ok &&
      Math.abs(labelDrag.center.x - labelDrag.target.x) < 2 &&
      Math.abs(labelDrag.center.y - labelDrag.target.y) < 2 &&
      labelDrag.pathUnchanged,
    labelDrag
  )

  // 标签编辑框:有可见边框,文字靠上下等量内边距垂直居中
  const labelEditor = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const box = document.querySelector('.canvas-edge-box')
      const svg = document.querySelector('.canvas-surface svg')
      if (!box || !svg) return { ok: false, reason: 'no-box' }
      const br = svg.getBoundingClientRect()
      const cx = br.left + Number(box.getAttribute('x')) + Number(box.getAttribute('width')) / 2
      const cy = br.top + Number(box.getAttribute('y')) + Number(box.getAttribute('height')) / 2
      surface.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, clientX: cx, clientY: cy
      }))
      const ta = document.querySelector('.canvas-text-editor')
      if (!ta) return { ok: false, reason: 'no-editor' }
      const style = getComputedStyle(ta)
      return {
        ok: true,
        labelClass: ta.classList.contains('canvas-text-editor-label'),
        borderWidth: parseFloat(style.borderTopWidth),
        paddingTop: parseFloat(style.paddingTop)
      }
    })()`
  )
  check(
    '标签编辑框有边框且文字垂直居中',
    labelEditor.ok &&
      labelEditor.labelClass &&
      labelEditor.borderWidth >= 1 &&
      labelEditor.paddingTop > 0,
    labelEditor
  )
  await js(wc, "document.querySelector('.canvas-text-editor')?.blur()")
  await wait(100)

  const edgeD = () =>
    js(
      wc,
      "document.querySelector('[data-idraw-edge].canvas-edge-selected')?.getAttribute('d') ?? null"
    )
  const dBefore = await edgeD()
  await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const svg = document.querySelector('.canvas-surface svg')
      const handle = document.querySelector('[data-edge-end="to"]')
      if (!svg || !handle) return false
      const r = svg.getBoundingClientRect()
      const cx = r.left + Number(handle.getAttribute('cx'))
      const cy = r.top + Number(handle.getAttribute('cy'))
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', cx, cy, 1)
      fire('pointermove', cx + 80, cy + 60, 1)
      fire('pointerup', cx + 80, cy + 60, 0)
      return true
    })()`
  )
  await wait(150)
  const dAfter = await edgeD()
  check('拖动端点改变了连线路径', !!dBefore && !!dAfter && dBefore !== dAfter, {
    before: dBefore,
    after: dAfter
  })
  wc.send('app:menu-command', 'edit:undo')
  await wait(150)
  check('撤销恢复连线路径', (await edgeD()) === dBefore)

  // 端点可以停在形状上的任意位置:拖到第二个节点内部 30%/80% 处,路径终点应精确落在落点
  const freeEnd = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const svg = document.querySelector('.canvas-surface svg')
      const world = document.querySelector('.canvas-world')
      const wm = /translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(world.getAttribute('transform'))
      if (!wm) return { ok: false, reason: 'no-world' }
      const tx = +wm[1], ty = +wm[2], scale = +wm[3]
      const sr = surface.getBoundingClientRect()
      const toClient = (x, y) => ({ x: sr.left + tx + x * scale, y: sr.top + ty + y * scale })
      const target = document.querySelectorAll('[data-idraw-node]')[1]
      const nm = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(target.getAttribute('transform'))
      const box = target.getBBox()
      const drop = { x: +nm[1] + box.width * 0.3, y: +nm[2] + box.height * 0.8 }
      const handle = document.querySelector('[data-edge-end="to"]')
      if (!handle) return { ok: false, reason: 'no-handle' }
      const br = svg.getBoundingClientRect()
      const cx = br.left + Number(handle.getAttribute('cx'))
      const cy = br.top + Number(handle.getAttribute('cy'))
      const p = toClient(drop.x, drop.y)
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', cx, cy, 1)
      fire('pointermove', p.x, p.y, 1)
      fire('pointerup', p.x, p.y, 0)
      const edge = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      if (!edge) return { ok: false, reason: 'not-selected' }
      const end = edge.getPointAtLength(edge.getTotalLength())
      return { ok: true, drop, end: { x: end.x, y: end.y } }
    })()`
  )
  check(
    '端点可停在形状上的任意位置',
    freeEnd.ok &&
      Math.abs(freeEnd.end.x - freeEnd.drop.x) < 0.05 &&
      Math.abs(freeEnd.end.y - freeEnd.drop.y) < 0.05,
    freeEnd
  )

  // 靠近形状边缘时吸附到轮廓:把起点拖到第一个节点上边缘内侧 3px(远离中点锚点),
  // 应精确落到上边缘的最近点
  const edgeSnapped = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const world = document.querySelector('.canvas-world')
      const wm = /translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(world.getAttribute('transform'))
      if (!wm) return { ok: false, reason: 'no-world' }
      const tx = +wm[1], ty = +wm[2], scale = +wm[3]
      const sr = surface.getBoundingClientRect()
      const toClient = (x, y) => ({ x: sr.left + tx + x * scale, y: sr.top + ty + y * scale })
      const node = document.querySelectorAll('[data-idraw-node]')[0]
      const nm = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(node.getAttribute('transform'))
      const box = node.getBBox()
      // 取靠近左上角的一段上边缘:按「中心方向」判断会从左侧水平离开,
      // 按「最近轮廓边」判断应该垂直向上离开
      const edge = { x: +nm[1] + box.width * 0.1, y: +nm[2] }
      const handle = document.querySelector('[data-edge-end="from"]')
      if (!handle) return { ok: false, reason: 'no-handle' }
      const svg = document.querySelector('.canvas-surface svg')
      const br = svg.getBoundingClientRect()
      const cx = br.left + Number(handle.getAttribute('cx'))
      const cy = br.top + Number(handle.getAttribute('cy'))
      // 上边缘内侧 3px:在边缘吸附阈值内、离中点锚点足够远
      const near = toClient(edge.x, edge.y + 3)
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', cx, cy, 1)
      fire('pointermove', near.x, near.y, 1)
      fire('pointerup', near.x, near.y, 0)
      const selected = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      if (!selected) return { ok: false, reason: 'not-selected' }
      const start = selected.getPointAtLength(0)
      const nearStart = selected.getPointAtLength(4)
      return {
        ok: true,
        edge,
        start: { x: start.x, y: start.y },
        nearStart: { x: nearStart.x, y: nearStart.y }
      }
    })()`
  )
  check(
    '端点靠近形状边缘时吸附到轮廓',
    edgeSnapped.ok &&
      Math.abs(edgeSnapped.start.x - edgeSnapped.edge.x) < 0.05 &&
      Math.abs(edgeSnapped.start.y - edgeSnapped.edge.y) < 0.05,
    edgeSnapped
  )
  check(
    '从轮廓吸附点垂直离开,不贴着形状边',
    edgeSnapped.ok && Math.abs(edgeSnapped.nearStart.x - edgeSnapped.start.x) < 0.5,
    edgeSnapped
  )

  // 靠近特殊点时仍然要吸附:把起点拖到第一个节点下边锚点旁 3px,应精确落到锚点
  const snappedEnd = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const world = document.querySelector('.canvas-world')
      const wm = /translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(world.getAttribute('transform'))
      if (!wm) return { ok: false, reason: 'no-world' }
      const tx = +wm[1], ty = +wm[2], scale = +wm[3]
      const sr = surface.getBoundingClientRect()
      const toClient = (x, y) => ({ x: sr.left + tx + x * scale, y: sr.top + ty + y * scale })
      const node = document.querySelectorAll('[data-idraw-node]')[0]
      const nm = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(node.getAttribute('transform'))
      const box = node.getBBox()
      const anchor = { x: +nm[1] + box.width / 2, y: +nm[2] + box.height }
      const handle = document.querySelector('[data-edge-end="from"]')
      if (!handle) return { ok: false, reason: 'no-handle' }
      const svg = document.querySelector('.canvas-surface svg')
      const br = svg.getBoundingClientRect()
      const cx = br.left + Number(handle.getAttribute('cx'))
      const cy = br.top + Number(handle.getAttribute('cy'))
      // 锚点旁 3px:仍在吸附阈值内
      const near = toClient(anchor.x + 3, anchor.y + 2)
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', cx, cy, 1)
      fire('pointermove', near.x, near.y, 1)
      fire('pointerup', near.x, near.y, 0)
      const edge = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      if (!edge) return { ok: false, reason: 'not-selected' }
      const start = edge.getPointAtLength(0)
      return { ok: true, anchor, start: { x: start.x, y: start.y } }
    })()`
  )
  check(
    '端点靠近特殊点时吸附到锚点',
    snappedEnd.ok &&
      Math.abs(snappedEnd.start.x - snappedEnd.anchor.x) < 0.05 &&
      Math.abs(snappedEnd.start.y - snappedEnd.anchor.y) < 0.05,
    snappedEnd
  )

  // 终点落在形状右边缘、另一端在左侧时,末段应沿线的方向进入(箭头朝前),
  // 而不是先绕到轮廓外侧再折回来,导致箭头看起来反向
  const arrowFlow = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const world = document.querySelector('.canvas-world')
      const wm = /translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(world.getAttribute('transform'))
      if (!wm) return { ok: false, reason: 'no-world' }
      const tx = +wm[1], ty = +wm[2], scale = +wm[3]
      const sr = surface.getBoundingClientRect()
      const toClient = (x, y) => ({ x: sr.left + tx + x * scale, y: sr.top + ty + y * scale })
      const target = document.querySelectorAll('[data-idraw-node]')[1]
      const nm = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(target.getAttribute('transform'))
      const box = target.getBBox()
      // 右侧边缘、避开中点锚点(10px/scale 吸附半径之外)
      const drop = { x: +nm[1] + box.width, y: +nm[2] + box.height * 0.9 }
      const handle = document.querySelector('[data-edge-end="to"]')
      if (!handle) return { ok: false, reason: 'no-handle' }
      const svg = document.querySelector('.canvas-surface svg')
      const br = svg.getBoundingClientRect()
      const cx = br.left + Number(handle.getAttribute('cx'))
      const cy = br.top + Number(handle.getAttribute('cy'))
      const p = toClient(drop.x, drop.y)
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', cx, cy, 1)
      fire('pointermove', p.x, p.y, 1)
      fire('pointerup', p.x, p.y, 0)
      const edge = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      if (!edge) return { ok: false, reason: 'not-selected' }
      const len = edge.getTotalLength()
      const end = edge.getPointAtLength(len)
      const near = edge.getPointAtLength(Math.max(0, len - 4))
      return {
        ok: true,
        drop,
        end: { x: end.x, y: end.y },
        near: { x: near.x, y: near.y }
      }
    })()`
  )
  check(
    '终点落在右边缘时沿线的方向进入(箭头不反转)',
    arrowFlow.ok &&
      Math.abs(arrowFlow.end.x - arrowFlow.drop.x) < 0.05 &&
      Math.abs(arrowFlow.end.y - arrowFlow.drop.y) < 0.05 &&
      arrowFlow.end.x - arrowFlow.near.x > 3 &&
      Math.abs(arrowFlow.end.y - arrowFlow.near.y) < 0.5,
    arrowFlow
  )

  // 固定锚点也一样:吸附到右边缘中点的东锚点、另一端在左侧时,
  // 不能在端点外侧折返,末段应沿线的方向进入
  const anchorFlow = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const world = document.querySelector('.canvas-world')
      const wm = /translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(world.getAttribute('transform'))
      if (!wm) return { ok: false, reason: 'no-world' }
      const tx = +wm[1], ty = +wm[2], scale = +wm[3]
      const sr = surface.getBoundingClientRect()
      const toClient = (x, y) => ({ x: sr.left + tx + x * scale, y: sr.top + ty + y * scale })
      const target = document.querySelectorAll('[data-idraw-node]')[1]
      const nm = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(target.getAttribute('transform'))
      const box = target.getBBox()
      // 右边缘中点 = 东锚点,会走固定锚点吸附
      const drop = { x: +nm[1] + box.width, y: +nm[2] + box.height / 2 }
      const handle = document.querySelector('[data-edge-end="to"]')
      if (!handle) return { ok: false, reason: 'no-handle' }
      const svg = document.querySelector('.canvas-surface svg')
      const br = svg.getBoundingClientRect()
      const cx = br.left + Number(handle.getAttribute('cx'))
      const cy = br.top + Number(handle.getAttribute('cy'))
      const p = toClient(drop.x, drop.y)
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', cx, cy, 1)
      fire('pointermove', p.x, p.y, 1)
      fire('pointerup', p.x, p.y, 0)
      const edge = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      if (!edge) return { ok: false, reason: 'not-selected' }
      const len = edge.getTotalLength()
      const end = edge.getPointAtLength(len)
      const near = edge.getPointAtLength(Math.max(0, len - 4))
      return {
        ok: true,
        drop,
        end: { x: end.x, y: end.y },
        near: { x: near.x, y: near.y }
      }
    })()`
  )
  check(
    '吸附到东锚点时也不折返(箭头朝前)',
    anchorFlow.ok &&
      Math.abs(anchorFlow.end.x - anchorFlow.drop.x) < 0.05 &&
      Math.abs(anchorFlow.end.y - anchorFlow.drop.y) < 0.05 &&
      anchorFlow.end.x - anchorFlow.near.x > 3 &&
      Math.abs(anchorFlow.end.y - anchorFlow.near.y) < 0.5,
    anchorFlow
  )

  // 还原 to 端点:后面的保存用例会断言 30%/80% 的相对比例
  await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const world = document.querySelector('.canvas-world')
      const wm = /translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(world.getAttribute('transform'))
      if (!wm) return false
      const tx = +wm[1], ty = +wm[2], scale = +wm[3]
      const sr = surface.getBoundingClientRect()
      const toClient = (x, y) => ({ x: sr.left + tx + x * scale, y: sr.top + ty + y * scale })
      const target = document.querySelectorAll('[data-idraw-node]')[1]
      const nm = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(target.getAttribute('transform'))
      const box = target.getBBox()
      const drop = { x: +nm[1] + box.width * 0.3, y: +nm[2] + box.height * 0.8 }
      const handle = document.querySelector('[data-edge-end="to"]')
      if (!handle) return false
      const svg = document.querySelector('.canvas-surface svg')
      const br = svg.getBoundingClientRect()
      const cx = br.left + Number(handle.getAttribute('cx'))
      const cy = br.top + Number(handle.getAttribute('cy'))
      const p = toClient(drop.x, drop.y)
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', cx, cy, 1)
      fire('pointermove', p.x, p.y, 1)
      fire('pointerup', p.x, p.y, 0)
      return true
    })()`
  )
  await wait(120)

  // 拖动折点:自动布线的拐角第一次拖动后固定为手动折点,路径跟着改
  const waypointDrag = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const svg = document.querySelector('.canvas-surface svg')
      const edge = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      const all = [...document.querySelectorAll('[data-edge-waypoint]')]
      if (!svg || !edge || all.length === 0) return { ok: false, reason: 'no-handle' }
      // 挑离标签框最远的折点:标签框的命中优先级高于折点
      const box = document.querySelector('.canvas-edge-box')
      let handle = all[0]
      if (box) {
        const bx = Number(box.getAttribute('x')) + Number(box.getAttribute('width')) / 2
        const by = Number(box.getAttribute('y')) + Number(box.getAttribute('height')) / 2
        let best = -1
        for (const h of all) {
          const cx = Number(h.getAttribute('x')) + Number(h.getAttribute('width')) / 2
          const cy = Number(h.getAttribute('y')) + Number(h.getAttribute('height')) / 2
          const d = Math.hypot(cx - bx, cy - by)
          if (d > best) {
            best = d
            handle = h
          }
        }
      }
      const dBefore = edge.getAttribute('d')
      const br = svg.getBoundingClientRect()
      const hx = br.left + Number(handle.getAttribute('x')) + Number(handle.getAttribute('width')) / 2
      const hy = br.top + Number(handle.getAttribute('y')) + Number(handle.getAttribute('height')) / 2
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', hx, hy, 1)
      fire('pointermove', hx + 40, hy + 30, 1)
      fire('pointerup', hx + 40, hy + 30, 0)
      const edge2 = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      if (!edge2) return { ok: false, reason: 'deselected' }
      return {
        ok: true,
        changed: dBefore !== edge2.getAttribute('d'),
        handles: document.querySelectorAll('[data-edge-waypoint]').length
      }
    })()`
  )
  check(
    '拖动折点改变连线路径',
    waypointDrag.ok && waypointDrag.changed && waypointDrag.handles >= 1,
    waypointDrag
  )

  // 曲线路由:折点作为贝塞尔控制点,拖动手柄应改变弧度
  const curveSwitch = await js(
    wc,
    `(() => {
      const btn = document.querySelector('.canvas-style-seg[aria-label="连线方式"] button[aria-label="曲线"]')
      if (!btn) return false
      btn.click()
      return true
    })()`
  )
  await wait(150)
  const curveDrag = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const svg = document.querySelector('.canvas-surface svg')
      const edge = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      const all = [...document.querySelectorAll('[data-edge-waypoint]')]
        .filter(h => Number(h.getAttribute('data-edge-waypoint')) <= 1)
      if (!svg || !edge || all.length === 0) return { ok: false, reason: 'no-handle' }
      // 挑离标签框最远的手柄,避免点到标签
      const box = document.querySelector('.canvas-edge-box')
      let handle = all[0]
      if (box) {
        const bx = Number(box.getAttribute('x')) + Number(box.getAttribute('width')) / 2
        const by = Number(box.getAttribute('y')) + Number(box.getAttribute('height')) / 2
        let best = -1
        for (const h of all) {
          const cx = Number(h.getAttribute('x')) + Number(h.getAttribute('width')) / 2
          const cy = Number(h.getAttribute('y')) + Number(h.getAttribute('height')) / 2
          const d = Math.hypot(cx - bx, cy - by)
          if (d > best) {
            best = d
            handle = h
          }
        }
      }
      const dBefore = edge.getAttribute('d')
      const br = svg.getBoundingClientRect()
      const hx = br.left + Number(handle.getAttribute('x')) + Number(handle.getAttribute('width')) / 2
      const hy = br.top + Number(handle.getAttribute('y')) + Number(handle.getAttribute('height')) / 2
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', hx, hy, 1)
      fire('pointermove', hx + 25, hy - 25, 1)
      fire('pointerup', hx + 25, hy - 25, 0)
      const edge2 = document.querySelector('[data-idraw-edge].canvas-edge-selected')
      if (!edge2) return { ok: false, reason: 'deselected' }
      return {
        ok: true,
        isCurve: /C/.test(edge2.getAttribute('d') || ''),
        changed: dBefore !== edge2.getAttribute('d')
      }
    })()`
  )
  check('可以切换到曲线路由', curveSwitch === true)
  check(
    '曲线手柄可调整弧度',
    curveDrag.ok && curveDrag.isCurve && curveDrag.changed,
    curveDrag
  )

  // 临时画布的核心承诺:不自动保存。等待超过自动保存延迟后,不应有写盘动作。
  const writesBeforeIdle = writeCalls
  await wait(1600)
  check('临时画布不会自动保存', writeCalls === writesBeforeIdle, {
    before: writesBeforeIdle,
    after: writeCalls
  })

  check(
    '外部 SVG 的脚本没有被执行',
    await js(wc, "!document.querySelector('.canvas-readonly-img')")
  )

  console.log('[3] 拖动节点')
  const nodePos = () =>
    js(
      wc,
      `(() => {
        const node = document.querySelector('[data-idraw-node]')
        if (!node) return null
        const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(node.getAttribute('transform') || '')
        return m ? { x: +m[1], y: +m[2] } : null
      })()`
    )
  const waitForPos = async (x, y) => {
    const start = Date.now()
    while (Date.now() - start < 3000) {
      const pos = await nodePos()
      if (pos && pos.x === x && pos.y === y) return true
      await wait(50)
    }
    return false
  }

  const before = await nodePos()
  const dragAnchors = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const world = document.querySelector('.canvas-world')
      const node = document.querySelector('[data-idraw-node]')
      const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(world.getAttribute('transform'))
      const tx = +m[1], ty = +m[2], scale = +m[3]
      const n = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(node.getAttribute('transform'))
      const x = +n[1], y = +n[2]
      const box = node.getBBox()
      const w = box.width
      const h = box.height
      const r = surface.getBoundingClientRect()
      const cx = r.left + tx + (x + w / 2) * scale
      const cy = r.top + ty + (y + h / 2) * scale
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      // 先移到空白处清掉悬浮,再悬浮节点让锚点出现
      fire('pointermove', r.left + 8, r.top + 8, 0)
      fire('pointermove', cx, cy, 0)
      const anchorsBefore = document.querySelectorAll('.canvas-anchor').length
      fire('pointerdown', cx, cy, 1)
      fire('pointermove', cx + 60, cy + 40, 1)
      const anchorsDuring = document.querySelectorAll('.canvas-anchor').length
      fire('pointerup', cx + 60, cy + 40, 0)
      return { anchorsBefore, anchorsDuring }
    })()`
  )
  await wait(120)
  const after = await nodePos()
  check(
    '拖动改变了节点坐标',
    !!before && !!after && (after.x !== before.x || after.y !== before.y),
    { before, after }
  )
  check(
    '移动时不再保留原位置的悬停锚点',
    dragAnchors.anchorsBefore > 0 && dragAnchors.anchorsDuring === 0,
    dragAnchors
  )

  console.log('[4] 撤销 / 重做')
  wc.send('app:menu-command', 'edit:undo')
  check(
    '撤销回到拖动前',
    !!before && (await waitForPos(before.x, before.y))
  )
  wc.send('app:menu-command', 'edit:redo')
  check(
    '重做回到拖动后',
    !!after && (await waitForPos(after.x, after.y))
  )

  console.log('[3.5] 缩放手柄粒度')
  const nodeBox = () =>
    js(
      wc,
      `(() => {
        const node = document.querySelector('[data-idraw-node]')
        if (!node) return null
        const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(node.getAttribute('transform') || '')
        const box = node.getBBox()
        return m ? { x: +m[1], y: +m[2], w: box.width, h: box.height } : null
      })()`
    )
  const resizeBefore = await nodeBox()
  await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const world = document.querySelector('.canvas-world')
      const node = document.querySelector('[data-idraw-node]')
      const wm = /translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(world.getAttribute('transform'))
      const tx = +wm[1], ty = +wm[2], scale = +wm[3]
      const nm = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(node.getAttribute('transform'))
      const box = node.getBBox()
      const r = surface.getBoundingClientRect()
      const sx = r.left + tx + (+nm[1] + box.width) * scale
      const sy = r.top + ty + (+nm[2] + box.height) * scale
      // 11 个世界单位的拖动:旧实现按 20px 网格吸附会跳 20,新实现应接近 11
      const delta = 11 * scale
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', sx, sy, 1)
      fire('pointermove', sx + delta, sy + delta, 1)
      fire('pointerup', sx + delta, sy + delta, 0)
    })()`
  )
  await wait(120)
  const resizeAfter = await nodeBox()
  const deltaW = resizeAfter && resizeBefore ? resizeAfter.w - resizeBefore.w : null
  check('缩放粒度与拖动一致(不是 20px 跳格)', deltaW !== null && deltaW > 0 && deltaW < 15, {
    before: resizeBefore,
    after: resizeAfter
  })

  console.log('[4.5] 填充色实时预览 / 上一填充色')
  const fillOfFirst = () =>
    js(wc, "document.querySelector('[data-idraw-node] rect')?.getAttribute('fill') || null")
  const fillBefore = await fillOfFirst()
  await js(
    wc,
    `(() => {
      const input = document.querySelector('.canvas-style-row input[type=color]')
      if (!input) return false
      input.value = '#ff0000'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`
  )
  await wait(150)
  check('拖动填充色时形状立即变色', (await fillOfFirst()) === '#ff0000', {
    before: fillBefore,
    now: await fillOfFirst()
  })
  await js(
    wc,
    "document.querySelector('.canvas-style-row input[type=color]')?.dispatchEvent(new Event('change', { bubbles: true }))"
  )
  check('确认后出现上一填充色按钮', await waitFor(wc, "!!document.querySelector('.canvas-color-prev')"))
  check('RGB 复制按钮存在', await js(wc, "!!document.querySelector('.canvas-color-mini')"))
  await js(wc, "document.querySelector('.canvas-color-prev')?.click()")
  await wait(150)
  check('上一填充色按钮恢复原色', (await fillOfFirst()) === fillBefore, {
    before: fillBefore,
    now: await fillOfFirst()
  })

  console.log('[5] 保存')
  wc.send('app:menu-command', 'file:save')
  const savedOk = await (async () => {
    const start = Date.now()
    while (Date.now() - start < 5000) {
      if (savedContent) return true
      await wait(50)
    }
    return false
  })()
  check('保存写出了 SVG', savedOk)
  check('保存后标题不再有脏点', await waitFor(wc, "!document.title.startsWith('● ')"))
  check(
    '文件是标准 SVG 且带 iDraw 标记',
    savedOk &&
      /^<\?xml/.test(savedContent) &&
      savedContent.includes('data-idraw-canvas="1"') &&
      savedContent.includes('data-idraw-node="n1"') &&
      !savedContent.includes('<style')
  )
  check(
    '新形状默认无填充',
    savedOk && /data-idraw-shape="rect"[\s\S]{0,400}?fill="none"/.test(savedContent)
  )
  const savedX = Number(/data-idraw-node="n1"[\s\S]*?data-idraw-x="([-\d.]+)"/.exec(savedContent)?.[1])
  check('保存的是拖动后的坐标', savedX === after.x, { savedX, after })
  check(
    '自由挂接的端点写入节点相对比例',
    savedOk &&
      /data-idraw-to-anchor="free"/.test(savedContent) &&
      /data-idraw-to-x="0\.3"/.test(savedContent) &&
      /data-idraw-to-y="0\.8"/.test(savedContent)
  )
  check(
    '吸附到特殊点的端点写入锚点侧',
    savedOk && /data-idraw-from-anchor="s"/.test(savedContent)
  )
  check('标签位置写入 SVG', savedOk && /data-idraw-label-pos="/.test(savedContent))
  check('手动折点写入 SVG', savedOk && /data-idraw-waypoints="/.test(savedContent))

  console.log('[6] 新建并重新打开')
  wc.send('app:menu-command', 'file:new')
  check('新建后是一张空白临时画布', await waitFor(wc, "!!document.querySelector('.canvas-new-card')"))
  check('新建后仍在编辑器里', await js(wc, "!!document.querySelector('.canvas-surface')"))
  wc.send('app:open-file', SAVED)
  check(
    '重新打开恢复 5 个节点',
    await waitFor(wc, "document.querySelectorAll('[data-idraw-node]').length === 5")
  )
  check('重新打开后标题为文件名', (await js(wc, 'document.title')).includes('diagram.svg'))

  console.log('[7] 外部 SVG 只读')
  wc.send('app:open-file', FOREIGN)
  check(
    '只读预览图片加载成功',
    await waitFor(
      wc,
      "(() => { const img = document.querySelector('.canvas-readonly-img'); return !!img && img.complete && img.naturalWidth > 0 })()"
    )
  )
  check('只读时没有编辑画布', (await js(wc, "!document.querySelector('.canvas-svg')")))
  check(
    '只读条说明原因',
    (await js(wc, "document.querySelector('.canvas-readonly-bar')?.textContent || ''")).includes(
      '只读'
    )
  )
  check(
    '只读文件仍能返回仓库选择',
    await js(wc, "!!document.querySelector('.canvas-readonly-back')")
  )
  check(
    '只读时菜单保留文档操作但置灰',
    await (async () => {
      await js(wc, "document.querySelector('.idraw-corner-btn').click()")
      const opened = await waitFor(wc, "!!document.querySelector('.idraw-corner-menu')")
      const state = await js(
        wc,
        `(() => {
          const items = [...document.querySelectorAll('.idraw-corner-menu-item')]
          const byAction = a => items.find(el => el.dataset.action === a)
          return {
            count: items.length,
            saveDisabled: !!byAction('menu-save')?.disabled,
            exportDisabled: !!byAction('menu-export-png')?.disabled,
            undoDisabled: !!byAction('menu-undo')?.disabled
          }
        })()`
      )
      await js(wc, "document.querySelector('.idraw-corner-mask')?.click()")
      return opened && state.count === 5 && state.saveDisabled && state.exportDisabled && state.undoDisabled
    })()
  )

  console.log('[8] 导出 PNG')
  wc.send('app:open-file', SAVED)
  await waitFor(wc, "document.querySelectorAll('[data-idraw-node]').length === 5")
  wc.send('app:menu-command', 'file:export-png')
  const pngOk = await (async () => {
    const start = Date.now()
    while (Date.now() - start < 8000) {
      if (pngWritten && fs.existsSync(PNG)) return true
      await wait(80)
    }
    return false
  })()
  check('PNG 文件写出', pngOk)
  check(
    'PNG 文件头正确',
    pngOk && fs.readFileSync(PNG).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )

  console.log('[9] 空白处框选后松手')
  const marquee = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const r = surface.getBoundingClientRect()
      const nodeRects = [...document.querySelectorAll('[data-idraw-node]')].map(el => el.getBoundingClientRect())
      const size = 120
      const free = (x, y) => !nodeRects.some(b => x < b.right && x + size > b.left && y < b.bottom && y + size > b.top)
      // 在画布上找一块不压到任何节点的 120x120 区域,保证框选结果为空
      let sx = r.left + 8, sy = r.top + 8
      outer: for (let y = r.top + 8; y + size <= r.bottom - 8; y += 40) {
        for (let x = r.left + 8; x + size <= r.right - 8; x += 40) {
          if (free(x, y)) { sx = x; sy = y; break outer }
        }
      }
      const selectedBefore = document.querySelectorAll('.canvas-sel-box').length
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true
      }))
      fire('pointerdown', sx, sy, 1)
      const cursorDown = surface.style.cursor
      fire('pointermove', sx + size, sy + size, 1)
      const cursorMove = surface.style.cursor
      const during = document.querySelectorAll('.canvas-marquee').length
      fire('pointerup', sx + size, sy + size, 0)
      return {
        during,
        after: document.querySelectorAll('.canvas-marquee').length,
        selectedBefore,
        selectedAfter: document.querySelectorAll('.canvas-sel-box').length,
        cursorDown,
        cursorMove,
        cursorAfter: surface.style.cursor,
        x: sx,
        y: sy
      }
    })()`
  )
  check('框选过程中出现框选矩形', marquee.during === 1, marquee)
  check('只按下鼠标时还不是十字光标', marquee.cursorDown !== 'crosshair', marquee)
  check('按住拖动时才变成十字光标', marquee.cursorMove === 'crosshair', marquee)
  check('松开鼠标后不再是十字光标', marquee.cursorAfter !== 'crosshair', marquee)
  check('选区没有变化(复现提前返回的路径)', marquee.selectedBefore === marquee.selectedAfter, marquee)
  check('松手后框选矩形消失', marquee.after === 0, marquee)

  // pointerup 丢失(在窗口外松手)时,回到窗口后的无按键移动要能收尾
  const lostUp = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const sx = ${marquee.x}, sy = ${marquee.y}
      const fire = (type, px, py, buttons) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true, pointerType: 'mouse'
      }))
      fire('pointerdown', sx, sy, 1)
      fire('pointermove', sx + 100, sy + 100, 1)
      const during = document.querySelectorAll('.canvas-marquee').length
      // 模拟 pointerup 丢失:直接来一次按键已松开的 pointermove
      fire('pointermove', sx + 110, sy + 110, 0)
      return { during, after: document.querySelectorAll('.canvas-marquee').length }
    })()`
  )
  check('丢失 pointerup 后,无按键移动会收尾', lostUp.during === 1 && lostUp.after === 0, lostUp)

  // 松手落在画布外(工具栏/侧栏)时,window 上的 pointerup 兜底
  const outsideUp = await js(
    wc,
    `(() => {
      const surface = document.querySelector('.canvas-surface')
      const sx = ${marquee.x}, sy = ${marquee.y}
      const fire = (target, type, px, py, buttons) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: px, clientY: py,
        button: 0, buttons, pointerId: 1, isPrimary: true, pointerType: 'mouse'
      }))
      fire(surface, 'pointerdown', sx, sy, 1)
      fire(surface, 'pointermove', sx + 100, sy + 100, 1)
      const during = document.querySelectorAll('.canvas-marquee').length
      fire(document.body, 'pointerup', sx + 100, sy + 100, 0)
      return { during, after: document.querySelectorAll('.canvas-marquee').length }
    })()`
  )
  check('画布外松手也能收尾', outsideUp.during === 1 && outsideUp.after === 0, outsideUp)

  console.log('[10] 空画布引导卡片与甘特图模板')
  wc.send('app:menu-command', 'file:new')
  check('新建后出现引导卡片', await waitFor(wc, "!!document.querySelector('.canvas-new-card')"))
  await js(wc, "document.querySelector('.canvas-template-item.is-gantt')?.click()")
  check(
    '甘特图生成任务节点',
    await waitFor(wc, "document.querySelectorAll('[data-idraw-node]').length >= 12")
  )
  check(
    '甘特图生成网格线',
    await waitFor(wc, "document.querySelectorAll('[data-idraw-edge]').length >= 6")
  )
  check(
    '模板插入后不选中形状',
    await js(
      wc,
      "document.querySelectorAll('.canvas-sel-box').length === 0 && !document.querySelector('.canvas-style')"
    )
  )

  // 双击空白处建一个空文本框:即使没有文字,也要有可见的占位框。
  // 候选点除了避开形状之外还要实测:甘特图的网格线(也是连线)和文字形状的模型框
  // 都可能吃掉双击;如果打开的是已有对象,按 Esc 取消并换下一个候选点。
  const createdEmptyText = await js(
    wc,
    `(async () => {
      const surface = document.querySelector('.canvas-surface')
      const r = surface.getBoundingClientRect()
      const nodes = [...document.querySelectorAll('[data-idraw-node]')].map(el => el.getBoundingClientRect())
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
      const countNodes = () => document.querySelectorAll('[data-idraw-node]').length
      const size = 90
      const tryPoint = async (cx, cy) => {
        const before = countNodes()
        surface.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true, cancelable: true, clientX: cx, clientY: cy
        }))
        await sleep(40)
        const ta = document.querySelector('.canvas-text-editor')
        if (ta && countNodes() > before) return true
        // 双击落在了已有形状/连线上:取消这次文字编辑,继续找空白处
        ta?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        ta?.blur()
        await sleep(30)
        return false
      }
      for (let yy = r.top + 20; yy + size <= r.bottom - 20; yy += 40) {
        for (let xx = r.left + 20; xx + size <= r.right - 20; xx += 40) {
          const cx = xx + size / 2, cy = yy + size / 2
          const freeOfNodes = !nodes.some(b => xx < b.right && xx + size > b.left && yy < b.bottom && yy + size > b.top)
          if (!freeOfNodes) continue
          if (await tryPoint(cx, cy)) return true
        }
      }
      return false
    })()`
  )
  check('双击空白处进入文字编辑', createdEmptyText === true)
  await js(wc, "document.querySelector('.canvas-text-editor')?.blur()")
  check(
    '空文本框显示可见的占位框',
    await waitFor(wc, "!!document.querySelector('.canvas-text-placeholder')")
  )

  // 从插入面板按住形状拖进画布:拖动中画布上显示目标形状的实时预览
  await js(wc, "document.querySelector('[data-action=toggle-shapes]').click()")
  await waitFor(wc, "!!document.querySelector('.shape-panel')")
  const dragged = await js(
    wc,
    `(() => {
      const item = [...document.querySelectorAll('.shape-item')].find(b => b.textContent.trim() === '星形')
      const surface = document.querySelector('.canvas-surface')
      const ir = item.getBoundingClientRect()
      const sr = surface.getBoundingClientRect()
      const fire = (type, x, y, buttons) => item.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons, pointerId: 9, isPrimary: true, pointerType: 'mouse'
      }))
      fire('pointerdown', ir.left + ir.width / 2, ir.top + ir.height / 2, 1)
      const tx = sr.left + sr.width * 0.7
      const ty = sr.top + sr.height * 0.7
      fire('pointermove', tx, ty, 1)
      const preview = !!document.querySelector('.canvas-create-preview-shape polygon')
      fire('pointerup', tx, ty, 0)
      return { preview, star: !!document.querySelector('[data-idraw-node][data-idraw-shape="star"]') }
    })()`
  )
  check('拖动过程中显示目标形状的实时预览', dragged.preview, dragged)
  check('从插入面板拖入画布可以创建形状', dragged.star, dragged)
  check('拖入后插入面板自动关闭', await waitFor(wc, "!document.querySelector('.shape-panel')"))

  console.log('[11] 仓库:新建多张画布并自动保存')
  wc.send('app:menu-command', 'file:open-workspace')
  check(
    '未保存修改弹窗出现',
    await waitFor(wc, "!!document.querySelector('.idraw-dialog')")
  )
  check(
    '弹窗使用应用内主题样式',
    await js(
      wc,
      "getComputedStyle(document.querySelector('.idraw-dialog')).backgroundColor !== 'rgba(0, 0, 0, 0)'"
    )
  )
  await js(wc, "document.querySelector('[data-dialog-value=discard]').click()")
  check('回到仓库选择页', await waitFor(wc, "!!document.querySelector('.workspace-picker')"))
  await waitFor(wc, "!!document.querySelector('.workspace-recent-add-slot button')")
  await js(wc, "document.querySelector('.workspace-recent-add-slot button').click()")
  check('加号菜单出现', await waitFor(wc, "!!document.querySelector('[data-action=open-workspace]')"))
  await js(wc, "document.querySelector('[data-action=open-workspace]').click()")
  check('应用内文件夹浏览器出现', await waitFor(wc, "!!document.querySelector('.dir-browser')"))
  check(
    '隐藏文件夹默认显示',
    await waitFor(wc, "!!document.querySelector('.dir-browser-item.hidden')")
  )
  await js(wc, "document.querySelector('.dir-browser-item.hidden').click()")
  check(
    '进入隐藏文件夹后能看到其中的 SVG',
    await waitFor(wc, "!!document.querySelector('.dir-browser-file')")
  )
  await js(wc, "document.querySelector('.dir-browser-up').click()")
  check(
    '文件夹浏览器可以返回上级',
    await waitFor(wc, "!!document.querySelector('.dir-browser-item.hidden')")
  )
  await js(wc, "document.querySelector('.dir-browser-select').click()")
  check('打开仓库后出现侧栏', await waitFor(wc, "!!document.querySelector('.workspace-sidebar')"))
  check('空仓库显示引导卡片', await waitFor(wc, "!!document.querySelector('.workspace-empty')"))
  check(
    '空仓库时侧栏被禁用',
    await js(wc, "getComputedStyle(document.querySelector('.workspace-sidebar')).pointerEvents === 'none'")
  )
  check(
    '空仓库时状态栏被禁用',
    await js(wc, "getComputedStyle(document.querySelector('.idraw-statusbar')).pointerEvents === 'none'")
  )
  check(
    '引导卡片的按钮仍可点击',
    await js(wc, "getComputedStyle(document.querySelector('.workspace-empty-btn')).pointerEvents !== 'none'")
  )
  await js(
    wc,
    "document.querySelector('.workspace-empty')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))"
  )
  check(
    '点击空白处不会关闭空仓库引导',
    await js(wc, "!!document.querySelector('.workspace-empty')")
  )
  await js(wc, "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
  check(
    '空仓库按 Esc 返回画布总览',
    await waitFor(wc, "!!document.querySelector('.workspace-picker')")
  )
  await waitFor(wc, "!!document.querySelector('[data-action=recent-workspace]')")
  await js(wc, "document.querySelector('[data-action=recent-workspace]').click()")
  check(
    '重新打开空仓库继续后续流程',
    await waitFor(wc, "!!document.querySelector('.workspace-empty')")
  )
  check(
    '侧栏入口文案为新建画布',
    await js(
      wc,
      "document.querySelector('[data-action=workspace-new-canvas]').textContent.includes('新建画布')"
    )
  )
  check(
    '默认不列出子目录中的画布',
    await js(wc, "!document.querySelector('[data-rel-path=\"nested/nested.svg\"]')")
  )
  await js(wc, "document.querySelector('.idraw-corner-btn').click()")
  await js(wc, "document.querySelector('[data-action=open-settings]').click()")
  check('设置里有布局分区', await waitFor(wc, "!!document.querySelector('[data-section=layout]')"))
  await js(wc, "document.querySelectorAll('.idraw-settings-nav-item')[1].click()")
  check(
    '仓库模式下有自动保存模块',
    await waitFor(wc, "!!document.querySelector('[data-section=autosave]')")
  )
  check(
    '自动保存模块有间隔输入',
    await js(wc, "!!document.querySelector('[data-field=auto-save-delay]')")
  )
  check(
    '自动保存可关闭',
    await waitFor(wc, "!!document.querySelector('[data-field=auto-save-mode-off]')")
  )
  await js(wc, "document.querySelector('[data-field=auto-save-mode-off]').click()")
  check(
    '关闭后隐藏间隔设置',
    await waitFor(wc, "!document.querySelector('[data-field=auto-save-delay]')")
  )
  check(
    '自动保存模式已持久化',
    (await js(wc, "localStorage.getItem('idraw-autosave-mode')")) === 'off'
  )
  await js(wc, "document.querySelector('[data-field=auto-save-mode-delay]').click()")
  check(
    '重新开启后显示间隔设置',
    await waitFor(wc, "!!document.querySelector('[data-field=auto-save-delay]')")
  )
  check(
    '自动保存模式恢复为定时',
    (await js(wc, "localStorage.getItem('idraw-autosave-mode')")) === 'delay'
  )
  check(
    '编辑器设置按网格/自动保存分组',
    await js(
      wc,
      "document.querySelectorAll('.idraw-settings-group').length === 2 && [...document.querySelectorAll('.idraw-settings-section-title')].map(el => el.textContent.trim()).join(',') === '网格,自动保存'"
    )
  )
  await js(wc, "document.querySelector('[data-section=layout]').click()")
  check(
    '布局里有子目录开关',
    await waitFor(wc, "!!document.querySelector('[data-field=show-nested-canvases]')")
  )
  await js(wc, "document.querySelector('[data-field=show-nested-canvases]').click()")
  check(
    '开启后列出子目录画布',
    await waitFor(wc, "!!document.querySelector('[data-rel-path=\"nested/nested.svg\"]')")
  )
  check(
    '偏好写入了 localStorage',
    (await js(wc, "localStorage.getItem('idraw-workspace-recursive')")) === '1'
  )
  await js(wc, "document.querySelector('[data-field=show-nested-canvases]').click()")
  check(
    '关闭后子目录画布消失',
    await waitFor(wc, "!document.querySelector('[data-rel-path=\"nested/nested.svg\"]')")
  )
  await js(wc, "document.querySelector('.idraw-settings-close').click()")

  await js(wc, "document.querySelector('[data-action=workspace-new-canvas]').click()")
  check(
    '点击新建画布出现输入框',
    await waitFor(wc, "!!document.querySelector('[data-field=new-canvas-name]')")
  )
  await js(
    wc,
    `(() => {
      const target = document.querySelector('.workspace-canvas-empty') ?? document.querySelector('.workspace-canvas-list')
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })()`
  )
  check(
    '点击别处关闭新建输入',
    await waitFor(wc, "!document.querySelector('[data-field=new-canvas-name]')")
  )

  await js(wc, "document.querySelector('[data-action=workspace-new-canvas]').click()")
  check('出现新建画布输入框', await waitFor(wc, "!!document.querySelector('[data-field=new-canvas-name]')"))
  await js(
    wc,
    `(() => {
      const input = document.querySelector('[data-field=new-canvas-name]')
      input.value = '流程图'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      // 名称已改成自定义值:点击别处应当直接创建,而不是必须按回车
      document.querySelector('.workspace-canvas-list').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true })
      )
    })()`
  )
  check('点击别处用自定义名称创建画布', await waitFor(wc, "!!document.querySelector('.canvas-surface')"))
  check(
    '侧栏出现画布行',
    await waitFor(wc, "!!document.querySelector('[data-rel-path=\"流程图.svg\"]')")
  )
  check('磁盘上创建了画布文件', fs.existsSync(path.join(WORKSPACE, '流程图.svg')))
  check(
    '仓库模式不显示工具栏新建按钮',
    await js(wc, "!document.querySelector('.canvas-new-btn')")
  )
  check(
    '齿轮位于底部状态栏',
    await js(wc, "!!document.querySelector('.idraw-statusbar .idraw-status-actions .idraw-corner-btn')")
  )

  await js(wc, "document.querySelector('.canvas-blank-btn')?.click()")
  await placeRect(400, 200)
  check(
    '仓库画布创建了节点',
    await waitFor(wc, "document.querySelectorAll('[data-idraw-node]').length === 1")
  )
  const autoSaved = await (async () => {
    const start = Date.now()
    while (Date.now() - start < 6000) {
      try {
        const text = fs.readFileSync(path.join(WORKSPACE, '流程图.svg'), 'utf8')
        if (text.includes('data-idraw-node')) return true
      } catch {
        /* 文件还没写完时继续等 */
      }
      await wait(100)
    }
    return false
  })()
  check('仓库画布编辑后自动保存(无需 Ctrl+S)', autoSaved)
  check(
    '状态栏显示自动保存',
    (await js(wc, "document.querySelector('.idraw-statusbar')?.textContent || ''")).includes(
      '自动保存'
    )
  )

  // 再建一张,验证「一个仓库里能放多张画布」
  await js(wc, "document.querySelector('[data-action=workspace-new-canvas]').click()")
  await waitFor(wc, "!!document.querySelector('[data-field=new-canvas-name]')")
  await js(
    wc,
    `(() => {
      const input = document.querySelector('[data-field=new-canvas-name]')
      input.value = '第二张'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })()`
  )
  check(
    '仓库里有两张画布',
    await waitFor(wc, "document.querySelectorAll('[data-rel-path]').length === 2")
  )
  check(
    '画布行高度固定不抖动',
    await js(
      wc,
      `(() => {
        const rows = [...document.querySelectorAll('.workspace-canvas-row')]
        if (rows.length < 2) return false
        const first = rows[0].getBoundingClientRect().height
        return rows.every(r => Math.abs(r.getBoundingClientRect().height - first) < 0.5)
      })()`
    )
  )
  check(
    '行操作按钮占位但不常显',
    await js(
      wc,
      `(() => {
        const row = [...document.querySelectorAll('.workspace-canvas-row')].find(r => !r.classList.contains('active'))
        const action = row?.querySelector('.workspace-row-action')
        if (!action) return false
        return getComputedStyle(action).visibility === 'hidden' && action.getBoundingClientRect().width > 0
      })()`
    )
  )
  check('第二张画布文件存在', fs.existsSync(path.join(WORKSPACE, '第二张.svg')))

  await js(wc, "document.querySelector('[data-rel-path=\"流程图.svg\"]').click()")
  check(
    '切回第一张画布仍是刚才的内容',
    await waitFor(wc, "document.querySelectorAll('[data-idraw-node]').length === 1")
  )

  await js(wc, "document.querySelector('[data-action=workspace-collapse]').click()")
  check('目录栏可以收起', await waitFor(wc, "!!document.querySelector('.workspace-sidebar.collapsed')"))
  check(
    '收起侧栏后齿轮仍在状态栏',
    await js(wc, "!!document.querySelector('.idraw-statusbar .idraw-status-actions .idraw-corner-btn')")
  )
  await js(wc, "document.querySelector('[data-action=workspace-collapse]').click()")
  check('目录栏可以再展开', await waitFor(wc, "!document.querySelector('.workspace-sidebar.collapsed')"))

  check(
    '仓库模式状态栏有返回总览图标',
    await js(wc, "!!document.querySelector('.idraw-statusbar [data-action=back-overview]')")
  )
  await js(wc, "document.querySelector('.idraw-statusbar [data-action=back-overview]').click()")
  check('从仓库返回选择页', await waitFor(wc, "!!document.querySelector('.workspace-picker')"))
  check(
    '选择页齿轮回到左下角',
    await js(
      wc,
      "parseFloat(getComputedStyle(document.querySelector('.idraw-corner-btn')).left) === 18"
    )
  )
  check(
    '最近打开记住了这个仓库',
    await waitFor(wc, "document.querySelectorAll('[data-action=recent-workspace]').length >= 1")
  )
  check(
    '仓库卡片展示了内部画布缩略图',
    await waitFor(
      wc,
      "document.querySelectorAll('[data-action=recent-workspace] img').length >= 2"
    )
  )

  const shot = path.join(TMP, 'shot.png')
  try {
    const image = await wc.capturePage()
    fs.writeFileSync(shot, image.toPNG())
    console.log(`[shot] ${shot}`)
  } catch {
    /* 无头环境偶尔截不到,不影响断言 */
  }

  console.log('[12] 选择页主题切换')
  check(
    '旧设置浮标已移除',
    await js(wc, "!document.querySelector('.idraw-fab')")
  )
  check(
    '选择页左下角是主题切换按钮',
    await js(wc, "!!document.querySelector('[data-action=toggle-theme]')")
  )
  const themeBefore = await js(wc, "document.documentElement.dataset.theme")
  const themeAfter = themeBefore === 'dark' ? 'light' : 'dark'
  await js(wc, "document.querySelector('[data-action=toggle-theme]').click()")
  check(
    '主题切换立即生效',
    await waitFor(wc, `document.documentElement.dataset.theme === '${themeAfter}'`)
  )
  check(
    '主题偏好已写入 localStorage',
    (await js(wc, "localStorage.getItem('idraw-theme')")) === themeAfter
  )
  const expectedTipAfter = themeAfter === 'dark' ? '切换到浅色主题' : '切换到深色主题'
  check(
    '主题切换提示随状态更新',
    (await js(
      wc,
      "document.querySelector('[data-action=toggle-theme]').getAttribute('data-tooltip')"
    )) === expectedTipAfter
  )
  await js(wc, "document.querySelector('[data-action=toggle-theme]').click()")
  check(
    '再次点击切回原主题',
    await waitFor(wc, `document.documentElement.dataset.theme === '${themeBefore}'`)
  )
  const expectedTipBack = themeBefore === 'dark' ? '切换到浅色主题' : '切换到深色主题'
  check(
    '再次切换后提示也更新',
    (await js(
      wc,
      "document.querySelector('[data-action=toggle-theme]').getAttribute('data-tooltip')"
    )) === expectedTipBack
  )

  console.log('[13] 状态栏菜单、设置与返回画布总览')
  await js(wc, "document.querySelector('.workspace-recent-add-button').click()")
  await js(wc, "document.querySelector('[data-action=temporary-canvas]').click()")
  check('临时画布已打开', await waitFor(wc, "!!document.querySelector('.canvas-surface')"))
  await js(wc, "document.querySelector('.idraw-statusbar .idraw-corner-btn').click()")
  check('状态栏全局菜单出现', await waitFor(wc, "!!document.querySelector('.idraw-corner-menu')"))
  await js(wc, "document.querySelector('[data-action=open-settings]').click()")
  check(
    '设置弹窗出现',
    await waitFor(wc, "!!document.querySelector('.idraw-settings-dialog')")
  )
  check(
    '设置面板有左侧分区',
    await js(wc, "!!document.querySelector('.idraw-settings-sidebar')")
  )
  check(
    '未打开目录时设置分区不显示布局',
    await js(
      wc,
      "document.querySelectorAll('.idraw-settings-nav-item').length === 3 && !document.querySelector('[data-section=layout]')"
    )
  )
  await js(wc, "document.querySelectorAll('.idraw-settings-nav-item')[0].click()")
  await js(wc, "document.querySelectorAll('.idraw-theme-option')[2].click()")
  check(
    '深色主题立即生效',
    await waitFor(wc, "document.documentElement.dataset.theme === 'dark'")
  )
  check('主题偏好已写入 localStorage', (await js(wc, "localStorage.getItem('idraw-theme')")) === 'dark')
  await js(wc, "document.querySelectorAll('.idraw-theme-option')[0].click()")
  check(
    '恢复跟随系统',
    await waitFor(wc, "localStorage.getItem('idraw-theme') === 'system'")
  )
  await js(wc, "document.querySelectorAll('.idraw-settings-nav-item')[1].click()")
  check(
    '编辑器设置包含网格与吸附开关',
    await js(wc, "document.querySelectorAll('.idraw-settings-switch').length === 2")
  )
  check(
    '临时画布也显示网格与自动保存两组',
    await js(
      wc,
      "document.querySelectorAll('.idraw-settings-group').length === 2 && [...document.querySelectorAll('.idraw-settings-section-title')].map(el => el.textContent.trim()).join(',') === '网格,自动保存'"
    )
  )
  check(
    '临时画布可设置自动保存间隔',
    await js(wc, "!!document.querySelector('[data-field=auto-save-delay]')")
  )
  check(
    '分组卡片内的行之间有分隔线',
    await js(
      wc,
      "getComputedStyle(document.querySelectorAll('.idraw-settings-row')[1]).borderTopWidth === '1px'"
    )
  )

  await js(wc, "document.querySelector('.idraw-settings-close').click()")
  check(
    '临时画布状态栏有返回总览图标',
    await js(wc, "!!document.querySelector('.idraw-statusbar [data-action=back-overview]')")
  )
  await js(wc, "document.querySelector('.idraw-statusbar [data-action=back-overview]').click()")
  check(
    '点击返回画布总览后回到选择页',
    await waitFor(wc, "!!document.querySelector('.workspace-picker')")
  )

  console.log('')
  if (failures.length) {
    console.log(`失败 ${failures.length} 项：${failures.join(' / ')}`)
    app.exit(1)
  } else {
    console.log('全部通过')
    app.exit(0)
  }
}

app.whenReady().then(() => {
  main().catch(err => {
    console.error(err)
    app.exit(1)
  })
})
