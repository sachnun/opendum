import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { categorizeModelFamily } from "../../lib/model-families";
import { compareModelEntries } from "../../lib/model-sort";
import { getProviderLabel } from "../../lib/provider-accounts";
import type { PlaygroundOptions } from "../../lib/dashboard-api-types";
import { useDashboardApi } from "../../hooks/useDashboardApi";
import { dashboardDataKeys, useDashboardData } from "../../hooks/useDashboardDataInvalidation";
import { UiBadge } from "../../components/ui/UiBadge";
import { UiButton } from "../../components/ui/UiButton";
import { UiIcon } from "../../components/ui/UiIcon";
import { UiSwitch } from "../../components/ui/UiSwitch";
import { cn } from "../../lib/utils";

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
type PlaygroundEndpoint = "chat_completions" | "messages" | "responses";
type ToolCallData = { name: string; arguments: string };
type ParsedUsageData = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
type ParsedCompletionData = { content: string; reasoning: string; toolCalls: ToolCallData[]; usage: ParsedUsageData | null };

interface ResponseData {
  content: string;
  reasoning: string;
  toolCalls: ToolCallData[];
  isLoading: boolean;
  error?: string;
  waitMs: number | null;
  firstResponseMs: number | null;
  usedAccountId?: string | null;
}

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

function createSseChunkProcessor(endpoint: PlaygroundEndpoint, onChunk: (chunk: ParsedCompletionData) => void) {
  let buffer = "";
  const processEvent = (data: string) => {
    if (!data || data === "[DONE]") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (endpoint === "messages") {
      // anthropic SSE: content_block_delta / thinking_delta / message_delta
      if (parsed["type"] === "content_block_delta") {
        const delta = (parsed["delta"] ?? {}) as Record<string, unknown>;
        if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          onChunk({ content: delta["text"], reasoning: "", toolCalls: [], usage: null });
        } else if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
          onChunk({ content: "", reasoning: delta["thinking"], toolCalls: [], usage: null });
        } else if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
          onChunk({ content: "", reasoning: "", toolCalls: [{ name: "tool", arguments: delta["partial_json"] }], usage: null });
        }
      } else if (parsed["type"] === "message_delta") {
        const usage = (parsed["usage"] ?? {}) as Record<string, unknown>;
        onChunk({ content: "", reasoning: "", toolCalls: [], usage: { inputTokens: toInt(usage["input_tokens"]), outputTokens: toInt(usage["output_tokens"]), totalTokens: null } });
      }
      return;
    }
    if (endpoint === "responses") {
      const type = typeof parsed["type"] === "string" ? parsed["type"] : "";
      if (type === "response.output_text.delta") {
        onChunk({ content: typeof parsed["delta"] === "string" ? parsed["delta"] : "", reasoning: "", toolCalls: [], usage: null });
      } else if (type === "response.reasoning.delta" || type === "response.reasoning_text.delta") {
        onChunk({ content: "", reasoning: typeof parsed["delta"] === "string" ? parsed["delta"] : "", toolCalls: [], usage: null });
      } else if (type === "response.function_call_arguments.delta") {
        onChunk({ content: "", reasoning: "", toolCalls: [{ name: "tool", arguments: typeof parsed["delta"] === "string" ? parsed["delta"] : "" }], usage: null });
      } else if (type === "response.completed" || type === "response.done") {
        const response = (parsed["response"] ?? parsed) as Record<string, unknown>;
        const usage = (response["usage"] ?? {}) as Record<string, unknown>;
        onChunk({ content: "", reasoning: "", toolCalls: [], usage: { inputTokens: toInt(usage["input_tokens"]), outputTokens: toInt(usage["output_tokens"]), totalTokens: null } });
      }
      return;
    }
    // chat.completion.chunk
    const choices = (parsed["choices"] ?? []) as unknown[];
    if (choices.length === 0) return;
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const delta = (choice["delta"] ?? {}) as Record<string, unknown>;
    const content = typeof delta["content"] === "string" ? delta["content"] : "";
    const reasoning = typeof delta["reasoning_content"] === "string" ? delta["reasoning_content"] : "";
    const toolCalls: ToolCallData[] = [];
    const calls = (delta["tool_calls"] ?? []) as unknown[];
    for (const raw of calls) {
      const call = (raw ?? {}) as Record<string, unknown>;
      const fn = (call["function"] ?? {}) as Record<string, unknown>;
      toolCalls.push({ name: typeof fn["name"] === "string" ? fn["name"] : "tool", arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : "" });
    }
    const usage = (parsed["usage"] ?? null) as Record<string, unknown> | null;
    onChunk({
      content,
      reasoning,
      toolCalls,
      usage: usage ? { inputTokens: toInt(usage["prompt_tokens"]), outputTokens: toInt(usage["completion_tokens"]), totalTokens: null } : null,
    });
  };
  return {
    feed(chunk: string) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) processEvent(line.slice(5).trim());
        }
      }
    },
    flush() {
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data:")) processEvent(line.slice(5).trim());
      }
      buffer = "";
    },
  };
}

function toInt(value: unknown): number | null {
  if (typeof value === "number") return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function extractChatCompletionData(payload: Record<string, unknown>): ParsedCompletionData {
  const content: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: ToolCallData[] = [];
  const choices = (payload["choices"] ?? []) as unknown[];
  if (choices.length > 0) {
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const message = (choice["message"] ?? {}) as Record<string, unknown>;
    if (typeof message["content"] === "string") content.push(message["content"]);
    if (typeof message["reasoning_content"] === "string") reasoning.push(message["reasoning_content"]);
    const calls = (message["tool_calls"] ?? []) as unknown[];
    for (const raw of calls) {
      const call = (raw ?? {}) as Record<string, unknown>;
      const fn = (call["function"] ?? {}) as Record<string, unknown>;
      toolCalls.push({ name: typeof fn["name"] === "string" ? fn["name"] : "", arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : "" });
    }
  }
  const usage = (payload["usage"] ?? null) as Record<string, unknown> | null;
  return {
    content: content.join(""),
    reasoning: reasoning.join(""),
    toolCalls,
    usage: usage ? { inputTokens: toInt(usage["prompt_tokens"]), outputTokens: toInt(usage["completion_tokens"]), totalTokens: toInt(usage["total_tokens"]) } : null,
  };
}

function extractMessagesCompletionData(payload: Record<string, unknown>): ParsedCompletionData {
  const content: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: ToolCallData[] = [];
  const blocks = (payload["content"] ?? []) as unknown[];
  for (const raw of blocks) {
    const block = (raw ?? {}) as Record<string, unknown>;
    if (block["type"] === "text" && typeof block["text"] === "string") content.push(block["text"]);
    if (block["type"] === "thinking" && typeof block["thinking"] === "string") reasoning.push(block["thinking"]);
    if (block["type"] === "tool_use") toolCalls.push({ name: typeof block["name"] === "string" ? block["name"] : "", arguments: JSON.stringify(block["input"] ?? {}) });
  }
  const usage = (payload["usage"] ?? {}) as Record<string, unknown>;
  return {
    content: content.join(""),
    reasoning: reasoning.join(""),
    toolCalls,
    usage: { inputTokens: toInt(usage["input_tokens"]), outputTokens: toInt(usage["output_tokens"]), totalTokens: null },
  };
}

function extractResponsesCompletionData(payload: Record<string, unknown>): ParsedCompletionData {
  const content: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: ToolCallData[] = [];
  const output = (payload["output"] ?? []) as unknown[];
  for (const raw of output) {
    const item = (raw ?? {}) as Record<string, unknown>;
    if (item["type"] === "message") {
      const parts = (item["content"] ?? []) as unknown[];
      for (const partRaw of parts) {
        const part = (partRaw ?? {}) as Record<string, unknown>;
        if (part["type"] === "output_text" && typeof part["text"] === "string") content.push(part["text"]);
      }
    } else if (item["type"] === "reasoning") {
      if (typeof item["text"] === "string") reasoning.push(item["text"]);
    } else if (item["type"] === "function_call") {
      toolCalls.push({ name: typeof item["name"] === "string" ? item["name"] : "", arguments: typeof item["arguments"] === "string" ? item["arguments"] : "" });
    }
  }
  const usage = (payload["usage"] ?? {}) as Record<string, unknown>;
  return {
    content: content.join(""),
    reasoning: reasoning.join(""),
    toolCalls,
    usage: { inputTokens: toInt(usage["input_tokens"]), outputTokens: toInt(usage["output_tokens"]), totalTokens: null },
  };
}

function extractErrorMessage(errorData: unknown): string | null {
  if (!errorData || typeof errorData !== "object") return null;
  const error = (errorData as Record<string, unknown>)["error"];
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  const message = (errorData as Record<string, unknown>)["message"];
  return typeof message === "string" ? message : null;
}

export default function PlaygroundPage() {
  const [searchParams] = useSearchParams();
  const dashboardApi = useDashboardApi();
  const { data: options } = useDashboardData<PlaygroundOptions>(dashboardDataKeys.playgroundOptions, () => dashboardApi.playground.options(), { enabled: true });

  const [settings, setSettings] = useState<PlaygroundSettings>(DEFAULT_SETTINGS);
  const [modelId, setModelId] = useState<string>("");
  const [provider, setProvider] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [messagesInput, setMessagesInput] = useState("Hello! Can you help me with a quick question?");
  const [additionalParametersInput, setAdditionalParametersInput] = useState("");
  const [response, setResponse] = useState<ResponseData>({ content: "", reasoning: "", toolCalls: [], isLoading: false, waitMs: null, firstResponseMs: null });
  const [errorMessage, setErrorMessage] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  const models = options?.models ?? [];
  const providerAccounts = options?.providerAccounts ?? [];

  useEffect(() => {
    const modelParam = searchParams.get("model");
    if (modelParam && models.length > 0) {
      const match = models.find((m) => m.id === modelParam);
      if (match) setModelId(match.id);
    }
    const accountParam = searchParams.get("accountId");
    if (accountParam) setAccountId(accountParam);
  }, [searchParams, models]);

  const modelOptions = useMemo(() => {
    const grouped = new Map<string, typeof models>();
    for (const model of models) {
      const family = categorizeModelFamily(model.family);
      const list = grouped.get(family) ?? [];
      list.push(model);
      grouped.set(family, list);
    }
    for (const list of grouped.values()) list.sort(compareModelEntries);
    return [...grouped.entries()];
  }, [models]);

  const selectedModel = models.find((m) => m.id === modelId) ?? null;
  const usableProviders = useMemo(() => {
    if (!selectedModel) return [];
    return selectedModel.providers.map((p) => ({ id: p, label: getProviderLabel(p) }));
  }, [selectedModel]);

  useEffect(() => {
    if (!selectedModel) {
      setProvider(null);
      return;
    }
    if (provider && selectedModel.providers.includes(provider)) return;
    setProvider(selectedModel.providers[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel]);

  const proxyBaseUrl = (options?.proxyBaseUrl ?? "").trim().replace(/\/+$/, "");
  const canUsePlayground = Boolean(proxyBaseUrl && modelId);

  const buildRequestBody = useCallback((): Record<string, unknown> => {
    let messages: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(messagesInput) as unknown;
      if (Array.isArray(parsed)) messages = parsed as Array<Record<string, unknown>>;
    } catch {
      messages = [{ role: "user", content: messagesInput }];
    }
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream: settings.streamResponses,
      temperature: settings.temperature,
      top_p: settings.topP,
      max_tokens: settings.maxTokens,
      presence_penalty: settings.presencePenalty,
      frequency_penalty: settings.frequencyPenalty,
    };
    if (settings.reasoningEffort !== "none") {
      body["reasoning_effort"] = settings.reasoningEffort;
    }
    if (additionalParametersInput.trim()) {
      try {
        const extra = JSON.parse(additionalParametersInput) as Record<string, unknown>;
        Object.assign(body, extra);
      } catch {
        // ignore invalid extra params (validated at send time)
      }
    }
    if (provider) {
      body["model"] = `${provider}/${modelId}`;
    }
    if (accountId) {
      body["model"] = `${accountId}/${modelId}`;
    }
    return body;
  }, [modelId, provider, accountId, messagesInput, additionalParametersInput, settings]);

  const sendRequest = async () => {
    if (!canUsePlayground || response.isLoading) return;
    setErrorMessage("");
    setResponse({ content: "", reasoning: "", toolCalls: [], isLoading: true, waitMs: null, firstResponseMs: null });
    const requestStartedAt = Date.now();
    let waitMs: number | null = null;
    let usedAccountId: string | null = null;
    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const body = buildRequestBody();
      if (additionalParametersInput.trim()) {
        try {
          JSON.parse(additionalParametersInput);
        } catch (error) {
          throw new Error(`Invalid additional parameters: ${(error as Error).message}`);
        }
      }
      const auth = await dashboardApi.playground.auth({ endpoint: settings.endpoint });
      const endpointPath = settings.endpoint === "messages" ? "/v1/messages" : settings.endpoint === "responses" ? "/v1/responses" : "/v1/chat/completions";
      const url = `${proxyBaseUrl}${endpointPath}`;
      const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...auth.headers };

      if (body["stream"] !== false) {
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
        waitMs = Date.now() - requestStartedAt;
        usedAccountId = response.headers.get("x-provider-account-id");
        if (!response.ok) {
          const text = await response.text();
          let message = "Request failed";
          try {
            message = extractErrorMessage(JSON.parse(text)) ?? (text || message);
          } catch {
            message = text || message;
          }
          throw new Error(message);
        }
        const processor = createSseChunkProcessor(settings.endpoint, (chunk) => {
          setResponse((current) => ({
            ...current,
            content: current.content + chunk.content,
            reasoning: current.reasoning + chunk.reasoning,
            toolCalls: chunk.toolCalls.length > 0 ? [...current.toolCalls, ...chunk.toolCalls] : current.toolCalls,
            firstResponseMs: current.firstResponseMs ?? Date.now() - requestStartedAt,
            waitMs,
            usedAccountId,
          }));
        });
        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) processor.feed(decoder.decode(value, { stream: true }));
          }
        }
        processor.flush();
        setResponse((current) => ({ ...current, isLoading: false }));
        return;
      }

      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      waitMs = Date.now() - requestStartedAt;
      usedAccountId = response.headers.get("x-provider-account-id");
      if (!response.ok) {
        let message = "Request failed";
        try {
          message = extractErrorMessage(await response.json()) ?? message;
        } catch {
          const text = await response.text();
          if (text.trim()) message = text;
        }
        throw new Error(message);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const parsed = settings.endpoint === "messages" ? extractMessagesCompletionData(payload) : settings.endpoint === "responses" ? extractResponsesCompletionData(payload) : extractChatCompletionData(payload);
      setResponse({
        content: parsed.content,
        reasoning: parsed.reasoning,
        toolCalls: parsed.toolCalls,
        isLoading: false,
        waitMs,
        firstResponseMs: Date.now() - requestStartedAt,
        usedAccountId,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        setResponse((current) => ({ ...current, isLoading: false }));
        return;
      }
      setResponse({ content: "", reasoning: "", toolCalls: [], isLoading: false, error: (error as Error).message, waitMs, firstResponseMs: null, usedAccountId });
    } finally {
      controllerRef.current = null;
    }
  };

  const stopRequest = () => {
    controllerRef.current?.abort();
  };

  return (
    <div className="space-y-6">
      <div className="dashboard-header-divider">
        <div className="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">Playground</h2>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Request panel */}
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="space-y-3">
            <label className="grid gap-1.5 text-sm font-medium">
              Model
              <select
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="">Select a model</option>
                {modelOptions.map(([family, familyModels]) => (
                  <optgroup key={family} label={family}>
                    {familyModels.map((model) => (
                      <option key={model.id} value={model.id}>{model.id}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>

            {usableProviders.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-7 cursor-pointer items-center justify-center rounded-md border px-2.5 text-xs font-medium",
                    provider === null ? "border-primary/35 bg-primary/10 text-primary" : "border-border/70 bg-card/30 text-muted-foreground",
                  )}
                  onClick={() => setProvider(null)}
                >
                  Auto
                </button>
                {usableProviders.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={cn(
                      "inline-flex h-7 cursor-pointer items-center justify-center rounded-md border px-2.5 text-xs font-medium",
                      provider === p.id ? "border-primary/35 bg-primary/10 text-primary" : "border-border/70 bg-card/30 text-muted-foreground",
                    )}
                    onClick={() => setProvider(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            ) : null}

            <label className="grid gap-1.5 text-sm font-medium">
              Account (optional)
              <select
                value={accountId ?? ""}
                onChange={(event) => setAccountId(event.target.value || null)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="">Auto</option>
                {providerAccounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-sm font-medium">
                Endpoint
                <select
                  value={settings.endpoint}
                  onChange={(event) => setSettings({ ...settings, endpoint: event.target.value as PlaygroundEndpoint })}
                  className="h-9 rounded-md border border-input bg-background px-3 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <option value="chat_completions">/v1/chat/completions</option>
                  <option value="messages">/v1/messages</option>
                  <option value="responses">/v1/responses</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Reasoning
                <select
                  value={settings.reasoningEffort}
                  onChange={(event) => setSettings({ ...settings, reasoningEffort: event.target.value as ReasoningEffort })}
                  className="h-9 rounded-md border border-input bg-background px-3 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {(["none", "low", "medium", "high", "xhigh"] as ReasoningEffort[]).map((effort) => (
                    <option key={effort} value={effort}>{effort}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                Temperature
                <input type="number" min={0} max={2} step={0.1} value={settings.temperature} onChange={(event) => setSettings({ ...settings, temperature: Number(event.target.value) })} className="h-9 rounded-md border border-input bg-background px-3 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
              </label>
              <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                Max tokens
                <input type="number" min={1} step={1} value={settings.maxTokens} onChange={(event) => setSettings({ ...settings, maxTokens: Number(event.target.value) })} className="h-9 rounded-md border border-input bg-background px-3 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
              </label>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">Stream responses</span>
              <UiSwitch checked={settings.streamResponses} onCheckedChange={(value) => setSettings({ ...settings, streamResponses: value })} />
            </div>
          </div>

          <label className="grid gap-1.5 text-sm font-medium">
            Messages (JSON array or plain text)
            <textarea
              value={messagesInput}
              onChange={(event) => setMessagesInput(event.target.value)}
              rows={6}
              spellCheck={false}
              className="min-h-36 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </label>

          <label className="grid gap-1.5 text-sm font-medium">
            Additional parameters (JSON, optional)
            <textarea
              value={additionalParametersInput}
              onChange={(event) => setAdditionalParametersInput(event.target.value)}
              rows={2}
              spellCheck={false}
              placeholder='{"tools": [...], "tool_choice": "auto"}'
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </label>

          {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

          <div className="flex gap-2">
            {response.isLoading ? (
              <UiButton className="flex-1" variant="destructive" onClick={stopRequest}>
                <UiIcon name="i-lucide-square" className="size-4" />
                Stop
              </UiButton>
            ) : (
              <UiButton className="flex-1" disabled={!canUsePlayground} onClick={() => void sendRequest()}>
                <UiIcon name="i-lucide-play" className="size-4" />
                Send
              </UiButton>
            )}
          </div>
        </div>

        {/* Response panel */}
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Response</p>
              {selectedModel ? <UiBadge variant="outline" className="font-mono text-[10px]">{selectedModel.id}</UiBadge> : null}
            </div>
            {response.usedAccountId ? <span className="text-[10px] text-muted-foreground">account: {response.usedAccountId}</span> : null}
          </div>

          {response.error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              <p className="whitespace-pre-wrap break-words font-mono text-xs">{response.error}</p>
            </div>
          ) : null}

          {response.reasoning ? (
            <div className="rounded-md border border-border/60 bg-muted/20 p-3">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Reasoning</p>
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{response.reasoning}</p>
            </div>
          ) : null}

          <div className="min-h-64 rounded-md border border-border/60 bg-muted/10 p-3">
            {response.content ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{response.content}</p>
            ) : response.isLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <UiIcon name="i-lucide-loader-2" className="size-4 animate-spin" />
                Waiting for response...
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Send a request to see the response.</p>
            )}
          </div>

          {response.toolCalls.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Tool calls</p>
              {response.toolCalls.map((call, index) => (
                <div key={index} className="rounded-md border border-border/60 bg-muted/20 p-2">
                  <p className="font-mono text-xs text-foreground">{call.name}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{call.arguments}</p>
                </div>
              ))}
            </div>
          ) : null}

          {(response.waitMs !== null || response.firstResponseMs !== null) && !response.isLoading ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
              <span>wait: {response.waitMs !== null ? `${response.waitMs}ms` : "-"}</span>
              <span>first response: {response.firstResponseMs !== null ? `${response.firstResponseMs}ms` : "-"}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
