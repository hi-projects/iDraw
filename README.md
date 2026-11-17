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

独立版支持新建/打开/保存/另存为、拖入 `.svg`、关闭前未保存确认、PNG 导出、
节点/连线/文字编辑、框选、对齐、吸附、撤销重做、复制粘贴与缩放。

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
