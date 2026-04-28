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
  <div :class="['font-semibold leading-none', $props.class]">
    <slot />
  </div>
</template>
