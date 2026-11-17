/**
 * 形状几何与文字版式 —— 渲染(render.ts)与序列化(serialize.ts)**共用这一份**。
 *
 * 共用不是为了省代码,而是为了不让两边漂移:同一张画布在屏幕上看是这样、
 * 存到文件里换一个查看器打开也必须是这样。任何"改一下渲染、忘了改保存"
 * 都会变成"存出来的图和你看到的不一样"。
 */
import type { CanvasEdge, CanvasNode, NodeStyle } from './model'
import { baselineOffset, fontOf, lineHeightOf, wrapText } from './textMetrics'

export interface SvgPart {
  tag: string
  attrs: Record<string, string | number>
}

function num(n: number): string {
  // 只用于拼接属性值;保留 2 位小数,去掉多余的 0
  return String(Math.round(n * 100) / 100)
}

function dashOf(style: { dash: boolean; strokeWidth: number }): string | undefined {
  return style.dash ? `${num(style.strokeWidth * 3)} ${num(style.strokeWidth * 2)}` : undefined
}

/** 在 w×h 的框内生成正多边形顶点,默认尖角朝上 */
function regularPolygon(w: number, h: number, sides: number, rotation = -Math.PI / 2): string {
  const cx = w / 2
  const cy = h / 2
  const rx = w / 2
  const ry = h / 2
  const points: string[] = []
  for (let i = 0; i < sides; i += 1) {
    const angle = rotation + (i * Math.PI * 2) / sides
    points.push(`${num(cx + Math.cos(angle) * rx)},${num(cy + Math.sin(angle) * ry)}`)
  }
  return points.join(' ')
}

/** 五角星:外顶点与内顶点交替 */
function starPolygon(w: number, h: number): string {
  const cx = w / 2
  const cy = h / 2
  const inner = 0.42
  const points: string[] = []
  for (let i = 0; i < 10; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5
    const rx = (w / 2) * (i % 2 === 0 ? 1 : inner)
    const ry = (h / 2) * (i % 2 === 0 ? 1 : inner)
    points.push(`${num(cx + Math.cos(angle) * rx)},${num(cy + Math.sin(angle) * ry)}`)
  }
  return points.join(' ')
}

/** 形状本身的元素(局部坐标 0..w / 0..h);`text` 形状没有 */
export function shapeParts(node: CanvasNode): SvgPart[] {
  const { w, h, style } = node
  const paint: Record<string, string | number> = {
    fill: style.fill,
    stroke: style.stroke,
    'stroke-width': num(style.strokeWidth)
  }
  const dash = dashOf(style)
  if (dash) paint['stroke-dasharray'] = dash

  switch (node.shape) {
    case 'rect':
      return [{ tag: 'rect', attrs: { x: 0, y: 0, width: num(w), height: num(h), ...paint } }]
    case 'roundRect': {
      const r = Math.max(0, Math.min(style.radius, w / 2, h / 2))
      return [
        { tag: 'rect', attrs: { x: 0, y: 0, width: num(w), height: num(h), rx: num(r), ry: num(r), ...paint } }
      ]
    }
    case 'ellipse':
      return [
        {
          tag: 'ellipse',
          attrs: { cx: num(w / 2), cy: num(h / 2), rx: num(w / 2), ry: num(h / 2), ...paint }
        }
      ]
    case 'diamond':
      return [
        {
          tag: 'polygon',
          attrs: { points: `${num(w / 2)},0 ${num(w)},${num(h / 2)} ${num(w / 2)},${num(h)} 0,${num(h / 2)}`, ...paint }
        }
      ]
    case 'parallelogram': {
      const skew = Math.min(w * 0.2, h * 0.8)
      return [
        {
          tag: 'polygon',
          attrs: {
            points: `${num(skew)},0 ${num(w)},0 ${num(w - skew)},${num(h)} 0,${num(h)}`,
            ...paint
          }
        }
      ]
    }
    case 'hexagon': {
      const cut = Math.min(w * 0.22, w / 2)
      return [
        {
          tag: 'polygon',
          attrs: {
            points: `${num(cut)},0 ${num(w - cut)},0 ${num(w)},${num(h / 2)} ${num(w - cut)},${num(h)} ${num(cut)},${num(h)} 0,${num(h / 2)}`,
            ...paint
          }
        }
      ]
    }
    case 'cylinder': {
      const ry = Math.max(4, Math.min(h * 0.16, 14))
      const rx = w / 2
      const body = `M0,${num(ry)} A${num(rx)},${num(ry)} 0 0 1 ${num(w)},${num(ry)} L${num(w)},${num(h - ry)} A${num(rx)},${num(ry)} 0 0 0 0,${num(h - ry)} Z`
      return [
        { tag: 'path', attrs: { d: body, ...paint } },
        // 顶面的下沿:没有它看起来只是个圆角矩形
        { tag: 'ellipse', attrs: { cx: num(rx), cy: num(ry), rx: num(rx), ry: num(ry), fill: 'none', stroke: style.stroke, 'stroke-width': num(style.strokeWidth) } }
      ]
    }
    case 'document': {
      const z = Math.min(h * 0.12, 10)
      const d = `M0,0 L${num(w)},0 L${num(w)},${num(h - z)} C${num(w * 0.7)},${num(h + z * 0.4)} ${num(w * 0.3)},${num(h - z * 1.6)} 0,${num(h)} Z`
      return [{ tag: 'path', attrs: { d, ...paint } }]
    }
    case 'triangle':
      return [
        {
          tag: 'polygon',
          attrs: { points: `${num(w / 2)},0 ${num(w)},${num(h)} 0,${num(h)}`, ...paint }
        }
      ]
    case 'rightTriangle':
      return [
        {
          tag: 'polygon',
          attrs: { points: `0,0 ${num(w)},${num(h)} 0,${num(h)}`, ...paint }
        }
      ]
    case 'pentagon':
      return [{ tag: 'polygon', attrs: { points: regularPolygon(w, h, 5), ...paint } }]
    case 'octagon':
      return [
        {
          tag: 'polygon',
          attrs: { points: regularPolygon(w, h, 8, -Math.PI / 2 + Math.PI / 8), ...paint }
        }
      ]
    case 'star':
      return [{ tag: 'polygon', attrs: { points: starPolygon(w, h), ...paint } }]
    case 'arrow': {
      const shaft = h * 0.34
      const y1 = (h - shaft) / 2
      const y2 = (h + shaft) / 2
      const head = w * 0.62
      const points = `0,${num(y1)} ${num(head)},${num(y1)} ${num(head)},0 ${num(w)},${num(h / 2)} ${num(head)},${num(h)} ${num(head)},${num(y2)} 0,${num(y2)}`
      return [{ tag: 'polygon', attrs: { points, ...paint } }]
    }
    case 'plus': {
      const x1 = w * 0.36
      const x2 = w * 0.64
      const y1 = h * 0.36
      const y2 = h * 0.64
      const points = `${num(x1)},0 ${num(x2)},0 ${num(x2)},${num(y1)} ${num(w)},${num(y1)} ${num(w)},${num(y2)} ${num(x2)},${num(y2)} ${num(x2)},${num(h)} ${num(x1)},${num(h)} ${num(x1)},${num(y2)} 0,${num(y2)} 0,${num(y1)} ${num(x1)},${num(y1)}`
      return [{ tag: 'polygon', attrs: { points, ...paint } }]
    }
    case 'text':
      return []
  }
}

export interface NodeTextLayout {
  lines: string[]
  /** `<text>` 与每个 `<tspan>` 的 x */
  x: number
  /** 第一行基线 */
  y: number
  lineHeight: number
  anchor: 'start' | 'middle' | 'end'
  fontSize: number
  fontFamily: string
  bold: boolean
  italic: boolean
  color: string
}

/** 形状内文字的外边距 */
export function textPadding(shape: CanvasNode['shape']): { x: number; y: number } {
  return shape === 'text' ? { x: 2, y: 2 } : { x: 10, y: 6 }
}

/**
 * 节点文字的折行与定位。
 *
 * 宽度按 `w - 2*padding` 算;文本形状不限制宽度(它常被当成标签用,自动折行
 * 会把一句话断得很奇怪),只认显式换行。
 */
export function layoutNodeText(node: CanvasNode): NodeTextLayout {
  const style = node.style
  const font = fontOf(style.fontSize, style.bold, style.italic)
  const padding = textPadding(node.shape)
  const maxWidth = node.shape === 'text' ? 0 : Math.max(10, node.w - padding.x * 2)
  const lines = wrapText(node.text || '', maxWidth, font)
  const lineHeight = lineHeightOf(style.fontSize)
  const blockHeight = lines.length * lineHeight
  let top: number
  if (style.valign === 'top') top = padding.y
  else if (style.valign === 'bottom') top = node.h - padding.y - blockHeight
  else top = (node.h - blockHeight) / 2
  const x =
    style.align === 'left' ? padding.x : style.align === 'right' ? node.w - padding.x : node.w / 2
  const anchor = style.align === 'left' ? 'start' : style.align === 'right' ? 'end' : 'middle'
  return {
    lines,
    x,
    y: top + baselineOffset(style.fontSize),
    lineHeight,
    anchor,
    fontSize: style.fontSize,
    fontFamily: "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
    bold: style.bold,
    italic: style.italic,
    color: style.color
  }
}

/** 文字元素的公共属性(不含 tspan) */
export function textAttrs(layout: NodeTextLayout): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    x: num(layout.x),
    y: num(layout.y),
    'text-anchor': layout.anchor,
    'font-family': layout.fontFamily,
    'font-size': num(layout.fontSize),
    fill: layout.color
  }
  if (layout.bold) attrs['font-weight'] = '600'
  if (layout.italic) attrs['font-style'] = 'italic'
  return attrs
}

/** 节点描边颜色(导出箭头 marker 用) */
export function edgeColor(edge: CanvasEdge): string {
  return edge.style.stroke
}

export function stylePaint(style: NodeStyle): Record<string, string | number> {
  const paint: Record<string, string | number> = {
    fill: style.fill,
    stroke: style.stroke,
    'stroke-width': num(style.strokeWidth)
  }
  const dash = dashOf(style)
  if (dash) paint['stroke-dasharray'] = dash
  return paint
}
