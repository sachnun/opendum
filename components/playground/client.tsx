"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import {
  ChatPanel,
  type ModelOption,
  type ProviderAccountOption,
  type ResponseData,
} from "./chat-panel";
import { ScenarioSelector, type Scenario } from "./scenario-selector";
import {
  SettingsSheet,
  DEFAULT_SETTINGS,
  type PlaygroundSettings,
} from "./settings-sheet";
import { Card } from "@/components/ui/card";

interface PlaygroundClientProps {
  models: ModelOption[];
  providerAccounts: ProviderAccountOption[];
}

interface PanelState {
  id: string;
  modelId: string | null;
  accountId: string | null;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!part || typeof part !== "object") {
        return "";
      }

      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

interface ParsedUsageData {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

function normalizeTokenValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.round(value);
}

function extractUsageData(payload: unknown): ParsedUsageData | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const usageRecord = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
  };

  const inputTokens =
    normalizeTokenValue(usageRecord.prompt_tokens) ??
    normalizeTokenValue(usageRecord.input_tokens);
  const outputTokens =
    normalizeTokenValue(usageRecord.completion_tokens) ??
    normalizeTokenValue(usageRecord.output_tokens);
  const totalTokens = normalizeTokenValue(usageRecord.total_tokens);

  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function mergeUsageData(
  current: ParsedUsageData | null,
  incoming: ParsedUsageData | null
): ParsedUsageData | null {
  if (!incoming) {
    return current;
  }

  return {
    inputTokens: incoming.inputTokens ?? current?.inputTokens ?? null,
    outputTokens: incoming.outputTokens ?? current?.outputTokens ?? null,
    totalTokens: incoming.totalTokens ?? current?.totalTokens ?? null,
  };
}

function buildResponseMetrics(
  waitMs: number | null,
  firstResponseMs: number | null,
  usage: ParsedUsageData | null
) {
  const inputTokens = usage?.inputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  const totalTokens =
    usage?.totalTokens ??
    (inputTokens === null && outputTokens === null
      ? null
      : (inputTokens ?? 0) + (outputTokens ?? 0));

  return {
    waitMs,
    firstResponseMs,
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

interface ParsedCompletionData {
  content: string;
  reasoning: string;
  toolCallsText: string;
  usage: ParsedUsageData | null;
}

function extractToolCallsText(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return "";
  }

  const lines = toolCalls
    .map((toolCall, index) => {
      if (!toolCall || typeof toolCall !== "object") {
        return `- tool_${index + 1}()`;
      }

      const fn = (toolCall as { function?: unknown }).function;
      if (!fn || typeof fn !== "object") {
        return `- tool_${index + 1}()`;
      }

      const name =
        typeof (fn as { name?: unknown }).name === "string"
          ? ((fn as { name: string }).name || `tool_${index + 1}`)
          : `tool_${index + 1}`;

      const args = (fn as { arguments?: unknown }).arguments;
      const argText =
        typeof args === "string"
          ? args.trim() || "{}"
          : args === undefined
            ? "{}"
            : JSON.stringify(args);

      return `- ${name}(${argText})`;
    })
    .filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  return `Tool calls:\n${lines.join("\n")}`;
}

function extractChatCompletionData(payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") {
    return { content: "", reasoning: "", toolCallsText: "", usage: null };
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      content: "",
      reasoning: "",
      toolCallsText: "",
      usage: extractUsageData(payload),
    };
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    return {
      content: "",
      reasoning: "",
      toolCallsText: "",
      usage: extractUsageData(payload),
    };
  }

  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return {
      content: "",
      reasoning: "",
      toolCallsText: "",
      usage: extractUsageData(payload),
    };
  }

  return {
    content: extractTextContent((message as { content?: unknown }).content),
    reasoning: extractTextContent(
      (message as { reasoning_content?: unknown }).reasoning_content
    ),
    toolCallsText: extractToolCallsText(
      (message as { tool_calls?: unknown }).tool_calls
    ),
    usage: extractUsageData(payload),
  };
}

function extractStreamChunkData(payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") {
    return { content: "", reasoning: "", toolCallsText: "", usage: null };
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      content: "",
      reasoning: "",
      toolCallsText: "",
      usage: extractUsageData(payload),
    };
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    return {
      content: "",
      reasoning: "",
      toolCallsText: "",
      usage: extractUsageData(payload),
    };
  }

  const delta = (firstChoice as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") {
    return {
      content: "",
      reasoning: "",
      toolCallsText: "",
      usage: extractUsageData(payload),
    };
  }

  return {
    content: extractTextContent((delta as { content?: unknown }).content),
    reasoning: extractTextContent(
      (delta as { reasoning_content?: unknown }).reasoning_content
    ),
    toolCallsText: "",
    usage: extractUsageData(payload),
  };
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return null;
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : null;
}

function processSseEvents(
  events: string[],
  onChunk: (chunk: ParsedCompletionData) => void
) {
  for (const event of events) {
    const lines = event.split(/\r?\n/);

    for (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }

      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const errorMessage = extractErrorMessage(parsed);
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      const chunk = extractStreamChunkData(parsed);
      if (chunk.content || chunk.reasoning || chunk.toolCallsText || chunk.usage) {
        onChunk(chunk);
      }
    }
  }
}

async function consumeChatCompletionStream(
  response: Response,
  onChunk: (chunk: ParsedCompletionData) => void
) {
  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    processSseEvents(events, onChunk);
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    processSseEvents([buffer], onChunk);
  }
}

export function PlaygroundClient({ models, providerAccounts }: PlaygroundClientProps) {
  const [panels, setPanels] = React.useState<PanelState[]>(() => [
    {
      id: generateId(),
      modelId: null,
      accountId: null,
    },
  ]);

  const [selectedScenario, setSelectedScenario] = React.useState<Scenario | null>(null);
  const [settings, setSettings] = React.useState<PlaygroundSettings>(DEFAULT_SETTINGS);
  const [responses, setResponses] = React.useState<Record<string, ResponseData>>({});
  const [isAnyLoading, setIsAnyLoading] = React.useState(false);
  const maxPanels = Math.max(models.length, 1);

  const providerAccountsById = React.useMemo(
    () => new Map(providerAccounts.map((account) => [account.id, account])),
    [providerAccounts]
  );

  const modelsById = React.useMemo(
    () => new Map(models.map((model) => [model.id, model])),
    [models]
  );

  const getValidAccountIdForPanel = React.useCallback(
    (panel: PanelState): string | null => {
      if (!panel.accountId || !panel.modelId) {
        return null;
      }

      const selectedModel = modelsById.get(panel.modelId);
      if (!selectedModel) {
        return null;
      }

      const account = providerAccountsById.get(panel.accountId);
      if (!account || !selectedModel.providers.includes(account.provider)) {
        return null;
      }

      return account.id;
    },
    [modelsById, providerAccountsById]
  );

  const updatePanelSelection = (
    panelId: string,
    modelId: string,
    accountId: string | null
  ) => {
    setPanels((prev) =>
      prev.map((panel) => {
        if (panel.id !== panelId) {
          return panel;
        }

        if (!accountId) {
          return { ...panel, modelId, accountId: null };
        }

        const selectedAccount = providerAccountsById.get(accountId);
        const selectedModel = modelsById.get(modelId);
        if (
          !selectedAccount ||
          !selectedModel ||
          !selectedModel.providers.includes(selectedAccount.provider)
        ) {
          return { ...panel, modelId, accountId: null };
        }

        return { ...panel, modelId, accountId };
      })
    );
  };

  const addPanel = () => {
    setPanels((prev) => {
      if (prev.length >= maxPanels) {
        return prev;
      }

      return [...prev, { id: generateId(), modelId: null, accountId: null }];
    });
  };

  const removePanel = (panelId: string) => {
    setPanels((prev) => prev.filter((panel) => panel.id !== panelId));
    setResponses((prev) => {
      const next = { ...prev };
      delete next[panelId];
      return next;
    });
  };

  const canAddPanel = panels.length < maxPanels;
  const hasSelectedModel = panels.some((panel) => panel.modelId);

  const handleScenarioSelect = async (scenario: Scenario) => {
    setSelectedScenario(scenario);

    let currentSettings = settings;
    if (scenario.isReasoning && settings.reasoningEffort === "none") {
      currentSettings = { ...settings, reasoningEffort: "medium" };
      setSettings(currentSettings);
    }

    const panelsWithModels = panels.filter((panel) => panel.modelId);
    if (panelsWithModels.length === 0) {
      return;
    }

    setIsAnyLoading(true);

    const clearedResponses: Record<string, ResponseData> = {};
    panelsWithModels.forEach((panel) => {
      clearedResponses[panel.id] = {
        content: "",
        reasoning: "",
        isLoading: true,
        metrics: buildResponseMetrics(null, null, null),
      };
    });
    setResponses(clearedResponses);

    const promises = panelsWithModels.map((panel) =>
      fetchFromModel(
        panel.id,
        panel.modelId!,
        scenario,
        currentSettings,
        getValidAccountIdForPanel(panel)
      )
    );

    await Promise.all(promises);
    setIsAnyLoading(false);
  };

  const fetchFromModel = async (
    panelId: string,
    modelId: string,
    scenario: Scenario,
    currentSettings: PlaygroundSettings = settings,
    accountId: string | null = null
  ) => {
    setResponses((prev) => ({
      ...prev,
      [panelId]: {
        content: "",
        reasoning: "",
        isLoading: true,
        metrics: buildResponseMetrics(null, null, null),
      },
    }));

    const requestStartedAt = Date.now();
    let waitMs: number | null = null;

    try {
      const scenarioMessages =
        Array.isArray(scenario.messages) && scenario.messages.length > 0
          ? scenario.messages
          : [{ role: "user", content: scenario.prompt }];

      const requestBody: Record<string, unknown> = {
        model: modelId,
        messages: scenarioMessages,
        stream: currentSettings.streamResponses,
        temperature: currentSettings.temperature,
        top_p: currentSettings.topP,
        max_tokens: currentSettings.maxTokens,
        presence_penalty: currentSettings.presencePenalty,
        frequency_penalty: currentSettings.frequencyPenalty,
      };

      if (accountId) {
        requestBody.provider_account_id = accountId;
      }

      if (currentSettings.reasoningEffort !== "none") {
        requestBody.reasoning_effort = currentSettings.reasoningEffort;
      }

      if (scenario.requestOverrides) {
        Object.assign(requestBody, scenario.requestOverrides);
      }

      const streamValue = requestBody.stream;
      const shouldStream = typeof streamValue === "boolean" ? streamValue : true;

      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      waitMs = Date.now() - requestStartedAt;

      if (!response.ok) {
        const clonedResponse = response.clone();
        let errorMessage = "Request failed";

        try {
          const errorData = await response.json();
          const apiError = extractErrorMessage(errorData);
          if (apiError) {
            errorMessage = apiError;
          }
        } catch {
          const errorText = await clonedResponse.text();
          if (errorText.trim()) {
            errorMessage = errorText;
          }
        }

        throw new Error(errorMessage);
      }

      const contentType = response.headers.get("content-type") || "";
      const isStreamingResponse =
        shouldStream && contentType.includes("text/event-stream");

      if (isStreamingResponse) {
        let streamedContent = "";
        let streamedReasoning = "";
        let firstResponseMs: number | null = null;
        let usage: ParsedUsageData | null = null;

        await consumeChatCompletionStream(response, (chunk) => {
          if (firstResponseMs === null) {
            firstResponseMs = Date.now() - requestStartedAt;
          }

          streamedContent += chunk.content;
          streamedReasoning += chunk.reasoning;
          usage = mergeUsageData(usage, chunk.usage);

          setResponses((prev) => ({
            ...prev,
            [panelId]: {
              content: streamedContent,
              reasoning: streamedReasoning,
              isLoading: true,
              metrics: buildResponseMetrics(waitMs, firstResponseMs, usage),
            },
          }));
        });

        setResponses((prev) => ({
          ...prev,
          [panelId]: {
            content: streamedContent,
            reasoning: streamedReasoning,
            isLoading: false,
            metrics: buildResponseMetrics(waitMs, firstResponseMs, usage),
          },
        }));

        return;
      }

      const data = await response.json();
      const parsedData = extractChatCompletionData(data);
      const firstResponseMs = Date.now() - requestStartedAt;
      const combinedContent = [parsedData.toolCallsText, parsedData.content]
        .filter((part) => typeof part === "string" && part.trim().length > 0)
        .join("\n\n");

      setResponses((prev) => ({
        ...prev,
        [panelId]: {
          content: combinedContent,
          reasoning: parsedData.reasoning,
          isLoading: false,
          metrics: buildResponseMetrics(waitMs, firstResponseMs, parsedData.usage),
        },
      }));
    } catch (error) {
      setResponses((prev) => ({
        ...prev,
        [panelId]: {
          content: "",
          reasoning: "",
          isLoading: false,
          error: error instanceof Error ? error.message : "Unknown error",
          metrics: buildResponseMetrics(waitMs, null, null),
        },
      }));
    }
  };

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">Playground</h1>
          <SettingsSheet
            settings={settings}
            onSettingsChange={setSettings}
            disabled={isAnyLoading}
          />
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Scenario</h2>
        <ScenarioSelector
          selectedScenario={selectedScenario?.id || null}
          onSelect={handleScenarioSelect}
          disabled={isAnyLoading || !hasSelectedModel}
        />
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {panels.map((panel) => {
          const selectedAccountId = getValidAccountIdForPanel(panel);

          return (
            <ChatPanel
              key={panel.id}
              panelId={panel.id}
              models={models}
              accountOptions={providerAccounts}
              selectedModel={panel.modelId}
              selectedAccountId={selectedAccountId}
              onModelChange={(modelId, accountId) =>
                updatePanelSelection(panel.id, modelId, accountId)
              }
              onRemove={() => removePanel(panel.id)}
              response={responses[panel.id]}
              disabled={isAnyLoading}
            />
          );
        })}

        {canAddPanel && (
          <Card className="group h-[400px] overflow-hidden border-2 border-dashed border-border/80 bg-background p-0 transition-colors hover:border-muted-foreground/45">
            <button
              type="button"
              onClick={addPanel}
              disabled={isAnyLoading}
              aria-label="Add comparison card"
              className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground transition-colors hover:bg-muted/15 hover:text-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-muted-foreground/30 transition-colors group-hover:border-muted-foreground/45">
                <Plus className="h-4 w-4 transition-colors group-hover:text-foreground/80" />
              </span>
              <span className="text-sm font-medium">Add comparison</span>
            </button>
          </Card>
        )}
      </div>
    </div>
  );
}
