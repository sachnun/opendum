<script setup lang="ts">
import { compareModelIds } from "../../lib/model-sort";

type AccessMode = "all" | "whitelist" | "blacklist";

const props = defineProps<{
  apiKeyId: string;
  availableModels: string[];
  initialMode: AccessMode;
  initialModels: string[];
  readonly?: boolean;
}>();

const emit = defineEmits<{
  updated: [value: { mode: AccessMode; models: string[] }];
}>();

const dashboardApi = useDashboardApi();
const modelPickerOpen = ref(false);
const modelSearch = ref("");
const isSaving = ref(false);
const savedMode = ref<AccessMode>(props.initialMode);
const savedModels = ref<string[]>(normalizeModels(props.initialModels));
const draftMode = ref<AccessMode>(props.initialMode);
const draftModels = ref<string[]>(normalizeModels(props.initialModels));
const errorMessage = ref("");

function normalizeModels(models: string[]): string[] {
  return Array.from(new Set(models)).sort(compareModelIds);
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function getModeLabel(mode: AccessMode): string {
  if (mode === "all") return "All models";
  if (mode === "whitelist") return "Whitelist";
  return "Blacklist";
}

function setDraftMode(value: AccessMode) {
  if (props.readonly) return;
  draftMode.value = value;
}

function toggleModel(modelId: string) {
  if (props.readonly) return;
  draftModels.value = draftModels.value.includes(modelId)
    ? draftModels.value.filter((model) => model !== modelId)
    : normalizeModels([...draftModels.value, modelId]);
}

function resetDraftState() {
  draftMode.value = savedMode.value;
  draftModels.value = [...savedModels.value];
  modelPickerOpen.value = false;
  modelSearch.value = "";
  errorMessage.value = "";
}

async function save() {
  if (props.readonly) return;
  const modelsForSave = draftMode.value === "all" ? [] : normalizedDraftModels.value;
  if (draftMode.value !== "all" && modelsForSave.length === 0) {
    errorMessage.value = "Select at least one model";
    return;
  }

  isSaving.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.updateModelAccess({ id: props.apiKeyId, mode: draftMode.value, models: modelsForSave });
    if (!result.success) throw new Error(result.error);
    savedMode.value = result.data.mode;
    savedModels.value = normalizeModels(result.data.models);
    draftMode.value = result.data.mode;
    draftModels.value = [...savedModels.value];
    modelPickerOpen.value = false;
    emit("updated", { mode: result.data.mode, models: savedModels.value });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to update model access";
  } finally {
    isSaving.value = false;
  }
}

const normalizedDraftModels = computed(() => normalizeModels(draftModels.value));
const normalizedSavedModels = computed(() => normalizeModels(savedModels.value));
const hasChanges = computed(() => draftMode.value !== savedMode.value || !sameList(draftMode.value === "all" ? [] : normalizedDraftModels.value, savedMode.value === "all" ? [] : normalizedSavedModels.value));
const filteredModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase();
  if (!query) return props.availableModels;
  return props.availableModels.filter((model) => model.toLowerCase().includes(query));
});
</script>

<template>
  <section class="flex h-full flex-col p-4 max-lg:p-0">
    <div class="hidden items-start justify-between gap-3 lg:flex">
      <div class="inline-flex items-center gap-2 text-sm font-semibold">
        <UiIcon name="i-lucide-list-filter" class="size-4 text-muted-foreground" />
        <span>Model Access</span>
      </div>
      <UiBadge variant="outline" class="shrink-0">{{ getModeLabel(savedMode) }}</UiBadge>
    </div>

    <div class="flex-1 space-y-3 lg:mt-5">
      <div class="grid grid-cols-3 gap-1 rounded-md border border-input bg-input/30 p-1">
        <button v-for="mode in ['all', 'whitelist', 'blacklist']" :key="mode" type="button" :disabled="readonly" :class="['h-8 rounded-sm px-2 text-xs font-medium transition-colors disabled:cursor-default disabled:pointer-events-none disabled:opacity-60', draftMode === mode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground']" @click="setDraftMode(mode as AccessMode)">
          {{ mode === 'all' ? 'All' : mode === 'whitelist' ? 'Whitelist' : 'Blacklist' }}
        </button>
      </div>

      <div v-if="draftMode !== 'all'" class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs font-medium">Models</p>
          <UiButton type="button" variant="ghost" size="sm" class="h-7 px-2 text-[11px]" :disabled="normalizedDraftModels.length === 0 || isSaving || readonly" @click="draftModels = []">Clear</UiButton>
        </div>

        <UiPopover v-model:open="modelPickerOpen" :content="{ align: 'start', class: 'w-[min(90vw,28rem)] p-0' }">
          <UiButton variant="outline" class="h-9 w-full justify-between px-3 text-xs" :disabled="isSaving || readonly">
            <span class="truncate">{{ normalizedDraftModels.length > 0 ? `${normalizedDraftModels.length} model selected` : 'Select models' }}</span>
            <UiIcon name="i-lucide-chevron-down" class="size-3.5 text-muted-foreground" />
          </UiButton>
          <template #content>
            <div class="border-b border-border p-2">
              <input v-model="modelSearch" placeholder="Search model..." class="h-8 w-full rounded-md bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
            </div>
            <div class="max-h-72 overflow-y-auto p-1">
              <button v-for="modelId in filteredModels" :key="modelId" type="button" :disabled="readonly" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:cursor-default disabled:pointer-events-none disabled:opacity-60" @click="toggleModel(modelId)">
                <UiIcon name="i-lucide-check" :class="['size-3.5', normalizedDraftModels.includes(modelId) ? 'opacity-100' : 'opacity-0']" />
                <span class="truncate font-mono text-[11px]">{{ modelId }}</span>
              </button>
              <p v-if="filteredModels.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">No model found.</p>
            </div>
          </template>
        </UiPopover>

        <div class="max-h-40 overflow-y-auto py-1">
          <p v-if="normalizedDraftModels.length === 0" class="px-1 text-[11px] text-muted-foreground">No models selected</p>
          <div v-else class="flex flex-wrap gap-1.5">
            <UiBadge v-for="modelId in normalizedDraftModels" :key="modelId" variant="outline" class="max-w-full gap-1 pr-1 text-[10px] font-normal">
              <span class="min-w-0 truncate font-mono">{{ modelId }}</span>
              <UiTooltip text="Remove">
                <button type="button" :disabled="readonly" :aria-label="`Remove model ${modelId}`" class="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground disabled:cursor-default disabled:pointer-events-none disabled:opacity-60" @click="toggleModel(modelId)">
                  <UiIcon name="i-lucide-x" class="size-2.5" />
                </button>
              </UiTooltip>
            </UiBadge>
          </div>
        </div>
      </div>
      <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
    </div>

    <div class="flex items-center justify-end gap-2 border-t border-border/60 pt-3 lg:mt-4">
      <UiButton variant="outline" size="sm" :disabled="isSaving || !hasChanges || readonly" @click="resetDraftState"><UiIcon name="i-lucide-rotate-ccw" class="size-3.5" />Reset</UiButton>
      <UiButton size="sm" :disabled="isSaving || !hasChanges || readonly" @click="save">{{ isSaving ? 'Saving...' : 'Save' }}</UiButton>
    </div>
  </section>
</template>
