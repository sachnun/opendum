import { MODEL_FAMILY_SORT_ORDER, categorizeModelFamily } from "../../lib/model-families";
import { compareModelEntries } from "../../lib/model-sort";
import { BY_KEY, getProviderAccountPath, getProviderLabel, type ProviderAccountKey } from "../../lib/provider-accounts";
import type { PlaygroundOptions } from "../../lib/api-types";
import {
  generateId,
  normalizeQueryParam,
  normalizeQueryEndpoint,
  normalizeQueryNumber,
  normalizeQueryBoolean,
  normalizeQueryReasoningEffort,
  normalizeQueryAdditionalParameters,
  parseAdditionalParameters,
  clampNumber,
  extractMessageText,
  extractImageUrls,
  formatDurationMs,
  mergeUsageData,
  buildResponseMetrics,
  extractErrorMessage,
  extractChatCompletionData,
  extractAnthropicCompletionData,
  extractResponsesCompletionData,
  createSseChunkProcessor,
  isSuccessfulStatus,
  getErrorMessageFromText,
  buildPlaygroundErrorMessage,
  getEndpointPath,
  buildRequestBody,
  applyRouteSelectorToRequestBody,
  adaptRequestOverridesForEndpoint,
  formatToolArguments,
} from "../../lib/playground-protocol";
import type {
  ReasoningEffort,
  PlaygroundEndpoint,
  ScenarioMessage,
  ParsedUsageData,
  ToolCallData,
  ParsedCompletionData,
  ResponseMetrics,
  PlaygroundSettings,
} from "../../lib/playground-protocol";

export function usePlayground() {









type ResponseData = { content: string; reasoning: string; toolCalls: ToolCallData[]; isLoading: boolean; error?: string; errorDetails?: string; metrics: ResponseMetrics; usedAccountId?: string | null; startedAt?: number | null };
type FetchModelResult = "success" | "error" | "aborted";
type StreamHeaderInfo = { status: number; statusText: string; getHeader: (name: string) => string | null };
type StreamProxyRequestInput = { url: string; headers: Record<string, string>; body: string; signal: AbortSignal; endpoint: PlaygroundEndpoint; onHeaders: (info: StreamHeaderInfo) => void; onChunk: (chunk: ParsedCompletionData) => void };



interface Scenario {
  id: string;
  name: string;
  icon: string;
  prompt: string;
  isReasoning: boolean;
  messages?: ScenarioMessage[];
  autoFollowUps?: string[];
  requestOverrides?: Record<string, unknown>;
}

const api = useApi();
const invalidation = useInvalidate();
const route = useRoute();

type ModelOption = PlaygroundOptions["models"][number];
type ProviderAccountOption = PlaygroundOptions["providerAccounts"][number];
type PanelState = { id: string; modelId: string | null; provider: string | null; accountId: string | null };

const DEFAULT_SETTINGS: PlaygroundSettings = {
  endpoint: "chat_completions",
  streamResponses: true,
  temperature: 1,
  topP: 1,
  maxTokens: 4096,
  presencePenalty: 0,
  frequencyPenalty: 0,
  reasoningEffort: "low",
};

const SCENARIOS: Scenario[] = [
  {
    id: "text",
    name: "Text",
    icon: "i-lucide-file-text",
    prompt: "Write a short poem about the ocean.",
    isReasoning: false,
    messages: [
      { role: "system", content: "You are a creative writing assistant. Write vivid, expressive text with a poetic tone. Keep responses concise." },
      { role: "user", content: "Write a short poem about the ocean." },
    ],
  },
  {
    id: "chat",
    name: "Chat",
    icon: "i-lucide-message-square-text",
    prompt: "Help me plan a small weekend project to learn Vue.",
    isReasoning: false,
    messages: [
      { role: "system", content: "You are a concise chat assistant. Keep each answer conversational, practical, and no longer than 3 short paragraphs." },
      { role: "user", content: "Help me plan a small weekend project to learn Vue." },
    ],
    autoFollowUps: [
      "Turn that into a 3-step weekend checklist.",
      "Wrap up with the biggest risk and one practical tip to stay on track.",
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
  { value: "max", label: "Max" },
];

const { data, error } = useCachedData(dataKeys.playgroundOptions, () => api.playground.options());
watch(data, (value) => {
  if (value && !value.hasAnyProviderAccount) void navigateTo("/", { replace: true });
}, { immediate: true });

const options = computed<PlaygroundOptions | null>(() => data.value ?? null);
const models = computed<ModelOption[]>(() => options.value?.models ?? []);
const providerAccounts = computed<ProviderAccountOption[]>(() => options.value?.providerAccounts ?? []);
const hasAnyProviderAccount = computed(() => Boolean(options.value?.hasAnyProviderAccount));
const isProxyConfigured = computed(() => Boolean(options.value?.proxyBaseUrl));
const canUsePlayground = computed(() => hasAnyProviderAccount.value && isProxyConfigured.value && providerAccounts.value.length > 0 && models.value.length > 0);

const selectedScenario = ref<Scenario>(SCENARIOS[0]!);
const settings = reactive<PlaygroundSettings>({ ...DEFAULT_SETTINGS });
const settingsOpen = ref(false);
const panels = ref<PanelState[]>([{ id: generateId(), modelId: null, provider: null, accountId: null }]);
const responses = ref<Record<string, ResponseData>>({});
const loopDialogOpen = ref(false);
const loopCountInput = ref("2");
const loopCount = ref(2);
const additionalParametersInput = ref("");
const activeLoopProgress = ref<{ current: number; total: number } | null>(null);
const activeFamilyPresets = ref<string[]>([]);
const activeProviderPresets = ref<string[]>([]);
const familyPresetExpanded = ref(false);
const providerPresetExpanded = ref(false);
const selectionOpenByPanel = reactive<Record<string, boolean>>({});
const selectionStepByPanel = reactive<Record<string, "model" | "routing">>({});
const pendingModelByPanel = reactive<Record<string, string | null>>({});
const modelSearchByPanel = reactive<Record<string, string>>({});
const routeSearchByPanel = reactive<Record<string, string>>({});
const chatMessagesByPanel = reactive<Record<string, ScenarioMessage[]>>({});
const autoScrollByPanel = reactive<Record<string, boolean>>({});
const copiedErrorByPanel = reactive<Record<string, boolean>>({});
const copyErrorTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const initializedFromRoute = ref(false);
const liveNow = ref(Date.now());

const controllers = new Map<string, AbortController>();
const requestIds = new Map<string, string>();
const stoppedBatchPanelIds = new Set<string>();
const panelScrollElements = new Map<string, HTMLElement>();
const isBatchRunActive = ref(false);
let liveTimer: ReturnType<typeof setInterval> | null = null;
let startLongPressTimer: ReturnType<typeof setTimeout> | null = null;
let accountOverviewInvalidationTimer: ReturnType<typeof setTimeout> | null = null;
let startLongPressTriggered = false;
const START_LONG_PRESS_DELAY_MS = 600;
const ACCOUNT_OVERVIEW_INVALIDATION_DELAY_MS = 500;
const AUTO_SCROLL_DISABLE_THRESHOLD = 0.05;

const filteredModels = computed(() => models.value);
const filteredModelIds = computed(() => new Set(filteredModels.value.map((model) => model.id)));
const modelsById = computed(() => new Map(models.value.map((model) => [model.id, model])));
const providerAccountsById = computed(() => new Map(providerAccounts.value.map((account) => [account.id, account])));
const familyPresets = computed(() => buildFamilyPresets(filteredModels.value, providerAccounts.value));
const providerPresets = computed(() => buildProviderPresets(filteredModels.value, providerAccounts.value));
const activePresetModelIds = computed(() => {
  if (activeFamilyPresets.value.length > 0) {
    const ids = new Set<string>();
    for (const preset of familyPresets.value) {
      if (!activeFamilyPresets.value.includes(preset.family)) continue;
      for (const model of preset.models) ids.add(model.id);
    }
    return ids;
  }

  if (activeProviderPresets.value.length === 0) return null;
  const ids = new Set<string>();
  for (const preset of providerPresets.value) {
    if (!activeProviderPresets.value.includes(preset.provider)) continue;
    for (const model of preset.models) ids.add(model.id);
  }
  return ids;
});
const maxPanels = computed(() => Math.max(filteredModels.value.length, providerPresets.value.reduce((total, preset) => total + preset.panels.length, 0), 1));
const canAddPanel = computed(() => panels.value.length < maxPanels.value);
const hasSelectedModel = computed(() => panels.value.some((panel) => panel.modelId));
const isAnyLoading = computed(() => Object.values(responses.value).some((response) => response.isLoading));
const isTopPDeprecated = computed(() =>
  panels.value.some((panel) => {
    if (!panel.modelId) return false;
    const model = modelsById.value.get(panel.modelId);
    if (!model?.topPDeprecatedProviders) return false;
    const provider = panel.accountId
      ? providerAccountsById.value.get(panel.accountId)?.provider
      : panel.provider;
    return Boolean(provider && model.topPDeprecatedProviders.includes(provider));
  }),
);
const additionalParametersError = computed(() => parseAdditionalParameters(additionalParametersInput.value).error);
const canRunPlayground = computed(() => Boolean(selectedScenario.value && hasSelectedModel.value && canUsePlayground.value && !additionalParametersError.value));
const playgroundSetupMessage = computed(() => {
  if (!hasAnyProviderAccount.value) return "Connect a provider account before running Playground.";
  if (!isProxyConfigured.value) return "Set NUXT_PUBLIC_PROXY_URL to your proxy service URL before running Playground.";
  if (providerAccounts.value.length === 0) return "Enable at least one provider account before running Playground.";
  if (models.value.length === 0) return "";
  return "";
});
const parsedLoopCount = computed(() => Number(loopCountInput.value));
const isLoopCountValid = computed(() => Number.isInteger(parsedLoopCount.value) && parsedLoopCount.value >= 1);
const activeLoopBadgeLabel = computed(() => activeLoopProgress.value && activeLoopProgress.value.total > 1 ? `${activeLoopProgress.value.current}/${activeLoopProgress.value.total}` : null);
const scenarioMessages = computed(() => getScenarioMessages(selectedScenario.value));
const isChatScenario = computed(() => selectedScenario.value.id === "chat");
const isVisionScenario = computed(() => selectedScenario.value.id === "vision");

watch(options, (value) => {
  if (value && !value.hasAnyProviderAccount) void navigateTo("/", { replace: true });
});

watch(options, (value) => {
  if (!value || initializedFromRoute.value) return;

  applyQuerySettings(route.query);
  const modelId = normalizeQueryParam(route.query.model);
  const accountId = normalizeQueryParam(route.query.accountId);
  const compareAuto = isAutoCompareQuery(route.query.compare);

  if (modelId) {
    const model = modelsById.value.get(modelId);
    if (compareAuto && model) {
      panels.value = buildAutoComparePanelsForModel(model);
      initializedFromRoute.value = true;
      return;
    }

    if (model) {
      panels.value = [{ id: generateId(), modelId, provider: null, accountId: getValidRouteAccountId(accountId, modelId) }];
      initializedFromRoute.value = true;
      return;
    }
  }

  if (accountId) {
    const account = providerAccountsById.value.get(accountId);
    if (account) {
      const compatibleModels = models.value.filter((model) => accountSupportsModel(account, model));
      panels.value = compatibleModels.length > 0
        ? compatibleModels.map((model) => ({ id: generateId(), modelId: model.id, provider: null, accountId }))
        : [{ id: generateId(), modelId: null, provider: null, accountId }];
      initializedFromRoute.value = true;
      return;
    }
  }

  initializedFromRoute.value = true;
}, { immediate: true });

watch(() => route.query, (query) => {
  if (!initializedFromRoute.value) return;
  if (!options.value) return;

  applyQuerySettings(query);
  const modelId = normalizeQueryParam(query.model);
  const accountId = normalizeQueryParam(query.accountId);
  const compareAuto = isAutoCompareQuery(query.compare);

  if (modelId) {
    const model = modelsById.value.get(modelId);
    if (compareAuto && model) {
      panels.value = buildAutoComparePanelsForModel(model);
      responses.value = {};
      return;
    }

    if (model) {
      panels.value = [{ id: generateId(), modelId, provider: null, accountId: getValidRouteAccountId(accountId, modelId) }];
      responses.value = {};
      return;
    }
  }

  if (accountId) {
    const account = providerAccountsById.value.get(accountId);
    if (account) {
      const compatibleModels = models.value.filter((m) => accountSupportsModel(account, m));
      panels.value = compatibleModels.length > 0
        ? compatibleModels.map((m) => ({ id: generateId(), modelId: m.id, provider: null, accountId }))
        : [{ id: generateId(), modelId: null, provider: null, accountId }];
      responses.value = {};
      return;
    }
  }
});

watch([filteredModelIds, familyPresets, providerPresets], ([availableIds]) => {
  panels.value = panels.value.map((panel) => panel.modelId && !availableIds.has(panel.modelId) ? { ...panel, modelId: null, provider: null, accountId: null } : panel);

  activeFamilyPresets.value = activeFamilyPresets.value.filter((family) => familyPresets.value.some((preset) => preset.family === family));
  activeProviderPresets.value = activeProviderPresets.value.filter((provider) => providerPresets.value.some((preset) => preset.provider === provider));
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

onMounted(() => {
  providerPresetExpanded.value = true;
  if (window.matchMedia("(min-width: 640px)").matches) {
    familyPresetExpanded.value = true;
  }
});

onBeforeUnmount(() => {
  stopAllRequests();
  if (liveTimer) clearInterval(liveTimer);
  if (startLongPressTimer) clearTimeout(startLongPressTimer);
  if (accountOverviewInvalidationTimer) clearTimeout(accountOverviewInvalidationTimer);
  for (const timeout of copyErrorTimeouts.values()) clearTimeout(timeout);
  copyErrorTimeouts.clear();
});



















function applyQuerySettings(query: typeof route.query) {
  const endpoint = normalizeQueryEndpoint(query.endpoint);
  const streamResponses = normalizeQueryBoolean(query.stream);
  const temperature = normalizeQueryNumber(query.temperature);
  const topP = normalizeQueryNumber(query.top_p);
  const maxTokens = normalizeQueryNumber(query.max_tokens);
  const presencePenalty = normalizeQueryNumber(query.presence_penalty);
  const frequencyPenalty = normalizeQueryNumber(query.frequency_penalty);
  const reasoningEffort = normalizeQueryReasoningEffort(query.reasoning_effort);
  const additionalParameters = normalizeQueryAdditionalParameters(query.additional_parameters);

  if (endpoint) settings.endpoint = endpoint;
  if (streamResponses !== null) settings.streamResponses = streamResponses;
  if (temperature !== null) settings.temperature = clampNumber(temperature, 0, 2);
  if (topP !== null) settings.topP = clampNumber(topP, 0, 1);
  if (maxTokens !== null) settings.maxTokens = Math.round(clampNumber(maxTokens, 1, 128000));
  if (presencePenalty !== null) settings.presencePenalty = clampNumber(presencePenalty, -2, 2);
  if (frequencyPenalty !== null) settings.frequencyPenalty = clampNumber(frequencyPenalty, -2, 2);
  if (reasoningEffort) settings.reasoningEffort = reasoningEffort;
  if (additionalParameters !== null) additionalParametersInput.value = additionalParameters;
}

function accountSupportsModel(account: ProviderAccountOption, model: ModelOption | string): boolean {
  const modelId = typeof model === "string" ? model : model.id;
  const modelOption = typeof model === "string" ? modelsById.value.get(model) : model;
  if (!modelOption?.providers.includes(account.provider)) return false;
  if (account.disabledModels?.includes(modelId)) return false;
  return !account.supportedModels || account.supportedModels.includes(modelId);
}

function providerSupportsModel(provider: string | null, model: ModelOption | string): boolean {
  if (!provider) return false;
  const modelOption = typeof model === "string" ? modelsById.value.get(model) : model;
  if (!modelOption?.providers.includes(provider)) return false;
  return providerAccounts.value.some((account) => account.provider === provider && accountSupportsModel(account, modelOption));
}

function getValidRouteAccountId(accountId: string | null, modelId: string): string | null {
  const account = accountId ? providerAccountsById.value.get(accountId) : null;
  return account && accountSupportsModel(account, modelId) ? account.id : null;
}

function getValidProviderForPanel(panel: PanelState): string | null {
  if (!panel.provider || !panel.modelId || panel.accountId) return null;
  return providerSupportsModel(panel.provider, panel.modelId) ? panel.provider : null;
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
    familyModels.sort(compareModelEntries);
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

function buildProviderPresets(modelOptions: ModelOption[], accounts: ProviderAccountOption[]) {
  const accountsByProvider = new Map<string, ProviderAccountOption[]>();
  for (const account of accounts) {
    accountsByProvider.set(account.provider, [...(accountsByProvider.get(account.provider) ?? []), account]);
  }

  return Array.from(accountsByProvider.entries()).flatMap(([provider, providerAccountsForProvider]) => {
    const modelsForProvider = modelOptions.filter((model) => model.providers.includes(provider) && providerAccountsForProvider.some((account) => accountSupportsModel(account, model)));
    const presetPanels = modelsForProvider.map((model) => ({ modelId: model.id, provider, accountId: null }));

    return presetPanels.length > 0 ? [{ provider, accounts: providerAccountsForProvider, models: modelsForProvider, panels: presetPanels }] : [];
  });
}

function buildAutoComparePanelsForModel(model: ModelOption): PanelState[] {
  const supportedProviders = model.providers.filter((provider) => providerSupportsModel(provider, model));
  return [
    { id: generateId(), modelId: model.id, provider: null, accountId: null },
    ...supportedProviders.map((provider) => ({ id: generateId(), modelId: model.id, provider, accountId: null })),
  ];
}

function isAutoCompareQuery(value: unknown): boolean {
  return normalizeQueryParam(value)?.trim().toLowerCase() === "auto";
}

function getAccountLabel(account: ProviderAccountOption): string {
  const name = account.name.trim();
  const email = account.email?.trim();
  if (!email) return name;
  if (!name || name.toLowerCase() === email.toLowerCase()) return email;
  return `${name} (${email})`;
}

function getAccountPlaygroundStatus(account: ProviderAccountOption): string | null {
  if (!account.isActive) return "Off";
  if (!account.disabledUntil) return null;

  const disabledUntil = account.disabledUntil instanceof Date ? account.disabledUntil : new Date(account.disabledUntil);
  if (Number.isNaN(disabledUntil.getTime()) || disabledUntil <= new Date(liveNow.value)) return null;
  return "Disabled";
}

function isAuthlessAccount(account: ProviderAccountOption): boolean {
  return account.id === account.provider || account.id.startsWith("authless:");
}

function getProviderPresetAccountLabel(accounts: ProviderAccountOption[]): string | null {
  if (accounts.every(isAuthlessAccount)) return null;
  return `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`;
}

function getProviderScopedRouteLabel(provider: string): string {
  return `Auto (${getProviderLabel(provider)})`;
}

function getPendingModelProviders(panel: PanelState): string[] {
  const pendingModelId = pendingModelByPanel[panel.id];
  const pendingModel = pendingModelId ? modelsById.value.get(pendingModelId) : null;
  if (!pendingModel) return [];

  const routeSearch = routeSearchByPanel[panel.id]?.trim().toLowerCase();
  return pendingModel.providers
    .filter((provider) => providerSupportsModel(provider, pendingModel))
    .filter((provider) => !routeSearch || `${provider} ${getProviderLabel(provider)}`.toLowerCase().includes(routeSearch));
}

function getValidAccountIdForPanel(panel: PanelState): string | null {
  if (!panel.accountId || !panel.modelId) return null;
  const model = modelsById.value.get(panel.modelId);
  const account = providerAccountsById.value.get(panel.accountId);
  if (!model || !account || !accountSupportsModel(account, model)) return null;
  return account.id;
}

function getSelectedRouteLabel(panel: PanelState): string {
  const selectedAccountId = getValidAccountIdForPanel(panel);
  const selectedAccount = selectedAccountId ? providerAccountsById.value.get(selectedAccountId) : null;
  const selectedProvider = getValidProviderForPanel(panel);
  const response = responses.value[panel.id];
  const usedAccount = response?.usedAccountId ? providerAccountsById.value.get(response.usedAccountId) : null;

  if (selectedAccount) return `${getAccountLabel(selectedAccount)} (${getProviderLabel(selectedAccount.provider)})`;
  if (selectedProvider) return usedAccount ? `Auto (${getAccountLabel(usedAccount)} - ${getProviderLabel(usedAccount.provider)})` : getProviderScopedRouteLabel(selectedProvider);
  if (panel.modelId) return usedAccount ? `Auto (${getAccountLabel(usedAccount)} - ${getProviderLabel(usedAccount.provider)})` : "Auto (load balancer)";
  return "-";
}

function getPanelProviderAccount(panel: PanelState): ProviderAccountOption | null {
  const selectedAccountId = getValidAccountIdForPanel(panel);
  if (selectedAccountId) return providerAccountsById.value.get(selectedAccountId) ?? null;

  const usedAccountId = responses.value[panel.id]?.usedAccountId;
  return usedAccountId ? providerAccountsById.value.get(usedAccountId) ?? null : null;
}

function getProviderAccountHref(account: ProviderAccountOption): string | null {
  if (!(account.provider in BY_KEY)) return null;
  return `${getProviderAccountPath(account.provider as ProviderAccountKey)}#${encodeURIComponent(account.id)}`;
}

function getPanelProviderAccountHref(panel: PanelState): string | null {
  const account = getPanelProviderAccount(panel);
  return account ? getProviderAccountHref(account) : null;
}

function getPanelModels(panel: PanelState): ModelOption[] {
  let nextModels = activePresetModelIds.value ? filteredModels.value.filter((model) => activePresetModelIds.value?.has(model.id)) : filteredModels.value;
  const account = panel.accountId ? providerAccountsById.value.get(panel.accountId) : null;
  const provider = panel.accountId ? null : panel.provider;

  if (account?.disabledModels?.length) {
    const disabled = new Set(account.disabledModels);
    nextModels = nextModels.filter((model) => !disabled.has(model.id));
  }

  if (account?.supportedModels) {
    const supported = new Set(account.supportedModels);
    nextModels = nextModels.filter((model) => supported.has(model.id));
  }

  if (provider) {
    nextModels = nextModels.filter((model) => providerSupportsModel(provider, model));
  }

  const search = modelSearchByPanel[panel.id]?.trim().toLowerCase();
  if (!search) return nextModels;
  return nextModels.filter((model) => `${model.name} ${model.providers.join(" ")}`.toLowerCase().includes(search));
}

function hasVisionMetadata(model: ModelOption | undefined): boolean {
  if (!model?.modalities) return false;
  return model.modalities.input.includes("image");
}

function shouldShowVisionWarning(model: ModelOption | undefined): boolean {
  return Boolean(isVisionScenario.value && model && !hasVisionMetadata(model));
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
    .map(([family, familyModels]) => ({ family, models: familyModels.sort(compareModelEntries) }));
}

function getPendingModelAccounts(panel: PanelState): ProviderAccountOption[] {
  const pendingModelId = pendingModelByPanel[panel.id];
  const pendingModel = pendingModelId ? modelsById.value.get(pendingModelId) : null;
  if (!pendingModel) return [];

  const routeSearch = routeSearchByPanel[panel.id]?.trim().toLowerCase();
  const providerOrder = new Map(pendingModel.providers.map((provider, index) => [provider, index]));
  return providerAccounts.value
    .filter((account) => accountSupportsModel(account, pendingModel))
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

function selectPanelRoute(panel: PanelState, route: { provider: string | null; accountId: string | null }) {
  const modelId = pendingModelByPanel[panel.id];
  if (!modelId) return;

  panels.value = panels.value.map((item) => item.id === panel.id ? { ...item, modelId, provider: route.accountId ? null : route.provider, accountId: route.accountId } : item);
  selectionOpenByPanel[panel.id] = false;
  selectionStepByPanel[panel.id] = "model";
  pendingModelByPanel[panel.id] = null;
  modelSearchByPanel[panel.id] = "";
  routeSearchByPanel[panel.id] = "";
}

function addPanel() {
  if (!canAddPanel.value) return;
  panels.value = [...panels.value, { id: generateId(), modelId: null, provider: null, accountId: null }];
}

function removePanel(panelId: string) {
  stopPanelRequest(panelId);
  panelScrollElements.delete(panelId);
  Reflect.deleteProperty(autoScrollByPanel, panelId);
  Reflect.deleteProperty(chatMessagesByPanel, panelId);
  Reflect.deleteProperty(copiedErrorByPanel, panelId);
  const timeout = copyErrorTimeouts.get(panelId);
  if (timeout) {
    clearTimeout(timeout);
    copyErrorTimeouts.delete(panelId);
  }
  panels.value = panels.value.filter((panel) => panel.id !== panelId);
  const nextResponses = { ...responses.value };
  Reflect.deleteProperty(nextResponses, panelId);
  responses.value = nextResponses;
}

function applyFamilyPresets(families: string[]) {
  const accountByModel = new Map<string, string>();
  for (const panel of panels.value) {
    if (panel.modelId && panel.accountId && getValidAccountIdForPanel(panel)) {
      accountByModel.set(panel.modelId, panel.accountId);
    }
  }

  const selected = familyPresets.value.filter((preset) => families.includes(preset.family));
  const nextModels = selected.flatMap((preset) => preset.models);
  panels.value = nextModels.length > 0
    ? nextModels.map((model) => ({ id: generateId(), modelId: model.id, provider: null, accountId: accountByModel.get(model.id) ?? null }))
    : [{ id: generateId(), modelId: null, provider: null, accountId: null }];
  responses.value = {};
}

function applyProviderPresets(providers: string[]) {
  const selected = providerPresets.value.filter((preset) => providers.includes(preset.provider));
  const nextPanels = selected.flatMap((preset) => preset.panels);
  panels.value = nextPanels.length > 0
    ? nextPanels.map((panel) => ({ id: generateId(), modelId: panel.modelId, provider: panel.provider, accountId: panel.accountId }))
    : [{ id: generateId(), modelId: null, provider: null, accountId: null }];
  responses.value = {};
}

function applyFamilyPreset(family: string) {
  if (!familyPresets.value.some((item) => item.family === family)) return;

  const nextFamilies = activeFamilyPresets.value.includes(family)
    ? activeFamilyPresets.value.filter((item) => item !== family)
    : [...activeFamilyPresets.value, family];

  activeFamilyPresets.value = nextFamilies;
  activeProviderPresets.value = [];
  applyFamilyPresets(nextFamilies);
}

function applyProviderPreset(provider: string) {
  if (!providerPresets.value.some((item) => item.provider === provider)) return;

  const nextProviders = activeProviderPresets.value.includes(provider)
    ? activeProviderPresets.value.filter((item) => item !== provider)
    : [...activeProviderPresets.value, provider];

  activeProviderPresets.value = nextProviders;
  activeFamilyPresets.value = [];
  applyProviderPresets(nextProviders);
}

function selectScenario(scenario: Scenario) {
  selectedScenario.value = scenario;
  responses.value = {};
  resetChatMessages();
  if (scenario.isReasoning && settings.reasoningEffort === "none") {
    settings.reasoningEffort = "medium";
  }
}

function resetSettings() {
  Object.assign(settings, DEFAULT_SETTINGS);
  additionalParametersInput.value = "";
}

function resetChatMessages() {
  for (const panelId of Object.keys(chatMessagesByPanel)) {
    Reflect.deleteProperty(chatMessagesByPanel, panelId);
  }
}

function getScenarioMessages(scenario: Scenario): ScenarioMessage[] {
  return scenario.messages?.length ? scenario.messages : [{ role: "user", content: scenario.prompt }];
}

function getPanelScenarioMessages(panelId: string, scenario: Scenario): ScenarioMessage[] {
  return scenario.id === "chat" && chatMessagesByPanel[panelId]?.length ? chatMessagesByPanel[panelId] : getScenarioMessages(scenario);
}

function getScenarioConversationMessages(panelId: string): ScenarioMessage[] {
  const scenario = selectedScenario.value;
  return scenario?.id === "chat" && chatMessagesByPanel[panelId]?.length ? chatMessagesByPanel[panelId] : scenarioMessages.value;
}

function getPanelSystemPromptText(panelId: string): string {
  return getScenarioConversationMessages(panelId).filter((message) => message.role === "system").map((message) => extractMessageText(message.content)).filter(Boolean).join("\n\n");
}

function getPanelUserScenarioMessages(panelId: string): ScenarioMessage[] {
  return getScenarioConversationMessages(panelId).filter((message) => message.role !== "system");
}









function getPanelWaitLabel(panelId: string): string {
  const response = responses.value[panelId];
  if (response?.isLoading && response.startedAt) return formatDurationMs(liveNow.value - response.startedAt);
  return formatDurationMs(response?.metrics.waitMs);
}

function setPanelScrollElement(panelId: string, element: unknown) {
  if (element instanceof HTMLElement) {
    panelScrollElements.set(panelId, element);
    return;
  }

  panelScrollElements.delete(panelId);
}

function scrollPanelToBottom(panelId: string) {
  if (!autoScrollByPanel[panelId]) return;
  nextTick(() => {
    const element = panelScrollElements.get(panelId);
    const response = responses.value[panelId];
    if (!element || !response?.isLoading || !autoScrollByPanel[panelId]) return;
    element.scrollTop = element.scrollHeight;
  });
}

function handlePanelScroll(panelId: string, event: Event) {
  const element = event.currentTarget;
  if (!(element instanceof HTMLElement)) return;

  const response = responses.value[panelId];
  if (!response?.isLoading) return;

  const scrollableDistance = Math.max(element.scrollHeight - element.clientHeight, 0);
  if (scrollableDistance === 0) return;

  const distanceFromBottom = scrollableDistance - element.scrollTop;
  autoScrollByPanel[panelId] = distanceFromBottom / scrollableDistance <= AUTO_SCROLL_DISABLE_THRESHOLD;
}






















































function streamProxyRequest(input: StreamProxyRequestInput): Promise<void> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    let processedLength = 0;
    let headersHandled = false;
    let settled = false;
    const processor = createSseChunkProcessor(input.endpoint, input.onChunk);

    const cleanup = () => {
      input.signal.removeEventListener("abort", abortRequest);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleHeaders = () => {
      if (headersHandled || xhr.readyState < XMLHttpRequest.HEADERS_RECEIVED) return;
      headersHandled = true;
      input.onHeaders({ status: xhr.status, statusText: xhr.statusText, getHeader: (name) => xhr.getResponseHeader(name) });
    };
    const processResponseText = () => {
      const text = xhr.responseText || "";
      if (text.length <= processedLength) return;
      const chunk = text.slice(processedLength);
      processedLength = text.length;
      processor.feed(chunk);
    };
    function abortRequest() {
      xhr.abort();
    }

    xhr.onreadystatechange = () => {
      handleHeaders();
      if (xhr.readyState === XMLHttpRequest.LOADING && isSuccessfulStatus(xhr.status)) processResponseText();
    };
    xhr.onprogress = () => {
      handleHeaders();
      if (isSuccessfulStatus(xhr.status)) processResponseText();
    };
    xhr.onload = () => {
      handleHeaders();
      if (!isSuccessfulStatus(xhr.status)) {
        settle(() => reject(new Error(getErrorMessageFromText(xhr.responseText || ""))));
        return;
      }
      processResponseText();
      processor.flush();
      settle(resolve);
    };
    xhr.onerror = () => settle(() => reject(new Error("Network error")));
    xhr.ontimeout = () => settle(() => reject(new Error("Request timed out")));
    xhr.onabort = () => settle(() => reject(new DOMException("Aborted", "AbortError")));

    input.signal.addEventListener("abort", abortRequest, { once: true });
    try {
      xhr.open("POST", input.url, true);
      for (const [name, value] of Object.entries(input.headers)) {
        xhr.setRequestHeader(name, value);
      }
      xhr.send(input.body);
    } catch (error) {
      settle(() => reject(error));
    }
  });
}



function getProxyBaseUrl(): string {
  const proxyBaseUrl = options.value?.proxyBaseUrl?.trim().replace(/\/+$/, "");
  if (!proxyBaseUrl) throw new Error("Proxy URL is not configured");
  return proxyBaseUrl;
}

















function setResponse(panelId: string, response: ResponseData) {
  responses.value = { ...responses.value, [panelId]: response };
  if (response.isLoading) scrollPanelToBottom(panelId);
}

function setResponseIfCurrent(panelId: string, requestId: string, response: ResponseData) {
  if (requestIds.get(panelId) !== requestId) return;
  setResponse(panelId, response);
}

function refreshAccountOverview() {
  if (accountOverviewInvalidationTimer) clearTimeout(accountOverviewInvalidationTimer);
  accountOverviewInvalidationTimer = setTimeout(() => {
    accountOverviewInvalidationTimer = null;
    void invalidation.invalidateAccountOverview();
  }, ACCOUNT_OVERVIEW_INVALIDATION_DELAY_MS);
}

async function runChatScenarioForPanel(panel: PanelState & { modelId: string }, scenario: Scenario, currentSettings: PlaygroundSettings): Promise<FetchModelResult> {
  const messages = [...getScenarioMessages(scenario)];
  chatMessagesByPanel[panel.id] = messages;

  const followUps = scenario.autoFollowUps ?? [];
  for (let step = 0; step <= followUps.length; step += 1) {
    if (!isBatchRunActive.value || stoppedBatchPanelIds.has(panel.id)) return "aborted";

    const result = await fetchFromModel(panel.id, panel.modelId, scenario, currentSettings, getValidProviderForPanel(panel), getValidAccountIdForPanel(panel), messages);
    if (result !== "success") return result;

    const response = responses.value[panel.id];
    const assistantContent = response?.content?.trim();
    if (!assistantContent) return "success";

    messages.push({ role: "assistant", content: assistantContent });
    chatMessagesByPanel[panel.id] = [...messages];

    const followUp = followUps[step];
    if (!followUp) return "success";

    messages.push({ role: "user", content: followUp });
    chatMessagesByPanel[panel.id] = [...messages];
  }

  return "success";
}

async function fetchFromModel(panelId: string, modelId: string, scenario: Scenario, currentSettings: PlaygroundSettings, provider: string | null, accountId: string | null, messages = getPanelScenarioMessages(panelId, scenario)): Promise<FetchModelResult> {
  const requestStartedAt = Date.now();
  const requestId = generateId();
  let waitMs: number | null = null;
  let usedAccountId: string | null = null;
  let shouldRefreshAccountOverview = false;
  let errorContextParameters: Record<string, unknown> | null = null;

  controllers.get(panelId)?.abort();
  requestIds.set(panelId, requestId);
  autoScrollByPanel[panelId] = true;
  setResponse(panelId, { content: "", reasoning: "", toolCalls: [], isLoading: true, metrics: buildResponseMetrics(null, null, null), startedAt: requestStartedAt });

  try {
    const requestBody = buildRequestBody(modelId, messages, currentSettings);
    errorContextParameters = requestBody;
    const endpointOverrides = adaptRequestOverridesForEndpoint(scenario.requestOverrides, currentSettings.endpoint);
    if (endpointOverrides) Object.assign(requestBody, endpointOverrides);
    const additionalParameters = parseAdditionalParameters(additionalParametersInput.value);
    if (additionalParameters.error) throw new Error(`Invalid additional parameters: ${additionalParameters.error}`);
    if (additionalParameters.params) Object.assign(requestBody, additionalParameters.params);
    applyRouteSelectorToRequestBody(requestBody, provider, accountId);
    if (!canUsePlayground.value) throw new Error(playgroundSetupMessage.value || "Playground is not ready.");

    const controller = new AbortController();
    controllers.set(panelId, controller);
    const auth = await api.playground.auth({ endpoint: currentSettings.endpoint });
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");

    const url = `${getProxyBaseUrl()}${getEndpointPath(currentSettings.endpoint)}`;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...auth.headers,
    };
    const body = JSON.stringify(requestBody);

    if (requestBody.stream !== false) {
      let streamedContent = "";
      let streamedReasoning = "";
      let streamedToolCalls: ToolCallData[] = [];
      let firstResponseMs: number | null = null;
      let usage: ParsedUsageData | null = null;

      await streamProxyRequest({
        url,
        headers,
        body,
        signal: controller.signal,
        endpoint: currentSettings.endpoint,
        onHeaders: (info) => {
          waitMs = Date.now() - requestStartedAt;
          usedAccountId = info.getHeader("x-provider-account-id");
          shouldRefreshAccountOverview = true;
        },
        onChunk: (chunk) => {
          firstResponseMs ??= Date.now() - requestStartedAt;
          streamedContent += chunk.content;
          streamedReasoning += chunk.reasoning;
          streamedToolCalls = chunk.toolCalls.length > 0 ? [...streamedToolCalls, ...chunk.toolCalls] : streamedToolCalls;
          usage = mergeUsageData(usage, chunk.usage);
          setResponseIfCurrent(panelId, requestId, { content: streamedContent, reasoning: streamedReasoning, toolCalls: streamedToolCalls, isLoading: true, metrics: buildResponseMetrics(waitMs, firstResponseMs, usage), usedAccountId, startedAt: requestStartedAt });
        },
      });

      setResponseIfCurrent(panelId, requestId, { content: streamedContent, reasoning: streamedReasoning, toolCalls: streamedToolCalls, isLoading: false, metrics: buildResponseMetrics(waitMs, firstResponseMs, usage), usedAccountId });
      return "success";
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body,
    });

    waitMs = Date.now() - requestStartedAt;
    usedAccountId = response.headers.get("x-provider-account-id");
    shouldRefreshAccountOverview = true;

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

    const payload = await response.json();
    const parsed = currentSettings.endpoint === "messages" ? extractAnthropicCompletionData(payload) : currentSettings.endpoint === "responses" ? extractResponsesCompletionData(payload) : extractChatCompletionData(payload);
    setResponseIfCurrent(panelId, requestId, { content: parsed.content, reasoning: parsed.reasoning, toolCalls: parsed.toolCalls, isLoading: false, metrics: buildResponseMetrics(waitMs, Date.now() - requestStartedAt, parsed.usage), usedAccountId });
    return "success";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      const existing = responses.value[panelId];
      if (existing && requestIds.get(panelId) === requestId) setResponse(panelId, { ...existing, isLoading: false, error: undefined });
      return "aborted";
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const providerByAccount = accountId ? providerAccountsById.value.get(accountId)?.provider ?? null : null;
    const providerByUsedAccount = usedAccountId ? providerAccountsById.value.get(usedAccountId)?.provider ?? null : null;
    const errorProvider = provider ?? providerByAccount ?? providerByUsedAccount ?? null;
    const errorDetails = buildPlaygroundErrorMessage(errorMessage, { model: modelId, provider: errorProvider, endpoint: currentSettings.endpoint, parameters: errorContextParameters, messages });
    setResponseIfCurrent(panelId, requestId, { content: "", reasoning: "", toolCalls: [], isLoading: false, error: errorMessage, errorDetails, metrics: buildResponseMetrics(waitMs, null, null), usedAccountId });
    return "error";
  } finally {
    if (requestIds.get(panelId) === requestId) {
      controllers.delete(panelId);
      requestIds.delete(panelId);
    }
    if (shouldRefreshAccountOverview) refreshAccountOverview();
  }
}

async function runSelectedScenario(requestedLoopCount = 1) {
  if (!selectedScenario.value || !canRunPlayground.value) return;
  const scenario = selectedScenario.value;
  resetChatMessages();
  let currentSettings = { ...settings };
  if (scenario.isReasoning && currentSettings.reasoningEffort === "none") {
    settings.reasoningEffort = "medium";
    currentSettings = { ...settings };
  }

  const panelsWithModels = panels.value.filter((panel): panel is PanelState & { modelId: string } => Boolean(panel.modelId));
  if (panelsWithModels.length === 0) return;

  const totalLoops = Math.max(1, Math.floor(requestedLoopCount));
  activeLoopProgress.value = totalLoops > 1 ? { current: 1, total: totalLoops } : null;
  stoppedBatchPanelIds.clear();
  isBatchRunActive.value = true;

  try {
    await Promise.all(panelsWithModels.map(async (panel) => {
      for (let iteration = 0; iteration < totalLoops; iteration += 1) {
        if (!isBatchRunActive.value || stoppedBatchPanelIds.has(panel.id)) break;
        activeLoopProgress.value = totalLoops > 1 ? { current: iteration + 1, total: totalLoops } : null;

        const result = scenario.id === "chat"
          ? await runChatScenarioForPanel(panel, scenario, currentSettings)
          : await fetchFromModel(panel.id, panel.modelId, scenario, currentSettings, getValidProviderForPanel(panel), getValidAccountIdForPanel(panel));
        if (result !== "success") {
          stoppedBatchPanelIds.add(panel.id);
          break;
        }
      }
    }));
  } finally {
    activeLoopProgress.value = null;
    stoppedBatchPanelIds.clear();
    isBatchRunActive.value = false;
  }
}

function stopPanelRequest(panelId: string) {
  controllers.get(panelId)?.abort();
  controllers.delete(panelId);
  requestIds.delete(panelId);
  stoppedBatchPanelIds.add(panelId);

  const response = responses.value[panelId];
  if (response?.isLoading) setResponse(panelId, { ...response, isLoading: false, error: undefined });
}

function stopAllRequests() {
  for (const panelId of Array.from(controllers.keys())) {
    stopPanelRequest(panelId);
  }
  isBatchRunActive.value = false;
  activeLoopProgress.value = null;
}

async function retryPanel(panelId: string) {
  const panel = panels.value.find((item) => item.id === panelId);
  if (!panel?.modelId || !selectedScenario.value || !canRunPlayground.value) return;
  const wasBatchRunActive = isBatchRunActive.value;
  if (wasBatchRunActive) stoppedBatchPanelIds.add(panelId);
  if (selectedScenario.value.id === "chat") {
    isBatchRunActive.value = true;
    stoppedBatchPanelIds.delete(panel.id);
    try {
      await runChatScenarioForPanel(panel as PanelState & { modelId: string }, selectedScenario.value, { ...settings });
    } finally {
      isBatchRunActive.value = wasBatchRunActive;
    }
    return;
  }
  await fetchFromModel(panel.id, panel.modelId, selectedScenario.value, { ...settings }, getValidProviderForPanel(panel), getValidAccountIdForPanel(panel));
}

function handleStartPointerDown(event: PointerEvent) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  document.getSelection()?.removeAllRanges();
  if (startLongPressTimer) clearTimeout(startLongPressTimer);
  startLongPressTriggered = false;
  startLongPressTimer = setTimeout(() => {
    startLongPressTriggered = true;
    document.getSelection()?.removeAllRanges();
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



async function copyPanelError(panelId: string) {
  const response = responses.value[panelId];
  const error = response?.error;
  if (!error) return;

  try {
    await navigator.clipboard.writeText(response.errorDetails ?? error);
    copiedErrorByPanel[panelId] = true;
    const existingTimeout = copyErrorTimeouts.get(panelId);
    if (existingTimeout) clearTimeout(existingTimeout);
    copyErrorTimeouts.set(panelId, setTimeout(() => {
      copiedErrorByPanel[panelId] = false;
      copyErrorTimeouts.delete(panelId);
    }, 1800));
  } catch {
    console.error("Failed to copy error");
  }
}

  return {
    SCENARIOS,
    ENDPOINT_OPTIONS,
    REASONING_OPTIONS,
    models,
    selectedScenario,
    settings,
    settingsOpen,
    panels,
    responses,
    loopDialogOpen,
    loopCountInput,
    additionalParametersInput,
    activeFamilyPresets,
    activeProviderPresets,
    familyPresetExpanded,
    providerPresetExpanded,
    selectionOpenByPanel,
    selectionStepByPanel,
    pendingModelByPanel,
    modelSearchByPanel,
    routeSearchByPanel,
    copiedErrorByPanel,
    modelsById,
    providerAccountsById,
    familyPresets,
    providerPresets,
    canAddPanel,
    isAnyLoading,
    isTopPDeprecated,
    additionalParametersError,
    canRunPlayground,
    isLoopCountValid,
    activeLoopBadgeLabel,
    isChatScenario,
    getValidProviderForPanel,
    getAccountLabel,
    getAccountPlaygroundStatus,
    getProviderPresetAccountLabel,
    getProviderScopedRouteLabel,
    getPendingModelProviders,
    getValidAccountIdForPanel,
    getSelectedRouteLabel,
    getPanelProviderAccountHref,
    shouldShowVisionWarning,
    getGroupedPanelModels,
    getPendingModelAccounts,
    openPanelPicker,
    setModelSearch,
    setRouteSearch,
    selectPendingModel,
    selectPanelRoute,
    addPanel,
    removePanel,
    applyFamilyPreset,
    applyProviderPreset,
    selectScenario,
    resetSettings,
    getScenarioConversationMessages,
    getPanelSystemPromptText,
    getPanelUserScenarioMessages,
    getPanelWaitLabel,
    setPanelScrollElement,
    handlePanelScroll,
    stopPanelRequest,
    stopAllRequests,
    retryPanel,
    handleStartPointerDown,
    handleStartPointerEnd,
    handleStartClick,
    runLoop,
    copyPanelError,
    error,
    getProviderLabel,
    extractMessageText,
    extractImageUrls,
    formatToolArguments,
  };
}
