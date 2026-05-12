<script setup lang="ts">
import { getEffectiveModelCapabilities, type ModelMeta } from "../../lib/model-capabilities";

const props = defineProps<{
  meta?: ModelMeta;
  compact?: boolean;
}>();

const capabilities = computed(() => getEffectiveModelCapabilities(props.meta));
</script>

<template>
  <div class="space-y-1.5 text-xs text-muted-foreground">
    <div v-if="capabilities.reasoning || capabilities.toolCall || capabilities.vision" class="flex flex-wrap gap-1">
      <UiBadge v-if="capabilities.reasoning" variant="outline" class="h-5 py-0 text-[11px]">
        <UiIcon name="i-lucide-brain" class="mr-1 size-3" /> Reasoning
      </UiBadge>
      <UiBadge v-if="capabilities.toolCall" variant="outline" class="h-5 py-0 text-[11px]">
        <UiIcon name="i-lucide-wrench" class="mr-1 size-3" /> Tools
      </UiBadge>
      <UiBadge v-if="capabilities.vision" variant="outline" class="h-5 py-0 text-[11px]">
        <UiIcon name="i-lucide-eye" class="mr-1 size-3" /> Vision
      </UiBadge>
    </div>
  </div>
</template>
