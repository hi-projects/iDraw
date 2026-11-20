# iDraw(iMark 插件)

把 iDraw 的画布编辑器嵌进 iMark:在仓库里直接打开、编辑、保存标准 SVG 画布,不用切换应用。

插件外壳在 `src/webview/`,独立版外壳在 `src/renderer/src/`;画布引擎与编辑本体
(`src/engine`、`src/editor`)两边共用。分层说明见 [`../docs/architecture.md`](../docs/architecture.md)。

## 安装

iMark 已把这个扩展作为**内置插件**随应用发布,默认启用,不需要手动安装。

更新 iDraw 的画布代码后,按下面的顺序同步:iDraw 里构建扩展包,再把包同步进 iMark 的
`src/main/market/builtin/`:

```bash
# iDraw 仓库
npm run plugin:build

# iMark 仓库
npm run idraw:builtin     # 默认读取同级 iDraw-main,可用 IDRAW_ROOT 指定
npm run build
```

构建脚本会调用 iMark 的共享校验模块,因此需要 iMark 仓库位于 iDraw 的同级目录;
不在同级时设置 `IMARK_ROOT`。

如果要把扩展装到别的 iMark 实例,也可以直接使用产物 `dist/imark/idraw.canvas.imkpkg.json`,
在「设置 → 扩展 → 浏览市场」里点「选择扩展包」安装。

## 使用

- 命令面板里搜索「画布」:
  - **打开画布** — 从仓库里的 `.svg` 文件中选择一张(包括 `.assets/` 里的画布),或输入相对路径;
  - **新建画布** — 先输入画布名称,在仓库根的 `.assets/` 下创建 SVG 后打开;
  - **插入画布** — 与笔记行首「+」→「画布」相同,在当前行建画布并插入图像;
  - **保存画布 / 画布另存为 / 导出画布 PNG / 撤销 / 重做**。
- 笔记编辑区行首的「+」菜单里有 **画布**:先输入画布名称,在仓库根的 `.assets/`
  下建好 SVG,再把画布图像插到点「+」的那一行并打开画布。画布保存后回到笔记,
  那个位置显示的就是画布的最新内容。
- 画布是标签栏里与文件等同的标签(`presentation: 'tab'`):标题显示文件名,切到笔记
  只隐藏画布、iframe 与撤销栈都保留。工具栏左侧是 **插入**:点开后在画布上方展开
  文本 / 基本形状 / 其它三组形状,选中后在画布上拖画;新建 / 打开 / 保存用快捷键
  `Ctrl+S`、`Ctrl+Shift+S`、`Ctrl+O`、`Ctrl+N`、`Ctrl+Shift+E` 或命令面板——
  原生菜单拦截的 `Ctrl+S` / `Ctrl+Shift+S` 会经 `imark:command` 转发进来。
- 保存对话框是**工作区内的相对路径**输入框,目录不存在时会自动创建。
  会覆盖已有文件时先弹确认。

## 文件与恢复

新建的画布保存在仓库根的 `.assets/`(与粘贴图片同一个目录,默认不在文件树里显示,
但 Git 同步会带上);文件本身仍是普通 `.svg`,格式见
[`../docs/format.md`](../docs/format.md)。插件不复制文件、不维护旁挂数据。

标签标题显示当前文件名,未保存状态由 `panel.imark.setDirty()` 画成标签上的圆点。
直接关闭标签时,iMark 目前没有
「关闭前询问」的扩展钩子,所以插件会把最新一份未保存内容写到扩展的全局存储目录:

```
<iMark 数据目录>/extensions-data/idraw.canvas/recovery/<时间戳>-<文件名>.svg
```

同时弹出一条「打开恢复文件」的提示。恢复文件本身就是标准 SVG,可以另存为覆盖原图。
