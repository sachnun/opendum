<script setup lang="ts">
import { MODEL_FAMILY_SORT_ORDER, categorizeModelFamily } from "../../../lib/model-families";
import { getProviderLabel } from "../../../lib/provider-accounts";
import type { PlaygroundOptions } from "../../../lib/dashboard-api-types";

definePageMeta({ middleware: "auth", layout: "dashboard" });

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
type PlaygroundEndpoint = "chat_completions" | "messages" | "responses";
type ScenarioMessage = { role: string; content: string | Array<Record<string, unknown>> };
type ParsedUsageData = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
type ToolCallData = { name: string; arguments: string };
type ParsedCompletionData = { content: string; reasoning: string; toolCalls: ToolCallData[]; usage: ParsedUsageData | null };
type ResponseMetrics = { waitMs: number | null; firstResponseMs: number | null; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
type ResponseData = { content: string; reasoning: string; toolCalls: ToolCallData[]; isLoading: boolean; error?: string; metrics: ResponseMetrics; usedAccountId?: string | null; startedAt?: number | null };

interface PlaygroundSettings {
  endpoint: PlaygroundEndpoint;
  streamResponses: boolean;
  temperature: number;
  topP: number;
  maxTokens: number;
  presencePenalty: number;
  frequencyPenalty: number;
  reasoningEffort: ReasoningEffort;
}

interface Scenario {
  id: string;
  name: string;
  icon: string;
  prompt: string;
  isReasoning: boolean;
  messages?: ScenarioMessage[];
  requestOverrides?: Record<string, unknown>;
}

const dashboardApi = useDashboardApi();
const route = useRoute();
const config = useRuntimeConfig();
const runtimeProxyBaseUrl = normalizeProxyBaseUrl(config.public.proxyUrl);

type ModelOption = PlaygroundOptions["models"][number];
type ProviderAccountOption = PlaygroundOptions["providerAccounts"][number];
type ApiKeyOption = PlaygroundOptions["apiKeyOptions"][number];
type PanelState = { id: string; modelId: string | null; accountId: string | null };

const DEFAULT_SETTINGS: PlaygroundSettings = {
  endpoint: "chat_completions",
  streamResponses: true,
  temperature: 1,
  topP: 1,
  maxTokens: 4096,
  presencePenalty: 0,
  frequencyPenalty: 0,
  reasoningEffort: "none",
};

const SCENARIOS: Scenario[] = [
  {
    id: "text",
    name: "Text",
    icon: "i-lucide-message-square-text",
    prompt: "Write a short poem about the ocean.",
    isReasoning: false,
    messages: [
      { role: "system", content: "You are a creative writing assistant. Write vivid, expressive text with a poetic tone. Keep responses concise." },
      { role: "user", content: "Write a short poem about the ocean." },
    ],
  },
  {
    id: "tool-call",
    name: "Tool Call",
    icon: "i-lucide-wrench",
    prompt: "Use available tools to get weather in Jakarta and convert 120 USD to IDR, then summarize in 3 bullets.",
    isReasoning: false,
    messages: [
      { role: "system", content: "You are a helpful assistant with access to external tools. When the user asks for real-time data such as weather or currency conversion, call the appropriate tool instead of guessing. After receiving tool results, summarize them clearly and concisely." },
      { role: "user", content: "Use available tools to get weather in Jakarta and convert 120 USD to IDR, then summarize in 3 bullets." },
    ],
    requestOverrides: {
      stream: false,
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather for a city",
            parameters: { type: "object", properties: { city: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } }, required: ["city"] },
          },
        },
        {
          type: "function",
          function: {
            name: "convert_currency",
            description: "Convert amount between currencies",
            parameters: { type: "object", properties: { amount: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, required: ["amount", "from", "to"] },
          },
        },
      ],
    },
  },
  {
    id: "vision",
    name: "Vision",
    icon: "i-lucide-image",
    prompt: "Describe the image, then list 3 visible objects and 1 possible scene context.",
    isReasoning: false,
    messages: [
      { role: "system", content: "You are a visual analysis assistant. When given an image, describe it concisely, identify key visible objects, and infer the likely context or setting of the scene." },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image in short, list 3 visible objects, and infer one likely scene context." },
          { type: "image_url", image_url: { url: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=640" } },
        ],
      },
    ],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    icon: "i-lucide-brain",
    prompt: "Think step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain your reasoning.",
    isReasoning: true,
    messages: [
      { role: "system", content: "You are a logical reasoning assistant. Think through problems step by step, showing your chain of thought clearly before giving a final answer. Focus on accuracy and clarity." },
      { role: "user", content: "Think step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain your reasoning." },
    ],
  },
];

const ENDPOINT_OPTIONS: Array<{ value: PlaygroundEndpoint; label: string; description: string }> = [
  { value: "chat_completions", label: "/v1/chat/completions", description: "OpenAI-compatible format" },
  { value: "messages", label: "/v1/messages", description: "Anthropic-compatible format" },
  { value: "responses", label: "/v1/responses", description: "OpenAI Responses API format" },
];

const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

const { data, error, pending } = await useAsyncData("dashboard-playground-options", () => dashboardApi.playground.options());
const options = computed<PlaygroundOptions | null>(() => data.value ?? null);
const models = computed<ModelOption[]>(() => options.value?.models ?? []);
const providerAccounts = computed<ProviderAccountOption[]>(() => options.value?.providerAccounts ?? []);
const apiKeyOptions = computed<ApiKeyOption[]>(() => options.value?.apiKeyOptions ?? []);
const proxyBaseUrl = computed(() => normalizeProxyBaseUrl(options.value?.proxyBaseUrl) ?? runtimeProxyBaseUrl);

const selectedApiKeyId = ref<string | null>(null);
const apiKeyPickerOpen = ref(false);
const selectedScenario = ref<Scenario>(SCENARIOS[0]!);
const settings = reactive<PlaygroundSettings>({ ...DEFAULT_SETTINGS });
const settingsOpen = ref(false);
const panels = ref<PanelState[]>([{ id: generateId(), modelId: null, accountId: null }]);
const responses = ref<Record<string, ResponseData>>({});
const isAnyLoading = ref(false);
const loopDialogOpen = ref(false);
const loopCountInput = ref("2");
const loopCount = ref(2);
const activeLoopProgress = ref<{ current: number; total: number } | null>(null);
const activeFamilyPreset = ref<string | null>(null);
const selectionOpenByPanel = reactive<Record<string, boolean>>({});
const selectionStepByPanel = reactive<Record<string, "model" | "routing">>({});
const pendingModelByPanel = reactive<Record<string, string | null>>({});
const modelSearchByPanel = reactive<Record<string, string>>({});
const routeSearchByPanel = reactive<Record<string, string>>({});
const systemCollapsedByPanel = reactive<Record<string, boolean>>({});
const initializedFromRoute = ref(false);
const liveNow = ref(Date.now());

const controllers = new Map<string, AbortController>();
let liveTimer: ReturnType<typeof setInterval> | null = null;
let startLongPressTimer: ReturnType<typeof setTimeout> | null = null;
let startLongPressTriggered = false;
const START_LONG_PRESS_DELAY_MS = 600;

const selectedApiKey = computed(() => apiKeyOptions.value.find((key) => key.id === selectedApiKeyId.value) ?? null);
const selectedApiKeyValue = computed(() => selectedApiKey.value?.decryptedKey.trim() || "");
const selectedApiKeyLabel = computed(() => selectedApiKey.value ? getApiKeyLabel(selectedApiKey.value) : "Select key");
const filteredModels = computed(() => filterModelsByApiKey(models.value, selectedApiKey.value));
const filteredModelIds = computed(() => new Set(filteredModels.value.map((model) => model.id)));
const modelsById = computed(() => new Map(models.value.map((model) => [model.id, model])));
const providerAccountsById = computed(() => new Map(providerAccounts.value.map((account) => [account.id, account])));
const familyPresets = computed(() => buildFamilyPresets(filteredModels.value, providerAccounts.value));
const activePresetModelIds = computed(() => {
  if (!activeFamilyPreset.value) return null;
  const preset = familyPresets.value.find((item) => item.family === activeFamilyPreset.value);
  return preset ? new Set(preset.models.map((model) => model.id)) : null;
});
const maxPanels = computed(() => Math.max(filteredModels.value.length, 1));
const canAddPanel = computed(() => panels.value.length < maxPanels.value);
const hasSelectedModel = computed(() => panels.value.some((panel) => panel.modelId));
const canRunPlayground = computed(() => Boolean(selectedScenario.value && hasSelectedModel.value && proxyBaseUrl.value && selectedApiKeyValue.value));
const playgroundSetupMessage = computed(() => {
  if (!proxyBaseUrl.value) return "Set NUXT_PUBLIC_PROXY_URL to your proxy service URL before running Playground.";
  if (apiKeyOptions.value.length === 0) return "Create an active API key before running Playground.";
  if (!selectedApiKeyValue.value) return "Select an API key before running Playground.";
  return "";
});
const parsedLoopCount = computed(() => Number(loopCountInput.value));
const isLoopCountValid = computed(() => Number.isInteger(parsedLoopCount.value) && parsedLoopCount.value >= 1);
const activeLoopBadgeLabel = computed(() => activeLoopProgress.value && activeLoopProgress.value.total > 1 ? `${activeLoopProgress.value.current}/${activeLoopProgress.value.total}` : null);
const scenarioMessages = computed(() => getScenarioMessages(selectedScenario.value));
const systemPromptText = computed(() => scenarioMessages.value.filter((message) => message.role === "system").map((message) => extractMessageText(message.content)).filter(Boolean).join("\n\n"));
const userScenarioMessages = computed(() => scenarioMessages.value.filter((message) => message.role !== "system"));

watch([apiKeyOptions, models], () => {
  if (selectedApiKeyId.value && apiKeyOptions.value.some((key) => key.id === selectedApiKeyId.value)) return;
  selectedApiKeyId.value = findApiKeyWithMostModels(apiKeyOptions.value, models.value);
}, { immediate: true });

watch(options, (value) => {
  if (!value || initializedFromRoute.value) return;

  const modelId = normalizeQueryParam(route.query.model);
  const accountId = normalizeQueryParam(route.query.accountId);

  if (modelId && modelsById.value.has(modelId)) {
    panels.value = [{ id: generateId(), modelId, accountId: null }];
    initializedFromRoute.value = true;
    return;
  }

  if (accountId) {
    const account = providerAccountsById.value.get(accountId);
    if (account) {
      const disabledSet = new Set(account.disabledModels ?? []);
      const compatibleModels = models.value.filter((model) => model.providers.includes(account.provider) && !disabledSet.has(model.id));
      panels.value = compatibleModels.length > 0
        ? compatibleModels.map((model) => ({ id: generateId(), modelId: model.id, accountId }))
        : [{ id: generateId(), modelId: null, accountId }];
      initializedFromRoute.value = true;
      return;
    }
  }

  initializedFromRoute.value = true;
}, { immediate: true });

watch(() => route.query, (query) => {
  if (!initializedFromRoute.value) return;
  if (!options.value) return;

  const modelId = normalizeQueryParam(query.model);
  const accountId = normalizeQueryParam(query.accountId);

  if (modelId && modelsById.value.has(modelId)) {
    panels.value = [{ id: generateId(), modelId, accountId: null }];
    responses.value = {};
    return;
  }

  if (accountId) {
    const account = providerAccountsById.value.get(accountId);
    if (account) {
      const disabledSet = new Set(account.disabledModels ?? []);
      const compatibleModels = models.value.filter((m) => m.providers.includes(account.provider) && !disabledSet.has(m.id));
      panels.value = compatibleModels.length > 0
        ? compatibleModels.map((m) => ({ id: generateId(), modelId: m.id, accountId }))
        : [{ id: generateId(), modelId: null, accountId }];
      responses.value = {};
      return;
    }
  }
});

watch(filteredModelIds, (availableIds) => {
  panels.value = panels.value.map((panel) => panel.modelId && !availableIds.has(panel.modelId) ? { ...panel, modelId: null, accountId: null } : panel);

  if (activeFamilyPreset.value && !familyPresets.value.some((preset) => preset.family === activeFamilyPreset.value)) {
    activeFamilyPreset.value = null;
  }
});

watch(isAnyLoading, (loading) => {
  if (loading && !liveTimer) {
    liveTimer = setInterval(() => {
      liveNow.value = Date.now();
    }, 100);
    return;
  }

  if (!loading && liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
});

onBeforeUnmount(() => {
  stopAllRequests();
  if (liveTimer) clearInterval(liveTimer);
  if (startLongPressTimer) clearTimeout(startLongPressTimer);
});

function generateId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function normalizeProxyBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\/$/, "");
  return trimmed || undefined;
}

function normalizeQueryParam(value: unknown): string | null {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

function getApiKeyLabel(apiKey: Pick<ApiKeyOption, "name">): string {
  return apiKey.name?.trim() || "Unnamed key";
}

function filterModelsByApiKey(modelOptions: ModelOption[], apiKey: ApiKeyOption | null): ModelOption[] {
  if (!apiKey || apiKey.modelAccessMode === "all") return modelOptions;
  const modelSet = new Set(apiKey.modelAccessList);
  return apiKey.modelAccessMode === "whitelist"
    ? modelOptions.filter((model) => modelSet.has(model.id))
    : modelOptions.filter((model) => !modelSet.has(model.id));
}

function findApiKeyWithMostModels(apiKeys: ApiKeyOption[], modelOptions: ModelOption[]): string | null {
  if (apiKeys.length === 0) return null;

  let bestId = apiKeys[0]!.id;
  let bestCount = -1;

  for (const apiKey of apiKeys) {
    const count = filterModelsByApiKey(modelOptions, apiKey).length;
    if (count > bestCount) {
      bestId = apiKey.id;
      bestCount = count;
    }
  }

  return bestId;
}

function buildFamilyPresets(modelOptions: ModelOption[], accounts: ProviderAccountOption[]) {
  const availableProviders = new Set(accounts.map((account) => account.provider));
  const grouped = new Map<ReturnType<typeof categorizeModelFamily>, ModelOption[]>();

  for (const model of modelOptions) {
    if (!model.providers.some((provider) => availableProviders.has(provider))) continue;
    const family = categorizeModelFamily(model.family);
    grouped.set(family, [...(grouped.get(family) ?? []), model]);
  }

  for (const familyModels of grouped.values()) {
    familyModels.sort((a, b) => a.name.localeCompare(b.name));
  }

  const familyOrder = new Map(MODEL_FAMILY_SORT_ORDER.map((family, index) => [family, index]));
  return Array.from(grouped.entries())
    .sort(([familyA], [familyB]) => {
      const orderA = familyOrder.get(familyA) ?? Number.MAX_SAFE_INTEGER;
      const orderB = familyOrder.get(familyB) ?? Number.MAX_SAFE_INTEGER;
      return orderA === orderB ? familyA.localeCompare(familyB) : orderA - orderB;
    })
    .map(([family, familyModels]) => ({ family, models: familyModels }));
}

function getAccountLabel(account: ProviderAccountOption): string {
  const name = account.name.trim();
  const email = account.email?.trim();
  if (!email) return name;
  if (!name || name.toLowerCase() === email.toLowerCase()) return email;
  return `${name} (${email})`;
}

function getValidAccountIdForPanel(panel: PanelState): string | null {
  if (!panel.accountId || !panel.modelId) return null;
  const model = modelsById.value.get(panel.modelId);
  const account = providerAccountsById.value.get(panel.accountId);
  if (!model || !account || !model.providers.includes(account.provider)) return null;
  return account.id;
}

function getSelectedRouteLabel(panel: PanelState): string {
  const selectedAccountId = getValidAccountIdForPanel(panel);
  const selectedAccount = selectedAccountId ? providerAccountsById.value.get(selectedAccountId) : null;
  const response = responses.value[panel.id];
  const usedAccount = response?.usedAccountId ? providerAccountsById.value.get(response.usedAccountId) : null;

  if (selectedAccount) return `${getAccountLabel(selectedAccount)} (${getProviderLabel(selectedAccount.provider)})`;
  if (panel.modelId) return usedAccount ? `Auto (${getAccountLabel(usedAccount)} - ${getProviderLabel(usedAccount.provider)})` : "Auto (load balancer)";
  return "-";
}

function getPanelModels(panel: PanelState): ModelOption[] {
  let nextModels = activePresetModelIds.value ? filteredModels.value.filter((model) => activePresetModelIds.value?.has(model.id)) : filteredModels.value;
  const account = panel.accountId ? providerAccountsById.value.get(panel.accountId) : null;

  if (account?.disabledModels?.length) {
    const disabled = new Set(account.disabledModels);
    nextModels = nextModels.filter((model) => !disabled.has(model.id));
  }

  const search = modelSearchByPanel[panel.id]?.trim().toLowerCase();
  if (!search) return nextModels;
  return nextModels.filter((model) => `${model.name} ${model.providers.join(" ")}`.toLowerCase().includes(search));
}

function getGroupedPanelModels(panel: PanelState) {
  const groups = new Map<ReturnType<typeof categorizeModelFamily>, ModelOption[]>();
  for (const model of getPanelModels(panel)) {
    const family = categorizeModelFamily(model.family);
    groups.set(family, [...(groups.get(family) ?? []), model]);
  }

  const familyOrder = new Map(MODEL_FAMILY_SORT_ORDER.map((family, index) => [family, index]));
  return Array.from(groups.entries())
    .sort(([familyA], [familyB]) => {
      const orderA = familyOrder.get(familyA) ?? Number.MAX_SAFE_INTEGER;
      const orderB = familyOrder.get(familyB) ?? Number.MAX_SAFE_INTEGER;
      return orderA === orderB ? familyA.localeCompare(familyB) : orderA - orderB;
    })
    .map(([family, familyModels]) => ({ family, models: familyModels.sort((a, b) => a.name.localeCompare(b.name)) }));
}

function getPendingModelAccounts(panel: PanelState): ProviderAccountOption[] {
  const pendingModelId = pendingModelByPanel[panel.id];
  const pendingModel = pendingModelId ? modelsById.value.get(pendingModelId) : null;
  if (!pendingModel) return [];

  const routeSearch = routeSearchByPanel[panel.id]?.trim().toLowerCase();
  const providerOrder = new Map(pendingModel.providers.map((provider, index) => [provider, index]));
  return providerAccounts.value
    .filter((account) => pendingModel.providers.includes(account.provider) && !account.disabledModels?.includes(pendingModel.id))
    .filter((account) => !routeSearch || `${account.provider} ${account.name} ${account.email ?? ""}`.toLowerCase().includes(routeSearch))
    .sort((a, b) => {
      const orderA = providerOrder.get(a.provider) ?? Number.MAX_SAFE_INTEGER;
      const orderB = providerOrder.get(b.provider) ?? Number.MAX_SAFE_INTEGER;
      return orderA === orderB ? getAccountLabel(a).localeCompare(getAccountLabel(b)) : orderA - orderB;
    });
}

function openPanelPicker(panel: PanelState) {
  selectionOpenByPanel[panel.id] = true;
  selectionStepByPanel[panel.id] = panel.modelId ? "routing" : "model";
  pendingModelByPanel[panel.id] = panel.modelId;
}

function setModelSearch(panelId: string, event: Event) {
  modelSearchByPanel[panelId] = (event.target as HTMLInputElement).value;
}

function setRouteSearch(panelId: string, event: Event) {
  routeSearchByPanel[panelId] = (event.target as HTMLInputElement).value;
}

function selectPendingModel(panel: PanelState, modelId: string) {
  pendingModelByPanel[panel.id] = modelId;
  selectionStepByPanel[panel.id] = "routing";
}

function selectPanelRoute(panel: PanelState, accountId: string | null) {
  const modelId = pendingModelByPanel[panel.id];
  if (!modelId) return;

  panels.value = panels.value.map((item) => item.id === panel.id ? { ...item, modelId, accountId } : item);
  selectionOpenByPanel[panel.id] = false;
  selectionStepByPanel[panel.id] = "model";
  pendingModelByPanel[panel.id] = null;
  modelSearchByPanel[panel.id] = "";
  routeSearchByPanel[panel.id] = "";
}

function addPanel() {
  if (!canAddPanel.value) return;
  panels.value = [...panels.value, { id: generateId(), modelId: null, accountId: null }];
}

function removePanel(panelId: string) {
  panels.value = panels.value.filter((panel) => panel.id !== panelId);
  const nextResponses = { ...responses.value };
  Reflect.deleteProperty(nextResponses, panelId);
  responses.value = nextResponses;
}

function applyFamilyPreset(family: string) {
  if (activeFamilyPreset.value === family) {
    panels.value = [{ id: generateId(), modelId: null, accountId: null }];
    responses.value = {};
    activeFamilyPreset.value = null;
    return;
  }

  const preset = familyPresets.value.find((item) => item.family === family);
  if (!preset) return;

  const accountByModel = new Map<string, string>();
  for (const panel of panels.value) {
    if (panel.modelId && panel.accountId && getValidAccountIdForPanel(panel)) {
      accountByModel.set(panel.modelId, panel.accountId);
    }
  }

  panels.value = preset.models.map((model) => ({ id: generateId(), modelId: model.id, accountId: accountByModel.get(model.id) ?? null }));
  responses.value = {};
  activeFamilyPreset.value = family;
}

function selectScenario(scenario: Scenario) {
  selectedScenario.value = scenario;
  responses.value = {};
  if (scenario.isReasoning && settings.reasoningEffort === "none") {
    settings.reasoningEffort = "medium";
  }
}

function resetSettings() {
  Object.assign(settings, DEFAULT_SETTINGS);
}

function getScenarioMessages(scenario: Scenario): ScenarioMessage[] {
  return scenario.messages?.length ? scenario.messages : [{ role: "user", content: scenario.prompt }];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("");
}

function extractMessageText(content: ScenarioMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    if ((part as { type?: unknown }).type === "text") {
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    }
    if ((part as { type?: unknown }).type === "image_url") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function extractImageUrls(content: ScenarioMessage["content"]): string[] {
  if (typeof content === "string" || !Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "image_url") return [];
    const imageUrl = (part as { image_url?: unknown }).image_url;
    if (typeof imageUrl === "string") return [imageUrl];
    if (imageUrl && typeof imageUrl === "object" && typeof (imageUrl as { url?: unknown }).url === "string") return [(imageUrl as { url: string }).url];
    return [];
  });
}

function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "-";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
}

function getPanelWaitLabel(panelId: string): string {
  const response = responses.value[panelId];
  if (response?.isLoading && response.startedAt) return formatDurationMs(liveNow.value - response.startedAt);
  return formatDurationMs(response?.metrics.waitMs);
}

function normalizeTokenValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function extractUsageData(payload: unknown): ParsedUsageData | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown };
  const inputTokens = normalizeTokenValue(record.prompt_tokens) ?? normalizeTokenValue(record.input_tokens);
  const outputTokens = normalizeTokenValue(record.completion_tokens) ?? normalizeTokenValue(record.output_tokens);
  const totalTokens = normalizeTokenValue(record.total_tokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function mergeUsageData(current: ParsedUsageData | null, incoming: ParsedUsageData | null): ParsedUsageData | null {
  if (!incoming) return current;
  return {
    inputTokens: incoming.inputTokens ?? current?.inputTokens ?? null,
    outputTokens: incoming.outputTokens ?? current?.outputTokens ?? null,
    totalTokens: incoming.totalTokens ?? current?.totalTokens ?? null,
  };
}

function buildResponseMetrics(waitMs: number | null, firstResponseMs: number | null, usage: ParsedUsageData | null): ResponseMetrics {
  const inputTokens = usage?.inputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  const totalTokens = usage?.totalTokens ?? (inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0));
  return { waitMs, firstResponseMs, inputTokens, outputTokens, totalTokens };
}

function extractToolCallsData(toolCalls: unknown): ToolCallData[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((toolCall, index) => {
    if (!toolCall || typeof toolCall !== "object") return { name: `tool_${index + 1}`, arguments: "{}" };
    const fn = (toolCall as { function?: unknown }).function;
    if (!fn || typeof fn !== "object") return { name: `tool_${index + 1}`, arguments: "{}" };
    const name = typeof (fn as { name?: unknown }).name === "string" ? ((fn as { name: string }).name || `tool_${index + 1}`) : `tool_${index + 1}`;
    const args = (fn as { arguments?: unknown }).arguments;
    return { name, arguments: typeof args === "string" ? (args.trim() || "{}") : args === undefined ? "{}" : JSON.stringify(args) };
  });
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : null;
}

function extractChatCompletionData(payload: unknown): ParsedCompletionData {
  const usage = extractUsageData(payload);
  if (!payload || typeof payload !== "object") return { content: "", reasoning: "", toolCalls: [], usage };
  const choices = (payload as { choices?: unknown }).choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : null;
  const message = firstChoice && typeof firstChoice === "object" ? (firstChoice as { message?: unknown }).message : null;
  if (!message || typeof message !== "object") return { content: "", reasoning: "", toolCalls: [], usage };
  return {
    content: extractTextContent((message as { content?: unknown }).content),
    reasoning: extractTextContent((message as { reasoning_content?: unknown }).reasoning_content),
    toolCalls: extractToolCallsData((message as { tool_calls?: unknown }).tool_calls),
    usage,
  };
}

function extractStreamChunkData(payload: unknown): ParsedCompletionData {
  const usage = extractUsageData(payload);
  if (!payload || typeof payload !== "object") return { content: "", reasoning: "", toolCalls: [], usage };
  const choices = (payload as { choices?: unknown }).choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : null;
  const delta = firstChoice && typeof firstChoice === "object" ? (firstChoice as { delta?: unknown }).delta : null;
  if (!delta || typeof delta !== "object") return { content: "", reasoning: "", toolCalls: [], usage };
  return {
    content: extractTextContent((delta as { content?: unknown }).content),
    reasoning: extractTextContent((delta as { reasoning_content?: unknown }).reasoning_content),
    toolCalls: [],
    usage,
  };
}

function extractAnthropicToolCallsData(content: unknown): ToolCallData[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, index) => {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "tool_use") return [];
    const name = typeof (block as { name?: unknown }).name === "string" ? ((block as { name: string }).name || `tool_${index + 1}`) : `tool_${index + 1}`;
    const input = (block as { input?: unknown }).input;
    return [{ name, arguments: typeof input === "string" ? (input.trim() || "{}") : input === undefined ? "{}" : JSON.stringify(input) }];
  });
}

function extractAnthropicCompletionData(payload: unknown): ParsedCompletionData {
  const usage = extractUsageData(payload);
  if (!payload || typeof payload !== "object") return { content: "", reasoning: "", toolCalls: [], usage };
  const contentBlocks = (payload as { content?: unknown }).content;
  if (!Array.isArray(contentBlocks)) return { content: "", reasoning: "", toolCalls: [], usage };
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") continue;
    if ((block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") textParts.push((block as { text: string }).text);
    if ((block as { type?: unknown }).type === "thinking" && typeof (block as { thinking?: unknown }).thinking === "string") reasoningParts.push((block as { thinking: string }).thinking);
  }
  return { content: textParts.join(""), reasoning: reasoningParts.join(""), toolCalls: extractAnthropicToolCallsData(contentBlocks), usage };
}

function extractResponsesCompletionData(payload: unknown): ParsedCompletionData {
  const usage = extractUsageData(payload) ?? (payload && typeof payload === "object" ? extractUsageData({ usage: ((payload as { response?: { usage?: unknown } }).response)?.usage }) : null);
  if (!payload || typeof payload !== "object") return { content: "", reasoning: "", toolCalls: [], usage };
  const outputItems = (payload as { output?: unknown }).output;
  if (!Array.isArray(outputItems)) return extractChatCompletionData(payload);
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCallData[] = [];
  for (const item of outputItems) {
    if (!item || typeof item !== "object") continue;
    const itemType = (item as { type?: unknown }).type;
    if (itemType === "message") {
      const content = (item as { content?: unknown }).content;
      if (typeof content === "string") textParts.push(content);
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === "object" && ["output_text", "text", "input_text"].includes(String((part as { type?: unknown }).type)) && typeof (part as { text?: unknown }).text === "string") {
            textParts.push((part as { text: string }).text);
          }
        }
      }
    }
    if (itemType === "reasoning") {
      const summary = (item as { summary?: unknown }).summary;
      if (Array.isArray(summary)) {
        for (const part of summary) {
          if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") reasoningParts.push((part as { text: string }).text);
        }
      }
    }
    if (itemType === "function_call" && typeof (item as { name?: unknown }).name === "string") {
      const args = (item as { arguments?: unknown }).arguments;
      toolCalls.push({ name: (item as { name: string }).name, arguments: typeof args === "string" ? (args.trim() || "{}") : args === undefined ? "{}" : JSON.stringify(args) });
    }
  }
  return { content: textParts.join(""), reasoning: reasoningParts.join(""), toolCalls, usage };
}

function processSseEvents(events: string[], onChunk: (chunk: ParsedCompletionData) => void, endpoint: PlaygroundEndpoint) {
  for (const event of events) {
    const lines = event.split(/\r?\n/);
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "";
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n").trim();
    if (!data || data === "[DONE]") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const errorMessage = extractErrorMessage(parsed);
    if (errorMessage) throw new Error(errorMessage);

    const chunk = endpoint === "messages" ? extractAnthropicStreamChunkData(eventName, parsed) : endpoint === "responses" ? extractResponsesStreamChunkData(parsed) : extractStreamChunkData(parsed);
    if (chunk.content || chunk.reasoning || chunk.toolCalls.length > 0 || chunk.usage) onChunk(chunk);
  }
}

function extractAnthropicStreamChunkData(eventName: string, payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") return { content: "", reasoning: "", toolCalls: [], usage: null };
  if (eventName === "content_block_delta") {
    const delta = (payload as { delta?: unknown }).delta;
    if (!delta || typeof delta !== "object") return { content: "", reasoning: "", toolCalls: [], usage: null };
    if ((delta as { type?: unknown }).type === "text_delta") return { content: typeof (delta as { text?: unknown }).text === "string" ? (delta as { text: string }).text : "", reasoning: "", toolCalls: [], usage: null };
    if ((delta as { type?: unknown }).type === "thinking_delta") return { content: "", reasoning: typeof (delta as { thinking?: unknown }).thinking === "string" ? (delta as { thinking: string }).thinking : "", toolCalls: [], usage: null };
  }
  if (eventName === "message_delta") return { content: "", reasoning: "", toolCalls: [], usage: extractUsageData({ usage: (payload as { usage?: unknown }).usage }) };
  return { content: "", reasoning: "", toolCalls: [], usage: null };
}

function extractResponsesStreamChunkData(payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") return { content: "", reasoning: "", toolCalls: [], usage: null };
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== "string") return extractStreamChunkData(payload);
  if (type.includes("output_text")) return { content: typeof (payload as { delta?: unknown; text?: unknown }).delta === "string" ? (payload as { delta: string }).delta : typeof (payload as { text?: unknown }).text === "string" ? (payload as { text: string }).text : "", reasoning: "", toolCalls: [], usage: null };
  if (type.includes("reasoning")) return { content: "", reasoning: typeof (payload as { delta?: unknown; text?: unknown }).delta === "string" ? (payload as { delta: string }).delta : typeof (payload as { text?: unknown }).text === "string" ? (payload as { text: string }).text : "", toolCalls: [], usage: null };
  if (type === "response.completed") return { content: "", reasoning: "", toolCalls: [], usage: extractUsageData(payload) };
  return { content: "", reasoning: "", toolCalls: [], usage: null };
}

async function consumeStream(response: Response, endpoint: PlaygroundEndpoint, onChunk: (chunk: ParsedCompletionData) => void) {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    processSseEvents(events, onChunk, endpoint);
  }

  buffer += decoder.decode();
  if (buffer.trim()) processSseEvents([buffer], onChunk, endpoint);
}

function mapReasoningEffortToThinkingBudget(effort: ReasoningEffort): number {
  if (effort === "low") return 4000;
  if (effort === "medium") return 8000;
  if (effort === "high") return 16000;
  if (effort === "xhigh") return 32000;
  return 0;
}

function usesAdaptiveThinking(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized === "claude-opus-4-7" || normalized === "claude-opus-4.7";
}

function convertOpenAIContentToAnthropic(content: ScenarioMessage["content"]): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    if ((part as { type?: unknown }).type === "text") return typeof (part as { text?: unknown }).text === "string" ? [{ type: "text", text: (part as { text: string }).text }] : [];
    if ((part as { type?: unknown }).type === "image_url") {
      const imageUrl = (part as { image_url?: unknown }).image_url;
      const url = typeof imageUrl === "string" ? imageUrl : imageUrl && typeof imageUrl === "object" ? (imageUrl as { url?: unknown }).url : null;
      return typeof url === "string" && url.trim() ? [{ type: "image", source: { type: "url", url: url.trim() } }] : [];
    }
    return [part];
  });
}

function convertScenarioMessagesToAnthropic(messages: ScenarioMessage[]) {
  const systemParts: string[] = [];
  const convertedMessages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      const systemText = extractMessageText(message.content);
      if (systemText) systemParts.push(systemText);
      continue;
    }

    convertedMessages.push({ role: message.role === "assistant" ? "assistant" : "user", content: convertOpenAIContentToAnthropic(message.content) });
  }

  if (convertedMessages.length === 0) convertedMessages.push({ role: "user", content: "" });
  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : null, messages: convertedMessages };
}

function convertScenarioMessagesToResponsesInput(messages: ScenarioMessage[]) {
  return messages.map((message) => ({ type: "message", role: message.role === "system" ? "developer" : message.role === "assistant" ? "assistant" : "user", content: message.content }));
}

function buildRequestBody(modelId: string, messages: ScenarioMessage[], currentSettings: PlaygroundSettings, accountId: string | null): Record<string, unknown> {
  if (currentSettings.endpoint === "messages") {
    const anthropicPayload = convertScenarioMessagesToAnthropic(messages);
    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: anthropicPayload.messages,
      stream: currentSettings.streamResponses,
      temperature: currentSettings.temperature,
      top_p: currentSettings.topP,
      max_tokens: currentSettings.maxTokens,
      presence_penalty: currentSettings.presencePenalty,
      frequency_penalty: currentSettings.frequencyPenalty,
    };
    if (anthropicPayload.system) requestBody.system = anthropicPayload.system;
    if (accountId) requestBody.provider_account_id = accountId;
    if (currentSettings.reasoningEffort !== "none") {
      if (usesAdaptiveThinking(modelId)) {
        requestBody.thinking = { type: "adaptive" };
        requestBody.output_config = { effort: currentSettings.reasoningEffort };
      } else {
        requestBody.thinking = { type: "enabled", budget_tokens: mapReasoningEffortToThinkingBudget(currentSettings.reasoningEffort) };
      }
    }
    return requestBody;
  }

  const requestBody: Record<string, unknown> = currentSettings.endpoint === "responses"
    ? {
        model: modelId,
        input: convertScenarioMessagesToResponsesInput(messages),
        stream: currentSettings.streamResponses,
        temperature: currentSettings.temperature,
        top_p: currentSettings.topP,
        max_output_tokens: currentSettings.maxTokens,
        presence_penalty: currentSettings.presencePenalty,
        frequency_penalty: currentSettings.frequencyPenalty,
      }
    : {
        model: modelId,
        messages,
        stream: currentSettings.streamResponses,
        temperature: currentSettings.temperature,
        top_p: currentSettings.topP,
        max_tokens: currentSettings.maxTokens,
        presence_penalty: currentSettings.presencePenalty,
        frequency_penalty: currentSettings.frequencyPenalty,
      };

  if (accountId) requestBody.provider_account_id = accountId;
  if (currentSettings.reasoningEffort !== "none") requestBody.reasoning_effort = currentSettings.reasoningEffort;
  return requestBody;
}

function adaptRequestOverridesForEndpoint(overrides: Record<string, unknown> | undefined, endpoint: PlaygroundEndpoint): Record<string, unknown> | null {
  if (!overrides) return null;
  if (endpoint !== "messages") return overrides;

  const adapted = { ...overrides };
  if (Array.isArray(adapted.tools)) {
    adapted.tools = adapted.tools.flatMap((tool) => {
      if (!tool || typeof tool !== "object" || (tool as { type?: unknown }).type !== "function") return [];
      const fn = (tool as { function?: unknown }).function;
      if (!fn || typeof fn !== "object" || typeof (fn as { name?: unknown }).name !== "string") return [];
      return [{ name: (fn as { name: string }).name, description: (fn as { description?: unknown }).description, input_schema: (fn as { parameters?: unknown }).parameters ?? {} }];
    });
  }
  if (adapted.tool_choice === "auto") adapted.tool_choice = { type: "auto" };
  if (adapted.tool_choice === "none") adapted.tool_choice = { type: "none" };
  if (adapted.tool_choice === "required") adapted.tool_choice = { type: "any" };
  return adapted;
}

function getEndpointPath(endpoint: PlaygroundEndpoint): string {
  const base = proxyBaseUrl.value?.replace(/\/$/, "") ?? "";
  if (endpoint === "messages") return `${base}/v1/messages`;
  if (endpoint === "responses") return `${base}/v1/responses`;
  return `${base}/v1/chat/completions`;
}

function setResponse(panelId: string, response: ResponseData) {
  responses.value = { ...responses.value, [panelId]: response };
}

function refreshAccountSummary() {
  requestDashboardAccountSummaryRefresh();
}

async function fetchFromModel(panelId: string, modelId: string, scenario: Scenario, currentSettings: PlaygroundSettings, accountId: string | null) {
  const requestStartedAt = Date.now();
  let waitMs: number | null = null;
  let usedAccountId: string | null = null;
  let shouldRefreshAccountSummary = false;

  setResponse(panelId, { content: "", reasoning: "", toolCalls: [], isLoading: true, metrics: buildResponseMetrics(null, null, null), startedAt: requestStartedAt });

  try {
    const requestBody = buildRequestBody(modelId, getScenarioMessages(scenario), currentSettings, accountId);
    const endpointOverrides = adaptRequestOverridesForEndpoint(scenario.requestOverrides, currentSettings.endpoint);
    if (endpointOverrides) Object.assign(requestBody, endpointOverrides);
    if (!proxyBaseUrl.value) throw new Error("Set NUXT_PUBLIC_PROXY_URL to your proxy service URL before running Playground.");
    const apiKey = selectedApiKeyValue.value;
    if (!apiKey) throw new Error("Select an API key before running Playground.");

    const controller = new AbortController();
    controllers.set(panelId, controller);
    const response = await fetch(getEndpointPath(currentSettings.endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    });

    waitMs = Date.now() - requestStartedAt;
    usedAccountId = response.headers.get("x-provider-account-id");
    shouldRefreshAccountSummary = true;

    if (!response.ok) {
      const clonedResponse = response.clone();
      let errorMessage = "Request failed";
      try {
        const errorData = await response.json();
        errorMessage = extractErrorMessage(errorData) ?? errorMessage;
      } catch {
        const errorText = await clonedResponse.text();
        if (errorText.trim()) errorMessage = errorText;
      }
      throw new Error(errorMessage);
    }

    const shouldStream = requestBody.stream !== false && (response.headers.get("content-type") ?? "").includes("text/event-stream");
    if (shouldStream) {
      let streamedContent = "";
      let streamedReasoning = "";
      let streamedToolCalls: ToolCallData[] = [];
      let firstResponseMs: number | null = null;
      let usage: ParsedUsageData | null = null;

      await consumeStream(response, currentSettings.endpoint, (chunk) => {
        firstResponseMs ??= Date.now() - requestStartedAt;
        streamedContent += chunk.content;
        streamedReasoning += chunk.reasoning;
        streamedToolCalls = chunk.toolCalls.length > 0 ? [...streamedToolCalls, ...chunk.toolCalls] : streamedToolCalls;
        usage = mergeUsageData(usage, chunk.usage);
        setResponse(panelId, { content: streamedContent, reasoning: streamedReasoning, toolCalls: streamedToolCalls, isLoading: true, metrics: buildResponseMetrics(waitMs, firstResponseMs, usage), usedAccountId, startedAt: requestStartedAt });
      });

      setResponse(panelId, { content: streamedContent, reasoning: streamedReasoning, toolCalls: streamedToolCalls, isLoading: false, metrics: buildResponseMetrics(waitMs, firstResponseMs, usage), usedAccountId });
      return;
    }

    const payload = await response.json();
    const parsed = currentSettings.endpoint === "messages" ? extractAnthropicCompletionData(payload) : currentSettings.endpoint === "responses" ? extractResponsesCompletionData(payload) : extractChatCompletionData(payload);
    setResponse(panelId, { content: parsed.content, reasoning: parsed.reasoning, toolCalls: parsed.toolCalls, isLoading: false, metrics: buildResponseMetrics(waitMs, Date.now() - requestStartedAt, parsed.usage), usedAccountId });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      const existing = responses.value[panelId];
      if (existing) setResponse(panelId, { ...existing, isLoading: false, error: undefined });
      return;
    }

    setResponse(panelId, { content: "", reasoning: "", toolCalls: [], isLoading: false, error: error instanceof Error ? error.message : "Unknown error", metrics: buildResponseMetrics(waitMs, null, null), usedAccountId });
  } finally {
    controllers.delete(panelId);
    if (shouldRefreshAccountSummary) refreshAccountSummary();
  }
}

async function runSelectedScenario(requestedLoopCount = 1) {
  if (!selectedScenario.value || isAnyLoading.value || !canRunPlayground.value) return;
  let currentSettings = { ...settings };
  if (selectedScenario.value.isReasoning && currentSettings.reasoningEffort === "none") {
    settings.reasoningEffort = "medium";
    currentSettings = { ...settings };
  }

  const panelsWithModels = panels.value.filter((panel): panel is PanelState & { modelId: string } => Boolean(panel.modelId));
  if (panelsWithModels.length === 0) return;

  const totalLoops = Math.max(1, Math.floor(requestedLoopCount));
  isAnyLoading.value = true;
  activeLoopProgress.value = totalLoops > 1 ? { current: 1, total: totalLoops } : null;

  try {
    for (let iteration = 0; iteration < totalLoops; iteration += 1) {
      activeLoopProgress.value = totalLoops > 1 ? { current: iteration + 1, total: totalLoops } : null;
      responses.value = Object.fromEntries(panelsWithModels.map((panel) => [panel.id, { content: "", reasoning: "", toolCalls: [], isLoading: true, metrics: buildResponseMetrics(null, null, null), startedAt: Date.now() }]));
      await Promise.all(panelsWithModels.map((panel) => fetchFromModel(panel.id, panel.modelId, selectedScenario.value, currentSettings, getValidAccountIdForPanel(panel))));
      if (!isAnyLoading.value) break;
    }
  } finally {
    activeLoopProgress.value = null;
    isAnyLoading.value = false;
  }
}

function stopAllRequests() {
  controllers.forEach((controller) => controller.abort());
  controllers.clear();
  activeLoopProgress.value = null;
  isAnyLoading.value = false;
  responses.value = Object.fromEntries(Object.entries(responses.value).map(([panelId, response]) => [panelId, response.isLoading ? { ...response, isLoading: false } : response]));
}

async function retryPanel(panelId: string) {
  const panel = panels.value.find((item) => item.id === panelId);
  if (!panel?.modelId || !selectedScenario.value || !canRunPlayground.value) return;
  isAnyLoading.value = true;
  try {
    await fetchFromModel(panel.id, panel.modelId, selectedScenario.value, { ...settings }, getValidAccountIdForPanel(panel));
  } finally {
    isAnyLoading.value = false;
  }
}

function handleStartPointerDown(event: PointerEvent) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (startLongPressTimer) clearTimeout(startLongPressTimer);
  startLongPressTriggered = false;
  startLongPressTimer = setTimeout(() => {
    startLongPressTriggered = true;
    loopCountInput.value = String(loopCount.value);
    loopDialogOpen.value = true;
  }, START_LONG_PRESS_DELAY_MS);
}

function handleStartPointerEnd() {
  if (startLongPressTimer) {
    clearTimeout(startLongPressTimer);
    startLongPressTimer = null;
  }
}

function handleStartClick() {
  if (startLongPressTriggered) {
    startLongPressTriggered = false;
    return;
  }
  runSelectedScenario();
}

function runLoop() {
  if (!isLoopCountValid.value) return;
  loopCount.value = parsedLoopCount.value;
  loopDialogOpen.value = false;
  runSelectedScenario(parsedLoopCount.value);
}

function formatToolArguments(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
</script>

<template>
  <div>
  <UiDialog v-model:open="loopDialogOpen" :ui="{ content: 'sm:max-w-[400px]' }">
    <template #content>
      <div class="space-y-1.5 pr-6">
        <h2 class="text-lg font-semibold">Run Loop</h2>
        <p class="text-sm text-muted-foreground">Choose how many times to run the selected playground scenario.</p>
      </div>
      <label class="grid gap-2 text-sm font-medium">
        Loop count
        <input v-model="loopCountInput" type="number" inputmode="numeric" min="1" step="1" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" @keydown.enter.prevent="runLoop">
      </label>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" size="sm" @click="loopDialogOpen = false">Cancel</UiButton>
        <UiButton size="sm" :disabled="!isLoopCountValid" @click="runLoop">Run loop</UiButton>
      </div>
    </template>
  </UiDialog>

  <UiSheet v-model:open="settingsOpen" side="right" :ui="{ content: 'w-[88vw] max-w-sm overflow-y-auto p-0' }">
    <template #content>
      <div class="flex min-h-full flex-col">
        <div class="border-b border-border px-5 py-4">
          <h2 class="text-lg font-semibold">Settings</h2>
        </div>
        <div class="flex-1 space-y-6 px-5 py-5">
          <section class="space-y-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Endpoint</h3>
            <div class="space-y-2">
              <p class="text-sm font-medium">API Endpoint</p>
              <button
                v-for="option in ENDPOINT_OPTIONS"
                :key="option.value"
                type="button"
                :class="[
                  'flex h-auto w-full cursor-pointer flex-col items-start justify-start rounded-md border px-3 py-2 text-left text-sm transition-all disabled:pointer-events-none disabled:opacity-50',
                  settings.endpoint === option.value ? 'border-primary bg-primary text-primary-foreground ring-1 ring-primary/30' : 'border-input bg-input/30 hover:bg-input/50',
                ]"
                :disabled="isAnyLoading"
                @click="settings.endpoint = option.value"
              >
                <span class="text-xs font-medium">{{ option.label }}</span>
                <span :class="settings.endpoint === option.value ? 'text-[11px] text-primary-foreground/80' : 'text-[11px] text-muted-foreground'">{{ option.description }}</span>
              </button>
              <p class="text-xs text-muted-foreground">Pick the API style you want to test in Playground.</p>
            </div>
          </section>

          <div class="h-px bg-border" />

          <section class="space-y-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Generation</h3>
            <div class="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div class="space-y-1">
                <p class="text-sm font-medium">Stream Responses</p>
                <p class="text-xs text-muted-foreground">Show tokens in real-time as they arrive</p>
              </div>
              <UiSwitch v-model="settings.streamResponses" :disabled="isAnyLoading" />
            </div>
            <label class="grid gap-2 text-sm font-medium">
              <span class="flex items-center justify-between"><span>Temperature</span><span class="w-12 text-right text-sm text-muted-foreground">{{ settings.temperature.toFixed(1) }}</span></span>
              <input v-model.number="settings.temperature" type="range" min="0" max="2" step="0.1" :disabled="isAnyLoading" class="w-full accent-primary">
              <span class="text-xs font-normal text-muted-foreground">Higher values make output more creative and random</span>
            </label>
            <label class="grid gap-2 text-sm font-medium">
              <span class="flex items-center justify-between"><span>Top P</span><span class="w-12 text-right text-sm text-muted-foreground">{{ settings.topP.toFixed(2) }}</span></span>
              <input v-model.number="settings.topP" type="range" min="0" max="1" step="0.05" :disabled="isAnyLoading" class="w-full accent-primary">
              <span class="text-xs font-normal text-muted-foreground">Nucleus sampling threshold (1.0 = consider all tokens)</span>
            </label>
            <label class="grid gap-2 text-sm font-medium">
              Max Tokens
              <input v-model.number="settings.maxTokens" type="number" min="1" max="128000" :disabled="isAnyLoading" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <span class="text-xs font-normal text-muted-foreground">Maximum number of tokens to generate</span>
            </label>
          </section>

          <div class="h-px bg-border" />

          <section class="space-y-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Penalties</h3>
            <label class="grid gap-2 text-sm font-medium">
              <span class="flex items-center justify-between"><span>Presence Penalty</span><span class="w-12 text-right text-sm text-muted-foreground">{{ settings.presencePenalty.toFixed(1) }}</span></span>
              <input v-model.number="settings.presencePenalty" type="range" min="-2" max="2" step="0.1" :disabled="isAnyLoading" class="w-full accent-primary">
              <span class="text-xs font-normal text-muted-foreground">Penalize tokens based on whether they appear in the text so far</span>
            </label>
            <label class="grid gap-2 text-sm font-medium">
              <span class="flex items-center justify-between"><span>Frequency Penalty</span><span class="w-12 text-right text-sm text-muted-foreground">{{ settings.frequencyPenalty.toFixed(1) }}</span></span>
              <input v-model.number="settings.frequencyPenalty" type="range" min="-2" max="2" step="0.1" :disabled="isAnyLoading" class="w-full accent-primary">
              <span class="text-xs font-normal text-muted-foreground">Penalize tokens based on how frequently they appear</span>
            </label>
          </section>

          <div class="h-px bg-border" />

          <section class="space-y-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Reasoning</h3>
            <div class="space-y-2">
              <p class="text-sm font-medium">Reasoning Effort</p>
              <div class="flex gap-1 overflow-x-auto">
                <UiButton
                  v-for="option in REASONING_OPTIONS"
                  :key="option.value"
                  size="sm"
                  :variant="settings.reasoningEffort === option.value ? 'default' : 'outline'"
                  :class="['flex-1', settings.reasoningEffort === option.value && option.value !== 'none' ? 'bg-amber-600 hover:bg-amber-700' : '']"
                  :disabled="isAnyLoading"
                  @click="settings.reasoningEffort = option.value"
                >
                  {{ option.label }}
                </UiButton>
              </div>
              <p class="text-xs text-muted-foreground">Enable extended thinking for reasoning models.</p>
            </div>
          </section>
        </div>
        <div class="border-t border-border p-5">
          <UiButton variant="outline" class="w-full" :disabled="isAnyLoading" @click="resetSettings">
            <UiIcon name="i-lucide-rotate-ccw" class="size-4" />
            Reset to Defaults
          </UiButton>
        </div>
      </div>
    </template>
  </UiSheet>

  <div class="space-y-6">
    <div class="border-b border-border pb-4">
      <div class="flex items-center justify-between gap-4">
        <h1 class="text-xl font-semibold">Playground</h1>
        <div class="flex items-center gap-2">
          <UiPopover v-if="apiKeyOptions.length > 1" v-model:open="apiKeyPickerOpen" :content="{ align: 'end', class: 'w-[280px] p-0' }">
            <UiButton type="button" variant="outline" size="sm" class="gap-1.5 sm:max-w-[200px]" :disabled="isAnyLoading">
              <UiIcon name="i-lucide-key" class="size-3.5 shrink-0" />
              <span class="hidden truncate sm:inline">{{ selectedApiKeyLabel }}</span>
              <UiIcon name="i-lucide-chevron-down" class="hidden size-3 shrink-0 opacity-50 sm:block" />
            </UiButton>
            <template #content>
              <div class="space-y-1 p-2">
                <input class="mb-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none" placeholder="Search API keys..." disabled>
                <button
                  v-for="apiKey in apiKeyOptions"
                  :key="apiKey.id"
                  type="button"
                  class="flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  :class="selectedApiKeyId === apiKey.id ? 'bg-accent' : ''"
                  @click="selectedApiKeyId = apiKey.id; apiKeyPickerOpen = false"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-xs font-medium">{{ getApiKeyLabel(apiKey) }}</p>
                    <p class="truncate font-mono text-[10px] text-muted-foreground">{{ apiKey.keyPreview }}</p>
                  </div>
                  <UiIcon v-if="selectedApiKeyId === apiKey.id" name="i-lucide-check" class="size-3.5 text-foreground" />
                </button>
              </div>
            </template>
          </UiPopover>
          <UiButton v-if="isAnyLoading" type="button" variant="outline" size="sm" @click="stopAllRequests">
            <span class="relative inline-flex">
              <UiIcon name="i-lucide-square" class="size-3.5" />
              <span v-if="activeLoopBadgeLabel" class="absolute -right-3 -top-2 rounded-full bg-primary px-1 py-0.5 text-[9px] font-semibold leading-none text-primary-foreground">{{ activeLoopBadgeLabel }}</span>
            </span>
            Stop
          </UiButton>
          <UiButton v-else type="button" variant="outline" size="sm" :disabled="!canRunPlayground" @click="handleStartClick" @pointerdown="handleStartPointerDown" @pointerup="handleStartPointerEnd" @pointerleave="handleStartPointerEnd" @pointercancel="handleStartPointerEnd">
            <UiIcon name="i-lucide-play" class="size-4" />
            Start
          </UiButton>
          <UiButton type="button" variant="outline" size="icon" :disabled="isAnyLoading" @click="settingsOpen = true">
            <UiIcon name="i-lucide-settings" class="size-4" />
            <span class="sr-only">Settings</span>
          </UiButton>
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <UiSkeleton v-if="pending" class="h-96 rounded-xl" />

    <template v-else>
      <div class="space-y-3">
        <div v-if="playgroundSetupMessage" class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {{ playgroundSetupMessage }}
        </div>
        <h2 class="text-sm font-medium text-muted-foreground">Scenario</h2>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="scenario in SCENARIOS"
            :key="scenario.id"
            type="button"
            :disabled="isAnyLoading || !hasSelectedModel"
            :class="[
              'flex h-auto min-w-[72px] cursor-pointer flex-col items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50',
              selectedScenario.id === scenario.id ? (scenario.isReasoning ? 'border-amber-600 bg-amber-600 text-white hover:bg-amber-700' : 'bg-primary text-primary-foreground') : (scenario.isReasoning ? 'border-dashed border-amber-700 hover:border-amber-600' : 'border-input bg-input/30 hover:bg-input/50'),
            ]"
            @click="selectScenario(scenario)"
          >
            <UiIcon :name="scenario.icon" class="size-4" />
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
            :disabled="isAnyLoading"
            :class="[
              'flex h-auto w-full min-w-0 cursor-pointer flex-col items-center gap-0.5 rounded-md border px-3 py-2 text-center text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 sm:w-auto sm:min-w-[92px]',
              activeFamilyPreset === preset.family ? 'bg-primary text-primary-foreground' : 'border-input bg-input/30 hover:bg-input/50',
            ]"
            @click="applyFamilyPreset(preset.family)"
          >
            <span class="whitespace-normal break-words text-xs leading-tight">{{ preset.family }}</span>
            <span :class="activeFamilyPreset === preset.family ? 'text-[10px] leading-none text-primary-foreground/85' : 'text-[10px] leading-none text-muted-foreground'">{{ preset.models.length }} models</span>
          </button>
        </div>
        <p v-else class="text-xs text-muted-foreground">Connect at least one provider account to use family presets.</p>
      </div>

      <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
        <UiCard v-for="panel in panels" :key="panel.id" class="relative flex h-[400px] flex-col gap-0 overflow-hidden py-0">
          <UiButton v-if="panels.length > 1" variant="outline" size="icon-xs" class="absolute right-2 top-2 z-10 h-7 w-7 rounded-full border bg-background/95" :disabled="isAnyLoading || responses[panel.id]?.isLoading" title="Remove card" @click="removePanel(panel.id)">
            <UiIcon name="i-lucide-x" class="size-3.5" />
          </UiButton>

          <UiCardHeader class="flex-none gap-0 border-b py-2 pl-3 pr-11">
            <UiPopover v-model:open="selectionOpenByPanel[panel.id]" :content="{ align: 'start', class: 'w-[340px] max-w-[calc(100vw-2rem)] p-0' }">
              <UiButton type="button" variant="ghost" class="h-8 flex-1 justify-between px-2 font-normal" :disabled="isAnyLoading || responses[panel.id]?.isLoading" @click="openPanelPicker(panel)">
                <span v-if="panel.modelId && modelsById.get(panel.modelId)" class="flex min-w-0 items-center gap-2">
                  <span class="truncate">{{ modelsById.get(panel.modelId)?.name }}</span>
                  <UiBadge variant="secondary" class="shrink-0 whitespace-nowrap px-1.5 py-0 text-[10px]">
                    {{ getValidAccountIdForPanel(panel) ? getProviderLabel(providerAccountsById.get(getValidAccountIdForPanel(panel)!)?.provider ?? '') : responses[panel.id]?.usedAccountId ? `Auto - ${getProviderLabel(providerAccountsById.get(responses[panel.id]?.usedAccountId ?? '')?.provider ?? '')}` : 'Auto' }}
                  </UiBadge>
                </span>
                <span v-else class="text-muted-foreground">Select model...</span>
                <UiIcon name="i-lucide-chevron-down" class="ml-1 size-3 shrink-0 opacity-50" />
              </UiButton>
              <template #content>
                <div v-if="selectionStepByPanel[panel.id] !== 'routing'" class="max-h-[420px] overflow-hidden">
                  <div class="border-b p-2">
                    <input :value="modelSearchByPanel[panel.id] ?? ''" placeholder="Search models..." class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none" @input="setModelSearch(panel.id, $event)">
                  </div>
                  <div class="max-h-[360px] overflow-y-auto p-1">
                    <p v-if="getGroupedPanelModels(panel).length === 0" class="px-2 py-6 text-center text-sm text-muted-foreground">No model found.</p>
                    <div v-for="group in getGroupedPanelModels(panel)" :key="group.family" class="py-1">
                      <p class="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">{{ group.family }}</p>
                      <button v-for="model in group.models" :key="model.id" type="button" class="flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground" :class="panel.modelId === model.id ? 'bg-accent' : ''" @click="selectPendingModel(panel, model.id)">
                        <div class="min-w-0 flex-1">
                          <p class="truncate text-xs font-medium">{{ model.name }}</p>
                          <div class="mt-1 flex flex-wrap gap-1">
                            <UiBadge v-for="provider in model.providers" :key="`${model.id}-${provider}`" variant="outline" class="h-4 px-1.5 text-[9px]">{{ getProviderLabel(provider) }}</UiBadge>
                          </div>
                        </div>
                      </button>
                    </div>
                  </div>
                </div>
                <div v-else class="max-h-[420px] overflow-hidden">
                  <div class="flex items-center justify-between border-b px-2 py-1.5">
                    <UiButton type="button" variant="ghost" size="sm" class="h-7 gap-1 px-2 text-xs" @click="selectionStepByPanel[panel.id] = 'model'; pendingModelByPanel[panel.id] = null">
                      <UiIcon name="i-lucide-chevron-left" class="size-3.5" />
                      Models
                    </UiButton>
                    <p class="max-w-[220px] truncate text-xs font-medium">{{ pendingModelByPanel[panel.id] }}</p>
                  </div>
                  <div class="border-b p-2">
                    <input :value="routeSearchByPanel[panel.id] ?? ''" placeholder="Search provider or account..." class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none" @input="setRouteSearch(panel.id, $event)">
                  </div>
                  <div class="max-h-[330px] overflow-y-auto p-1">
                    <p class="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">Routing</p>
                    <button type="button" class="flex w-full cursor-pointer items-center rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground" :class="panel.modelId === pendingModelByPanel[panel.id] && !panel.accountId ? 'bg-accent' : ''" @click="selectPanelRoute(panel, null)">
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-xs font-medium">Auto (load balancer)</p>
                        <p class="truncate text-[10px] text-muted-foreground">System chooses best provider account</p>
                      </div>
                    </button>
                    <button v-for="account in getPendingModelAccounts(panel)" :key="account.id" type="button" class="flex w-full cursor-pointer items-center rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground" :class="panel.modelId === pendingModelByPanel[panel.id] && panel.accountId === account.id ? 'bg-accent' : ''" @click="selectPanelRoute(panel, account.id)">
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-xs font-medium">{{ getAccountLabel(account) }}</p>
                        <p class="truncate text-[10px] text-muted-foreground">{{ getProviderLabel(account.provider) }}</p>
                      </div>
                      <UiBadge variant="outline" class="ml-2 text-[10px]">{{ getProviderLabel(account.provider) }}</UiBadge>
                    </button>
                  </div>
                </div>
              </template>
            </UiPopover>
          </UiCardHeader>

          <UiCardContent class="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
            <div class="min-h-0 flex-1 overflow-y-auto p-3">
              <p v-if="!panel.modelId && !responses[panel.id]?.isLoading && !responses[panel.id]?.content && !responses[panel.id]?.reasoning && !responses[panel.id]?.error" class="py-8 text-center text-sm text-muted-foreground">Select a model to start</p>

              <template v-if="panel.modelId && scenarioMessages.length > 0">
                <div v-if="systemPromptText" class="mb-2">
                  <button type="button" class="flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/80" @click="systemCollapsedByPanel[panel.id] = !(systemCollapsedByPanel[panel.id] ?? true)">
                    <UiIcon name="i-lucide-settings" class="size-3 shrink-0 text-muted-foreground" />
                    <span class="flex-1 text-[11px] font-medium text-muted-foreground">System</span>
                    <UiIcon :name="(systemCollapsedByPanel[panel.id] ?? true) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" class="size-3 shrink-0 text-muted-foreground" />
                  </button>
                  <div v-if="!(systemCollapsedByPanel[panel.id] ?? true)" class="mt-1 rounded-md bg-muted/30 px-2.5 py-2">
                    <pre class="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-muted-foreground">{{ systemPromptText }}</pre>
                  </div>
                </div>

                <div v-for="(message, index) in userScenarioMessages" :key="`${panel.id}-user-${index}`" class="mb-2 flex gap-2">
                  <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <UiIcon name="i-lucide-user" class="size-3 text-primary" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="mb-1 text-[11px] font-medium text-primary">User</p>
                    <div class="rounded-lg bg-muted px-3 py-2">
                      <pre v-if="extractMessageText(message.content)" class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ extractMessageText(message.content) }}</pre>
                      <div v-if="extractImageUrls(message.content).length > 0" class="mt-1.5 flex flex-wrap gap-1.5">
                        <a v-for="(url, imageIndex) in extractImageUrls(message.content)" :key="`${panel.id}-${imageIndex}`" :href="url" target="_blank" rel="noopener noreferrer" class="block overflow-hidden rounded border border-border">
                          <img :src="url" :alt="`Attached image ${imageIndex + 1}`" class="h-16 w-auto object-cover">
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              </template>

              <div v-if="responses[panel.id]?.error" class="space-y-2">
                <div role="alert" class="relative grid w-full grid-cols-[1rem_1fr] items-start gap-x-3 rounded-lg border border-destructive/40 bg-card px-4 py-3 text-sm text-destructive">
                  <UiIcon name="i-lucide-alert-circle" class="size-4 translate-y-0.5" />
                  <div>
                    <p class="font-medium">Error</p>
                    <p class="text-sm text-destructive/90">{{ responses[panel.id]?.error }}</p>
                  </div>
                </div>
                <UiButton v-if="panel.modelId" type="button" variant="outline" size="sm" class="w-full gap-1.5" :disabled="isAnyLoading || responses[panel.id]?.isLoading" @click="retryPanel(panel.id)">
                  <UiIcon name="i-lucide-rotate-cw" class="size-3.5" />
                  Retry
                </UiButton>
              </div>

              <div v-if="panel.modelId && (responses[panel.id]?.content || responses[panel.id]?.reasoning || responses[panel.id]?.toolCalls?.length || responses[panel.id]?.isLoading)" class="mb-2 flex gap-2">
                <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary">
                  <UiIcon name="i-lucide-bot" class="size-3 text-secondary-foreground" />
                </div>
                <div class="min-w-0 flex-1">
                  <p class="mb-1 text-[11px] font-medium text-muted-foreground">Assistant</p>
                  <div class="space-y-2">
                    <div v-if="responses[panel.id]?.reasoning" class="rounded-lg border border-amber-800 bg-amber-950 px-3 py-2">
                      <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Reasoning</p>
                      <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ responses[panel.id]?.reasoning }}<span v-if="responses[panel.id]?.isLoading && !responses[panel.id]?.content" class="animate-pulse text-primary">▌</span></pre>
                    </div>
                    <div v-if="responses[panel.id]?.content" class="rounded-lg border border-border bg-card px-3 py-2">
                      <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ responses[panel.id]?.content }}<span v-if="responses[panel.id]?.isLoading" class="animate-pulse text-primary">▌</span></pre>
                    </div>
                    <div v-if="!responses[panel.id]?.content && !responses[panel.id]?.reasoning && responses[panel.id]?.isLoading" class="rounded-lg border border-border bg-card px-3 py-2">
                      <div class="space-y-1.5">
                        <UiSkeleton class="h-3 w-full" />
                        <UiSkeleton class="h-3 w-4/5" />
                        <UiSkeleton class="h-3 w-3/5" />
                      </div>
                    </div>
                    <div v-if="responses[panel.id]?.toolCalls?.length" class="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
                      <div class="mb-1.5 flex items-center gap-1.5">
                        <UiIcon name="i-lucide-wrench" class="size-3 text-muted-foreground" />
                        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tool Calls</p>
                      </div>
                      <div class="space-y-1.5">
                        <div v-for="(toolCall, index) in responses[panel.id]?.toolCalls" :key="`${toolCall.name}-${index}`" class="rounded border border-border bg-background px-2 py-1.5">
                          <p class="text-[11px] font-semibold text-foreground">{{ toolCall.name }}</p>
                          <pre class="mt-0.5 whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">{{ formatToolArguments(toolCall.arguments) }}</pre>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <p v-if="panel.modelId && !responses[panel.id]?.isLoading && !responses[panel.id]?.content && !responses[panel.id]?.reasoning && !responses[panel.id]?.error && !responses[panel.id]?.toolCalls?.length && scenarioMessages.length === 0" class="py-8 text-center text-sm text-muted-foreground">Response will appear here</p>
            </div>

            <div class="shrink-0 border-t bg-card px-3 py-2 text-[11px]">
              <div class="flex items-center justify-between gap-2">
                <span class="text-muted-foreground">Wait</span>
                <div class="flex items-center gap-2">
                  <span class="font-medium tabular-nums">{{ getPanelWaitLabel(panel.id) }}</span>
                  <UiButton v-if="panel.modelId && !responses[panel.id]?.isLoading && !responses[panel.id]?.content && !responses[panel.id]?.reasoning && !responses[panel.id]?.error" type="button" variant="ghost" size="icon-xs" class="h-5 w-5" :disabled="isAnyLoading" title="Run panel" @click="retryPanel(panel.id)">
                    <UiIcon name="i-lucide-play" class="size-3 fill-current" />
                  </UiButton>
                  <UiButton v-if="panel.modelId && !responses[panel.id]?.isLoading && (responses[panel.id]?.content || responses[panel.id]?.reasoning || responses[panel.id]?.error)" type="button" variant="ghost" size="icon-xs" class="h-5 w-5" :disabled="isAnyLoading" title="Retry" @click="retryPanel(panel.id)">
                    <UiIcon name="i-lucide-rotate-cw" class="size-3" />
                  </UiButton>
                </div>
              </div>
              <div class="mt-1 flex items-center justify-between gap-2">
                <span class="shrink-0 whitespace-nowrap text-muted-foreground">Provider account</span>
                <span class="min-w-0 truncate text-right font-medium">{{ getSelectedRouteLabel(panel) }}</span>
              </div>
            </div>
          </UiCardContent>
        </UiCard>

        <UiCard v-if="canAddPanel" class="group h-[400px] overflow-hidden border-2 border-dashed border-border/80 bg-background p-0 transition-colors hover:border-muted-foreground/45">
          <button type="button" class="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-muted-foreground transition-colors hover:bg-muted/15 hover:text-foreground/90 disabled:cursor-not-allowed disabled:opacity-50" :disabled="isAnyLoading" aria-label="Add comparison card" @click="addPanel">
            <span class="inline-flex size-10 items-center justify-center rounded-full border border-muted-foreground/30 transition-colors group-hover:border-muted-foreground/45">
              <UiIcon name="i-lucide-plus" class="size-4 transition-colors group-hover:text-foreground/80" />
            </span>
            <span class="text-sm font-medium">Add comparison</span>
          </button>
        </UiCard>
      </div>
    </template>
  </div>
  </div>
</template>
