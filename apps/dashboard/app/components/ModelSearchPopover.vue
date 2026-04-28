<script setup lang="ts">
import { getProviderLabel } from "../../lib/provider-accounts";

interface ModelListItem {
  id: string;
  providers: string[];
  meta?: {
    contextLength?: number;
    outputLimit?: number;
    knowledgeCutoff?: string;
    reasoning?: boolean;
    toolCall?: boolean;
    vision?: boolean;
  };
  isEnabled?: boolean;
}

const { $client } = useNuxtApp();

const open = ref(false);
const search = ref("");
const detailModel = ref<ModelListItem | null>(null);
const detailOpen = computed({
  get: () => detailModel.value !== null,
  set: (value: boolean) => {
    if (!value) {
      detailModel.value = null;
    }
  },
});

const { data } = await useAsyncData("layout-model-search", () => $client.models.list.query(), {
  default: () => [] as ModelListItem[],
});

const models = computed<ModelListItem[]>(() => data.value ?? []);
const filteredModels = computed(() => {
  const term = search.value.trim().toLowerCase();

  if (!term) {
    return models.value.slice(0, 50);
  }

  return models.value
    .filter((model) => {
      const providers = model.providers.map(getProviderLabel).join(" ");
      return `${model.id} ${providers}`.toLowerCase().includes(term);
    })
    .slice(0, 50);
});

function selectModel(model: ModelListItem) {
  detailModel.value = model;
  open.value = false;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }

  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }

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
  <div class="mx-auto max-w-xl">
    <UPopover v-model:open="open" :content="{ align: 'start', sideOffset: 4 }">
      <button
        type="button"
        role="combobox"
        :aria-expanded="open"
        class="inline-flex h-9 w-full cursor-pointer items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-xs font-normal shadow-xs outline-none transition-all hover:bg-input/50 hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:px-3 sm:text-sm"
      >
        <span class="flex min-w-0 items-center gap-2">
          <UIcon name="i-lucide-search" class="size-4 text-muted-foreground" />
          <span class="truncate text-muted-foreground">Search models...</span>
        </span>
        <UIcon name="i-lucide-chevron-down" class="size-4 shrink-0 text-muted-foreground" />
      </button>

      <template #content>
        <div class="w-[min(92vw,30rem)] p-0">
          <div class="flex h-11 items-center gap-2 border-b border-border px-3">
            <UIcon name="i-lucide-search" class="size-4 shrink-0 text-muted-foreground" />
            <input
              v-model="search"
              class="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Search model ID or provider..."
              autocomplete="off"
            >
          </div>
          <div class="max-h-[320px] overflow-y-auto p-1">
            <p v-if="filteredModels.length === 0" class="py-6 text-center text-sm text-muted-foreground">
              No model found.
            </p>
            <div v-else class="space-y-1">
              <p class="px-2 py-1.5 text-xs font-medium text-muted-foreground">Models</p>
              <button
                v-for="model in filteredModels"
                :key="model.id"
                type="button"
                class="flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                @click="selectModel(model)"
              >
                <div class="min-w-0 flex-1">
                  <p class="truncate font-mono text-xs sm:text-sm">{{ model.id }}</p>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <UiBadge
                      v-for="provider in model.providers"
                      :key="`${model.id}-${provider}`"
                      variant="outline"
                      class="text-[10px]"
                    >
                      {{ getProviderLabel(provider) }}
                    </UiBadge>
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      </template>
    </UPopover>

    <UModal v-model:open="detailOpen" :ui="{ content: 'sm:max-w-md' }">
      <template #content>
        <div v-if="detailModel" class="space-y-3 p-6" :class="detailModel.isEnabled === false ? 'opacity-70' : ''">
          <div class="flex items-start justify-between gap-2">
            <button
              type="button"
              class="-m-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-md p-1 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              @click="navigator.clipboard.writeText(detailModel.id)"
            >
              <UIcon name="i-lucide-copy" class="size-3 shrink-0" />
              <span class="min-w-0 flex-1 overflow-hidden break-all font-mono text-sm font-semibold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                {{ detailModel.id }}
              </span>
            </button>
            <div class="flex shrink-0 items-center gap-1.5">
              <span class="text-[11px] text-muted-foreground">{{ detailModel.isEnabled === false ? 'Off' : 'On' }}</span>
              <span
                :class="[
                  'relative inline-flex h-5 w-9 rounded-full border border-transparent transition-colors',
                  detailModel.isEnabled === false ? 'bg-input' : 'bg-primary',
                ]"
              >
                <span
                  :class="[
                    'pointer-events-none block size-4 translate-y-0.5 rounded-full bg-background shadow-lg ring-0 transition-transform',
                    detailModel.isEnabled === false ? 'translate-x-0.5' : 'translate-x-4',
                  ]"
                />
              </span>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-1">
            <UiBadge v-for="provider in detailModel.providers" :key="provider" variant="secondary" class="text-xs">
              {{ getProviderLabel(provider) }}
            </UiBadge>
            <NuxtLink
              v-if="detailModel.isEnabled !== false"
              to="/dashboard/playground"
              class="inline-flex h-5 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-accent/50"
            >
              <UIcon name="i-lucide-flask-conical" class="size-3" />
            </NuxtLink>
          </div>

          <div v-if="detailModel.meta" class="space-y-1.5 text-xs text-muted-foreground">
            <div class="flex flex-wrap items-center gap-1.5">
              <span v-if="detailModel.meta.contextLength" class="inline-flex items-center gap-1 tabular-nums" title="Input tokens">
                {{ formatTokens(detailModel.meta.contextLength) }}
                <UIcon name="i-lucide-arrow-down" class="size-3 shrink-0" />
              </span>
              <span v-if="detailModel.meta.contextLength && detailModel.meta.outputLimit">·</span>
              <span v-if="detailModel.meta.outputLimit" class="inline-flex items-center gap-1 tabular-nums" title="Output tokens">
                {{ formatTokens(detailModel.meta.outputLimit) }}
                <UIcon name="i-lucide-arrow-up" class="size-3 shrink-0" />
              </span>
              <template v-if="detailModel.meta.knowledgeCutoff">
                <span>·</span>
                <span class="inline-flex items-center gap-1">
                  <UIcon name="i-lucide-calendar" class="size-3 shrink-0" />
                  {{ formatDate(detailModel.meta.knowledgeCutoff) }}
                </span>
              </template>
            </div>
            <div v-if="detailModel.meta.reasoning || detailModel.meta.toolCall || detailModel.meta.vision" class="flex flex-wrap gap-1">
              <UiBadge v-if="detailModel.meta.reasoning" variant="outline" class="h-5 py-0 text-[11px]">
                <UIcon name="i-lucide-brain" class="mr-1 size-3" /> Reasoning
              </UiBadge>
              <UiBadge v-if="detailModel.meta.toolCall" variant="outline" class="h-5 py-0 text-[11px]">
                <UIcon name="i-lucide-wrench" class="mr-1 size-3" /> Tools
              </UiBadge>
              <UiBadge v-if="detailModel.meta.vision" variant="outline" class="h-5 py-0 text-[11px]">
                <UIcon name="i-lucide-eye" class="mr-1 size-3" /> Vision
              </UiBadge>
            </div>
          </div>

          <div class="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2 sm:p-2.5">
            <div class="flex items-center justify-between text-[11px] text-muted-foreground">
              <span class="inline-flex items-center gap-1">
                <UIcon name="i-lucide-bar-chart-3" class="size-3 shrink-0" />
                30d
              </span>
              <span class="tabular-nums">0 peak</span>
            </div>
            <div class="grid grid-cols-3 gap-1.5">
              <div class="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
                <p class="truncate text-[10px] text-muted-foreground">Requests</p>
                <p class="truncate text-xs font-semibold tabular-nums text-foreground sm:text-sm">0</p>
              </div>
              <div class="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
                <p class="truncate text-[10px] text-muted-foreground">Success</p>
                <p class="truncate text-xs font-semibold tabular-nums text-foreground sm:text-sm">-</p>
              </div>
              <div class="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
                <p class="truncate text-[10px] text-muted-foreground">Latency</p>
                <p class="truncate text-xs font-semibold tabular-nums text-foreground sm:text-sm">-</p>
              </div>
            </div>
            <UsageSparkline :values="[]" color="var(--chart-1)" :aria-label="`Requests trend for ${detailModel.id}`" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
