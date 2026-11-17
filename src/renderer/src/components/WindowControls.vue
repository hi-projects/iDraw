<script setup lang="ts">
/**
 * Windows/Linux 的自定义窗口按钮。
 *
 * 原生 titleBarOverlay 只能同时显示最小化/最大化/关闭三颗按钮;这里去掉最大化,
 * 只留最小化与关闭,并浮在所有视图右上角(选择页、画布工具栏、只读预览都适用)。
 * macOS 保留系统交通灯,不渲染这个组件。
 */
import { Minus, X } from 'lucide-vue-next'
import { api } from '../../../host/windowApi'
</script>

<template>
  <div class="idraw-window-controls">
    <button
      class="idraw-window-btn"
      type="button"
      title="最小化"
      aria-label="最小化"
      @click="api.minimizeWindow?.()"
    >
      <Minus :size="14" :stroke-width="1.8" />
    </button>
    <button
      class="idraw-window-btn is-close"
      type="button"
      title="关闭"
      aria-label="关闭"
      @click="api.closeWindow?.()"
    >
      <X :size="14" :stroke-width="1.8" />
    </button>
  </div>
</template>
