<script setup lang="ts">
import type { ProviderAccountIndicator } from "../../lib/navigation";

const props = defineProps<{
  activeAccountCount?: number;
  indicator?: ProviderAccountIndicator;
}>();

const hasActiveAccounts = computed(
  () => typeof props.activeAccountCount === "number" && props.activeAccountCount > 0
);

const indicatorClass = computed(() => {
  if (props.indicator === "error") {
    return "bg-red-500";
  }

  if (props.indicator === "warning") {
    return "bg-yellow-500";
  }

  return "bg-primary";
});
</script>

<template>
  <span v-if="hasActiveAccounts && indicator" class="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
    <span :class="['absolute inline-flex h-full w-full animate-ping rounded-full opacity-75', indicatorClass]" />
    <span :class="['relative inline-flex h-2.5 w-2.5 rounded-full', indicatorClass]" />
  </span>
  <span v-else class="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
    <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
  </span>
</template>
