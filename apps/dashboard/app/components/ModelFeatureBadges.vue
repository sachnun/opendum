<script setup lang="ts">
defineProps<{
  meta?: {
    contextLength?: number;
    outputLimit?: number;
    knowledgeCutoff?: string;
    reasoning?: boolean;
    toolCall?: boolean;
    vision?: boolean;
  };
}>();

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
  <div v-if="meta" class="space-y-1.5 text-xs text-muted-foreground">
    <div class="flex flex-wrap items-center gap-1.5">
      <span v-if="meta.contextLength" class="inline-flex items-center gap-1 tabular-nums" title="Input tokens">
        {{ formatTokens(meta.contextLength) }}
        <UIcon name="i-lucide-arrow-down" class="size-3 shrink-0" />
      </span>
      <span v-if="meta.contextLength && meta.outputLimit">·</span>
      <span v-if="meta.outputLimit" class="inline-flex items-center gap-1 tabular-nums" title="Output tokens">
        {{ formatTokens(meta.outputLimit) }}
        <UIcon name="i-lucide-arrow-up" class="size-3 shrink-0" />
      </span>
      <template v-if="meta.knowledgeCutoff">
        <span>·</span>
        <span class="inline-flex items-center gap-1">
          <UIcon name="i-lucide-calendar" class="size-3 shrink-0" />
          {{ formatDate(meta.knowledgeCutoff) }}
        </span>
      </template>
    </div>

    <div v-if="meta.reasoning || meta.toolCall || meta.vision" class="flex flex-wrap gap-1">
      <UiBadge v-if="meta.reasoning" variant="outline" class="h-5 py-0 text-[11px]">
        <UIcon name="i-lucide-brain" class="mr-1 size-3" /> Reasoning
      </UiBadge>
      <UiBadge v-if="meta.toolCall" variant="outline" class="h-5 py-0 text-[11px]">
        <UIcon name="i-lucide-wrench" class="mr-1 size-3" /> Tools
      </UiBadge>
      <UiBadge v-if="meta.vision" variant="outline" class="h-5 py-0 text-[11px]">
        <UIcon name="i-lucide-eye" class="mr-1 size-3" /> Vision
      </UiBadge>
    </div>
  </div>
</template>
