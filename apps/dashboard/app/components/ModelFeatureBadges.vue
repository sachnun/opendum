<script setup lang="ts">
import { getEffectiveModelCapabilities, type ModelMeta } from "../../lib/model-capabilities";

const props = defineProps<{
  meta?: ModelMeta;
  compact?: boolean;
}>();

const capabilities = computed(() => getEffectiveModelCapabilities(props.meta));

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return tokens.toString();
}

function formatDate(dateStr: string): string {
  const parts = dateStr.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = Number.parseInt(parts[1] ?? "1", 10) - 1;
  return `${months[monthIndex] ?? parts[1]} ${parts[0]}`;
}
</script>

<template>
  <div class="space-y-1.5 text-xs text-muted-foreground">
    <div v-if="meta && !compact" class="flex flex-wrap items-center gap-1.5">
      <span v-if="meta.contextLength" class="inline-flex items-center gap-1 tabular-nums" title="Input tokens">
        {{ formatTokens(meta.contextLength) }}
        <UiIcon name="i-lucide-arrow-down" class="size-3 shrink-0" />
      </span>
      <span v-if="meta.contextLength && meta.outputLimit">·</span>
      <span v-if="meta.outputLimit" class="inline-flex items-center gap-1 tabular-nums" title="Output tokens">
        {{ formatTokens(meta.outputLimit) }}
        <UiIcon name="i-lucide-arrow-up" class="size-3 shrink-0" />
      </span>
      <template v-if="meta.knowledgeCutoff">
        <span>·</span>
        <span class="inline-flex items-center gap-1">
          <UiIcon name="i-lucide-calendar" class="size-3 shrink-0" />
          {{ formatDate(meta.knowledgeCutoff) }}
        </span>
      </template>
    </div>

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
