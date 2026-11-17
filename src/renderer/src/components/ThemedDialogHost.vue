<script setup lang="ts">
/** 应用内确认弹窗的宿主;样式跟随主题,替代原生 message box。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Info, TriangleAlert } from 'lucide-vue-next'
import { dialogState, resolveDialog } from '../dialog'

const dialogEl = ref<HTMLElement | null>(null)
const options = computed(() => dialogState.options)
const cancelValue = computed(() => options.value?.cancelValue ?? 'cancel')

function cancel(): void {
  if (options.value) resolveDialog(cancelValue.value)
}

function choose(value: string): void {
  resolveDialog(value)
}

function onKeydown(event: KeyboardEvent): void {
  if (!options.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
    return
  }
  if (event.key === 'Enter') {
    const primary = options.value.buttons.find(button => button.kind === 'primary')
    if (primary) {
      event.preventDefault()
      choose(primary.value)
    }
  }
}

watch(options, async value => {
  if (!value) return
  await nextTick()
  dialogEl.value?.focus()
})

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="options" class="idraw-dialog-overlay" @click.self="cancel">
      <section
        ref="dialogEl"
        class="idraw-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="options.title"
        tabindex="-1"
      >
        <div class="idraw-dialog-main">
          <span v-if="options.icon" class="idraw-dialog-icon" :class="options.icon">
            <TriangleAlert v-if="options.icon === 'warning'" :size="20" />
            <Info v-else :size="20" />
          </span>
          <div class="idraw-dialog-text">
            <h2 class="idraw-dialog-title">{{ options.title }}</h2>
            <p class="idraw-dialog-message">{{ options.message }}</p>
            <p v-if="options.detail" class="idraw-dialog-detail">{{ options.detail }}</p>
          </div>
        </div>

        <div class="idraw-dialog-actions">
          <button
            v-for="button in options.buttons"
            :key="button.value"
            class="idraw-dialog-btn"
            :class="button.kind ?? 'default'"
            type="button"
            :data-dialog-value="button.value"
            @click="choose(button.value)"
          >
            {{ button.label }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
