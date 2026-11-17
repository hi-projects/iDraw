/**
 * 文字测量与换行。
 *
 * 画布的显示换行在**编辑时**算定,保存进 SVG 的是固定版式的多个 `<tspan>`。
 * 理由:SVG 没有"自动换行"这种标准语义,一旦交给查看器自己排,同一张图在
 * 浏览器 / Inkscape / Office 里行数和文字位置都会不同。这里用离屏 canvas 的
 * `measureText` 算出一份所有查看器都照抄的版式。
 *
 * 测量开销集中在两处:拖拽缩放时的反复排版、长文档里的重复测量。前者只在
 * 受影响节点上做,后者用一个小 LRU 挡住(同一句话在同一字号下会被量很多次)。
 */

const FONT_FAMILY = "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif"

let ctx: CanvasRenderingContext2D | null = null

function measureCtx(): CanvasRenderingContext2D | null {
  if (ctx) return ctx
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  ctx = canvas.getContext('2d')
  return ctx
}

export function fontOf(size: number, bold: boolean, italic: boolean): string {
  return `${italic ? 'italic ' : ''}${bold ? '600 ' : ''}${size}px ${FONT_FAMILY}`
}

export function fontFamily(): string {
  return FONT_FAMILY
}

/** 缓存上限:够覆盖一屏几百个不同短句;再大就是给内存找麻烦 */
const CACHE_LIMIT = 2000
const widthCache = new Map<string, number>()

export function measureText(text: string, font: string): number {
  const key = `${font}\u0000${text}`
  const hit = widthCache.get(key)
  if (hit !== undefined) {
    // Map 的插入顺序 = 访问顺序:重新插一次就把它挪到末尾
    widthCache.delete(key)
    widthCache.set(key, hit)
    return hit
  }
  const c = measureCtx()
  let width = 0
  if (c) {
    c.font = font
    width = c.measureText(text).width
  } else {
    // 没有 DOM(理论上不会发生):按全角 1em、半角 0.55em 估一个够用的值
    for (const ch of text) width += /[ᄀ-￿]/.test(ch) ? parseFloat(font) || 14 : (parseFloat(font) || 14) * 0.55
  }
  if (widthCache.size >= CACHE_LIMIT) {
    const oldest = widthCache.keys().next().value
    if (oldest !== undefined) widthCache.delete(oldest)
  }
  widthCache.set(key, width)
  return width
}

/**
 * 把一行文本切成可折行的 token:
 * - 中文/日文/韩文/全角标点:逐字;
 * - 拉丁词与数字:整词(连同其后的空格),避免把 `Flowchart` 拆成两行;
 * - 连续的空白:单独一个 token,行尾会被去掉。
 */
const TOKEN_RE =
  /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿︰-﹏＀-￯]|[^\sᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿︰-﹏＀-￯]+|\s+/g

/** 单个超长 token(长英文单词/URL)按字符硬断,免得撑出节点 */
function hardBreak(token: string, maxWidth: number, font: string): string[] {
  const out: string[] = []
  let current = ''
  for (const ch of token) {
    const next = current + ch
    if (current && measureText(next, font) > maxWidth) {
      out.push(current)
      current = ch
    } else {
      current = next
    }
  }
  if (current) out.push(current)
  return out
}

/**
 * 按最大宽度折行;显式 `\n` 永远断行。空行会保留(用户敲了两个回车就该空一行)。
 * maxWidth <= 0 时只按 `\n` 拆,不折行 —— 文本节点常有这种用法。
 */
export function wrapText(text: string, maxWidth: number, font: string): string[] {
  const result: string[] = []
  for (const raw of text.split('\n')) {
    if (!raw) {
      result.push('')
      continue
    }
    if (maxWidth <= 0) {
      result.push(raw)
      continue
    }
    const tokens = raw.match(TOKEN_RE) ?? []
    let line = ''
    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        // 行首空白丢掉;行中空白先留着,能不能留下由下一次拼宽度决定
        if (!line) continue
        if (measureText(line + token, font) <= maxWidth) line += token
        else {
          result.push(line)
          line = ''
        }
        continue
      }
      const candidate = line + token
      if (!line || measureText(candidate, font) <= maxWidth) {
        if (measureText(candidate, font) > maxWidth && !line) {
          // 单个 token 就超宽:硬断
          const parts = hardBreak(token, maxWidth, font)
          result.push(...parts.slice(0, -1))
          line = parts[parts.length - 1] ?? ''
        } else {
          line = candidate
        }
      } else {
        result.push(line.replace(/\s+$/, ''))
        if (measureText(token, font) > maxWidth) {
          const parts = hardBreak(token, maxWidth, font)
          result.push(...parts.slice(0, -1))
          line = parts[parts.length - 1] ?? ''
        } else {
          line = token
        }
      }
    }
    result.push(line.replace(/\s+$/, ''))
  }
  return result
}

/** 行高:字号 × 1.4,取整后所有查看器都能落在同一位置 */
export function lineHeightOf(fontSize: number): number {
  return Math.round(fontSize * 1.4)
}

/**
 * 基线相对行顶的偏移。
 *
 * 不用 `dominant-baseline`(Inkscape/Office 的支持参差),所以基线位置要自己算。
 * 常见西文/中文字体的 ascent 约 0.8em、descent 0.2em;把文字视觉中心放在
 * (行高 - (ascent + descent)) / 2 之后再下移 ascent。
 */
export function baselineOffset(fontSize: number): number {
  const lineHeight = lineHeightOf(fontSize)
  const ascent = fontSize * 0.8
  const descent = fontSize * 0.2
  return (lineHeight - (ascent + descent)) / 2 + ascent
}
