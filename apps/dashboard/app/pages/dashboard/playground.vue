<script setup lang="ts">
import { MODEL_FAMILY_SORT_ORDER, categorizeModelFamily } from "../../../lib/model-families";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const config = useRuntimeConfig();
const { $client } = useNuxtApp();
const selectedApiKeyId = ref<string | null>(null);
const apiKeyPickerOpen = ref(false);
const selectedScenario = ref("text");
const prompt = ref("Write a short poem about the ocean.");
const response = ref<Record<string, string>>({});
const loading = ref(false);
const panels = ref<Array<{ id: string; modelId: string | null }>>([{ id: crypto.randomUUID(), modelId: null }]);

type ModelListItem = Awaited<ReturnType<typeof $client.models.list.query>>[number];
type ApiKeyListItem = Awaited<ReturnType<typeof $client.apiKeys.list.query>>[number];

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const scenarios = [
  { id: "text", name: "Text", icon: "i-lucide-message-square-text", prompt: "Write a short poem about the ocean.", reasoning: false },
  { id: "tool-call", name: "Tool Call", icon: "i-lucide-wrench", prompt: "Use available tools to get weather in Jakarta and convert 120 USD to IDR, then summarize in 3 bullets.", reasoning: false },
  { id: "vision", name: "Vision", icon: "i-lucide-image", prompt: "Describe the image, then list 3 visible objects and 1 possible scene context.", reasoning: false },
  { id: "reasoning", name: "Reasoning", icon: "i-lucide-brain", prompt: "Think step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain your reasoning.", reasoning: true },
];

async function loadOptions() {
  const result: { models: ModelListItem[]; apiKeys: ApiKeyListItem[] } = { models: [], apiKeys: [] };
  try {
    result.models = await $client.models.list.query();
  } catch (error) {
    console.warn("Failed to load playground models:", error);
  }
  try {
    result.apiKeys = await $client.apiKeys.list.query();
  } catch (error) {
    console.warn("Failed to load playground API keys:", error);
  }
  return result;
}

const { data } = await useAsyncData("dashboard-playground-options", loadOptions);
const models = computed(() => data.value?.models ?? []);
const apiKeys = computed(() => data.value?.apiKeys ?? []);
const selectedApiKey = computed(() => apiKeys.value.find((key) => key.id === selectedApiKeyId.value) ?? null);
const selectedApiKeyLabel = computed(() => selectedApiKey.value ? `${selectedApiKey.value.name ?? "Unnamed key"} (${selectedApiKey.value.keyPreview})` : "Select key");
const groupedModels = computed(() => {
  const groups = new Map<string, ModelListItem[]>();

  for (const model of models.value) {
    const family = categorizeModelFamily(model.family);
    const familyModels = groups.get(family) ?? [];
    familyModels.push(model);
    groups.set(family, familyModels);
  }

  return MODEL_FAMILY_SORT_ORDER.map((family) => ({ family, models: groups.get(family) ?? [] })).filter((entry) => entry.models.length > 0);
});
const familyPresets = computed(() => groupedModels.value.map((entry) => ({ family: entry.family, models: entry.models.slice(0, 6) })));
const activeFamilyPreset = ref<string | null>(null);

watchEffect(() => {
  if (!selectedApiKeyId.value && apiKeys.value[0]) {
    selectedApiKeyId.value = apiKeys.value[0].id;
  }
});

function selectScenario(scenarioId: string) {
  const scenario = scenarios.find((item) => item.id === scenarioId);

  if (!scenario) return;

  selectedScenario.value = scenario.id;
  prompt.value = scenario.prompt;
  response.value = {};
}

function addPanel() {
  panels.value = [...panels.value, { id: crypto.randomUUID(), modelId: null }];
}

function removePanel(panelId: string) {
  panels.value = panels.value.filter((panel) => panel.id !== panelId);
  response.value = Object.fromEntries(
    Object.entries(response.value).filter(([id]) => id !== panelId)
  );
}

function applyFamilyPreset(family: string) {
  const preset = familyPresets.value.find((entry) => entry.family === family);

  if (!preset) return;

  if (activeFamilyPreset.value === family) {
    panels.value = [{ id: crypto.randomUUID(), modelId: null }];
    activeFamilyPreset.value = null;
    response.value = {};
    return;
  }

  panels.value = preset.models.map((model) => ({ id: crypto.randomUUID(), modelId: model.id }));
  activeFamilyPreset.value = family;
  response.value = {};
}

async function runPrompt() {
  loading.value = true;
  response.value = {};
  try {
    const proxyUrl = String(config.public.proxyUrl || "").replace(/\/$/, "");
    if (!proxyUrl || !selectedApiKeyId.value) {
      response.value = Object.fromEntries(panels.value.map((panel) => [panel.id, "Configure a proxy URL and select an API key to send a live request."]));
      return;
    }

    const revealedKey = await $client.apiKeys.reveal.query({ id: selectedApiKeyId.value });
    if (!revealedKey.success) {
      response.value = Object.fromEntries(panels.value.map((panel) => [panel.id, revealedKey.error]));
      return;
    }

    await Promise.all(
      panels.value
        .filter((panel) => panel.modelId)
        .map(async (panel) => {
          try {
            const result = await $fetch<ChatCompletionResponse>(`${proxyUrl}/v1/chat/completions`, {
              method: "POST",
              headers: { Authorization: `Bearer ${revealedKey.data.key}` },
              body: {
                model: panel.modelId,
                messages: [{ role: "user", content: prompt.value }],
              },
            });
            response.value = {
              ...response.value,
              [panel.id]: result?.choices?.[0]?.message?.content ?? JSON.stringify(result, null, 2),
            };
          } catch (error) {
            response.value = {
              ...response.value,
              [panel.id]: error instanceof Error ? error.message : "Request failed",
            };
          }
        })
    );
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="border-b border-border pb-4">
      <div class="flex items-center justify-between gap-4">
        <h1 class="text-xl font-semibold">Playground</h1>
        <div class="flex items-center gap-2">
          <UPopover v-if="apiKeys.length > 1" v-model:open="apiKeyPickerOpen" :content="{ align: 'end' }">
            <UiButton variant="outline" size="sm" class="gap-1.5 sm:max-w-[200px]" :disabled="loading">
              <UIcon name="i-lucide-key" class="size-3.5 shrink-0" />
              <span class="hidden truncate sm:inline">{{ selectedApiKeyLabel }}</span>
              <UIcon name="i-lucide-chevron-down" class="hidden size-3 shrink-0 opacity-50 sm:block" />
            </UiButton>
            <template #content>
              <div class="w-[280px] p-2">
                <button
                  v-for="apiKey in apiKeys"
                  :key="apiKey.id"
                  type="button"
                  :class="[
                    'flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground',
                    selectedApiKeyId === apiKey.id ? 'bg-accent' : '',
                  ]"
                  @click="selectedApiKeyId = apiKey.id; apiKeyPickerOpen = false"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-xs font-medium">{{ apiKey.name ?? apiKey.keyPreview }}</p>
                    <p class="truncate font-mono text-[10px] text-muted-foreground">{{ apiKey.keyPreview }}</p>
                  </div>
                  <UIcon v-if="selectedApiKeyId === apiKey.id" name="i-lucide-check" class="size-3.5 text-foreground" />
                </button>
              </div>
            </template>
          </UPopover>
          <UiButton v-if="loading" variant="outline" size="sm" disabled>
            <UIcon name="i-lucide-square" class="size-3.5" />
            Stop
          </UiButton>
          <UiButton v-else variant="outline" size="sm" :disabled="!panels.some((panel) => panel.modelId)" @click="runPrompt">
            <UIcon name="i-lucide-play" class="size-4" />
            Start
          </UiButton>
          <UiButton variant="outline" size="icon" disabled>
            <UIcon name="i-lucide-settings" class="size-4" />
            <span class="sr-only">Settings</span>
          </UiButton>
        </div>
      </div>
    </div>

    <div class="space-y-3">
      <h2 class="text-sm font-medium text-muted-foreground">Scenario</h2>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="scenario in scenarios"
          :key="scenario.id"
          type="button"
          :disabled="loading"
          :class="[
            'flex h-auto min-w-[72px] cursor-pointer flex-col items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50',
            selectedScenario === scenario.id ? (scenario.reasoning ? 'border-amber-600 bg-amber-600 text-white hover:bg-amber-700' : 'bg-primary text-primary-foreground') : (scenario.reasoning ? 'border-dashed border-amber-700 hover:border-amber-600' : 'border-input bg-input/30 hover:bg-input/50'),
          ]"
          @click="selectScenario(scenario.id)"
        >
          <UIcon :name="scenario.icon" class="size-4" />
          <span class="text-xs">{{ scenario.name }}</span>
        </button>
      </div>
    </div>

    <div class="space-y-3">
      <h2 class="text-sm font-medium text-muted-foreground">Family Preset</h2>
      <div v-if="familyPresets.length > 0" class="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
        <button
          v-for="preset in familyPresets"
          :key="preset.family"
          type="button"
          :disabled="loading"
          :class="[
            'flex h-auto w-full min-w-0 cursor-pointer flex-col items-center gap-0.5 rounded-md border px-3 py-2 text-center text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 sm:w-auto sm:min-w-[92px]',
            activeFamilyPreset === preset.family ? 'bg-primary text-primary-foreground' : 'border-input bg-input/30 hover:bg-input/50',
          ]"
          @click="applyFamilyPreset(preset.family)"
        >
          <span class="whitespace-normal break-words text-xs leading-tight">{{ preset.family }}</span>
          <span :class="activeFamilyPreset === preset.family ? 'text-[10px] leading-none text-primary-foreground/85' : 'text-[10px] leading-none text-muted-foreground'">
            {{ preset.models.length }} models
          </span>
        </button>
      </div>
      <p v-else class="text-xs text-muted-foreground">Connect at least one provider account to use family presets.</p>
    </div>

    <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
      <UiCard v-for="panel in panels" :key="panel.id" class="relative flex h-[400px] flex-col gap-0 overflow-hidden py-0">
        <button
          v-if="panels.length > 1"
          type="button"
          class="absolute right-2 top-2 z-10 inline-flex size-7 cursor-pointer items-center justify-center rounded-full border bg-background/95 text-sm font-medium transition-all hover:bg-accent/50"
          :disabled="loading"
          @click="removePanel(panel.id)"
        >
          <UIcon name="i-lucide-x" class="size-3.5" />
        </button>

        <UiCardHeader class="flex-none gap-0 border-b py-2 pl-3 pr-11">
          <select v-model="panel.modelId" class="h-8 flex-1 rounded-md bg-transparent px-2 text-sm font-normal outline-none hover:bg-accent/50" :disabled="loading">
            <option :value="null">Select model...</option>
            <optgroup v-for="group in groupedModels" :key="group.family" :label="group.family">
              <option v-for="model in group.models" :key="model.id" :value="model.id">
                {{ model.id }}
              </option>
            </optgroup>
          </select>
        </UiCardHeader>

        <UiCardContent class="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <div class="min-h-0 flex-1 overflow-y-auto p-3">
            <p v-if="!panel.modelId && !loading && !response[panel.id]" class="py-8 text-center text-sm text-muted-foreground">Select a model to start</p>
            <div v-if="panel.modelId" class="mb-2 flex gap-2">
              <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <UIcon name="i-lucide-user" class="size-3 text-primary" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="mb-1 text-[11px] font-medium text-primary">User</p>
                <div class="rounded-lg bg-muted px-3 py-2">
                  <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ prompt }}</pre>
                </div>
              </div>
            </div>

            <div v-if="loading && panel.modelId && !response[panel.id]" class="mb-2 flex gap-2">
              <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary">
                <UIcon name="i-lucide-bot" class="size-3 text-secondary-foreground" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="mb-1 text-[11px] font-medium text-muted-foreground">Assistant</p>
                <div class="rounded-lg border border-border bg-card px-3 py-2">
                  <div class="space-y-1.5">
                    <UiSkeleton class="h-3 w-full" />
                    <UiSkeleton class="h-3 w-4/5" />
                    <UiSkeleton class="h-3 w-3/5" />
                  </div>
                </div>
              </div>
            </div>

            <div v-if="response[panel.id]" class="mb-2 flex gap-2">
              <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary">
                <UIcon name="i-lucide-bot" class="size-3 text-secondary-foreground" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="mb-1 text-[11px] font-medium text-muted-foreground">Assistant</p>
                <div class="rounded-lg border border-border bg-card px-3 py-2">
                  <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ response[panel.id] }}</pre>
                </div>
              </div>
            </div>
          </div>

          <div class="shrink-0 border-t bg-card px-3 py-2 text-[11px]">
            <div class="flex items-center justify-between gap-2">
              <span class="text-muted-foreground">Wait</span>
              <span class="font-medium tabular-nums">-</span>
            </div>
            <div class="mt-1 flex items-center justify-between gap-2">
              <span class="shrink-0 whitespace-nowrap text-muted-foreground">Provider account</span>
              <span class="min-w-0 truncate text-right font-medium">Auto (load balancer)</span>
            </div>
          </div>
        </UiCardContent>
      </UiCard>

      <UiCard class="group h-[400px] overflow-hidden border-2 border-dashed border-border/80 bg-background p-0 transition-colors hover:border-muted-foreground/45">
        <button
          type="button"
          class="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-muted-foreground transition-colors hover:bg-muted/15 hover:text-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="loading"
          @click="addPanel"
        >
          <span class="inline-flex size-10 items-center justify-center rounded-full border border-muted-foreground/30 transition-colors group-hover:border-muted-foreground/45">
            <UIcon name="i-lucide-plus" class="size-4 transition-colors group-hover:text-foreground/80" />
          </span>
          <span class="text-sm font-medium">Add comparison</span>
        </button>
      </UiCard>
    </div>
  </div>
</template>
