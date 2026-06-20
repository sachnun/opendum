<script setup lang="ts">
import { getProviderLabel } from "../../lib/provider-accounts";
import type { ModelSearchItem } from "../../lib/dashboard-api-types";

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
const placeholderModelIndex = ref(0);
let placeholderTimer: number | null = null;

const suggestionListId = "model-search-suggestions";

const { data } = await useAsyncData("layout-model-search", () => dashboardApi.models.search(), {
  default: () => [] as ModelListItem[],
});

const models = computed<ModelListItem[]>(() => data.value ?? []);
const placeholderModels = computed(() => models.value.filter((model) => model.isEnabled !== false).map((model) => model.id).slice(0, 24));
const activePlaceholderModel = computed(() => placeholderModels.value[placeholderModelIndex.value] ?? null);
const showAnimatedPlaceholder = computed(() => search.value.length === 0 && activePlaceholderModel.value !== null);
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

async function selectModel(model: ModelListItem) {
  searchInput.value?.blur();
  closeSuggestions();
  await navigateTo({
    path: "/dashboard/models",
    hash: `#model-${encodeURIComponent(model.id)}`,
  });
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
      class="absolute left-0 right-0 top-full z-40 mt-1 max-h-[min(22rem,calc(100vh-5rem))] overflow-y-auto rounded-lg border border-border bg-background p-1 text-foreground shadow-lg"
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
  </div>
</template>
