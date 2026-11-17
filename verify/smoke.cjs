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
const SAVED = path.join(TMP, 'diagram.svg')
const FOREIGN = path.join(TMP, 'foreign.svg')
const PNG = path.join(TMP, 'diagram.png')

fs.writeFileSync(
  FOREIGN,
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><circle cx="60" cy="40" r="30" fill="#0969da"/></svg>'
)

let savedContent = null
let pngWritten = false

ipcMain.handle('app:take-pending-open-file', () => null)
ipcMain.handle('app:confirm-discard', () => 'discard')
ipcMain.handle('file:open-dialog', () => FOREIGN)
ipcMain.handle('file:save-dialog', (_e, options) => (options.kind === 'png' ? PNG : SAVED))
ipcMain.handle('file:read', (_e, file) => fs.readFileSync(file, 'utf8'))
ipcMain.handle('file:write', (_e, payload) => {
  fs.writeFileSync(payload.path, payload.content)
  savedContent = payload.content
})
ipcMain.handle('file:write-bytes', (_e, payload) => {
  fs.writeFileSync(payload.path, Buffer.from(payload.data))
  pngWritten = true
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
  await waitFor(wc, "!!document.querySelector('.canvas-pane')")

  console.log('[1] 启动页')
  check('启动页引导卡片出现', await waitFor(wc, "!!document.querySelector('.canvas-new-card')"))
  check('启动时还没有创建画布', await waitFor(wc, "!document.querySelector('.canvas-surface')"))
  check('窗口标题为 iDraw', (await js(wc, 'document.title')).includes('iDraw'))

  console.log('[2] 新建空白画布并用形状工具创建 5 个节点')
  await js(wc, "document.querySelector('.canvas-blank-btn')?.click()")
  check('点击后进入编辑器', await waitFor(wc, "!!document.querySelector('.canvas-surface')"))
  /** 选「形状 → 矩形」后在指定世界坐标点一下,生成一个默认尺寸的节点 */
  const placeRect = async (wx, wy) => {
    await js(wc, `(() => {
      const btn = [...document.querySelectorAll('.canvas-tool-btn')].find(b => b.textContent.trim() === '形状')
      btn.click()
    })()`)
    await wait(40)
    await js(wc, `(() => {
      const item = [...document.querySelectorAll('.canvas-shape-item')].find(b => b.textContent.trim() === '矩形')
      item.click()
    })()`)
    await wait(40)
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
        // 先悬浮让锚点出现,再从东侧锚点拖到目标节点
        fire('pointermove', toClient(from.x + from.w / 2, from.y + from.h / 2), 0)
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
  await js(
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
      fire('pointerdown', cx, cy, 1)
      fire('pointermove', cx + 60, cy + 40, 1)
      fire('pointerup', cx + 60, cy + 40, 0)
    })()`
  )
  await wait(120)
  const after = await nodePos()
  check(
    '拖动改变了节点坐标',
    !!before && !!after && (after.x !== before.x || after.y !== before.y),
    { before, after }
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
  const savedX = Number(/data-idraw-node="n1"[\s\S]*?data-idraw-x="([-\d.]+)"/.exec(savedContent)?.[1])
  check('保存的是拖动后的坐标', savedX === after.x, { savedX, after })

  console.log('[6] 新建并重新打开')
  wc.send('app:menu-command', 'file:new')
  check('新建后回到启动页', await waitFor(wc, "!!document.querySelector('.canvas-new-card')"))
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
      fire('pointermove', sx + size, sy + size, 1)
      const during = document.querySelectorAll('.canvas-marquee').length
      fire('pointerup', sx + size, sy + size, 0)
      return {
        during,
        after: document.querySelectorAll('.canvas-marquee').length,
        selectedBefore,
        selectedAfter: document.querySelectorAll('.canvas-sel-box').length,
        x: sx,
        y: sy
      }
    })()`
  )
  check('框选过程中出现框选矩形', marquee.during === 1, marquee)
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

  const shot = path.join(TMP, 'shot.png')
  try {
    const image = await wc.capturePage()
    fs.writeFileSync(shot, image.toPNG())
    console.log(`[shot] ${shot}`)
  } catch {
    /* 无头环境偶尔截不到,不影响断言 */
  }

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
