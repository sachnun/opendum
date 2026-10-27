import { Effect } from "effect";
import { Result } from "effect";
import { deferred, raise, settle } from "~~/lib/settle";
import { SORT_ORDER, categorize } from "@opendum/models/ranking";
import { compareEntries } from "@opendum/models/sort";
import { BY_KEY, accountPath, labelOf, type ProviderAccountKey } from "@opendum/providers/provider-accounts";
import type { PlaygroundOptions } from "~~/lib/api-types";
import {
  Body,
  Completion,
  Content,
  Duration,
  ErrorText,
  Ids,
  Params,
  Query,
  Sse,
  Tokens,
  ToolCalls,
} from "~~/lib/playground-protocol";
import type {
  ReasoningEffort,
  PlaygroundEndpoint,
  ScenarioMessage,
  ParsedUsageData,
  ToolCallData,
  ParsedCompletionData,
  ResponseMetrics,
  PlaygroundSettings,
} from "~~/lib/playground-protocol";

export function usePlayground() {









type ResponseData = { content: string; reasoning: string; toolCalls: ToolCallData[]; isLoading: boolean; error?: string; errorDetails?: string; metrics: ResponseMetrics; usedAccountId?: string | null; startedAt?: number | null };
type FetchModelResult = "success" | "error" | "aborted";
type StreamHeaderInfo = { status: number; statusText: string; getHeader: (name: string) => string | null };
type StreamRequest = { url: string; headers: Record<string, string>; body: string; signal: AbortSignal; endpoint: PlaygroundEndpoint; onHeaders: (info: StreamHeaderInfo) => void; onChunk: (chunk: ParsedCompletionData) => void };



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

const { data, error } = useAsyncData(dataKeys.playgroundOptions, () => api.playground.options());
watch(data, (value) => {
  if (value && !value.hasAnyProviderAccount) void navigateTo("/", { replace: true });
}, { immediate: true });

const options = computed<PlaygroundOptions | null>(() => data.value ?? null);
const models = computed<ModelOption[]>(() => options.value?.models ?? []);
const providerAccounts = computed<ProviderAccountOption[]>(() => options.value?.providerAccounts ?? []);
const hasAccount = computed(() => Boolean(options.value?.hasAnyProviderAccount));
const isProxyConfigured = computed(() => Boolean(options.value?.proxyBaseUrl));
const canUsePlayground = computed(() => hasAccount.value && isProxyConfigured.value && providerAccounts.value.length > 0 && models.value.length > 0);

const selectedScenario = ref<Scenario>(SCENARIOS[0]!);
const settings = reactive<PlaygroundSettings>({ ...DEFAULT_SETTINGS });
const settingsOpen = ref(false);
const panels = ref<PanelState[]>([{ id: Ids.short(), modelId: null, provider: null, accountId: null }]);
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
const pickerOpen = reactive<Record<string, boolean>>({});
const pickerStep = reactive<Record<string, "model" | "routing">>({});
const pendingModel = reactive<Record<string, string | null>>({});
const modelSearch = reactive<Record<string, string>>({});
const routeSearch = reactive<Record<string, string>>({});
const chatMessages = reactive<Record<string, ScenarioMessage[]>>({});
const autoScroll = reactive<Record<string, boolean>>({});
const copiedError = reactive<Record<string, boolean>>({});
const copyErrorTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const initializedFromRoute = ref(false);
const liveNow = ref(Date.now());

const controllers = new Map<string, AbortController>();
const requestIds = new Map<string, string>();
const stoppedPanels = new Set<string>();
const panelScrollElements = new Map<string, HTMLElement>();
const batchActive = ref(false);
let liveTimer: ReturnType<typeof setInterval> | null = null;
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let overviewTimer: ReturnType<typeof setTimeout> | null = null;
let longPressFired = false;
const LONG_PRESS_MS = 600;
const OVERVIEW_DELAY_MS = 500;
const SCROLL_THRESHOLD = 0.05;

const filteredModels = computed(() => models.value);
const filteredModelIds = computed(() => new Set(filteredModels.value.map((model) => model.id)));
const modelsById = computed(() => new Map(models.value.map((model) => [model.id, model])));
const accountsById = computed(() => new Map(providerAccounts.value.map((account) => [account.id, account])));
const familyPresets = computed(() => families(filteredModels.value, providerAccounts.value));
const providerPresets = computed(() => providers(filteredModels.value, providerAccounts.value));
const presetModelIds = computed(() => {
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
const topPDeprecated = computed(() =>
  panels.value.some((panel) => {
    if (!panel.modelId) return false;
    const model = modelsById.value.get(panel.modelId);
    if (!model?.deprecatedProviders) return false;
    const provider = panel.accountId
      ? accountsById.value.get(panel.accountId)?.provider
      : panel.provider;
    return Boolean(provider && model.deprecatedProviders.includes(provider));
  }),
);
const additionalParametersError = computed(() => Params.parse(additionalParametersInput.value).error);
const canRunPlayground = computed(() => Boolean(selectedScenario.value && hasSelectedModel.value && canUsePlayground.value && !additionalParametersError.value));
const playgroundSetupMessage = computed(() => {
  if (!hasAccount.value) return "Connect a provider account before running Playground.";
  if (!isProxyConfigured.value) return "Set NUXT_PUBLIC_API_URL to your API URL before running Playground.";
  if (providerAccounts.value.length === 0) return "Enable at least one provider account before running Playground.";
  if (models.value.length === 0) return "";
  return "";
});
const parsedLoopCount = computed(() => Number(loopCountInput.value));
const loopCountValid = computed(() => Number.isInteger(parsedLoopCount.value) && parsedLoopCount.value >= 1);
const loopBadge = computed(() => activeLoopProgress.value && activeLoopProgress.value.total > 1 ? `${activeLoopProgress.value.current}/${activeLoopProgress.value.total}` : null);
const scenarioMessages = computed(() => messagesOf(selectedScenario.value));
const isChatScenario = computed(() => selectedScenario.value.id === "chat");
const isVisionScenario = computed(() => selectedScenario.value.id === "vision");

watch(options, (value) => {
  if (value && !value.hasAnyProviderAccount) void navigateTo("/", { replace: true });
});

watch(options, (value) => {
  if (!value || initializedFromRoute.value) return;

  applyQuery(route.query);
  const modelId = Query.string(route.query.model);
  const accountId = Query.string(route.query.accountId);
  const compareAuto = autoCompare(route.query.compare);

  if (modelId) {
    const model = modelsById.value.get(modelId);
    if (compareAuto && model) {
      panels.value = autoPanels(model);
      initializedFromRoute.value = true;
      return;
    }

    if (model) {
      panels.value = [{ id: Ids.short(), modelId, provider: null, accountId: queryAccount(accountId, modelId) }];
      initializedFromRoute.value = true;
      return;
    }
  }

  if (accountId) {
    const account = accountsById.value.get(accountId);
    if (account) {
      const compatibleModels = models.value.filter((model) => accountSupports(account, model));
      panels.value = compatibleModels.length > 0
        ? compatibleModels.map((model) => ({ id: Ids.short(), modelId: model.id, provider: null, accountId }))
        : [{ id: Ids.short(), modelId: null, provider: null, accountId }];
      initializedFromRoute.value = true;
      return;
    }
  }

  initializedFromRoute.value = true;
}, { immediate: true });

watch(() => route.query, (query) => {
  if (!initializedFromRoute.value) return;
  if (!options.value) return;

  applyQuery(query);
  const modelId = Query.string(query.model);
  const accountId = Query.string(query.accountId);
  const compareAuto = autoCompare(query.compare);

  if (modelId) {
    const model = modelsById.value.get(modelId);
    if (compareAuto && model) {
      panels.value = autoPanels(model);
      responses.value = {};
      return;
    }

    if (model) {
      panels.value = [{ id: Ids.short(), modelId, provider: null, accountId: queryAccount(accountId, modelId) }];
      responses.value = {};
      return;
    }
  }

  if (accountId) {
    const account = accountsById.value.get(accountId);
    if (account) {
      const compatibleModels = models.value.filter((m) => accountSupports(account, m));
      panels.value = compatibleModels.length > 0
        ? compatibleModels.map((m) => ({ id: Ids.short(), modelId: m.id, provider: null, accountId }))
        : [{ id: Ids.short(), modelId: null, provider: null, accountId }];
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
  stopAll();
  if (liveTimer) clearInterval(liveTimer);
  if (longPressTimer) clearTimeout(longPressTimer);
  if (overviewTimer) clearTimeout(overviewTimer);
  for (const timeout of copyErrorTimeouts.values()) clearTimeout(timeout);
  copyErrorTimeouts.clear();
});



















function applyQuery(query: typeof route.query) {
  const endpoint = Query.endpoint(query.endpoint);
  const streamResponses = Query.boolean(query.stream);
  const temperature = Query.number(query.temperature);
  const topP = Query.number(query.top_p);
  const maxTokens = Query.number(query.max_tokens);
  const presencePenalty = Query.number(query.presence_penalty);
  const frequencyPenalty = Query.number(query.frequency_penalty);
  const reasoningEffort = Query.effort(query.reasoning_effort);
  const additionalParameters = Query.additional(query.additional_parameters);

  if (endpoint) settings.endpoint = endpoint;
  if (streamResponses !== null) settings.streamResponses = streamResponses;
  if (temperature !== null) settings.temperature = Params.clamp(temperature, 0, 2);
  if (topP !== null) settings.topP = Params.clamp(topP, 0, 1);
  if (maxTokens !== null) settings.maxTokens = Math.round(Params.clamp(maxTokens, 1, 128000));
  if (presencePenalty !== null) settings.presencePenalty = Params.clamp(presencePenalty, -2, 2);
  if (frequencyPenalty !== null) settings.frequencyPenalty = Params.clamp(frequencyPenalty, -2, 2);
  if (reasoningEffort) settings.reasoningEffort = reasoningEffort;
  if (additionalParameters !== null) additionalParametersInput.value = additionalParameters;
}

function accountSupports(account: ProviderAccountOption, model: ModelOption | string): boolean {
  const modelId = typeof model === "string" ? model : model.id;
  const modelOption = typeof model === "string" ? modelsById.value.get(model) : model;
  if (!modelOption?.providers.includes(account.provider)) return false;
  if (account.disabledModels?.includes(modelId)) return false;
  return !account.supportedModels || account.supportedModels.includes(modelId);
}

function providerSupports(provider: string | null, model: ModelOption | string): boolean {
  if (!provider) return false;
  const modelOption = typeof model === "string" ? modelsById.value.get(model) : model;
  if (!modelOption?.providers.includes(provider)) return false;
  return providerAccounts.value.some((account) => account.provider === provider && accountSupports(account, modelOption));
}

function queryAccount(accountId: string | null, modelId: string): string | null {
  const account = accountId ? accountsById.value.get(accountId) : null;
  return account && accountSupports(account, modelId) ? account.id : null;
}

function panelProvider(panel: PanelState): string | null {
  if (!panel.provider || !panel.modelId || panel.accountId) return null;
  return providerSupports(panel.provider, panel.modelId) ? panel.provider : null;
}

function families(modelOptions: ModelOption[], accounts: ProviderAccountOption[]) {
  const availableProviders = new Set(accounts.map((account) => account.provider));
  const grouped = new Map<ReturnType<typeof categorize>, ModelOption[]>();

  for (const model of modelOptions) {
    if (!model.providers.some((provider) => availableProviders.has(provider))) continue;
    const family = categorize(model.family);
    grouped.set(family, [...(grouped.get(family) ?? []), model]);
  }

  for (const familyModels of grouped.values()) {
    familyModels.sort(compareEntries);
  }

  const familyOrder = new Map(SORT_ORDER.map((family, index) => [family, index]));
  return Array.from(grouped.entries())
    .sort(([familyA], [familyB]) => {
      const orderA = familyOrder.get(familyA) ?? Number.MAX_SAFE_INTEGER;
      const orderB = familyOrder.get(familyB) ?? Number.MAX_SAFE_INTEGER;
      return orderA === orderB ? familyA.localeCompare(familyB) : orderA - orderB;
    })
    .map(([family, familyModels]) => ({ family, models: familyModels }));
}

function providers(modelOptions: ModelOption[], accounts: ProviderAccountOption[]) {
  const accountsByProvider = new Map<string, ProviderAccountOption[]>();
  for (const account of accounts) {
    accountsByProvider.set(account.provider, [...(accountsByProvider.get(account.provider) ?? []), account]);
  }

  return Array.from(accountsByProvider.entries()).flatMap(([provider, accountsForProvider]) => {
    const models = modelOptions.filter((model) => model.providers.includes(provider) && accountsForProvider.some((account) => accountSupports(account, model)));
    const presetPanels = models.map((model) => ({ modelId: model.id, provider, accountId: null }));

    return presetPanels.length > 0 ? [{ provider, accounts: accountsForProvider, models: models, panels: presetPanels }] : [];
  });
}

function autoPanels(model: ModelOption): PanelState[] {
  const supportedProviders = model.providers.filter((provider) => providerSupports(provider, model));
  return [
    { id: Ids.short(), modelId: model.id, provider: null, accountId: null },
    ...supportedProviders.map((provider) => ({ id: Ids.short(), modelId: model.id, provider, accountId: null })),
  ];
}

function autoCompare(value: unknown): boolean {
  return Query.string(value)?.trim().toLowerCase() === "auto";
}

function accountLabel(account: ProviderAccountOption): string {
  const name = account.name.trim();
  const email = account.email?.trim();
  if (!email) return name;
  if (!name || name.toLowerCase() === email.toLowerCase()) return email;
  return `${name} (${email})`;
}

function accountStatus(account: ProviderAccountOption): string | null {
  if (!account.isActive) return "Off";
  if (!account.disabledUntil) return null;

  const disabledUntil = account.disabledUntil instanceof Date ? account.disabledUntil : new Date(account.disabledUntil);
  if (Number.isNaN(disabledUntil.getTime()) || disabledUntil <= new Date(liveNow.value)) return null;
  return "Disabled";
}

function isAuthless(account: ProviderAccountOption): boolean {
  return account.id === account.provider || account.id.startsWith("authless:");
}

function presetLabel(accounts: ProviderAccountOption[]): string | null {
  if (accounts.every(isAuthless)) return null;
  return `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`;
}

function scopedLabel(provider: string): string {
  return `Auto (${labelOf(provider)})`;
}

function pendingProviders(panel: PanelState): string[] {
  const pendingId = pendingModel[panel.id];
  const candidate = pendingId ? modelsById.value.get(pendingId) : null;
  if (!candidate) return [];

  const search = routeSearch[panel.id]?.trim().toLowerCase();
  return candidate.providers
    .filter((provider) => providerSupports(provider, candidate))
    .filter((provider) => !search || `${provider} ${labelOf(provider)}`.toLowerCase().includes(search));
}

function routeAccount(panel: PanelState): string | null {
  if (!panel.accountId || !panel.modelId) return null;
  const model = modelsById.value.get(panel.modelId);
  const account = accountsById.value.get(panel.accountId);
  if (!model || !account || !accountSupports(account, model)) return null;
  return account.id;
}

function routeLabel(panel: PanelState): string {
  const selectedAccountId = routeAccount(panel);
  const selectedAccount = selectedAccountId ? accountsById.value.get(selectedAccountId) : null;
  const selectedProvider = panelProvider(panel);
  const response = responses.value[panel.id];
  const usedAccount = response?.usedAccountId ? accountsById.value.get(response.usedAccountId) : null;

  if (selectedAccount) return `${accountLabel(selectedAccount)} (${labelOf(selectedAccount.provider)})`;
  if (selectedProvider) return usedAccount ? `Auto (${accountLabel(usedAccount)} - ${labelOf(usedAccount.provider)})` : scopedLabel(selectedProvider);
  if (panel.modelId) return usedAccount ? `Auto (${accountLabel(usedAccount)} - ${labelOf(usedAccount.provider)})` : "Auto (load balancer)";
  return "-";
}

function panelAccount(panel: PanelState): ProviderAccountOption | null {
  const selectedAccountId = routeAccount(panel);
  if (selectedAccountId) return accountsById.value.get(selectedAccountId) ?? null;

  const usedAccountId = responses.value[panel.id]?.usedAccountId;
  return usedAccountId ? accountsById.value.get(usedAccountId) ?? null : null;
}

function accountHref(account: ProviderAccountOption): string | null {
  if (!(account.provider in BY_KEY)) return null;
  return `${accountPath(account.provider as ProviderAccountKey)}#${encodeURIComponent(account.id)}`;
}

function accountLink(panel: PanelState): string | null {
  const account = panelAccount(panel);
  return account ? accountHref(account) : null;
}

function panelModels(panel: PanelState): ModelOption[] {
  let nextModels = presetModelIds.value ? filteredModels.value.filter((model) => presetModelIds.value?.has(model.id)) : filteredModels.value;
  const account = panel.accountId ? accountsById.value.get(panel.accountId) : null;
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
    nextModels = nextModels.filter((model) => providerSupports(provider, model));
  }

  const search = modelSearch[panel.id]?.trim().toLowerCase();
  if (!search) return nextModels;
  return nextModels.filter((model) => `${model.name} ${model.providers.join(" ")}`.toLowerCase().includes(search));
}

function hasVision(model: ModelOption | undefined): boolean {
  if (!model?.modalities) return false;
  return model.modalities.input.includes("image");
}

function visionWarning(model: ModelOption | undefined): boolean {
  return Boolean(isVisionScenario.value && model && !hasVision(model));
}

function groupedModels(panel: PanelState) {
  const groups = new Map<ReturnType<typeof categorize>, ModelOption[]>();
  for (const model of panelModels(panel)) {
    const family = categorize(model.family);
    groups.set(family, [...(groups.get(family) ?? []), model]);
  }

  const familyOrder = new Map(SORT_ORDER.map((family, index) => [family, index]));
  return Array.from(groups.entries())
    .sort(([familyA], [familyB]) => {
      const orderA = familyOrder.get(familyA) ?? Number.MAX_SAFE_INTEGER;
      const orderB = familyOrder.get(familyB) ?? Number.MAX_SAFE_INTEGER;
      return orderA === orderB ? familyA.localeCompare(familyB) : orderA - orderB;
    })
    .map(([family, familyModels]) => ({ family, models: familyModels.sort(compareEntries) }));
}

function pendingAccounts(panel: PanelState): ProviderAccountOption[] {
  const pendingId = pendingModel[panel.id];
  const candidate = pendingId ? modelsById.value.get(pendingId) : null;
  if (!candidate) return [];

  const search = routeSearch[panel.id]?.trim().toLowerCase();
  const providerOrder = new Map(candidate.providers.map((provider, index) => [provider, index]));
  return providerAccounts.value
    .filter((account) => accountSupports(account, candidate))
    .filter((account) => !search || `${account.provider} ${account.name} ${account.email ?? ""}`.toLowerCase().includes(search))
    .sort((a, b) => {
      const orderA = providerOrder.get(a.provider) ?? Number.MAX_SAFE_INTEGER;
      const orderB = providerOrder.get(b.provider) ?? Number.MAX_SAFE_INTEGER;
      return orderA === orderB ? accountLabel(a).localeCompare(accountLabel(b)) : orderA - orderB;
    });
}

function openPicker(panel: PanelState) {
  pickerOpen[panel.id] = true;
  pickerStep[panel.id] = panel.modelId ? "routing" : "model";
  pendingModel[panel.id] = panel.modelId;
}

function searchModels(panelId: string, event: Event) {
  modelSearch[panelId] = (event.target as HTMLInputElement).value;
}

function searchRoutes(panelId: string, event: Event) {
  routeSearch[panelId] = (event.target as HTMLInputElement).value;
}

function selectModel(panel: PanelState, modelId: string) {
  pendingModel[panel.id] = modelId;
  pickerStep[panel.id] = "routing";
}

function selectRoute(panel: PanelState, route: { provider: string | null; accountId: string | null }) {
  const modelId = pendingModel[panel.id];
  if (!modelId) return;

  panels.value = panels.value.map((item) => item.id === panel.id ? { ...item, modelId, provider: route.accountId ? null : route.provider, accountId: route.accountId } : item);
  pickerOpen[panel.id] = false;
  pickerStep[panel.id] = "model";
  pendingModel[panel.id] = null;
  modelSearch[panel.id] = "";
  routeSearch[panel.id] = "";
}

function addPanel() {
  if (!canAddPanel.value) return;
  panels.value = [...panels.value, { id: Ids.short(), modelId: null, provider: null, accountId: null }];
}

function removePanel(panelId: string) {
  stopPanel(panelId);
  panelScrollElements.delete(panelId);
  Reflect.deleteProperty(autoScroll, panelId);
  Reflect.deleteProperty(chatMessages, panelId);
  Reflect.deleteProperty(copiedError, panelId);
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

function applyFamilies(families: string[]) {
  const accountByModel = new Map<string, string>();
  for (const panel of panels.value) {
    if (panel.modelId && panel.accountId && routeAccount(panel)) {
      accountByModel.set(panel.modelId, panel.accountId);
    }
  }

  const selected = familyPresets.value.filter((preset) => families.includes(preset.family));
  const nextModels = selected.flatMap((preset) => preset.models);
  panels.value = nextModels.length > 0
    ? nextModels.map((model) => ({ id: Ids.short(), modelId: model.id, provider: null, accountId: accountByModel.get(model.id) ?? null }))
    : [{ id: Ids.short(), modelId: null, provider: null, accountId: null }];
  responses.value = {};
}

function applyProviders(providers: string[]) {
  const selected = providerPresets.value.filter((preset) => providers.includes(preset.provider));
  const nextPanels = selected.flatMap((preset) => preset.panels);
  panels.value = nextPanels.length > 0
    ? nextPanels.map((panel) => ({ id: Ids.short(), modelId: panel.modelId, provider: panel.provider, accountId: panel.accountId }))
    : [{ id: Ids.short(), modelId: null, provider: null, accountId: null }];
  responses.value = {};
}

function toggleFamily(family: string) {
  if (!familyPresets.value.some((item) => item.family === family)) return;

  const nextFamilies = activeFamilyPresets.value.includes(family)
    ? activeFamilyPresets.value.filter((item) => item !== family)
    : [...activeFamilyPresets.value, family];

  activeFamilyPresets.value = nextFamilies;
  activeProviderPresets.value = [];
  applyFamilies(nextFamilies);
}

function toggleProvider(provider: string) {
  if (!providerPresets.value.some((item) => item.provider === provider)) return;

  const nextProviders = activeProviderPresets.value.includes(provider)
    ? activeProviderPresets.value.filter((item) => item !== provider)
    : [...activeProviderPresets.value, provider];

  activeProviderPresets.value = nextProviders;
  activeFamilyPresets.value = [];
  applyProviders(nextProviders);
}

function selectScenario(scenario: Scenario) {
  selectedScenario.value = scenario;
  responses.value = {};
  clearChat();
  if (scenario.isReasoning && settings.reasoningEffort === "none") {
    settings.reasoningEffort = "medium";
  }
}

function resetSettings() {
  Object.assign(settings, DEFAULT_SETTINGS);
  additionalParametersInput.value = "";
}

function clearChat() {
  for (const panelId of Object.keys(chatMessages)) {
    Reflect.deleteProperty(chatMessages, panelId);
  }
}

function messagesOf(scenario: Scenario): ScenarioMessage[] {
  return scenario.messages?.length ? scenario.messages : [{ role: "user", content: scenario.prompt }];
}

function panelMessages(panelId: string, scenario: Scenario): ScenarioMessage[] {
  return scenario.id === "chat" && chatMessages[panelId]?.length ? chatMessages[panelId] : messagesOf(scenario);
}

function conversationMessages(panelId: string): ScenarioMessage[] {
  const scenario = selectedScenario.value;
  return scenario?.id === "chat" && chatMessages[panelId]?.length ? chatMessages[panelId] : scenarioMessages.value;
}

function systemPrompt(panelId: string): string {
  return conversationMessages(panelId).filter((message) => message.role === "system").map((message) => Content.message(message.content)).filter(Boolean).join("\n\n");
}

function userMessages(panelId: string): ScenarioMessage[] {
  return conversationMessages(panelId).filter((message) => message.role !== "system");
}









function waitLabel(panelId: string): string {
  const response = responses.value[panelId];
  if (response?.isLoading && response.startedAt) return Duration.format(liveNow.value - response.startedAt);
  return Duration.format(response?.metrics.waitMs);
}

function bindScroll(panelId: string, element: unknown) {
  if (element instanceof HTMLElement) {
    panelScrollElements.set(panelId, element);
    return;
  }

  panelScrollElements.delete(panelId);
}

function scrollBottom(panelId: string) {
  if (!autoScroll[panelId]) return;
  nextTick(() => {
    const element = panelScrollElements.get(panelId);
    const response = responses.value[panelId];
    if (!element || !response?.isLoading || !autoScroll[panelId]) return;
    element.scrollTop = element.scrollHeight;
  });
}

function onScroll(panelId: string, event: Event) {
  const element = event.currentTarget;
  if (!(element instanceof HTMLElement)) return;

  const response = responses.value[panelId];
  if (!response?.isLoading) return;

  const scrollableDistance = Math.max(element.scrollHeight - element.clientHeight, 0);
  if (scrollableDistance === 0) return;

  const distanceFromBottom = scrollableDistance - element.scrollTop;
  autoScroll[panelId] = distanceFromBottom / scrollableDistance <= SCROLL_THRESHOLD;
}






















































function streamRequest(input: StreamRequest): Promise<void> {
  const gate = deferred<void>();
  {
    const resolve = gate.resolve;
    const reject = gate.reject;
    if (input.signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return gate.promise;
    }

    const xhr = new XMLHttpRequest();
    let processedLength = 0;
    let headersHandled = false;
    let settled = false;
    const processor = Sse.processor(input.endpoint, input.onChunk);

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
      if (xhr.readyState === XMLHttpRequest.LOADING && Sse.ok(xhr.status)) processResponseText();
    };
    xhr.onprogress = () => {
      handleHeaders();
      if (Sse.ok(xhr.status)) processResponseText();
    };
    xhr.onload = () => {
      handleHeaders();
      if (!Sse.ok(xhr.status)) {
        settle(() => reject(new Error(ErrorText.fromResponse(xhr.responseText || ""))));
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
    const opened = Result.try({
      try: () => {
        xhr.open("POST", input.url, true);
        for (const [name, value] of Object.entries(input.headers)) {
          xhr.setRequestHeader(name, value);
        }
        xhr.send(input.body);
        return null;
      },
      catch: (error: unknown) => error,
    });
    if (Result.isFailure(opened)) settle(() => reject(opened.failure));
  }
  return gate.promise;
}



function proxyUrl(): string {
  const proxyUrl = options.value?.proxyBaseUrl?.trim().replace(/\/+$/, "");
  if (!proxyUrl) raise(new Error("Proxy URL is not configured"));
  return proxyUrl;
}

















function setResponse(panelId: string, response: ResponseData, requestId?: string) {
  if (requestId !== undefined && requestIds.get(panelId) !== requestId) return;
  responses.value = { ...responses.value, [panelId]: response };
  if (response.isLoading) scrollBottom(panelId);
}

function refreshOverview() {
  if (overviewTimer) clearTimeout(overviewTimer);
  overviewTimer = setTimeout(() => {
    overviewTimer = null;
    void invalidation.invalidateAccountOverview();
  }, OVERVIEW_DELAY_MS);
}

async function runChat(panel: PanelState & { modelId: string }, scenario: Scenario, currentSettings: PlaygroundSettings): Promise<FetchModelResult> {
  const messages = [...messagesOf(scenario)];
  chatMessages[panel.id] = messages;

  const followUps = scenario.autoFollowUps ?? [];
  for (let step = 0; step <= followUps.length; step += 1) {
    if (!batchActive.value || stoppedPanels.has(panel.id)) return "aborted";

    const result = await fetchModel(panel.id, panel.modelId, scenario, currentSettings, panelProvider(panel), routeAccount(panel), messages);
    if (result !== "success") return result;

    const response = responses.value[panel.id];
    const assistantContent = response?.content?.trim();
    if (!assistantContent) return "success";

    messages.push({ role: "assistant", content: assistantContent });
    chatMessages[panel.id] = [...messages];

    const followUp = followUps[step];
    if (!followUp) return "success";

    messages.push({ role: "user", content: followUp });
    chatMessages[panel.id] = [...messages];
  }

  return "success";
}

async function fetchModel(panelId: string, modelId: string, scenario: Scenario, currentSettings: PlaygroundSettings, provider: string | null, accountId: string | null, messages = panelMessages(panelId, scenario)): Promise<FetchModelResult> {
  const requestStartedAt = Date.now();
  const requestId = Ids.short();
  let waitMs: number | null = null;
  let usedAccountId: string | null = null;
  let shouldRefreshOverview = false;
  let errorContextParameters: Record<string, unknown> | null = null;

  controllers.get(panelId)?.abort();
  requestIds.set(panelId, requestId);
  autoScroll[panelId] = true;
  setResponse(panelId, { content: "", reasoning: "", toolCalls: [], isLoading: true, metrics: Tokens.metrics(null, null, null), startedAt: requestStartedAt });

  const outcome = await settle(async () => {
    const requestBody = Body.build(modelId, messages, currentSettings);
    errorContextParameters = requestBody;
    const endpointOverrides = Body.overrides(scenario.requestOverrides, currentSettings.endpoint);
    if (endpointOverrides) Object.assign(requestBody, endpointOverrides);
    const additionalParameters = Params.parse(additionalParametersInput.value);
    if (additionalParameters.error) raise(new Error(`Invalid additional parameters: ${additionalParameters.error}`));
    if (additionalParameters.params) Object.assign(requestBody, additionalParameters.params);
    Body.route(requestBody, provider, accountId);
    if (!canUsePlayground.value) raise(new Error(playgroundSetupMessage.value || "Playground is not ready."));

    const controller = new AbortController();
    controllers.set(panelId, controller);
    const auth = await api.playground.auth({ endpoint: currentSettings.endpoint });
    if (controller.signal.aborted) raise(new DOMException("Aborted", "AbortError"));

    const url = `${proxyUrl()}${ErrorText.path(currentSettings.endpoint)}`;
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

      await streamRequest({
        url,
        headers,
        body,
        signal: controller.signal,
        endpoint: currentSettings.endpoint,
        onHeaders: (info) => {
          waitMs = Date.now() - requestStartedAt;
          usedAccountId = info.getHeader("x-provider-account-id");
          shouldRefreshOverview = true;
        },
        onChunk: (chunk) => {
          firstResponseMs ??= Date.now() - requestStartedAt;
          streamedContent += chunk.content;
          streamedReasoning += chunk.reasoning;
          streamedToolCalls = chunk.toolCalls.length > 0 ? [...streamedToolCalls, ...chunk.toolCalls] : streamedToolCalls;
          usage = Tokens.merge(usage, chunk.usage);
          setResponse(panelId, { content: streamedContent, reasoning: streamedReasoning, toolCalls: streamedToolCalls, isLoading: true, metrics: Tokens.metrics(waitMs, firstResponseMs, usage), usedAccountId, startedAt: requestStartedAt }, requestId);
        },
      });

      setResponse(panelId, { content: streamedContent, reasoning: streamedReasoning, toolCalls: streamedToolCalls, isLoading: false, metrics: Tokens.metrics(waitMs, firstResponseMs, usage), usedAccountId }, requestId);
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
    shouldRefreshOverview = true;

    if (!response.ok) {
      const clonedResponse = response.clone();
      let errorMessage = "Request failed";
      {
        const parsedError = await settle(() => response.json());
        if (parsedError.ok) {
          errorMessage = Completion.error(parsedError.value) ?? errorMessage;
        } else {
          const fallback = await settle(() => clonedResponse.text());
          if (fallback.ok && fallback.value.trim()) errorMessage = fallback.value;
        }
      }
      raise(new Error(errorMessage));
    }

    const payload = await response.json();
    const parsed = currentSettings.endpoint === "messages" ? Completion.anthropic(payload) : currentSettings.endpoint === "responses" ? Completion.responses(payload) : Completion.chat(payload);
    setResponse(panelId, { content: parsed.content, reasoning: parsed.reasoning, toolCalls: parsed.toolCalls, isLoading: false, metrics: Tokens.metrics(waitMs, Date.now() - requestStartedAt, parsed.usage), usedAccountId }, requestId);
    return "success" as const;
  });
  if (requestIds.get(panelId) === requestId) {
    controllers.delete(panelId);
    requestIds.delete(panelId);
  }
  if (shouldRefreshOverview) refreshOverview();
  if (outcome.ok) return outcome.value;
  {
    const error = outcome.error;
    if (error instanceof DOMException && error.name === "AbortError") {
      const existing = responses.value[panelId];
      if (existing && requestIds.get(panelId) === requestId) setResponse(panelId, { ...existing, isLoading: false, error: undefined });
      return "aborted";
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const providerByAccount = accountId ? accountsById.value.get(accountId)?.provider ?? null : null;
    const usedAccountProvider = usedAccountId ? accountsById.value.get(usedAccountId)?.provider ?? null : null;
    const errorProvider = provider ?? providerByAccount ?? usedAccountProvider ?? null;
    const errorDetails = ErrorText.build(errorMessage, { model: modelId, provider: errorProvider, endpoint: currentSettings.endpoint, parameters: errorContextParameters, messages });
    setResponse(panelId, { content: "", reasoning: "", toolCalls: [], isLoading: false, error: errorMessage, errorDetails, metrics: Tokens.metrics(waitMs, null, null), usedAccountId }, requestId);
    return "error";
  }
}

async function runScenario(requestedLoopCount = 1) {
  if (!selectedScenario.value || !canRunPlayground.value) return;
  const scenario = selectedScenario.value;
  clearChat();
  let currentSettings = { ...settings };
  if (scenario.isReasoning && currentSettings.reasoningEffort === "none") {
    settings.reasoningEffort = "medium";
    currentSettings = { ...settings };
  }

  const panelsWithModels = panels.value.filter((panel): panel is PanelState & { modelId: string } => Boolean(panel.modelId));
  if (panelsWithModels.length === 0) return;

  const totalLoops = Math.max(1, Math.floor(requestedLoopCount));
  activeLoopProgress.value = totalLoops > 1 ? { current: 1, total: totalLoops } : null;
  stoppedPanels.clear();
  batchActive.value = true;

  {
    await Effect.runPromise(Effect.all(panelsWithModels.map((panel) => Effect.promise(async () => {
      for (let iteration = 0; iteration < totalLoops; iteration += 1) {
        if (!batchActive.value || stoppedPanels.has(panel.id)) break;
        activeLoopProgress.value = totalLoops > 1 ? { current: iteration + 1, total: totalLoops } : null;

        const result = scenario.id === "chat"
          ? await runChat(panel, scenario, currentSettings)
          : await fetchModel(panel.id, panel.modelId, scenario, currentSettings, panelProvider(panel), routeAccount(panel));
        if (result !== "success") {
          stoppedPanels.add(panel.id);
          break;
        }
      }
    })), { concurrency: "unbounded" }));
  }
  activeLoopProgress.value = null;
  stoppedPanels.clear();
  batchActive.value = false;
}

function stopPanel(panelId: string) {
  controllers.get(panelId)?.abort();
  controllers.delete(panelId);
  requestIds.delete(panelId);
  stoppedPanels.add(panelId);

  const response = responses.value[panelId];
  if (response?.isLoading) setResponse(panelId, { ...response, isLoading: false, error: undefined });
}

function stopAll() {
  for (const panelId of Array.from(controllers.keys())) {
    stopPanel(panelId);
  }
  batchActive.value = false;
  activeLoopProgress.value = null;
}

async function retryPanel(panelId: string) {
  const panel = panels.value.find((item) => item.id === panelId);
  if (!panel?.modelId || !selectedScenario.value || !canRunPlayground.value) return;
  const wasBatchActive = batchActive.value;
  if (wasBatchActive) stoppedPanels.add(panelId);
  if (selectedScenario.value.id === "chat") {
    batchActive.value = true;
    stoppedPanels.delete(panel.id);
    await runChat(panel as PanelState & { modelId: string }, selectedScenario.value, { ...settings });
    batchActive.value = wasBatchActive;
    return;
  }
  await fetchModel(panel.id, panel.modelId, selectedScenario.value, { ...settings }, panelProvider(panel), routeAccount(panel));
}

function onPress(event: PointerEvent) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  document.getSelection()?.removeAllRanges();
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressFired = false;
  longPressTimer = setTimeout(() => {
    longPressFired = true;
    document.getSelection()?.removeAllRanges();
    loopCountInput.value = String(loopCount.value);
    loopDialogOpen.value = true;
  }, LONG_PRESS_MS);
}

function pressRelease() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function onTap() {
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  runScenario();
}

function runLoop() {
  if (!loopCountValid.value) return;
  loopCount.value = parsedLoopCount.value;
  loopDialogOpen.value = false;
  runScenario(parsedLoopCount.value);
}



async function copyError(panelId: string) {
  const response = responses.value[panelId];
  const error = response?.error;
  if (!error) return;

  const copied = await settle(() => navigator.clipboard.writeText(response.errorDetails ?? error));
  if (!copied.ok) {
    console.error("Failed to copy error");
    return;
  }
  copiedError[panelId] = true;
  const existingTimeout = copyErrorTimeouts.get(panelId);
  if (existingTimeout) clearTimeout(existingTimeout);
  copyErrorTimeouts.set(panelId, setTimeout(() => {
    copiedError[panelId] = false;
    copyErrorTimeouts.delete(panelId);
  }, 1800));
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
    pickerOpen,
    pickerStep,
    pendingModel,
    modelSearch,
    routeSearch,
    copiedError,
    modelsById,
    accountsById,
    familyPresets,
    providerPresets,
    canAddPanel,
    isAnyLoading,
    topPDeprecated,
    additionalParametersError,
    canRunPlayground,
    loopCountValid,
    loopBadge,
    isChatScenario,
    panelProvider,
    accountLabel,
    accountStatus,
    presetLabel,
    scopedLabel,
    pendingProviders,
    routeAccount,
    routeLabel,
    accountLink,
    visionWarning,
    groupedModels,
    pendingAccounts,
    openPicker,
    searchModels,
    searchRoutes,
    selectModel,
    selectRoute,
    addPanel,
    removePanel,
    toggleFamily,
    toggleProvider,
    selectScenario,
    resetSettings,
    conversationMessages,
    systemPrompt,
    userMessages,
    waitLabel,
    bindScroll,
    onScroll,
    stopPanel,
    stopAll,
    retryPanel,
    onPress,
    pressRelease,
    onTap,
    runLoop,
    copyError,
    error,
    labelOf,
    extractMessageText: Content.message,
    extractImageUrls: Content.images,
    formatToolArguments: ToolCalls.format,
  };
}
