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
  <div class="hidden h-full rounded-sm border border-border/60 bg-muted/20 lg:block">
    <slot />
  </div>
  <details :open="defaultOpen" class="rounded-sm border border-border/60 bg-muted/20 lg:hidden">
    <summary class="flex w-full cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-semibold [&::-webkit-details-marker]:hidden">
      <span>{{ title }}</span>
      <UiIcon name="i-lucide-chevron-down" class="size-4 text-muted-foreground transition-transform details-open:rotate-180" />
    </summary>
    <div class="px-3 pb-3">
      <slot />
    </div>
  </details>
</template>
