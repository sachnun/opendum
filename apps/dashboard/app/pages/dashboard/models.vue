<script setup lang="ts">
import { MODEL_FAMILY_SORT_ORDER, categorizeModelFamily } from "../../../lib/model-families";
import type { ModelFamilyCounts } from "../../../lib/navigation";
import type { ModelStats } from "../../../lib/model-stats";
import { getProviderLabel } from "../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const dashboardApi = useDashboardApi();

type ModelListItem = Awaited<ReturnType<typeof dashboardApi.models.list>>[number];

const { data, error, pending } = await useAsyncData("dashboard-models", () => dashboardApi.models.list());
const models = computed<ModelListItem[]>(() => data.value ?? []);
const availableProviders = computed(() => {
  const entries = new Map<string, string>();

  for (const model of models.value) {
    for (const provider of model.providers) {
      entries.set(provider, getProviderLabel(provider));
    }
  }

  return Array.from(entries, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
});
const activeProviders = ref<string[]>([]);
const pendingModelId = ref<string | null>(null);
const copiedModelId = ref<string | null>(null);
const modelFamilyCountsOverride = useState<ModelFamilyCounts | null>("dashboard-model-family-counts-override", () => null);

watchEffect(() => {
  if (activeProviders.value.length === 0 && availableProviders.value.length > 0) {
    activeProviders.value = availableProviders.value.map((provider) => provider.id);
  }
});

const allSelected = computed(() => activeProviders.value.length === availableProviders.value.length);
const filteredModels = computed(() => {
  const active = new Set(activeProviders.value);
  return models.value.filter((model) => model.providers.some((provider) => active.has(provider)));
});
const enabledModelCount = computed(() => models.value.filter((model) => model.isEnabled).length);
const modelSections = computed(() => {
  const groupedModels = new Map<string, ModelListItem[]>();

  for (const model of filteredModels.value) {
    const family = categorizeModelFamily(model.family);
    const familyModels = groupedModels.get(family) ?? [];
    familyModels.push(model);
    groupedModels.set(family, familyModels);
  }

  for (const familyModels of groupedModels.values()) {
    familyModels.sort((a, b) => a.id.localeCompare(b.id));
  }

  return MODEL_FAMILY_SORT_ORDER
    .map((family) => ({
      name: family,
      anchorId: getFamilyAnchorId(family),
      models: groupedModels.get(family) ?? [],
    }))
    .filter((section) => section.models.length > 0);
});

watchEffect(() => {
  modelFamilyCountsOverride.value = Object.fromEntries(
    modelSections.value.map((section) => [section.anchorId, section.models.length])
  );
});

onUnmounted(() => {
  modelFamilyCountsOverride.value = null;
});

function getFamilyAnchorId(family: string) {
  if (family === "OpenAI") return "openai-models";
  if (family === "Claude") return "claude-models";
  if (family === "Gemini") return "gemini-models";
  if (family === "Qwen") return "qwen-models";
  if (family === "DeepSeek") return "deepseek-models";
  if (family === "Kimi") return "kimi-models";
  if (family === "MiniMax") return "minimax-models";
  if (family === "Xiaomi") return "xiaomi-models";
  if (family === "Z.AI") return "zai-models";
  return "other-models";
}

function toggleProvider(providerId: string) {
  if (providerId === "all") {
    activeProviders.value = allSelected.value ? [] : availableProviders.value.map((provider) => provider.id);

    if (activeProviders.value.length === 0 && availableProviders.value[0]) {
      activeProviders.value = [availableProviders.value[0].id];
    }

    return;
  }

  if (allSelected.value) {
    activeProviders.value = [providerId];
    return;
  }

  if (activeProviders.value.includes(providerId)) {
    const next = activeProviders.value.filter((id) => id !== providerId);

    if (next.length > 0) {
      activeProviders.value = next;
    }

    return;
  }

  activeProviders.value = [...activeProviders.value, providerId];
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
    const result = await dashboardApi.models.setEnabled({ modelId: model.id, enabled });
    if (!result.success) throw new Error(result.error);
  } catch (error) {
    model.isEnabled = previousValue;
    console.error(error);
  } finally {
    pendingModelId.value = null;
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="border-b border-border pb-4">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-xl font-semibold">Models</h2>
        <UiBadge variant="outline" class="tabular-nums">{{ enabledModelCount }}/{{ models.length }}</UiBadge>
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <UiSkeleton v-if="pending" class="h-96 rounded-xl" />
    <DashboardEmptyState v-else-if="models.length === 0" title="No models found" description="Connect accounts or adjust your search." icon="i-lucide-cpu" />
    <div v-else class="space-y-5">
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          :class="[
            'inline-flex h-8 cursor-pointer items-center justify-center rounded-md border px-3 text-sm font-medium transition-all',
            allSelected ? 'bg-primary text-primary-foreground' : 'border-input bg-input/30 hover:bg-input/50',
          ]"
          @click="toggleProvider('all')"
        >
          All
        </button>
        <button
          v-for="provider in availableProviders"
          :key="provider.id"
          type="button"
          :class="[
            'inline-flex h-8 cursor-pointer items-center justify-center rounded-md border px-3 text-sm font-medium transition-all',
            activeProviders.includes(provider.id) ? 'bg-primary text-primary-foreground' : 'border-input bg-input/30 hover:bg-input/50',
          ]"
          @click="toggleProvider(provider.id)"
        >
          {{ provider.label }}
        </button>
      </div>

      <div v-if="modelSections.length > 0" class="space-y-8">
        <section v-for="section in modelSections" :id="section.anchorId" :key="section.name" class="scroll-mt-24 space-y-3">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold">{{ section.name }}</h3>
            <span class="text-xs text-muted-foreground">{{ section.models.length }} models</span>
          </div>
          <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
              <UiCard v-for="model in section.models" :key="model.id" class="flex flex-col bg-card py-4" :class="model.isEnabled === false ? 'opacity-70' : ''">
                <UiCardHeader class="px-4 pb-2 sm:px-5">
                  <div class="flex items-start justify-between gap-2">
                    <button
                    type="button"
                    class="-m-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-md p-1 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      :title="`Copy model ID ${model.id}`"
                      :aria-label="`Copy model ID ${model.id}`"
                      @click="copyModelId(model.id)"
                    >
                      <span class="flex size-3 shrink-0 items-center justify-center">
                        <UiIcon :name="copiedModelId === model.id ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3" />
                      </span>
                      <span class="min-w-0 flex-1 overflow-hidden break-all font-mono text-sm font-semibold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" :title="model.id">
                        {{ model.id }}
                    </span>
                  </button>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <span class="text-[11px] text-muted-foreground">{{ model.isEnabled ? 'On' : 'Off' }}</span>
                    <UiSwitch
                      :model-value="model.isEnabled"
                      :disabled="pendingModelId === model.id"
                      :title="model.isEnabled ? 'Disable model' : 'Enable model'"
                      @update:model-value="setModelEnabled(model, $event)"
                    />
                  </div>
                </div>

                <div class="mt-1.5 flex flex-wrap items-center gap-1">
                  <UiBadge v-for="provider in model.providers" :key="provider" variant="secondary" class="text-xs">
                    {{ getProviderLabel(provider) }}
                  </UiBadge>
                  <NuxtLink v-if="model.isEnabled" :to="`/dashboard/playground?model=${encodeURIComponent(model.id)}`" class="inline-flex h-5 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-accent/50" title="Try in Playground">
                    <UiIcon name="i-lucide-flask-conical" class="size-3" />
                  </NuxtLink>
                </div>
              </UiCardHeader>

              <UiCardContent class="flex flex-1 flex-col px-4 sm:px-5">
                <div class="mt-auto space-y-2.5">
                  <ModelFeatureBadges :meta="model.meta" />
                  <ModelStatsPanel :stats="model.stats as ModelStats" :label="model.id" compact />
                </div>
              </UiCardContent>
            </UiCard>
          </div>
        </section>
      </div>

      <div v-else class="rounded-lg border border-dashed border-border py-12 text-center text-muted-foreground">
        No models found for the selected providers.
      </div>
    </div>
  </div>
</template>
