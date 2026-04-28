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
  <div :class="['px-6', $props.class]">
    <slot />
  </div>
</template>
