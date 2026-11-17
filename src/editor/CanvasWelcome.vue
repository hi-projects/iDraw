<script setup lang="ts">
/**
 * 新建画布引导卡片。
 *
 * 独立版启动页和空画布都会复用它:卡片分三段(空白画布 / 预设模板 / 从模板导入),
 * 具体是「在当前空文档里插入模板」还是「挂载一份新文档」由外壳决定。
 */
import {
  ArrowRight,
  GanttChart,
  LayoutTemplate,
  Plus,
  Workflow
} from 'lucide-vue-next'

const emit = defineEmits<{
  (e: 'blank'): void
  (e: 'template', kind: 'flowchart' | 'gantt'): void
  (e: 'import'): void
}>()
</script>

<template>
  <div class="canvas-welcome">
    <div class="canvas-new-card">
      <section class="canvas-new-section">
        <div class="canvas-new-section-title">空白画布</div>
        <button class="canvas-blank-btn" @click="emit('blank')">
          <span class="canvas-item-icon"><Plus :size="18" /></span>
          <span class="canvas-item-text">
            <span class="canvas-item-name">新建空白画布</span>
            <span class="canvas-item-desc">从一张干净的页面开始</span>
          </span>
          <ArrowRight class="canvas-item-arrow" :size="17" />
        </button>
      </section>

      <div class="canvas-new-divider"></div>

      <section class="canvas-new-section">
        <div class="canvas-new-section-title">预设模板</div>
        <button
          class="canvas-template-item is-flow"
          @click="emit('template', 'flowchart')"
        >
          <span class="canvas-item-icon"><Workflow :size="18" /></span>
          <span class="canvas-item-text">
            <span class="canvas-item-name">流程图</span>
            <span class="canvas-item-desc">开始 / 判断 / 处理 / 结束</span>
          </span>
          <ArrowRight class="canvas-item-arrow" :size="17" />
        </button>
        <button
          class="canvas-template-item is-gantt"
          @click="emit('template', 'gantt')"
        >
          <span class="canvas-item-icon"><GanttChart :size="18" /></span>
          <span class="canvas-item-text">
            <span class="canvas-item-name">甘特图</span>
            <span class="canvas-item-desc">按周排期，跟踪任务进度</span>
          </span>
          <ArrowRight class="canvas-item-arrow" :size="17" />
        </button>
      </section>

      <div class="canvas-new-divider"></div>

      <section class="canvas-new-section">
        <div class="canvas-new-section-title">从模板导入</div>
        <button class="canvas-template-item is-import is-coming" @click="emit('import')">
          <span class="canvas-item-icon"><LayoutTemplate :size="18" /></span>
          <span class="canvas-item-text">
            <span class="canvas-item-name">模板社区</span>
            <span class="canvas-item-desc">从社区导入现成的画布</span>
          </span>
          <span class="canvas-new-badge">即将上线</span>
        </button>
      </section>
    </div>
  </div>
</template>
