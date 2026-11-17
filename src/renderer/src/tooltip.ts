/**
 * 全局主题化悬浮提示。
 *
 * 浏览器原生 title 提示由系统绘制,深色主题下仍是白底(且无法用 CSS 改)。
 * 这里在运行时把 title 转成 data-tooltip,并用固定在 body 上的气泡显示:
 * 背景/边框/文字全部使用主题变量,随浅色/深色自动切换。
 */

const SHOW_DELAY = 320
const GAP = 8
const EDGE = 8

let tooltipEl: HTMLDivElement | null = null
let showTimer: number | null = null
let current: Element | null = null

function ensureTooltip(): HTMLDivElement {
  if (tooltipEl) return tooltipEl
  const el = document.createElement('div')
  el.className = 'idraw-tooltip'
  el.setAttribute('role', 'tooltip')
  document.body.append(el)
  tooltipEl = el
  return el
}

function hide(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer)
    showTimer = null
  }
  current = null
  tooltipEl?.classList.remove('is-visible')
}

function show(el: Element, text: string): void {
  if (!el.isConnected) return
  const tip = ensureTooltip()
  tip.textContent = text
  tip.classList.add('is-visible')

  const rect = el.getBoundingClientRect()
  let left = rect.left + rect.width / 2 - tip.offsetWidth / 2
  let top = rect.bottom + GAP
  if (top + tip.offsetHeight > window.innerHeight - EDGE) {
    top = rect.top - tip.offsetHeight - GAP
  }
  left = Math.max(EDGE, Math.min(left, window.innerWidth - tip.offsetWidth - EDGE))
  top = Math.max(EDGE, Math.min(top, window.innerHeight - tip.offsetHeight - EDGE))
  tip.style.left = `${Math.round(left)}px`
  tip.style.top = `${Math.round(top)}px`
}

function schedule(el: Element): void {
  const text = el.getAttribute('data-tooltip')?.trim()
  if (!text) return
  if (showTimer !== null) clearTimeout(showTimer)
  current = el
  showTimer = window.setTimeout(() => {
    showTimer = null
    if (current === el) show(el, text)
  }, SHOW_DELAY)
}

/** 把 title 转成 data-tooltip;交互元素补一份 aria-label 作为可访问名称 */
function upgrade(el: Element): void {
  const title = el.getAttribute('title')
  if (title === null) return
  el.removeAttribute('title')
  const text = title.trim()
  if (!text) return
  if (!el.hasAttribute('data-tooltip')) el.setAttribute('data-tooltip', text)
  if (
    el instanceof HTMLElement &&
    !el.hasAttribute('aria-label') &&
    el.matches('button, a, input, select, textarea, [role="button"]')
  ) {
    el.setAttribute('aria-label', text)
  }
}

function upgradeTree(root: ParentNode): void {
  if (root instanceof Element) upgrade(root)
  root.querySelectorAll?.('[title]').forEach(upgrade)
}

export function initThemedTooltips(): void {
  upgradeTree(document.body)

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        upgrade(record.target as Element)
      } else {
        record.addedNodes.forEach(node => {
          if (node instanceof Element) upgradeTree(node)
        })
      }
    }
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title']
  })

  document.addEventListener('mouseover', event => {
    const target = event.target
    if (!(target instanceof Element)) return
    const owner = target.closest('[data-tooltip]')
    if (!owner) return
    if (owner === current) return
    schedule(owner)
  })

  document.addEventListener('mouseout', event => {
    if (!current) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('[data-tooltip]') !== current) return
    const next = event.relatedTarget
    if (next instanceof Node && current.contains(next)) return
    hide()
  })

  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('wheel', hide, { capture: true, passive: true })
  window.addEventListener('scroll', hide, true)
  window.addEventListener('resize', hide)
  window.addEventListener('blur', hide)
}
