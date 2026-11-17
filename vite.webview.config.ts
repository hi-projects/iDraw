import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 插件 webview 的打包配置。
 *
 * 产物是单个 IIFE `canvas.js` + `canvas.css`:插件宿主用 `asWebviewUri()` 把两者
 * 作为普通静态资源引用,不需要模块加载器、不需要 hash 文件名,也不会与 iMark 的
 * CSP 打架(脚本只从 `imark-webview://idraw.canvas` 这一个源加载)。
 */
export default defineConfig({
  plugins: [vue()],
  publicDir: false,
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  build: {
    outDir: 'imark-plugin/webview',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    minify: 'esbuild',
    sourcemap: false,
    lib: {
      entry: resolve('src/webview/main.ts'),
      name: 'iDrawCanvas',
      formats: ['iife'],
      fileName: () => 'canvas.js',
      cssFileName: 'canvas'
    }
  }
})
