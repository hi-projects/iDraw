import { createApp } from 'vue'
import App from './App.vue'
import './styles'
import { initTheme } from './theme'
import { initThemedTooltips } from './tooltip'

// 先应用主题再挂载,避免启动时先闪一下浅色界面
initTheme()
createApp(App).mount('#app')
// 把原生 title 提示替换成跟随主题的气泡
initThemedTooltips()
