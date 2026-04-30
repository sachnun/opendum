<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    defaultOpen?: boolean;
  }>(),
  {
    defaultOpen: false,
  }
);
</script>

<template>
  <div class="hidden h-full lg:block">
    <slot />
  </div>
  <details :open="defaultOpen" class="rounded-xl border border-border/70 bg-muted/20 lg:hidden">
    <summary class="flex w-full cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold [&::-webkit-details-marker]:hidden">
      <span>{{ title }}</span>
      <UiIcon name="i-lucide-chevron-down" class="size-4 text-muted-foreground transition-transform details-open:rotate-180" />
    </summary>
    <div class="px-4 pb-4">
      <slot />
    </div>
  </details>
</template>
