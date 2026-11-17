/**
 * 画布 → PNG。
 *
 * 渲染层 CSP 没有放行 `blob:`,所以 SVG 走 `data:image/svg+xml,` 的 data URI;
 * 图片解码完再画进 canvas 编码成 PNG。全程只在导出时发生,平时不生成位图。
 */
import type { CanvasDoc } from './model'
import { serializeCanvas } from './serialize'
import { computedViewBox } from './geometry'

/** 导出最长边上限:再大既慢又容易触发 canvas 尺寸限制 */
const MAX_SIDE = 8192

export interface PngResult {
  bytes: Uint8Array
  width: number
  height: number
}

export async function renderPng(doc: CanvasDoc, scale = 2): Promise<PngResult> {
  const vb = computedViewBox(doc)
  const longest = Math.max(vb.w, vb.h, 1)
  const effective = Math.min(scale, MAX_SIDE / longest)
  const width = Math.max(1, Math.round(vb.w * effective))
  const height = Math.max(1, Math.round(vb.h * effective))

  const svg = serializeCanvas(doc)
  // encodeURIComponent 比 base64 省事,也避免大图生成一份同样大的 base64 字符串
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const img = new Image()
  img.decoding = 'sync'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('SVG 渲染失败'))
    img.src = url
  })

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文')
  // SVG 自己带白色页面,这里再铺一层:页面被画到带透明度的区域时也不会透出底色
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('PNG 编码失败')
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height }
}
