/**
 * iMark 插件 webview 的入口。
 *
 * 插件有自己的外壳(`./App.vue`)和工具栏;画布引擎、编辑本体与主题变量来自
 * `src/engine` / `src/editor`,与独立版共用。`bridge.ts` 先把 `window.idraw`
 * 换成 postMessage 实现,再挂载应用。
 */
import './bridge'
import { createApp } from 'vue'
import App from './App.vue'
import '../editor/styles'
import './plugin.css'

createApp(App).mount('#app')

export {}
