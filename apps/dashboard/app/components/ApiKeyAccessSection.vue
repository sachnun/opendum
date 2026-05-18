<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    badge?: string;
    defaultOpen?: boolean;
  }>(),
  {
    badge: undefined,
    defaultOpen: false,
  }
);
</script>

<template>
  <details :open="defaultOpen" class="rounded-sm border border-border/60 bg-muted/20">
    <summary class="flex w-full cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-semibold [&::-webkit-details-marker]:hidden">
      <span class="flex min-w-0 items-center gap-2">
        <span class="truncate">{{ title }}</span>
        <UiBadge v-if="badge" variant="outline" class="text-[10px] font-normal">{{ badge }}</UiBadge>
      </span>
      <UiIcon name="i-lucide-chevron-down" class="size-4 text-muted-foreground transition-transform details-open:rotate-180" />
    </summary>
    <div class="px-3 pb-3">
      <slot />
    </div>
  </details>
</template>
