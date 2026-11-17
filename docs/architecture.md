# 架构:共用引擎,分离外壳

iDraw 有两个入口:

- 独立应用:Electron 窗口,带原生菜单、窗口标题、拖放打开。
- iMark 插件:iMark 的 overlay webview 面板,文件读写和菜单命令由 iMark 宿主转发。

两个入口共用画布引擎,但**应用外壳和工具栏分开维护**,这样 iMark 里的界面可以按 iMark
的密度和主题单独调整,不会反过来影响独立版。

```text
src/engine/                  画布引擎(两个入口共用)
  model.ts                   场景模型
  serialize.ts               SVG 读写
  geometry.ts                锚点、路由、边界
  history.ts                 逆操作撤销栈
  render.ts                  命令式 SVG 渲染
  interactions.ts            指针/键盘状态机
  clipboard.ts / png.ts / templates.ts / textMetrics.ts / shapes.ts
  runtime.ts                 每张画布的运行时
  host.ts                    引擎需要的宿主能力接口

src/editor/                  画布编辑本体(两个入口共用)
  CanvasView.vue             挂载 runtime、只读预览、属性面板
  CanvasStylePanel.vue       样式/对齐/层级
  notice.ts                  共用通知气泡
  styles/                    主题变量、画布外壳、通知样式

src/renderer/src/            独立应用外壳
  App.vue                    文件生命周期、原生菜单、窗口标题、拖放
  components/CanvasPane.vue  独立版面板 = 自己的工具栏 + CanvasView
  components/CanvasToolbar.vue
  host.ts                    Electron 宿主实现

src/webview/                 iMark 插件外壳
  App.vue                    文件生命周期 + 文档状态上报
  CanvasToolbar.vue          iMark 紧凑工具栏
  host.ts                    postMessage 宿主实现
  bridge.ts                  window.idraw 的 postMessage 适配 + 主题变量
  plugin.css                 iMark 外壳布局覆盖

src/host/windowApi.ts        window.idraw 的唯一读取入口
src/shared/                  两边共用的协议、类型、路径工具
```

## 边界

| 内容 | 归属 |
|---|---|
| 场景、SVG 序列化、几何、渲染、交互、撤销栈 | `src/engine` |
| 画布挂载、只读预览、属性面板 | `src/editor` |
| 工具栏布局、按钮文案、文件入口位置 | 各入口自己的 `CanvasToolbar.vue` |
| 原生菜单、窗口标题、拖放 | 独立应用 |
| 面板标题、文档状态上报、iMark 主题 | iMark 插件 |
| PNG 保存位置与错误提示 | 各入口实现 `CanvasRuntimeHost` |

引擎不 import 任何应用外壳模块。导出 PNG 时只生成 bytes,通过 `host.savePng()` 交给宿主。

## 构建

```text
src/renderer/src/main.ts ─┐
                          ├─→ src/engine + src/editor
src/webview/main.ts ──────┘
```

两边各自打包,源码只有一份。运行时不共享内存或实例:独立应用和 iMark 进程各自加载自己的
构建产物。修改引擎或共用编辑本体后,两边都需要重新构建:

```bash
# 独立应用
npm run build

# iMark 插件
npm run plugin:build
cd ../iMark-main
npm run idraw:builtin
npm run build
```
