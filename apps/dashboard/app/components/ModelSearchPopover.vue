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
  isEnabled: boolean;
  stats: {
    totalRequests: number;
    successRate: number | null;
    dailyRequests: Array<{ date: string; count: number }>;
    avgDurationLastDay: number | null;
    durationLast24Hours: Array<{ time: string; avgDuration: number | null }>;
  };
}

const { $client } = useNuxtApp();
const route = useRoute();

const desktopOpen = ref(false);
const mobileOpen = ref(false);
const search = ref("");
const detailModel = ref<ModelListItem | null>(null);
const copiedModelId = ref<string | null>(null);
const pendingModelId = ref<string | null>(null);

const detailOpen = computed({
  get: () => detailModel.value !== null,
  set: (value: boolean) => {
    if (!value) detailModel.value = null;
  },
});

const { data, refresh } = await useAsyncData("layout-model-search", () => $client.models.search.query(), {
  default: () => [] as ModelListItem[],
});

const models = computed<ModelListItem[]>(() => data.value ?? []);
const filteredModels = computed(() => {
  const term = search.value.trim().toLowerCase();

  if (!term) return models.value;

  return models.value.filter((model) => {
    const providers = model.providers.map(getProviderLabel).join(" ");
    return `${model.id} ${providers}`.toLowerCase().includes(term);
  });
});

watch(() => route.fullPath, () => {
  desktopOpen.value = false;
  mobileOpen.value = false;
  search.value = "";
});

function selectModel(model: ModelListItem) {
  detailModel.value = model;
  desktopOpen.value = false;
  mobileOpen.value = false;
}

async function copyModelId(modelId: string) {
  await navigator.clipboard.writeText(modelId);
  copiedModelId.value = modelId;
  window.setTimeout(() => {
    if (copiedModelId.value === modelId) copiedModelId.value = null;
  }, 2000);
}

async function setModelEnabled(model: ModelListItem, enabled: boolean) {
  pendingModelId.value = model.id;
  const previousValue = model.isEnabled;
  model.isEnabled = enabled;

  try {
    const result = await $client.models.setEnabled.mutate({ modelId: model.id, enabled });
    if (!result.success) throw new Error(result.error);
    await refresh();
    const updatedModel = models.value.find((item) => item.id === model.id);
    if (updatedModel) detailModel.value = updatedModel;
  } catch (error) {
    model.isEnabled = previousValue;
    console.error(error);
  } finally {
    pendingModelId.value = null;
  }
}
</script>

<template>
  <div class="mx-auto max-w-xl">
    <UPopover v-model:open="desktopOpen" :content="{ align: 'start', sideOffset: 4 }" class="hidden md:block">
      <button
        type="button"
        role="combobox"
        :aria-expanded="desktopOpen"
        class="hidden h-9 w-full cursor-pointer items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-xs font-normal shadow-xs outline-none transition-all hover:bg-input/50 hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:px-3 sm:text-sm md:inline-flex"
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
            <p v-if="filteredModels.length === 0" class="py-6 text-center text-sm text-muted-foreground">No model found.</p>
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
                    <UiBadge v-for="provider in model.providers" :key="`${model.id}-${provider}`" variant="outline" class="text-[10px]">
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

    <button
      type="button"
      role="combobox"
      :aria-expanded="mobileOpen"
      class="inline-flex h-9 w-full cursor-pointer items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-xs font-normal shadow-xs outline-none transition-all hover:bg-input/50 hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:px-3 sm:text-sm md:hidden"
      @click="mobileOpen = true"
    >
      <span class="flex min-w-0 items-center gap-2">
        <UIcon name="i-lucide-search" class="size-4 text-muted-foreground" />
        <span class="truncate text-muted-foreground">Search models...</span>
      </span>
      <UIcon name="i-lucide-chevron-down" class="size-4 shrink-0 text-muted-foreground" />
    </button>

    <UModal v-model:open="mobileOpen" :ui="{ content: 'p-0 sm:max-w-md' }">
      <template #content>
        <div class="border-b border-border px-4 py-3">
          <p class="text-sm font-semibold">Search Models</p>
          <p class="mt-1 text-xs text-muted-foreground">Find a model and tap to view details</p>
        </div>
        <div class="flex h-11 items-center gap-2 border-b border-border px-3">
          <UIcon name="i-lucide-search" class="size-4 shrink-0 text-muted-foreground" />
          <input v-model="search" class="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" placeholder="Search model ID or provider...">
        </div>
        <div class="max-h-[60vh] overflow-y-auto p-1">
          <p v-if="filteredModels.length === 0" class="py-6 text-center text-sm text-muted-foreground">No model found.</p>
          <button
            v-for="model in filteredModels"
            :key="`mobile-${model.id}`"
            type="button"
            class="flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
            @click="selectModel(model)"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate font-mono text-xs sm:text-sm">{{ model.id }}</p>
              <div class="mt-1 flex flex-wrap gap-1">
                <UiBadge v-for="provider in model.providers" :key="`mobile-${model.id}-${provider}`" variant="outline" class="text-[10px]">
                  {{ getProviderLabel(provider) }}
                </UiBadge>
              </div>
            </div>
          </button>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="detailOpen" :ui="{ content: 'gap-0 sm:max-w-md' }">
      <template #content>
        <div v-if="detailModel" class="space-y-3" :class="detailModel.isEnabled === false ? 'opacity-70' : ''">
          <div class="flex items-start justify-between gap-2">
            <button
              type="button"
              :title="`Copy model ID ${detailModel.id}`"
              :aria-label="`Copy model ID ${detailModel.id}`"
              class="-m-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-md p-1 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              @click="copyModelId(detailModel.id)"
            >
              <span class="flex size-3 shrink-0 items-center justify-center">
                <UIcon :name="copiedModelId === detailModel.id ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3" />
              </span>
              <span class="min-w-0 flex-1 overflow-hidden break-all font-mono text-sm font-semibold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" :title="detailModel.id">
                {{ detailModel.id }}
              </span>
            </button>
            <div class="flex shrink-0 items-center gap-1.5">
              <span class="text-[11px] text-muted-foreground">{{ detailModel.isEnabled ? 'On' : 'Off' }}</span>
              <UiSwitch
                :model-value="detailModel.isEnabled"
                :disabled="pendingModelId === detailModel.id"
                :title="detailModel.isEnabled ? 'Disable model' : 'Enable model'"
                @update:model-value="setModelEnabled(detailModel, $event)"
              />
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-1">
            <UiBadge v-for="provider in detailModel.providers" :key="provider" variant="secondary" class="text-xs">
              {{ getProviderLabel(provider) }}
            </UiBadge>
            <NuxtLink
              v-if="detailModel.isEnabled"
              :to="`/dashboard/playground?model=${encodeURIComponent(detailModel.id)}`"
              class="inline-flex h-5 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-accent/50"
            >
              <UIcon name="i-lucide-flask-conical" class="size-3" />
            </NuxtLink>
          </div>

          <ModelFeatureBadges :meta="detailModel.meta" />
          <ModelStatsPanel :stats="detailModel.stats" :label="detailModel.id" compact />
        </div>
      </template>
    </UModal>
  </div>
</template>
