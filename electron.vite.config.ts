import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// 开发模式下 Electron 的 Crashpad handler 有时不会启动,Chromium 会打印一条无害的
// 注册失败日志。关闭崩溃上报,保持控制台干净。
if (!process.env['ELECTRON_CLI_ARGS']) {
  process.env['ELECTRON_CLI_ARGS'] = JSON.stringify([
    '--disable-breakpad',
    '--disable-crash-reporter'
  ])
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  }
})
