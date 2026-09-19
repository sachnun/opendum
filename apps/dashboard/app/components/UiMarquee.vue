<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { cn } from "../../lib/utils";

const props = withDefaults(
  defineProps<{
    text: string;
    speed?: number;
    class?: string | string[];
  }>(),
  {
    speed: 28,
    class: "",
  }
);

const root = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const distance = ref(0);

let observer: ResizeObserver | null = null;

function measure() {
  const rootEl = root.value;
  const contentEl = content.value;
  if (!rootEl || !contentEl) return;
  distance.value = Math.max(0, Math.ceil(contentEl.scrollWidth - rootEl.clientWidth));
}

onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);
  if (root.value) observer.observe(root.value);
  if (content.value) observer.observe(content.value);
});

onBeforeUnmount(() => observer?.disconnect());

watch(
  () => props.text,
  async () => {
    await nextTick();
    measure();
  }
);
</script>

<template>
  <span ref="root" :class="cn('block min-w-0 overflow-hidden', props.class)">
    <span
      ref="content"
      class="inline-block whitespace-nowrap"
      :class="distance > 0 ? 'opendum-marquee' : ''"
      :style="
        distance > 0
          ? {
              '--opendum-marquee-distance': `-${distance}px`,
              '--opendum-marquee-duration': `${Math.max(4, distance / props.speed)}s`,
            }
          : undefined
      "
      >{{ text }}</span
    >
  </span>
</template>
