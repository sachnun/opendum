import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { Effect, Result } from "effect";
import { deferred, raise, settle } from "~/lib/settle";
import { SORT_ORDER, categorize } from "@opendum/models/ranking";
import { compareEntries } from "@opendum/models/sort";
import { compareText } from "@opendum/models/compare";
import { BY_KEY, accountPath, labelOf, type ProviderAccountKey } from "@opendum/providers/provider-accounts";
import type { PlaygroundOptions } from "~/lib/api-types";
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
  type ReasoningEffort,
  type PlaygroundEndpoint,
  type ScenarioMessage,
  type ParsedUsageData,
  type ToolCallData,
  type ParsedCompletionData,
  type ResponseMetrics,
  type PlaygroundSettings,
} from "~/lib/playground-protocol";
import { api } from "~/api";
import { invalidation } from "~/lib/invalidate";
import { dataKeys } from "~/lib/data-keys";
import { createQuery } from "~/lib/query";

type ResponseData = {
  content: string;
  reasoning: string;
  toolCalls: ToolCallData[];
  isLoading: boolean;
  error?: string;
  errorDetails?: string;
  metrics: ResponseMetrics;
  usedAccountId?: string | null;
  startedAt?: number | null;
};

type FetchModelResult = "success" | "error" | "aborted";

type StreamHeaderInfo = { status: number; statusText: string; getHeader: (name: string) => string | null };

type StreamRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  endpoint: PlaygroundEndpoint;
  onHeaders: (info: StreamHeaderInfo) => void;
  onChunk: (chunk: ParsedCompletionData) => void;
};

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

const SCENARIOS: [Scenario, ...Scenario[]] = [
  {
    id: "text",
    name: "Text",
    icon: "i-lucide-file-text",
    prompt: "Write a short poem about the ocean.",
    isReasoning: false,
    messages: [
      {
        role: "system",
        content:
          "You are a creative writing assistant. Write vivid, expressive text with a poetic tone. Keep responses concise.",
      },
      { role: "user", content: "Write a short poem about the ocean." },
    ],
  },
  {
    id: "chat",
    name: "Chat",
    icon: "i-lucide-message-square-text",
    prompt: "Help me plan a small weekend project to learn Solid.",
    isReasoning: false,
    messages: [
      {
        role: "system",
        content:
          "You are a concise chat assistant. Keep each answer conversational, practical, and no longer than 3 short paragraphs.",
      },
      { role: "user", content: "Help me plan a small weekend project to learn Solid." },
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
      {
        role: "system",
        content:
          "You are a helpful assistant with access to external tools. When the user asks for real-time data such as weather or currency conversion, call the appropriate tool instead of guessing. After receiving tool results, summarize them clearly and concisely.",
      },
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
            parameters: {
              type: "object",
              properties: { city: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
              required: ["city"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "convert_currency",
            description: "Convert amount between currencies",
            parameters: {
              type: "object",
              properties: { amount: { type: "number" }, from: { type: "string" }, to: { type: "string" } },
              required: ["amount", "from", "to"],
            },
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
      {
        role: "system",
        content:
          "You are a visual analysis assistant. When given an image, describe it concisely, identify key visible objects, and infer the likely context or setting of the scene.",
      },
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

const LONG_PRESS_MS = 600;
const OVERVIEW_DELAY_MS = 500;
const SCROLL_THRESHOLD = 0.05;

export interface PlaygroundQuery {
  model?: string;
  accountId?: string;
  compare?: string;
  endpoint?: string;
  stream?: string;
  temperature?: string;
  top_p?: string;
  max_tokens?: string;
  presence_penalty?: string;
  frequency_penalty?: string;
  reasoning_effort?: string;
  additional_parameters?: string;
}

export function createPlayground(routeQuery: () => PlaygroundQuery) {
  const optionsQuery = createQuery(dataKeys.playgroundOptions, () => api.playground.options());
  const options = createMemo<PlaygroundOptions | null>(() => optionsQuery.data() ?? null);
  const models = createMemo<ModelOption[]>(() => options()?.models ?? []);
  const providerAccounts = createMemo<ProviderAccountOption[]>(() => options()?.providerAccounts ?? []);
  const hasAccount = createMemo(() => Boolean(options()?.hasAnyProviderAccount));
  const isProxyConfigured = createMemo(() => Boolean(options()?.proxyBaseUrl));
  const canUsePlayground = createMemo(
    () => hasAccount() && isProxyConfigured() && providerAccounts().length > 0 && models().length > 0
  );

  const [selectedScenario, setSelectedScenario] = createSignal<Scenario>(SCENARIOS[0]);
  const [settings, setSettings] = createStore<PlaygroundSettings>({ ...DEFAULT_SETTINGS });
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [panels, setPanels] = createSignal<PanelState[]>([{ id: Ids.short(), modelId: null, provider: null, accountId: null }]);
  const [responses, setResponses] = createSignal<Record<string, ResponseData>>({});
  const [loopDialogOpen, setLoopDialogOpen] = createSignal(false);
  const [loopCountInput, setLoopCountInput] = createSignal("2");
  const [loopCount, setLoopCount] = createSignal(2);
  const [additionalParametersInput, setAdditionalParametersInput] = createSignal("");
  const [activeLoopProgress, setActiveLoopProgress] = createSignal<{ current: number; total: number } | null>(null);
  const [activeFamilyPresets, setActiveFamilyPresets] = createSignal<string[]>([]);
  const [activeProviderPresets, setActiveProviderPresets] = createSignal<string[]>([]);
  const [familyPresetExpanded, setFamilyPresetExpanded] = createSignal(false);
  const [providerPresetExpanded, setProviderPresetExpanded] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createStore<Record<string, boolean>>({});
  const [pickerStep, setPickerStep] = createStore<Record<string, "model" | "routing">>({});
  const [pendingModel, setPendingModel] = createStore<Record<string, string | null>>({});
  const [modelSearch, setModelSearch] = createStore<Record<string, string>>({});
  const [routeSearch, setRouteSearch] = createStore<Record<string, string>>({});
  const [chatMessages, setChatMessages] = createStore<Record<string, ScenarioMessage[]>>({});
  const [autoScroll, setAutoScroll] = createStore<Record<string, boolean>>({});
  const [copiedError, setCopiedError] = createStore<Record<string, boolean>>({});
  const [liveNow, setLiveNow] = createSignal(Date.now());
  const [batchActive, setBatchActive] = createSignal(false);
  const [initializedFromRoute, setInitializedFromRoute] = createSignal(false);

  const copyErrorTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const controllers = new Map<string, AbortController>();
  const requestIds = new Map<string, string>();
  const stoppedPanels = new Set<string>();
  const panelScrollElements = new Map<string, HTMLElement>();
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let overviewTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressFired = false;

  const filteredModels = createMemo(() => models());
  const filteredModelIds = createMemo(() => new Set(filteredModels().map((model) => model.id)));
  const modelsById = createMemo(() => new Map(models().map((model) => [model.id, model])));
  const accountsById = createMemo(() => new Map(providerAccounts().map((account) => [account.id, account])));
  const familyPresets = createMemo(() => families(filteredModels(), providerAccounts()));
  const providerPresets = createMemo(() => providers(filteredModels(), providerAccounts()));

  const presetModelIds = createMemo(() => {
    if (activeFamilyPresets().length > 0) {
      const ids = new Set<string>();
      for (const preset of familyPresets()) {
        if (!activeFamilyPresets().includes(preset.family)) continue;
        for (const model of preset.models) ids.add(model.id);
      }
      return ids;
    }

    if (activeProviderPresets().length === 0) return null;
    const ids = new Set<string>();
    for (const preset of providerPresets()) {
      if (!activeProviderPresets().includes(preset.provider)) continue;
      for (const model of preset.models) ids.add(model.id);
    }
    return ids;
  });

  const maxPanels = createMemo(() =>
    Math.max(
      filteredModels().length,
      providerPresets().reduce((total, preset) => total + preset.panels.length, 0),
      1
    )
  );
  const canAddPanel = createMemo(() => panels().length < maxPanels());
  const hasSelectedModel = createMemo(() => panels().some((panel) => panel.modelId));
  const isAnyLoading = createMemo(() => Object.values(responses()).some((response) => response.isLoading));

  const topPDeprecated = createMemo(() =>
    panels().some((panel) => {
      if (!panel.modelId) return false;
      const model = modelsById().get(panel.modelId);
      if (!model?.deprecatedProviders) return false;
      const provider = panel.accountId ? accountsById().get(panel.accountId)?.provider : panel.provider;
      return Boolean(provider && model.deprecatedProviders.includes(provider));
    })
  );

  const additionalParametersError = createMemo(() => Params.parse(additionalParametersInput()).error);
  const canRunPlayground = createMemo(
    () =>
      Boolean(selectedScenario() && hasSelectedModel() && canUsePlayground() && !additionalParametersError())
  );

  const playgroundSetupMessage = createMemo(() => {
    if (!hasAccount()) return "Connect a provider account before running Playground.";
    if (!isProxyConfigured()) return "Set VITE_API_URL to your API URL before running Playground.";
    if (providerAccounts().length === 0) return "Enable at least one provider account before running Playground.";
    if (models().length === 0) return "";
    return "";
  });

  const parsedLoopCount = createMemo(() => Number(loopCountInput()));
  const loopCountValid = createMemo(() => Number.isInteger(parsedLoopCount()) && parsedLoopCount() >= 1);
  const loopBadge = createMemo(() => {
    const progress = activeLoopProgress();
    return progress && progress.total > 1 ? `${progress.current}/${progress.total}` : null;
  });

  const scenarioMessages = createMemo(() => messagesOf(selectedScenario()));
  const isChatScenario = createMemo(() => selectedScenario().id === "chat");
  const isVisionScenario = createMemo(() => selectedScenario().id === "vision");

  function applyQuery(query: PlaygroundQuery) {
    const endpoint = Query.endpoint(query.endpoint);
    const streamResponses = Query.boolean(query.stream);
    const temperature = Query.number(query.temperature);
    const topP = Query.number(query.top_p);
    const maxTokens = Query.number(query.max_tokens);
    const presencePenalty = Query.number(query.presence_penalty);
    const frequencyPenalty = Query.number(query.frequency_penalty);
    const reasoningEffort = Query.effort(query.reasoning_effort);
    const additionalParameters = Query.additional(query.additional_parameters);

    if (endpoint) setSettings("endpoint", endpoint);
    if (streamResponses !== null) setSettings("streamResponses", streamResponses);
    if (temperature !== null) setSettings("temperature", Params.clamp(temperature, 0, 2));
    if (topP !== null) setSettings("topP", Params.clamp(topP, 0, 1));
    if (maxTokens !== null) setSettings("maxTokens", Math.round(Params.clamp(maxTokens, 1, 128000)));
    if (presencePenalty !== null) setSettings("presencePenalty", Params.clamp(presencePenalty, -2, 2));
    if (frequencyPenalty !== null) setSettings("frequencyPenalty", Params.clamp(frequencyPenalty, -2, 2));
    if (reasoningEffort) setSettings("reasoningEffort", reasoningEffort);
    if (additionalParameters !== null) setAdditionalParametersInput(additionalParameters);
  }

  function accountSupports(account: ProviderAccountOption, model: ModelOption | string): boolean {
    const modelId = typeof model === "string" ? model : model.id;
    const modelOption = typeof model === "string" ? modelsById().get(model) : model;
    if (!modelOption?.providers.includes(account.provider)) return false;
    if (account.disabledModels?.includes(modelId)) return false;
    return !account.supportedModels || account.supportedModels.includes(modelId);
  }

  function providerSupports(provider: string | null, model: ModelOption | string): boolean {
    if (!provider) return false;
    const modelOption = typeof model === "string" ? modelsById().get(model) : model;
    if (!modelOption?.providers.includes(provider)) return false;
    return providerAccounts().some((account) => account.provider === provider && accountSupports(account, modelOption));
  }

  function queryAccount(accountId: string | null, modelId: string): string | null {
    const account = accountId ? accountsById().get(accountId) : null;
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

    for (const familyModels of grouped.values()) familyModels.sort(compareEntries);

    const familyOrder = new Map(SORT_ORDER.map((family, index) => [family, index]));
    return Array.from(grouped.entries())
      .sort(([familyA], [familyB]) => {
        const orderA = familyOrder.get(familyA) ?? Number.MAX_SAFE_INTEGER;
        const orderB = familyOrder.get(familyB) ?? Number.MAX_SAFE_INTEGER;
        return orderA === orderB ? compareText(familyA, familyB) : orderA - orderB;
      })
      .map(([family, familyModels]) => ({ family, models: familyModels }));
  }

  function providers(modelOptions: ModelOption[], accounts: ProviderAccountOption[]) {
    const accountsByProvider = new Map<string, ProviderAccountOption[]>();
    for (const account of accounts) {
      accountsByProvider.set(account.provider, [...(accountsByProvider.get(account.provider) ?? []), account]);
    }

    return Array.from(accountsByProvider.entries()).flatMap(([provider, accountsForProvider]) => {
      const providerModels = modelOptions.filter(
        (model) => model.providers.includes(provider) && accountsForProvider.some((account) => accountSupports(account, model))
      );
      const presetPanels = providerModels.map((model) => ({ modelId: model.id, provider, accountId: null }));

      return presetPanels.length > 0 ? [{ provider, accounts: accountsForProvider, models: providerModels, panels: presetPanels }] : [];
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
    if (Number.isNaN(disabledUntil.getTime()) || disabledUntil <= new Date(liveNow())) return null;
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
    const candidate = pendingId ? modelsById().get(pendingId) : null;
    if (!candidate) return [];

    const search = routeSearch[panel.id]?.trim().toLowerCase();
    return candidate.providers
      .filter((provider) => providerSupports(provider, candidate))
      .filter((provider) => !search || `${provider} ${labelOf(provider)}`.toLowerCase().includes(search));
  }

  function routeAccount(panel: PanelState): string | null {
    if (!panel.accountId || !panel.modelId) return null;
    const model = modelsById().get(panel.modelId);
    const account = accountsById().get(panel.accountId);
    if (!model || !account || !accountSupports(account, model)) return null;
    return account.id;
  }

  function routeLabel(panel: PanelState): string {
    const selectedAccountId = routeAccount(panel);
    const selectedAccount = selectedAccountId ? accountsById().get(selectedAccountId) : null;
    const selectedProvider = panelProvider(panel);
    const response = responses()[panel.id];
    const usedAccount = response?.usedAccountId ? accountsById().get(response.usedAccountId) : null;

    if (selectedAccount) return `${accountLabel(selectedAccount)} (${labelOf(selectedAccount.provider)})`;
    if (selectedProvider)
      return usedAccount ? `Auto (${accountLabel(usedAccount)} - ${labelOf(usedAccount.provider)})` : scopedLabel(selectedProvider);
    if (panel.modelId)
      return usedAccount ? `Auto (${accountLabel(usedAccount)} - ${labelOf(usedAccount.provider)})` : "Auto (load balancer)";
    return "-";
  }

  function panelAccount(panel: PanelState): ProviderAccountOption | null {
    const selectedAccountId = routeAccount(panel);
    if (selectedAccountId) return accountsById().get(selectedAccountId) ?? null;

    const usedAccountId = responses()[panel.id]?.usedAccountId;
    return usedAccountId ? (accountsById().get(usedAccountId) ?? null) : null;
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
    const presetIds = presetModelIds();
    let nextModels = presetIds ? filteredModels().filter((model) => presetIds.has(model.id)) : filteredModels();
    const account = panel.accountId ? accountsById().get(panel.accountId) : null;
    const provider = panel.accountId ? null : panel.provider;

    if (account?.disabledModels?.length) {
      const disabled = new Set(account.disabledModels);
      nextModels = nextModels.filter((model) => !disabled.has(model.id));
    }

    if (account?.supportedModels) {
      const supported = new Set(account.supportedModels);
      nextModels = nextModels.filter((model) => supported.has(model.id));
    }

    if (provider) nextModels = nextModels.filter((model) => providerSupports(provider, model));

    const search = modelSearch[panel.id]?.trim().toLowerCase();
    if (!search) return nextModels;
    return nextModels.filter((model) => `${model.name} ${model.providers.join(" ")}`.toLowerCase().includes(search));
  }

  function hasVision(model: ModelOption | undefined): boolean {
    if (!model?.modalities) return false;
    return model.modalities.input.includes("image");
  }

  function visionWarning(model: ModelOption | undefined): boolean {
    return Boolean(isVisionScenario() && model && !hasVision(model));
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
        return orderA === orderB ? compareText(familyA, familyB) : orderA - orderB;
      })
      .map(([family, familyModels]) => ({ family, models: familyModels.sort(compareEntries) }));
  }

  function pendingAccounts(panel: PanelState): ProviderAccountOption[] {
    const pendingId = pendingModel[panel.id];
    const candidate = pendingId ? modelsById().get(pendingId) : null;
    if (!candidate) return [];

    const search = routeSearch[panel.id]?.trim().toLowerCase();
    const providerOrder = new Map(candidate.providers.map((provider, index) => [provider, index]));
    return providerAccounts()
      .filter((account) => accountSupports(account, candidate))
      .filter((account) => !search || `${account.provider} ${account.name} ${account.email ?? ""}`.toLowerCase().includes(search))
      .sort((a, b) => {
        const orderA = providerOrder.get(a.provider) ?? Number.MAX_SAFE_INTEGER;
        const orderB = providerOrder.get(b.provider) ?? Number.MAX_SAFE_INTEGER;
        return orderA === orderB ? compareText(accountLabel(a), accountLabel(b)) : orderA - orderB;
      });
  }

  function openPicker(panel: PanelState) {
    setPickerOpen(panel.id, true);
    setPickerStep(panel.id, panel.modelId ? "routing" : "model");
    setPendingModel(panel.id, panel.modelId);
  }

  function searchModels(panelId: string, event: Event) {
    setModelSearch(panelId, (event.target as HTMLInputElement).value);
  }

  function searchRoutes(panelId: string, event: Event) {
    setRouteSearch(panelId, (event.target as HTMLInputElement).value);
  }

  function selectModel(panel: PanelState, modelId: string) {
    setPendingModel(panel.id, modelId);
    setPickerStep(panel.id, "routing");
  }

  function selectRoute(panel: PanelState, route: { provider: string | null; accountId: string | null }) {
    const modelId = pendingModel[panel.id];
    if (!modelId) return;

    setPanels((current) =>
      current.map((item) =>
        item.id === panel.id
          ? { ...item, modelId, provider: route.accountId ? null : route.provider, accountId: route.accountId }
          : item
      )
    );
    setPickerOpen(panel.id, false);
    setPickerStep(panel.id, "model");
    setPendingModel(panel.id, null);
    setModelSearch(panel.id, "");
    setRouteSearch(panel.id, "");
  }

  function addPanel() {
    if (!canAddPanel()) return;
    setPanels((current) => [...current, { id: Ids.short(), modelId: null, provider: null, accountId: null }]);
  }

  function removePanel(panelId: string) {
    stopPanel(panelId);
    panelScrollElements.delete(panelId);
    setAutoScroll(produce((state) => { delete state[panelId]; }));
    setChatMessages(produce((state) => { delete state[panelId]; }));
    setCopiedError(produce((state) => { delete state[panelId]; }));
    const timeout = copyErrorTimeouts.get(panelId);
    if (timeout) {
      clearTimeout(timeout);
      copyErrorTimeouts.delete(panelId);
    }
    setPanels((current) => current.filter((panel) => panel.id !== panelId));
    setResponses((current) => {
      const next = { ...current };
      delete next[panelId];
      return next;
    });
  }

  function applyFamilies(selectedFamilies: string[]) {
    const accountByModel = new Map<string, string>();
    for (const panel of panels()) {
      if (panel.modelId && panel.accountId && routeAccount(panel)) {
        accountByModel.set(panel.modelId, panel.accountId);
      }
    }

    const selected = familyPresets().filter((preset) => selectedFamilies.includes(preset.family));
    const nextModels = selected.flatMap((preset) => preset.models);
    setPanels(
      nextModels.length > 0
        ? nextModels.map((model) => ({ id: Ids.short(), modelId: model.id, provider: null, accountId: accountByModel.get(model.id) ?? null }))
        : [{ id: Ids.short(), modelId: null, provider: null, accountId: null }]
    );
    setResponses({});
  }

  function applyProviders(selectedProviders: string[]) {
    const selected = providerPresets().filter((preset) => selectedProviders.includes(preset.provider));
    const nextPanels = selected.flatMap((preset) => preset.panels);
    setPanels(
      nextPanels.length > 0
        ? nextPanels.map((panel) => ({ id: Ids.short(), modelId: panel.modelId, provider: panel.provider, accountId: panel.accountId }))
        : [{ id: Ids.short(), modelId: null, provider: null, accountId: null }]
    );
    setResponses({});
  }

  function toggleFamily(family: string) {
    if (!familyPresets().some((item) => item.family === family)) return;

    const nextFamilies = activeFamilyPresets().includes(family)
      ? activeFamilyPresets().filter((item) => item !== family)
      : [...activeFamilyPresets(), family];

    setActiveFamilyPresets(nextFamilies);
    setActiveProviderPresets([]);
    applyFamilies(nextFamilies);
  }

  function toggleProvider(provider: string) {
    if (!providerPresets().some((item) => item.provider === provider)) return;

    const nextProviders = activeProviderPresets().includes(provider)
      ? activeProviderPresets().filter((item) => item !== provider)
      : [...activeProviderPresets(), provider];

    setActiveProviderPresets(nextProviders);
    setActiveFamilyPresets([]);
    applyProviders(nextProviders);
  }

  function selectScenario(scenario: Scenario) {
    setSelectedScenario(scenario);
    setResponses({});
    clearChat();
    if (scenario.isReasoning && settings.reasoningEffort === "none") {
      setSettings("reasoningEffort", "medium");
    }
  }

  function resetSettings() {
    setSettings(reconcile({ ...DEFAULT_SETTINGS }));
    setAdditionalParametersInput("");
  }

  function clearChat() {
    setChatMessages(reconcile({}));
  }

  function messagesOf(scenario: Scenario): ScenarioMessage[] {
    return scenario.messages?.length ? scenario.messages : [{ role: "user", content: scenario.prompt }];
  }

  function panelMessages(panelId: string, scenario: Scenario): ScenarioMessage[] {
    return scenario.id === "chat" && chatMessages[panelId]?.length ? chatMessages[panelId] : messagesOf(scenario);
  }

  function conversationMessages(panelId: string): ScenarioMessage[] {
    const scenario = selectedScenario();
    return scenario?.id === "chat" && chatMessages[panelId]?.length ? chatMessages[panelId] : scenarioMessages();
  }

  function systemPrompt(panelId: string): string {
    return conversationMessages(panelId)
      .filter((message) => message.role === "system")
      .map((message) => Content.message(message.content))
      .filter(Boolean)
      .join("\n\n");
  }

  function userMessages(panelId: string): ScenarioMessage[] {
    return conversationMessages(panelId).filter((message) => message.role !== "system");
  }

  function waitLabel(panelId: string): string {
    const response = responses()[panelId];
    if (response?.isLoading && response.startedAt) return Duration.format(liveNow() - response.startedAt);
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
    queueMicrotask(() => {
      const element = panelScrollElements.get(panelId);
      const response = responses()[panelId];
      if (!element || !response?.isLoading || !autoScroll[panelId]) return;
      element.scrollTop = element.scrollHeight;
    });
  }

  function onScroll(panelId: string, event: Event) {
    const element = event.currentTarget;
    if (!(element instanceof HTMLElement)) return;

    const response = responses()[panelId];
    if (!response?.isLoading) return;

    const scrollableDistance = Math.max(element.scrollHeight - element.clientHeight, 0);
    if (scrollableDistance === 0) return;

    const distanceFromBottom = scrollableDistance - element.scrollTop;
    setAutoScroll(panelId, distanceFromBottom / scrollableDistance <= SCROLL_THRESHOLD);
  }

  function streamRequest(input: StreamRequest): Promise<void> {
    const gate = deferred<void>();
    const { resolve, reject } = gate;

    if (input.signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return gate.promise;
    }

    const xhr = new XMLHttpRequest();
    let processedLength = 0;
    let headersHandled = false;
    let settled = false;
    const processor = Sse.processor(input.endpoint, input.onChunk);

    const cleanup = () => input.signal.removeEventListener("abort", abortRequest);
    const settleOnce = (callback: () => void) => {
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
    const abortRequest = () => xhr.abort();

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
        settleOnce(() => reject(new Error(ErrorText.fromResponse(xhr.responseText || ""))));
        return;
      }
      processResponseText();
      processor.flush();
      settleOnce(resolve);
    };
    xhr.onerror = () => settleOnce(() => reject(new Error("Network error")));
    xhr.ontimeout = () => settleOnce(() => reject(new Error("Request timed out")));
    xhr.onabort = () => settleOnce(() => reject(new DOMException("Aborted", "AbortError")));

    input.signal.addEventListener("abort", abortRequest, { once: true });
    const opened = Result.try({
      try: () => {
        xhr.open("POST", input.url, true);
        for (const [name, value] of Object.entries(input.headers)) xhr.setRequestHeader(name, value);
        xhr.send(input.body);
        return null;
      },
      catch: (error: unknown) => error,
    });
    if (Result.isFailure(opened)) settleOnce(() => reject(opened.failure));

    return gate.promise;
  }

  function proxyUrl(): string {
    const url = options()?.proxyBaseUrl?.trim().replace(/\/+$/, "");
    if (!url) raise(new Error("Proxy URL is not configured"));
    return url;
  }

  function setResponse(panelId: string, response: ResponseData, requestId?: string) {
    if (requestId !== undefined && requestIds.get(panelId) !== requestId) return;
    setResponses((current) => ({ ...current, [panelId]: response }));
    if (response.isLoading) scrollBottom(panelId);
  }

  function refreshOverview() {
    if (overviewTimer) clearTimeout(overviewTimer);
    overviewTimer = setTimeout(() => {
      overviewTimer = null;
      void invalidation.invalidateAccountOverview();
    }, OVERVIEW_DELAY_MS);
  }

  async function runChat(
    panel: PanelState & { modelId: string },
    scenario: Scenario,
    currentSettings: PlaygroundSettings
  ): Promise<FetchModelResult> {
    const messages = [...messagesOf(scenario)];
    setChatMessages(panel.id, messages);

    const followUps = scenario.autoFollowUps ?? [];
    for (let stepIndex = 0; stepIndex <= followUps.length; stepIndex += 1) {
      if (!batchActive() || stoppedPanels.has(panel.id)) return "aborted";

      const result = await fetchModel(
        panel.id,
        panel.modelId,
        scenario,
        currentSettings,
        panelProvider(panel),
        routeAccount(panel),
        messages
      );
      if (result !== "success") return result;

      const response = responses()[panel.id];
      const assistantContent = response?.content?.trim();
      if (!assistantContent) return "success";

      messages.push({ role: "assistant", content: assistantContent });
      setChatMessages(panel.id, [...messages]);

      const followUp = followUps[stepIndex];
      if (!followUp) return "success";

      messages.push({ role: "user", content: followUp });
      setChatMessages(panel.id, [...messages]);
    }

    return "success";
  }

  async function fetchModel(
    panelId: string,
    modelId: string,
    scenario: Scenario,
    currentSettings: PlaygroundSettings,
    provider: string | null,
    accountId: string | null,
    messages = panelMessages(panelId, scenario)
  ): Promise<FetchModelResult> {
    const requestStartedAt = Date.now();
    const requestId = Ids.short();
    let waitMs: number | null = null;
    let usedAccountId: string | null = null;
    let shouldRefreshOverview = false;
    let errorContextParameters: Record<string, unknown> | null = null;

    controllers.get(panelId)?.abort();
    requestIds.set(panelId, requestId);
    setAutoScroll(panelId, true);
    setResponse(panelId, {
      content: "",
      reasoning: "",
      toolCalls: [],
      isLoading: true,
      metrics: Tokens.metrics(null, null, null),
      startedAt: requestStartedAt,
    });

    const outcome = await settle(async () => {
      const requestBody = Body.build(modelId, messages, currentSettings);
      errorContextParameters = requestBody;
      const endpointOverrides = Body.overrides(scenario.requestOverrides, currentSettings.endpoint);
      if (endpointOverrides) Object.assign(requestBody, endpointOverrides);
      const additionalParameters = Params.parse(additionalParametersInput());
      if (additionalParameters.error) raise(new Error(`Invalid additional parameters: ${additionalParameters.error}`));
      if (additionalParameters.params) Object.assign(requestBody, additionalParameters.params);
      Body.route(requestBody, provider, accountId);
      if (!canUsePlayground()) raise(new Error(playgroundSetupMessage() || "Playground is not ready."));

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
            setResponse(
              panelId,
              {
                content: streamedContent,
                reasoning: streamedReasoning,
                toolCalls: streamedToolCalls,
                isLoading: true,
                metrics: Tokens.metrics(waitMs, firstResponseMs, usage),
                usedAccountId,
                startedAt: requestStartedAt,
              },
              requestId
            );
          },
        });

        setResponse(
          panelId,
          {
            content: streamedContent,
            reasoning: streamedReasoning,
            toolCalls: streamedToolCalls,
            isLoading: false,
            metrics: Tokens.metrics(waitMs, firstResponseMs, usage),
            usedAccountId,
          },
          requestId
        );
        return "success";
      }

      const response = await fetch(url, { method: "POST", headers, signal: controller.signal, body });

      waitMs = Date.now() - requestStartedAt;
      usedAccountId = response.headers.get("x-provider-account-id");
      shouldRefreshOverview = true;

      if (!response.ok) {
        const clonedResponse = response.clone();
        let errorMessage = "Request failed";
        const parsedError = await settle(() => response.json());
        if (parsedError.ok) {
          errorMessage = Completion.error(parsedError.value) ?? errorMessage;
        } else {
          const fallback = await settle(() => clonedResponse.text());
          if (fallback.ok && fallback.value.trim()) errorMessage = fallback.value;
        }
        raise(new Error(errorMessage));
      }

      const payload = await response.json();
      const parsed =
        currentSettings.endpoint === "messages"
          ? Completion.anthropic(payload)
          : currentSettings.endpoint === "responses"
            ? Completion.responses(payload)
            : Completion.chat(payload);
      setResponse(
        panelId,
        {
          content: parsed.content,
          reasoning: parsed.reasoning,
          toolCalls: parsed.toolCalls,
          isLoading: false,
          metrics: Tokens.metrics(waitMs, Date.now() - requestStartedAt, parsed.usage),
          usedAccountId,
        },
        requestId
      );
      return "success" as const;
    });

    if (requestIds.get(panelId) === requestId) {
      controllers.delete(panelId);
      requestIds.delete(panelId);
    }
    if (shouldRefreshOverview) refreshOverview();
    if (outcome.ok) return outcome.value;

    const error = outcome.error;
    if (error instanceof DOMException && error.name === "AbortError") {
      const existing = responses()[panelId];
      if (existing && requestIds.get(panelId) === requestId) setResponse(panelId, { ...existing, isLoading: false, error: undefined });
      return "aborted";
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const providerByAccount = accountId ? (accountsById().get(accountId)?.provider ?? null) : null;
    const usedAccountProvider = usedAccountId ? (accountsById().get(usedAccountId)?.provider ?? null) : null;
    const errorProvider = provider ?? providerByAccount ?? usedAccountProvider ?? null;
    const errorDetails = ErrorText.build(errorMessage, {
      model: modelId,
      provider: errorProvider,
      endpoint: currentSettings.endpoint,
      parameters: errorContextParameters,
      messages,
    });
    setResponse(
      panelId,
      {
        content: "",
        reasoning: "",
        toolCalls: [],
        isLoading: false,
        error: errorMessage,
        errorDetails,
        metrics: Tokens.metrics(waitMs, null, null),
        usedAccountId,
      },
      requestId
    );
    return "error";
  }

  async function runScenario(requestedLoopCount = 1) {
    const scenario = selectedScenario();
    if (!scenario || !canRunPlayground()) return;
    clearChat();
    let currentSettings = { ...settings };
    if (scenario.isReasoning && currentSettings.reasoningEffort === "none") {
      setSettings("reasoningEffort", "medium");
      currentSettings = { ...settings };
    }

    const panelsWithModels = panels().filter((panel): panel is PanelState & { modelId: string } => Boolean(panel.modelId));
    if (panelsWithModels.length === 0) return;

    const totalLoops = Math.max(1, Math.floor(requestedLoopCount));
    setActiveLoopProgress(totalLoops > 1 ? { current: 1, total: totalLoops } : null);
    stoppedPanels.clear();
    setBatchActive(true);

    await Effect.runPromise(
      Effect.all(
        panelsWithModels.map((panel) =>
          Effect.promise(async () => {
            for (let iteration = 0; iteration < totalLoops; iteration += 1) {
              if (!batchActive() || stoppedPanels.has(panel.id)) break;
              setActiveLoopProgress(totalLoops > 1 ? { current: iteration + 1, total: totalLoops } : null);

              const result =
                scenario.id === "chat"
                  ? await runChat(panel, scenario, currentSettings)
                  : await fetchModel(panel.id, panel.modelId, scenario, currentSettings, panelProvider(panel), routeAccount(panel));
              if (result !== "success") {
                stoppedPanels.add(panel.id);
                break;
              }
            }
          })
        ),
        { concurrency: Math.max(1, panelsWithModels.length) }
      )
    );
    setActiveLoopProgress(null);
    stoppedPanels.clear();
    setBatchActive(false);
  }

  function stopPanel(panelId: string) {
    controllers.get(panelId)?.abort();
    controllers.delete(panelId);
    requestIds.delete(panelId);
    stoppedPanels.add(panelId);

    const response = responses()[panelId];
    if (response?.isLoading) setResponse(panelId, { ...response, isLoading: false, error: undefined });
  }

  function stopAll() {
    for (const panelId of Array.from(controllers.keys())) stopPanel(panelId);
    setBatchActive(false);
    setActiveLoopProgress(null);
  }

  async function retryPanel(panelId: string) {
    const panel = panels().find((item) => item.id === panelId);
    const scenario = selectedScenario();
    if (!panel?.modelId || !scenario || !canRunPlayground()) return;
    const wasBatchActive = batchActive();
    if (wasBatchActive) stoppedPanels.add(panelId);
    if (scenario.id === "chat") {
      setBatchActive(true);
      stoppedPanels.delete(panel.id);
      await runChat(panel as PanelState & { modelId: string }, scenario, { ...settings });
      setBatchActive(wasBatchActive);
      return;
    }
    await fetchModel(panel.id, panel.modelId, scenario, { ...settings }, panelProvider(panel), routeAccount(panel));
  }

  function onPress(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    document.getSelection()?.removeAllRanges();
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressFired = false;
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      document.getSelection()?.removeAllRanges();
      setLoopCountInput(String(loopCount()));
      setLoopDialogOpen(true);
    }, LONG_PRESS_MS);
  }

  function pressRelease() {
    if (!longPressTimer) return;
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function onTap() {
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    void runScenario();
  }

  function runLoop() {
    if (!loopCountValid()) return;
    setLoopCount(parsedLoopCount());
    setLoopDialogOpen(false);
    void runScenario(parsedLoopCount());
  }

  async function copyError(panelId: string) {
    const response = responses()[panelId];
    const error = response?.error;
    if (!error) return;

    const copied = await settle(() => navigator.clipboard.writeText(response.errorDetails ?? error));
    if (!copied.ok) return;

    setCopiedError(panelId, true);
    const existingTimeout = copyErrorTimeouts.get(panelId);
    if (existingTimeout) clearTimeout(existingTimeout);
    copyErrorTimeouts.set(
      panelId,
      setTimeout(() => {
        setCopiedError(panelId, false);
        copyErrorTimeouts.delete(panelId);
      }, 1800)
    );
  }

  function initializeFromRoute() {
    const query = routeQuery();
    if (!options() || initializedFromRoute()) return;

    applyQuery(query);
    const modelId = Query.string(query.model);
    const accountId = Query.string(query.accountId);
    const compareAuto = autoCompare(query.compare);

    if (modelId) {
      const model = modelsById().get(modelId);
      if (compareAuto && model) {
        setPanels(autoPanels(model));
        setInitializedFromRoute(true);
        return;
      }

      if (model) {
        setPanels([{ id: Ids.short(), modelId, provider: null, accountId: queryAccount(accountId, modelId) }]);
        setInitializedFromRoute(true);
        return;
      }
    }

    if (accountId) {
      const account = accountsById().get(accountId);
      if (account) {
        const compatibleModels = models().filter((model) => accountSupports(account, model));
        setPanels(
          compatibleModels.length > 0
            ? compatibleModels.map((model) => ({ id: Ids.short(), modelId: model.id, provider: null, accountId }))
            : [{ id: Ids.short(), modelId: null, provider: null, accountId }]
        );
        setInitializedFromRoute(true);
        return;
      }
    }

    setInitializedFromRoute(true);
  }

  function syncRoute(query: PlaygroundQuery) {
    if (!initializedFromRoute() || !options()) return;

    applyQuery(query);
    const modelId = Query.string(query.model);
    const accountId = Query.string(query.accountId);
    const compareAuto = autoCompare(query.compare);

    if (modelId) {
      const model = modelsById().get(modelId);
      if (compareAuto && model) {
        setPanels(autoPanels(model));
        setResponses({});
        return;
      }

      if (model) {
        setPanels([{ id: Ids.short(), modelId, provider: null, accountId: queryAccount(accountId, modelId) }]);
        setResponses({});
        return;
      }
    }

    const account = accountId ? accountsById().get(accountId) : undefined;
    if (account && accountId) {
      const compatibleModels = models().filter((m) => accountSupports(account, m));
      setPanels(
        compatibleModels.length > 0
          ? compatibleModels.map((m) => ({ id: Ids.short(), modelId: m.id, provider: null, accountId }))
          : [{ id: Ids.short(), modelId: null, provider: null, accountId }]
      );
      setResponses({});
    }
  }

  function pruneUnavailablePanels() {
    const availableIds = filteredModelIds();
    setPanels((current) =>
      current.map((panel) =>
        panel.modelId && !availableIds.has(panel.modelId) ? { ...panel, modelId: null, provider: null, accountId: null } : panel
      )
    );
    setActiveFamilyPresets((current) => current.filter((family) => familyPresets().some((preset) => preset.family === family)));
    setActiveProviderPresets((current) =>
      current.filter((provider) => providerPresets().some((preset) => preset.provider === provider))
    );
  }

  function syncLiveTimer() {
    if (isAnyLoading()) {
      if (liveTimer) return;
      liveTimer = setInterval(() => setLiveNow(Date.now()), 100);
      return;
    }

    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  onMount(() => {
    setProviderPresetExpanded(true);
    if (window.matchMedia("(min-width: 640px)").matches) setFamilyPresetExpanded(true);
  });

  onCleanup(() => {
    stopAll();
    if (liveTimer) clearInterval(liveTimer);
    if (longPressTimer) clearTimeout(longPressTimer);
    if (overviewTimer) clearTimeout(overviewTimer);
    for (const timeout of copyErrorTimeouts.values()) clearTimeout(timeout);
    copyErrorTimeouts.clear();
  });

  return {
    SCENARIOS,
    ENDPOINT_OPTIONS,
    REASONING_OPTIONS,
    options,
    optionsQuery,
    models,
    hasAccount,
    isProxyConfigured,
    canUsePlayground,
    selectedScenario,
    settings,
    setSettings,
    settingsOpen,
    setSettingsOpen,
    panels,
    responses,
    loopDialogOpen,
    setLoopDialogOpen,
    loopCountInput,
    setLoopCountInput,
    additionalParametersInput,
    setAdditionalParametersInput,
    activeFamilyPresets,
    activeProviderPresets,
    familyPresetExpanded,
    setFamilyPresetExpanded,
    providerPresetExpanded,
    setProviderPresetExpanded,
    pickerOpen,
    setPickerOpen,
    pickerStep,
    setPickerStep,
    pendingModel,
    setPendingModel,
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
    playgroundSetupMessage,
    loopCountValid,
    loopBadge,
    isChatScenario,
    isVisionScenario,
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
    initializeFromRoute,
    syncRoute,
    pruneUnavailablePanels,
    syncLiveTimer,
    labelOf,
    extractMessageText: (content: ScenarioMessage["content"]) => Content.message(content),
    extractImageUrls: (content: ScenarioMessage["content"]) => Content.images(content),
    formatToolArguments: (argumentsText: string) => ToolCalls.format(argumentsText),
  };
}
