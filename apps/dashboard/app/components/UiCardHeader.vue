<script setup lang="ts">
withDefaults(
  defineProps<{
    class?: string;
  }>(),
  {
    class: "",
  }
);
</script>

<template>
  <div :class="['grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6', $props.class]">
    <slot />
  </div>
</template>
