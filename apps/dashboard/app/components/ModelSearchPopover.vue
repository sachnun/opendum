<script setup lang="ts">
import { getProviderLabel } from "../../lib/provider-accounts";
import type { ModelListItem as DashboardModelListItem, ModelSearchItem } from "../../lib/dashboard-api-types";
import type { ModelStats } from "../../lib/model-stats";

type ModelListItem = ModelSearchItem;

const dashboardApi = useDashboardApi();
const route = useRoute();
const emit = defineEmits<{
  focusChange: [focused: boolean];
}>();

const root = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const suggestionsOpen = ref(false);
const activeSuggestionIndex = ref(-1);
const search = ref("");
const detailModel = ref<ModelListItem | null>(null);
const copiedModelId = ref<string | null>(null);
const suppressFocusUntil = ref(0);
const suggestionListId = "model-search-suggestions";
const placeholderModelIndex = ref(0);
let placeholderTimer: ReturnType<typeof window.setInterval> | null = null;

const detailOpen = computed({
  get: () => detailModel.value !== null,
  set: (value: boolean) => {
    if (!value) detailModel.value = null;
  },
});

const { data } = await useAsyncData("layout-model-search", () => dashboardApi.models.search(), {
  default: () => [] as ModelListItem[],
});
const sharedFullModels = useNuxtData<DashboardModelListItem[]>("dashboard-models");
const { data: fullModelData, execute: loadFullModels, status: fullModelStatus } = useAsyncData("dashboard-models", () => dashboardApi.models.list(), {
  immediate: false,
});

const models = computed<ModelListItem[]>(() => data.value ?? []);
const placeholderModels = computed(() => models.value.filter((model) => model.isEnabled !== false).map((model) => model.id).slice(0, 24));
const activePlaceholderModel = computed(() => placeholderModels.value[placeholderModelIndex.value] ?? null);
const showAnimatedPlaceholder = computed(() => search.value.length === 0 && activePlaceholderModel.value !== null);
const fullModels = computed(() => fullModelData.value ?? sharedFullModels.data.value ?? []);
const fullModelById = computed(() => new Map(fullModels.value.map((model) => [model.id, model])));
const detailModelStats = computed<ModelStats | undefined>(() => detailModel.value ? fullModelById.value.get(detailModel.value.id)?.stats : undefined);
const isLoadingDetailStats = computed(() => detailModel.value !== null && !detailModelStats.value && fullModelStatus.value === "pending");
const filteredModels = computed(() => {
  const term = search.value.trim().toLowerCase();

  if (!term) return models.value;

  return models.value.filter((model) => {
    const providers = model.providers.map(getProviderLabel).join(" ");
    return `${model.id} ${providers}`.toLowerCase().includes(term);
  });
});
const activeSuggestionModel = computed(() => filteredModels.value[activeSuggestionIndex.value] ?? null);

watch(filteredModels, (items) => {
  if (items.length === 0) {
    activeSuggestionIndex.value = -1;
    return;
  }

  if (activeSuggestionIndex.value < 0 || activeSuggestionIndex.value >= items.length) {
    activeSuggestionIndex.value = 0;
  }
});

watch(placeholderModels, (items) => {
  if (placeholderModelIndex.value >= items.length) placeholderModelIndex.value = 0;
});

watch(() => route.fullPath, () => {
  suggestionsOpen.value = false;
  activeSuggestionIndex.value = -1;
  search.value = "";
  detailModel.value = null;
});

onMounted(() => {
  placeholderTimer = window.setInterval(() => {
    const total = placeholderModels.value.length;
    if (total <= 1) return;
    placeholderModelIndex.value = (placeholderModelIndex.value + 1) % total;
  }, 2600);
});

onBeforeUnmount(() => {
  if (placeholderTimer) window.clearInterval(placeholderTimer);
});

function openSuggestions() {
  if (Date.now() < suppressFocusUntil.value) return;

  emit("focusChange", true);
  suggestionsOpen.value = true;
  if (filteredModels.value.length > 0 && activeSuggestionIndex.value === -1) {
    activeSuggestionIndex.value = 0;
  }
}

function closeSuggestions() {
  suggestionsOpen.value = false;
  activeSuggestionIndex.value = -1;
}

function handleFocusOut(event: FocusEvent) {
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node && root.value?.contains(nextTarget)) return;
  emit("focusChange", false);
  closeSuggestions();
}

function moveActiveSuggestion(delta: number) {
  openSuggestions();
  const total = filteredModels.value.length;
  if (total === 0) return;

  const currentIndex = activeSuggestionIndex.value === -1 ? 0 : activeSuggestionIndex.value;
  activeSuggestionIndex.value = (currentIndex + delta + total) % total;
}

function selectActiveSuggestion() {
  if (!suggestionsOpen.value) return;
  const model = activeSuggestionModel.value ?? filteredModels.value[0];
  if (model) selectModel(model);
}

function clearSearch() {
  search.value = "";
  openSuggestions();
}

function selectModel(model: ModelListItem) {
  searchInput.value?.blur();
  detailModel.value = model;
  closeSuggestions();
  if (!fullModelById.value.get(model.id)?.stats) void loadFullModels();
}

async function copyModelId(modelId: string) {
  await navigator.clipboard.writeText(modelId);
  copiedModelId.value = modelId;
  window.setTimeout(() => {
    if (copiedModelId.value === modelId) copiedModelId.value = null;
  }, 2000);
}

function closeDetail() {
  suppressFocusUntil.value = Date.now() + 300;
  detailModel.value = null;
  closeSuggestions();
  search.value = "";
  searchInput.value?.blur();

  if (document.activeElement instanceof HTMLElement && root.value?.contains(document.activeElement)) {
    document.activeElement.blur();
  }
}
</script>

<template>
  <div ref="root" class="relative w-full max-w-xl" @focusout="handleFocusOut">
    <label for="model-search-input" class="sr-only">Search models</label>
    <div class="relative">
      <UiIcon name="i-lucide-search" class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        id="model-search-input"
        ref="searchInput"
        v-model="search"
        type="text"
        role="combobox"
        :aria-expanded="suggestionsOpen"
        :aria-controls="suggestionListId"
        :aria-activedescendant="activeSuggestionModel ? `model-search-option-${activeSuggestionIndex}` : undefined"
        aria-autocomplete="list"
        class="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-9 text-xs font-normal shadow-xs outline-none transition-all placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-sm"
        :placeholder="showAnimatedPlaceholder ? '' : 'Search models...'"
        autocomplete="off"
        @focus="openSuggestions"
        @input="openSuggestions"
        @keydown.down.prevent="moveActiveSuggestion(1)"
        @keydown.up.prevent="moveActiveSuggestion(-1)"
        @keydown.enter.prevent="selectActiveSuggestion"
        @keydown.esc.stop="closeSuggestions"
      >
      <Transition
        mode="out-in"
        enter-active-class="transition-opacity duration-300 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="transition-opacity duration-200 ease-in motion-reduce:transition-none"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <span
          v-if="showAnimatedPlaceholder"
          :key="activePlaceholderModel ?? ''"
          aria-hidden="true"
          class="pointer-events-none absolute left-9 right-9 top-1/2 -translate-y-1/2 truncate text-xs text-muted-foreground sm:text-sm"
        >
          {{ activePlaceholderModel }}
        </span>
      </Transition>
      <UiTooltip v-if="search" text="Clear">
        <button
          type="button"
          class="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Clear model search"
          @mousedown.prevent
          @click="clearSearch"
        >
          <UiIcon name="i-lucide-x" class="size-3.5" />
        </button>
      </UiTooltip>
    </div>

    <div
      v-if="suggestionsOpen"
      :id="suggestionListId"
      role="listbox"
      class="absolute left-0 right-0 top-full z-40 mt-1 max-h-[min(22rem,calc(100vh-5rem))] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      <p v-if="filteredModels.length === 0" class="py-6 text-center text-sm text-muted-foreground">No model found.</p>
      <div v-else class="space-y-1">
        <p class="px-2 py-1.5 text-xs font-medium text-muted-foreground">Models</p>
        <button
          v-for="(model, index) in filteredModels"
          :id="`model-search-option-${index}`"
          :key="model.id"
          type="button"
          role="option"
          :aria-selected="activeSuggestionIndex === index"
          :class="[
            'flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors',
            activeSuggestionIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground',
          ]"
          @mouseenter="activeSuggestionIndex = index"
          @mousedown.prevent="selectModel(model)"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-xs sm:text-sm">{{ model.id }}</p>
            <div class="mt-1 flex flex-wrap gap-1.5">
              <UiBadge v-for="provider in model.providers" :key="`${model.id}-${provider}`" variant="outline" class="text-[10px] font-normal">
                {{ getProviderLabel(provider) }}
              </UiBadge>
            </div>
          </div>
        </button>
      </div>
    </div>

    <UiDialog v-model:open="detailOpen" prevent-close-auto-focus :ui="{ content: 'gap-0 sm:max-w-md' }">
      <template #content>
        <div v-if="detailModel" class="space-y-3" :class="detailModel.isEnabled === false ? 'opacity-70' : ''">
          <div class="flex items-start justify-between gap-2">
            <UiTooltip text="Copy ID" class="max-w-96 break-all font-mono">
              <button
                type="button"
                :aria-label="`Copy model ID ${detailModel.id}`"
                class="-m-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md p-1 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                @click="copyModelId(detailModel.id)"
              >
                <span class="flex size-3 shrink-0 items-center justify-center">
                  <UiIcon :name="copiedModelId === detailModel.id ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3" />
                </span>
                <span class="min-w-0 flex-1 overflow-hidden break-all font-mono text-sm font-semibold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                  {{ detailModel.id }}
                </span>
              </button>
            </UiTooltip>
          </div>

          <div class="flex flex-wrap items-center gap-1.5">
            <UiBadge v-for="provider in detailModel.providers" :key="provider" variant="outline" class="text-[10px] font-normal">
              {{ getProviderLabel(provider) }}
            </UiBadge>
            <UiTooltip v-if="detailModel.isEnabled" text="Playground">
              <NuxtLink
                :to="`/dashboard/playground?model=${encodeURIComponent(detailModel.id)}`"
                class="inline-flex h-5 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-accent/50"
                aria-label="Try in Playground"
                @click="closeDetail"
              >
                <UiIcon name="i-lucide-flask-conical" class="size-3" />
              </NuxtLink>
            </UiTooltip>
          </div>

          <div class="space-y-3 pt-1">
            <ModelFeatureBadges :meta="detailModel.meta" />
            <UiSkeleton v-if="isLoadingDetailStats" class="h-24 rounded-lg" />
            <ModelStatsPanel v-else-if="detailModelStats" :stats="detailModelStats" :label="detailModel.id" compact />
          </div>
        </div>
      </template>
    </UiDialog>
  </div>
</template>
