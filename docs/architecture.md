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

src/main/                    独立应用主进程
  index.ts                   窗口、菜单、文件 IPC、同步落盘
  workspace.ts               仓库扫描、新建/重命名/删除画布
  workspaceRecents.ts        最近打开列表(userData)

src/renderer/src/            独立应用外壳
  App.vue                    视图状态(选择页/仓库/临时)、自动保存、菜单、拖放
  components/WorkspacePicker.vue   启动页 / 仓库选择
  components/WorkspaceSidebar.vue  仓库画布列表与文件操作入口
  components/StatusBar.vue   仓库名、画布名与保存状态
  components/WindowControls.vue  最小化 / 关闭按钮(Windows/Linux)
  components/GlobalMenu.vue  左下角全局菜单、设置面板与主题选择
  components/CanvasPane.vue  独立版面板 = 自己的工具栏 + CanvasView
  components/CanvasToolbar.vue
  components/ShapePanel.vue  左侧滑出的形状面板(独立版)
  components/ShapePreview.vue  形状面板里的线稿预览
  theme.ts                  独立版主题偏好(localStorage)
  host.ts                    Electron 宿主实现 + 仓库 API 断言

src/webview/                 iMark 插件外壳
  App.vue                    文件生命周期 + 文档状态上报
  CanvasToolbar.vue          iMark 紧凑工具栏
  host.ts                    postMessage 宿主实现
  bridge.ts                  window.idraw 的 postMessage 适配 + 主题变量
  plugin.css                 iMark 外壳布局覆盖

src/host/windowApi.ts        window.idraw 的唯一读取入口
src/shared/                  两边共用的协议、类型、路径工具
```

## 仓库模式

独立版启动永远先到仓库选择页,不自动恢复上次仓库。`WindowApi.workspace`
是**只由独立应用 preload 提供**的可选能力(选择目录、列画布、改名、删除、
最近打开),插件 webview 的 postMessage 桥不需要实现它。

- 进入画布/仓库视图时渲染层请求最大化(保留任务栏),回到仓库选择页时还原;
  Windows/Linux 的最小化、关闭与最大化都走 `window:*` IPC。
- 仓库画布由渲染层调度自动保存:编辑后 700ms 无操作写回;切换画布、
  返回选择页、重命名当前画布前先排空写盘队列;窗口关闭时走
  `sendSync` 同步写盘,写成功就不再弹未保存确认。
- 临时画布与单独打开的 SVG 不启用自动保存,关闭/切换时仍按原有
  「保存 / 不保存 / 取消」流程处理。
- 主进程只负责目录扫描与文件操作,并为所有相对路径做仓库边界校验;
  最近打开列表存在 `userData/workspaces.json`,同时记录仓库与单独打开的画布,
  不会污染仓库目录。
- 启动页的缩略图不走主进程离屏渲染:渲染层读 SVG 文本,转成 `data:` URL
  交给 `<img>` 缩放。仓库卡片最多取前 4 张画布,单文件卡片取自身;
  放不下的画布不读取,避免一次打开大量文件。

## 边界

| 内容 | 归属 |
|---|---|
| 场景、SVG 序列化、几何、渲染、交互、撤销栈 | `src/engine` |
| 画布挂载、只读预览、属性面板 | `src/editor` |
| 工具栏布局、按钮文案、文件入口位置 | 各入口自己的 `CanvasToolbar.vue` |
| 原生菜单、窗口标题、拖放 | 独立应用 |
| Windows/Linux 的最小化与关闭按钮 | 渲染层 `WindowControls.vue` + 主进程 IPC;macOS 仍用原生交通灯 |
| 左下角菜单、设置面板与主题偏好 | 独立应用渲染层(`GlobalMenu.vue` + `theme.ts`,localStorage) |
| 仓库扫描、画布新建/改名/删除、最近打开 | 主进程 `workspace*.ts` |
| 仓库选择页、侧栏、自动保存调度 | 独立应用外壳 |
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
