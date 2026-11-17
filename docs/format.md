# iDraw 格式

iDraw 的画布是仓库里的一个**普通 `.svg` 文件**。它没有私有二进制格式、没有压缩包、没有
旁挂 JSON：浏览器、Inkscape、Illustrator、Office、图片查看器都能直接打开；Markdown 里用标准
图片语法引用：

```markdown
![](图.svg)
```

iDraw 自己的编辑信息（节点 id、锚点、路由方式、文字逻辑内容等）全部放在 `data-idraw-*`
属性里。这些属性属于标准 SVG 的扩展属性，其他软件忽略它们以后看到的仍是一张完整、位置
正确的图。

实现代码在 `src/renderer/src/canvas/`，读写在 `serialize.ts`，场景类型在 `model.ts`。

## 1. 总体结构

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"
     viewBox="0 0 1600 1000" data-idraw-canvas="1" data-idraw-version="1">
  <defs>
    <marker id="idraw-arrow-4b5563" ...>...</marker>
    <marker id="idraw-arrow-start-4b5563" ...>...</marker>
  </defs>
  <rect data-idraw-page="1" x="0" y="0" width="1600" height="1000" fill="#ffffff"/>
  <g data-idraw-layer="edges">
    <path data-idraw-edge="e1" data-idraw-from-node="n1" data-idraw-from-anchor="auto"
          data-idraw-to-node="n2" data-idraw-to-anchor="auto"
          data-idraw-routing="orthogonal" data-idraw-arrow="end"
          d="M 280 160 L 360 160" fill="none" stroke="#4b5563" stroke-width="1.5"
          marker-end="url(#idraw-arrow-4b5563)"/>
  </g>
  <g data-idraw-layer="nodes">
    <g data-idraw-node="n1" data-idraw-shape="roundRect"
       data-idraw-x="120" data-idraw-y="120" data-idraw-w="160" data-idraw-h="80"
       data-idraw-align="center" data-idraw-valign="middle" data-idraw-radius="8"
       transform="translate(120 120)">
      <rect width="160" height="80" rx="8" fill="#ffffff" stroke="#4b5563" stroke-width="1.5"/>
      <text x="80" y="40" text-anchor="middle" font-family="'Segoe UI', 'Microsoft YaHei', sans-serif"
            font-size="14" fill="#1f2328" data-idraw-text="开始">
        <tspan x="80" y="40">开始</tspan>
      </text>
    </g>
  </g>
</svg>
```

约定：

- 根节点必须有 `data-idraw-canvas="1"`。**没有这个标记的 SVG 一律只读预览**，iDraw 不会保存
  或改写它。
- `data-idraw-version` 是格式版本，当前为 `1`。
- 背景页是一个白色 `<rect data-idraw-page="1">`；文件本身固定浅色纸面，不跟随应用深色主题，
  保证在任意查看器里颜色一致（编辑区的无限画布背景会跟随主题，但保存出来的文件仍是白底）。
- **边层在节点层之前**，所以连线和标签不会被形状里的文字盖住。
- 样式全部写成 presentation attributes（`fill`、`stroke`、`stroke-width`、
  `stroke-dasharray` 等），**不使用 `<style>` 或 class**。外部软件不会因为选择器、层叠顺序
  或样式表丢失而变样。
- 坐标保留两位小数（`Math.round(n * 100) / 100`）。文件统一 LF 换行。

## 2. 节点

每个节点是一个 `<g data-idraw-node="...">`。组内的形状元素只负责“让别的软件看得见”，
iDraw 自己的几何以 `data-idraw-*` 为准。

| 属性 | 含义 |
|---|---|
| `data-idraw-node` | 节点 id，画布内唯一 |
| `data-idraw-shape` | `rect` / `roundRect` / `ellipse` / `diamond` / `parallelogram` / `hexagon` / `cylinder` / `document` / `triangle` / `rightTriangle` / `pentagon` / `octagon` / `star` / `arrow` / `plus` / `text` |
| `data-idraw-x` / `data-idraw-y` | 节点左上角的世界坐标（权威） |
| `data-idraw-w` / `data-idraw-h` | 节点宽高（权威） |
| `data-idraw-align` | 文字水平对齐 `left` / `center` / `right` |
| `data-idraw-valign` | 文字垂直对齐 `top` / `middle` / `bottom` |
| `data-idraw-radius` | 圆角半径（圆角矩形） |
| `transform="translate(x y)"` | 与 `data-idraw-x/y` 相同的平移，方便其他查看器 |

读到节点时以 `data-idraw-x/y/w/h` 为权威；如果外部工具改了 `transform` 或子元素尺寸但没有改
`data-idraw-*`，iDraw 会按 `data` 恢复自己的布局。这是刻意的取舍：`data` 属性是我们能无歧义
还原的东西，而外部工具对形状的任意变换不一定能反映回场景模型。

节点内可能有多个形状子元素（例如圆柱由椭圆 + path 组成），统一按同一套 `fill` / `stroke` /
`stroke-width` / `dash` 读取样式。文字形状（`data-idraw-shape="text"`）忽略填充与描边，只保留
文字。

## 3. 文字

- 逻辑文字保存在 `<text data-idraw-text="...">` 上。XML 属性会把字面换行归一成空格，所以
  换行写成字符引用 `&#10;`。
- 可视换行由多个 `<tspan x y>` 表示。iDraw 打开时按节点宽度与字号重新排版；其他软件看到的是
  保存时的固定版式，不会重排。
- 水平/垂直对齐通过 `text-anchor` 与显式 `x/y` 表达，不使用 `dominant-baseline`（兼容性差）。
- 空文字也会输出一个 `data-idraw-text=""` 的 `<text>`，用来区分“没有文字”和“外部工具删掉了
  文字元素”。

## 4. 连线

每条边是一个 `<path data-idraw-edge="...">`：

| 属性 | 含义 |
|---|---|
| `data-idraw-edge` | 边 id，画布内唯一 |
| `data-idraw-from-node` / `data-idraw-to-node` | 端点绑定的节点 id；空表示自由端点 |
| `data-idraw-from-anchor` / `data-idraw-to-anchor` | `auto` / `n` / `e` / `s` / `w`；`auto` 由 iDraw 每次自动选边 |
| `data-idraw-from-x` / `data-idraw-from-y` | 仅自由端点：世界坐标 |
| `data-idraw-routing` | `straight` / `orthogonal` / `curve` |
| `data-idraw-arrow` | `none` / `start` / `end` / `both` |
| `d` | 实际路径。其他软件直接按它绘制 |

边标签是相邻的 `<text data-idraw-edge-label="边 id">`，逻辑内容存在 `data-idraw-label`（同样用
`&#10;` 表示换行），位置在路径中点。标签带白色描边（`paint-order="stroke"`），压在线上也
清楚。

箭头用 `<defs>` 里按**描边颜色**生成的 marker（`idraw-arrow-<颜色>` 与
`idraw-arrow-start-<颜色>`），不使用 `context-stroke`，也不用 `auto-start-reverse` —— 这两样在
部分导入器里不生效。双向箭头分别引用 start / end 两个 marker。

若一条边指向的节点在文件里不存在，解析时该端点退化成自由端点（坐标取自 `d` 的起止点），
不会因为一条坏边让整张图打不开。

## 5. 页面与可视区域

- 新建画布的页面是 1600 × 1000（`PAGE_WIDTH` / `PAGE_HEIGHT`）。
- 保存时 `viewBox` 会把内容包进来：以原页面为底，再按所有节点/自由端的包围盒向外扩 40px
  （`CONTENT_MARGIN`）。因此节点拖到页面外也不会被其他查看器裁掉，允许负坐标。
- 世界坐标不因 `viewBox` 变化而平移，节点位置始终是 `data-idraw-x/y` 的绝对坐标。

## 6. 解析、兼容与安全

- 解析用 `DOMParser`，**只读属性**，不把外部 SVG 塞进 `innerHTML`，也不执行其中任何脚本。
  没有 `data-idraw-canvas="1"` 的 SVG（或解析失败的文件）进入只读预览。
- 外部 SVG 只读时，保存流程写回的仍是原始文本；编辑器不创建任何可编辑场景。
- 未知的 `data-idraw-shape` 退回圆角矩形；未知的锚点/路由/箭头退回默认值。
- 只使用标准 SVG 元素与属性；`data-idraw-*` 是未知属性，其他软件按规范忽略。

## 7. 编辑与保存行为

- 新建画布先写一份空白骨架（根节点 + 白色页面），与打开空画布完全一致；第一次保存时才选路径。
- 保存前会 `flush()`：提交正在编辑的文字浮层、结束进行中的拖动，避免丢掉刚输入的字。
- 脏标记来自撤销栈：`currentKey !== savedKey`。撤销回到保存点时自动变干净。
- 撤销栈保存的是逆操作 patch（最多 100 条），不是整份场景快照。
- 只读画布不会变脏，也不会被保存改写。
- 另存为强制 `.svg` 扩展名。
- 新建、打开前若有未保存改动，会先问“保存 / 不保存 / 取消”；选择保存时走正常保存流程，
  取消则中止当前操作。
- 关闭窗口时由原生对话框确认“放弃修改并退出 / 取消”。插件模式没有关闭前钩子，见第 9 节
  的恢复草稿。
- 独立版把 `.svg` 文件拖进窗口即可打开，也支持命令行参数和系统“打开方式”。

## 8. 与其他软件、Markdown 共用

保存出的文件是标准 SVG：浏览器、Inkscape、Illustrator、Office、图片查看器都能直接打开，
`data-idraw-*` 只是被忽略的未知属性。Markdown 里按普通图片引用即可：

```markdown
![](图.svg)
```

路径含空格时使用标准尖括号写法：

```markdown
![](<assets/流程 图.svg>)
```

iDraw 不注册私有协议，也不生成缩略图或旁挂缓存；Markdown 预览直接读磁盘上的同一个文件。

## 9. 在 iMark 里使用（插件）

插件把整个 iDraw 应用装进 iMark 的 overlay 面板，画布代码与独立版是同一份。iMark 已把它
作为内置插件随应用发布（默认启用），日常使用不需要安装。更新代码时：

```bash
# iDraw 仓库
npm run plugin:build          # 产物 dist/imark/idraw.canvas.imkpkg.json

# iMark 仓库
npm run idraw:builtin         # 同步到内置包
npm run build
```

安装后：

- 命令面板：「打开画布」「新建画布」「保存画布」「画布另存为」「导出画布 PNG」「撤销」「重做」。
- 画布面板铺满编辑区，工具栏左侧是 **新建 / 打开 / 保存**；`Ctrl+S`、`Ctrl+Shift+S`、
  `Ctrl+O`、`Ctrl+N`、`Ctrl+Shift+E` 同样可用。
- 文件路径按**当前工作区内的相对路径**输入（目录会自动创建）；有同名文件时先确认覆盖。
- 插件不复制文件、不维护旁挂数据，保存目标就是仓库里的普通 `.svg`。

iMark 目前没有“面板关闭前”的扩展钩子，所以直接关闭面板时，插件会把最新一份未保存内容写到
扩展全局存储：

```
<iMark 数据目录>/extensions-data/idraw.canvas/recovery/<时间戳>-<文件名>.svg
```

并弹出一条「打开恢复文件」提示。恢复文件本身就是标准 SVG，可以另存为覆盖原图。

## 10. 性能

- 场景是普通 JS 对象，不放进 Vue 深层响应式；只有工具栏与属性面板的摘要状态是响应式的。
- 渲染是命令式 SVG DOM，按 id 复用元素；拖拽/缩放期间只改受影响节点的 `transform` 与相关边
  的 `d`，松手后才提交一次历史。
- SVG 字符串只在保存、导出、复制时生成。
- 文字测量用共享的离屏 canvas，并按 `(font, text)` 做小型 LRU。
- PNG 导出用 `data:image/svg+xml,...`（渲染层 CSP 未放行 `blob:`），最长边限制在 8192px。
- 插件模式只在打开画布面板后加载画布代码；不打开面板的 iMark 会话不承担这部分内存。

## 11. 验收

独立版冒烟（构建后直接加载渲染层，用桩 IPC 跑文件流程）：

```bash
npm run build
xvfb-run -a env -u ELECTRON_RUN_AS_NODE npx electron verify/smoke.cjs
```

覆盖：新建、画形状与连线、拖动、撤销/重做、保存与 SVG 解析、重开后保留、外部 SVG 只读、PNG 导出。

插件端到端（在 iMark 仓库里跑，默认读取同级 iDraw 的构建产物）：

```bash
xvfb-run -a node verify/run.mjs idraw-plugin
```

覆盖：插件安装、overlay 面板、模板、保存到仓库、新建后重新打开、外部 SVG 只读。
