<script setup lang="ts">
import { MODEL_FAMILY_SORT_ORDER, categorizeModelFamily } from "../../../lib/model-families";
import { getProviderLabel } from "../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const { $client } = useNuxtApp();

type ModelListItem = Awaited<ReturnType<typeof $client.models.list.query>>[number];

const { data, error, pending } = await useAsyncData("dashboard-models", () => $client.models.list.query());
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
const filteredEnabledCount = computed(() => filteredModels.value.filter((model) => model.isEnabled !== false).length);
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

function dailyValues() {
  return Array.from({ length: 30 }, () => 0);
}
</script>

<template>
  <div class="space-y-6">
    <div class="border-b border-border pb-4">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-xl font-semibold">Available Models</h2>
        <span class="text-sm text-muted-foreground">{{ models.length }} models</span>
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

      <p class="text-xs font-medium text-muted-foreground">
        {{ filteredModels.length }} / {{ models.length }} models - {{ filteredEnabledCount }} enabled
      </p>

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
                    @click="navigator.clipboard.writeText(model.id)"
                  >
                    <UIcon name="i-lucide-copy" class="size-3 shrink-0" />
                    <span class="min-w-0 flex-1 overflow-hidden break-all font-mono text-sm font-semibold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" :title="model.id">
                      {{ model.id }}
                    </span>
                  </button>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <span class="text-[11px] text-muted-foreground">{{ model.isEnabled === false ? 'Off' : 'On' }}</span>
                    <span :class="['relative inline-flex h-5 w-9 rounded-full border border-transparent transition-colors', model.isEnabled === false ? 'bg-input' : 'bg-primary']">
                      <span :class="['pointer-events-none block size-4 translate-y-0.5 rounded-full bg-background shadow-lg ring-0 transition-transform', model.isEnabled === false ? 'translate-x-0.5' : 'translate-x-4']" />
                    </span>
                  </div>
                </div>

                <div class="mt-1.5 flex flex-wrap items-center gap-1">
                  <UiBadge v-for="provider in model.providers" :key="provider" variant="secondary" class="text-xs">
                    {{ getProviderLabel(provider) }}
                  </UiBadge>
                  <NuxtLink v-if="model.isEnabled !== false" to="/dashboard/playground" class="inline-flex h-5 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-accent/50" title="Try in Playground">
                    <UIcon name="i-lucide-flask-conical" class="size-3" />
                  </NuxtLink>
                </div>
              </UiCardHeader>

              <UiCardContent class="flex flex-1 flex-col px-4 sm:px-5">
                <div class="mt-auto space-y-2.5">
                  <div v-if="model.meta" class="space-y-1.5 text-xs text-muted-foreground">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span v-if="model.meta.contextLength" class="inline-flex items-center gap-1 tabular-nums" title="Input tokens">
                        {{ formatTokens(model.meta.contextLength) }}
                        <UIcon name="i-lucide-arrow-down" class="size-3 shrink-0" />
                      </span>
                      <span v-if="model.meta.contextLength && model.meta.outputLimit">·</span>
                      <span v-if="model.meta.outputLimit" class="inline-flex items-center gap-1 tabular-nums" title="Output tokens">
                        {{ formatTokens(model.meta.outputLimit) }}
                        <UIcon name="i-lucide-arrow-up" class="size-3 shrink-0" />
                      </span>
                      <template v-if="model.meta.knowledgeCutoff">
                        <span>·</span>
                        <span class="inline-flex items-center gap-1">
                          <UIcon name="i-lucide-calendar" class="size-3 shrink-0" />
                          {{ formatDate(model.meta.knowledgeCutoff) }}
                        </span>
                      </template>
                    </div>

                    <div v-if="model.meta.reasoning || model.meta.toolCall || model.meta.vision" class="flex flex-wrap gap-1">
                      <UiBadge v-if="model.meta.reasoning" variant="outline" class="h-5 py-0 text-[11px]">
                        <UIcon name="i-lucide-brain" class="mr-1 size-3" /> Reasoning
                      </UiBadge>
                      <UiBadge v-if="model.meta.toolCall" variant="outline" class="h-5 py-0 text-[11px]">
                        <UIcon name="i-lucide-wrench" class="mr-1 size-3" /> Tools
                      </UiBadge>
                      <UiBadge v-if="model.meta.vision" variant="outline" class="h-5 py-0 text-[11px]">
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

                    <div class="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
                      <UsageSparkline :values="dailyValues()" color="var(--chart-2)" :aria-label="`Average duration trend for ${model.id} over last 24 hours`" empty-label="No duration data" class="h-6" :height="24" />
                      <div class="mt-0.5 grid grid-cols-3 text-[9px] text-muted-foreground">
                        <span class="truncate text-center">00:00</span>
                        <span class="truncate text-center">12:00</span>
                        <span class="truncate text-center">23:00</span>
                      </div>
                    </div>

                    <UsageSparkline :values="dailyValues()" color="var(--chart-1)" :aria-label="`Requests trend for ${model.id}`" />
                  </div>
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
