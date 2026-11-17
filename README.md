# iDraw

用**标准 SVG** 画流程图与示意图的桌面编辑器。可以单独运行,也可以作为插件嵌进 iMark。

- 文件就是普通 `.svg`：浏览器、Inkscape、Illustrator、Office、图片查看器都能直接打开；
  没有私有压缩包、旁挂 JSON 或缩略图缓存。
- iDraw 的节点/锚点/路由信息放在 `data-idraw-*` 扩展属性里,其他软件忽略后仍是一张完整、
  位置正确的图。格式细节见 [docs/format.md](docs/format.md)。
- 低内存:场景不进入 Vue 深层响应式,渲染直接操作 SVG DOM,撤销栈存逆操作 patch。

## 单独运行

```bash
npm install
npm run dev        # 开发
npm run build      # 生产构建
npm run typecheck
```

独立版启动后先进入**仓库选择页**,和 iMark 一样分三种用法:

- **打开文件夹**:选中的目录作为仓库,里面的 `.svg` 就是画布。侧栏可以新建、
  切换、重命名、删除(移到回收站),编辑后**自动保存**,关闭窗口前也会同步落盘。
- **临时画布**:不写入仓库,也**不会自动保存**,适合随手画两张;关闭前仍会确认。
- **打开单个 SVG 文件**:与临时画布一样手动保存,不会加入任何仓库。

选择页以普通窗口居中打开;打开仓库或画布后窗口会自动最大化(保留 Windows 任务栏),
返回仓库选择页时恢复为普通窗口。选择页是上下结构:最近打开区域的第一个位置
是「+」按钮,点击后弹出「临时画布 / 打开文件 / 打开文件夹」,其余位置显示
最近画布的缩略图。仓库卡片会把内部最多 4 张画布拼在一起预览
(1 张铺满、2 张并排、3 张一大多小、4 张 2x2),单独打开的画布卡片则
直接显示自身缩略图。

编辑能力包括节点/连线/文字编辑、框选、对齐、吸附、撤销重做、复制粘贴与缩放;
工具栏的插入按钮会从左侧滑出面板，包含文本、矩形、椭圆、三角形、星形、箭头等
16 种形状。另存为、拖入 `.svg`、PNG 导出、关闭前未保存确认仍然可用。

左下角的齿轮菜单集中了保存、导出 PNG、撤销、重做与设置入口;设置面板采用左侧
分区 + 右侧内容的布局,目前包含「外观 / 编辑器 / 关于」,外观里提供
「跟随系统 / 浅色 / 深色」主题选择,选择立即生效并会记住。

常用快捷键:`Ctrl+N` 新建画布(仓库里新建到侧栏 / 临时模式新建空白画布)、
`Ctrl+O` 打开 SVG、`Ctrl+Shift+O` 回到仓库选择页、`Ctrl+S` 保存、
`Ctrl+Shift+E` 导出 PNG。

冒烟验收:

```bash
npm run build
xvfb-run -a env -u ELECTRON_RUN_AS_NODE npx electron verify/smoke.cjs
```

## 作为 iMark 插件

```bash
npm run plugin:build
```

iMark 已把这个扩展作为内置插件随应用发布,默认启用,不需要手动安装。更新时把构建产物
同步进 iMark 的内置目录:

```bash
cd ../iMark-main
npm run idraw:builtin
npm run build
```

插件有自己的 iMark 外壳和紧凑工具栏,画布引擎与编辑本体从 `src/engine` / `src/editor`
共用同一份源码;文件读写由 iMark 宿主代劳,路径按当前工作区内的相对路径填写。产物也可以
在 iMark 的扩展设置里手动安装。分层说明见 [docs/architecture.md](docs/architecture.md),
使用细节见 [imark-plugin/README.md](imark-plugin/README.md)。

构建脚本会调用 iMark 的共享校验模块,默认查找同级目录的 `iMark-main`;不在同级时设置
`IMARK_ROOT` 指向 iMark 仓库。
