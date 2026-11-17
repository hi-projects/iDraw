/**
 * 「插入」面板的形状目录。
 *
 * 独立版左侧插入面板与 iMark 插件工具栏上方的插入浮层共用这一份,避免两边
 * 增加形状时漏掉一处。
 */
import type { ShapeKind } from '../engine/model'

export interface ShapeOption {
  kind: ShapeKind
  label: string
}

export interface ShapeGroup {
  title: string
  items: ShapeOption[]
}

export const SHAPE_GROUPS: ShapeGroup[] = [
  {
    title: '文本',
    items: [{ kind: 'text', label: '文本' }]
  },
  {
    title: '基本形状',
    items: [
      { kind: 'rect', label: '矩形' },
      { kind: 'roundRect', label: '圆角矩形' },
      { kind: 'ellipse', label: '椭圆' },
      { kind: 'triangle', label: '三角形' },
      { kind: 'rightTriangle', label: '直角三角形' },
      { kind: 'diamond', label: '菱形' },
      { kind: 'pentagon', label: '五边形' },
      { kind: 'hexagon', label: '六边形' },
      { kind: 'octagon', label: '八边形' },
      { kind: 'star', label: '星形' },
      { kind: 'parallelogram', label: '平行四边形' }
    ]
  },
  {
    title: '其它',
    items: [
      { kind: 'cylinder', label: '圆柱' },
      { kind: 'document', label: '文档' },
      { kind: 'arrow', label: '箭头' },
      { kind: 'plus', label: '十字' }
    ]
  }
]
