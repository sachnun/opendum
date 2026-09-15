<script setup lang="ts">
import type { CustomProviderListItem } from "../../lib/api-types";

const props = defineProps<{
  provider: CustomProviderListItem;
}>();

const models = computed(() => props.provider.models.length);
const modelPreview = computed(() => props.provider.models.slice(0, 3).map((model) => model.modelId));
</script>

<template>
  <UiCard class="group relative h-full gap-3 border-transparent bg-transparent p-0 shadow-none transition-colors">
    <NuxtLink :to="`/custom/${provider.slug}`" class="absolute inset-0 z-10 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" :aria-label="`Open ${provider.name}`" />

    <div class="pointer-events-none relative z-20 flex items-start justify-between gap-2">
      <div class="flex min-w-0 items-center gap-1">
        <UiCardTitle class="truncate text-base">{{ provider.name }}</UiCardTitle>
        <UiBadge v-if="provider.accountCount > 0" variant="outline" class="text-xs">{{ provider.accountCount }}</UiBadge>
        <UiBadge variant="secondary" class="text-[10px] font-normal">custom</UiBadge>
      </div>
      <UiBadge variant="outline" :class="provider.enabled ? 'border-green-500 text-green-600' : 'border-border text-muted-foreground'">
        {{ provider.enabled ? "Active" : "Paused" }}
      </UiBadge>
    </div>

    <UiCardContent class="pointer-events-none relative z-20 p-0">
      <div class="space-y-2 rounded-md border border-border/70 p-2.5 transition-colors group-hover:border-border">
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="font-mono text-muted-foreground">{{ provider.slug }}</span>
          <span class="text-muted-foreground">{{ models }} model{{ models === 1 ? "" : "s" }}</span>
        </div>
        <p class="truncate font-mono text-[10px] text-muted-foreground">{{ provider.baseUrl }}</p>
        <div class="flex flex-wrap gap-1">
          <UiBadge v-for="model in modelPreview" :key="model" variant="secondary" class="text-[10px] font-normal">
            {{ model }}
          </UiBadge>
          <span v-if="models > modelPreview.length" class="text-[10px] text-muted-foreground">+{{ models - modelPreview.length }}</span>
          <span v-if="models === 0" class="text-[10px] text-muted-foreground">No models yet</span>
        </div>
      </div>
    </UiCardContent>
  </UiCard>
</template>
