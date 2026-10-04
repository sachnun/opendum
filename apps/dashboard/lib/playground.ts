import { createParser, type EventSourceMessage } from "eventsource-parser";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type PlaygroundEndpoint = "chat_completions" | "messages" | "responses";

export type ScenarioMessage = { role: string; content: string | Array<Record<string, unknown>> };

export type ParsedUsageData = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };

export type ToolCallData = { name: string; arguments: string };

export type ParsedCompletionData = { content: string; reasoning: string; toolCalls: ToolCallData[]; usage: ParsedUsageData | null };

export type ResponseMetrics = { waitMs: number | null; firstResponseMs: number | null; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };

export interface PlaygroundSettings {
  endpoint: PlaygroundEndpoint;
  streamResponses: boolean;
  temperature: number;
  topP: number;
  maxTokens: number;
  presencePenalty: number;
  frequencyPenalty: number;
  reasoningEffort: ReasoningEffort;
}

export const ERROR_STRING_LIMIT = 200;

export const ERROR_ARRAY_PREVIEW_LIMIT = 10;

export const ERROR_MESSAGE_LIMIT = 30;

export const ERROR_RAW_MESSAGE_LIMIT = 2000;

export function generateId(): string {
  return Math.random().toString(36).slice(2, 9);
}

export function normalizeQueryParam(value: unknown): string | null {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

export function normalizeQueryEndpoint(value: unknown): PlaygroundEndpoint | null {
  const endpoint = normalizeQueryParam(value);
  return endpoint === "chat_completions" || endpoint === "messages" || endpoint === "responses" ? endpoint : null;
}

export function normalizeQueryNumber(value: unknown): number | null {
  const rawValue = normalizeQueryParam(value);
  if (rawValue === null || rawValue.trim() === "") return null;
  const numericValue = Number(rawValue);
  return Number.isFinite(numericValue) ? numericValue : null;
}

export function normalizeQueryBoolean(value: unknown): boolean | null {
  const rawValue = normalizeQueryParam(value)?.trim().toLowerCase();
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  return null;
}

export function normalizeQueryReasoningEffort(value: unknown): ReasoningEffort | null {
  const effort = normalizeQueryParam(value);
  return effort === "none" || effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max" ? effort : null;
}

export function normalizeQueryAdditionalParameters(value: unknown): string | null {
  const rawValue = normalizeQueryParam(value);
  if (!rawValue?.trim()) return null;

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? JSON.stringify(parsed, null, 2) : null;
  } catch {
    return rawValue;
  }
}

export function parseAdditionalParameters(value: string): { params: Record<string, unknown> | null; error: string } {
  if (!value.trim()) return { params: null, error: "" };

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { params: null, error: "Additional parameters must be a JSON object." };
    }
    return { params: parsed as Record<string, unknown>, error: "" };
  } catch (error) {
    return { params: null, error: error instanceof Error ? error.message : "Invalid JSON." };
  }
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("");
}

export function extractMessageText(content: ScenarioMessage["content"]): string {
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

export function extractImageUrls(content: ScenarioMessage["content"]): string[] {
  if (typeof content === "string" || !Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "image_url") return [];
    const imageUrl = (part as { image_url?: unknown }).image_url;
    if (typeof imageUrl === "string") return [imageUrl];
    if (imageUrl && typeof imageUrl === "object" && typeof (imageUrl as { url?: unknown }).url === "string") return [(imageUrl as { url: string }).url];
    return [];
  });
}

export function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "-";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
}

export function normalizeTokenValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

export function extractUsageData(payload: unknown): ParsedUsageData | null {
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

export function mergeUsageData(current: ParsedUsageData | null, incoming: ParsedUsageData | null): ParsedUsageData | null {
  if (!incoming) return current;
  return {
    inputTokens: incoming.inputTokens ?? current?.inputTokens ?? null,
    outputTokens: incoming.outputTokens ?? current?.outputTokens ?? null,
    totalTokens: incoming.totalTokens ?? current?.totalTokens ?? null,
  };
}

export function buildResponseMetrics(waitMs: number | null, firstResponseMs: number | null, usage: ParsedUsageData | null): ResponseMetrics {
  const inputTokens = usage?.inputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  const totalTokens = usage?.totalTokens ?? (inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0));
  return { waitMs, firstResponseMs, inputTokens, outputTokens, totalTokens };
}

export function extractToolCallsData(toolCalls: unknown): ToolCallData[] {
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

export function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : null;
}

export function extractChatCompletionData(payload: unknown): ParsedCompletionData {
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

export function extractStreamChunkData(payload: unknown): ParsedCompletionData {
  const usage = extractUsageData(payload);
  if (!payload || typeof payload !== "object") return { content: "", reasoning: "", toolCalls: [], usage };
  const choices = (payload as { choices?: unknown }).choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : null;
  const delta = firstChoice && typeof firstChoice === "object" ? (firstChoice as { delta?: unknown }).delta : null;
  if (!delta || typeof delta !== "object") return { content: "", reasoning: "", toolCalls: [], usage };
  return {
    content: extractTextContent((delta as { content?: unknown }).content),
    reasoning: extractTextContent((delta as { reasoning_content?: unknown; reasoning?: unknown }).reasoning_content ?? (delta as { reasoning?: unknown }).reasoning),
    toolCalls: [],
    usage,
  };
}

export function extractAnthropicToolCallsData(content: unknown): ToolCallData[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, index) => {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "tool_use") return [];
    const name = typeof (block as { name?: unknown }).name === "string" ? ((block as { name: string }).name || `tool_${index + 1}`) : `tool_${index + 1}`;
    const input = (block as { input?: unknown }).input;
    return [{ name, arguments: typeof input === "string" ? (input.trim() || "{}") : input === undefined ? "{}" : JSON.stringify(input) }];
  });
}

export function extractAnthropicCompletionData(payload: unknown): ParsedCompletionData {
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

export function extractResponsesCompletionData(payload: unknown): ParsedCompletionData {
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

export function handleSseMessage(message: EventSourceMessage, onChunk: (chunk: ParsedCompletionData) => void, endpoint: PlaygroundEndpoint): boolean {
  const data = message.data.trim();
  if (!data || data === "[DONE]") return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }

  const errorMessage = extractErrorMessage(parsed);
  if (errorMessage) throw new Error(errorMessage);

  const eventName = message.event ?? (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string" ? (parsed as { type: string }).type : "");
  const chunk = endpoint === "messages" ? extractAnthropicStreamChunkData(eventName, parsed) : endpoint === "responses" ? extractResponsesStreamChunkData(parsed) : extractStreamChunkData(parsed);
  if (!chunk.content && !chunk.reasoning && chunk.toolCalls.length === 0 && !chunk.usage) return false;

  onChunk(chunk);
  return true;
}

export function createSseChunkProcessor(endpoint: PlaygroundEndpoint, onChunk: (chunk: ParsedCompletionData) => void) {
  let emittedSinceLastFlush = 0;
  const parser = createParser({
    onEvent: (message) => {
      if (handleSseMessage(message, onChunk, endpoint)) emittedSinceLastFlush += 1;
    },
  });

  return {
    feed(chunk: string) {
      emittedSinceLastFlush = 0;
      parser.feed(chunk);
      return emittedSinceLastFlush;
    },
    flush() {
      emittedSinceLastFlush = 0;
      parser.reset({ consume: true });
      return emittedSinceLastFlush;
    },
  };
}

export function extractAnthropicStreamChunkData(eventName: string, payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") return { content: "", reasoning: "", toolCalls: [], usage: null };
  const normalizedEventName = eventName || (typeof (payload as { type?: unknown }).type === "string" ? (payload as { type: string }).type : "");
  if (normalizedEventName === "content_block_delta") {
    const delta = (payload as { delta?: unknown }).delta;
    if (!delta || typeof delta !== "object") return { content: "", reasoning: "", toolCalls: [], usage: null };
    if ((delta as { type?: unknown }).type === "text_delta") return { content: typeof (delta as { text?: unknown }).text === "string" ? (delta as { text: string }).text : "", reasoning: "", toolCalls: [], usage: null };
    if ((delta as { type?: unknown }).type === "thinking_delta") return { content: "", reasoning: typeof (delta as { thinking?: unknown }).thinking === "string" ? (delta as { thinking: string }).thinking : "", toolCalls: [], usage: null };
  }
  if (normalizedEventName === "message_delta") return { content: "", reasoning: "", toolCalls: [], usage: extractUsageData({ usage: (payload as { usage?: unknown }).usage }) };
  return { content: "", reasoning: "", toolCalls: [], usage: null };
}

export function extractResponsesStreamChunkData(payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") return { content: "", reasoning: "", toolCalls: [], usage: null };
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== "string") return extractStreamChunkData(payload);
  if (type.includes("output_text")) return { content: typeof (payload as { delta?: unknown; text?: unknown }).delta === "string" ? (payload as { delta: string }).delta : typeof (payload as { text?: unknown }).text === "string" ? (payload as { text: string }).text : "", reasoning: "", toolCalls: [], usage: null };
  if (type.includes("reasoning")) return { content: "", reasoning: typeof (payload as { delta?: unknown; text?: unknown }).delta === "string" ? (payload as { delta: string }).delta : typeof (payload as { text?: unknown }).text === "string" ? (payload as { text: string }).text : "", toolCalls: [], usage: null };
  if (type === "response.completed") return { content: "", reasoning: "", toolCalls: [], usage: extractUsageData(payload) };
  return { content: "", reasoning: "", toolCalls: [], usage: null };
}

export function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function getErrorMessageFromText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Request failed";
  try {
    const parsed = JSON.parse(trimmed);
    const errorMessage = extractErrorMessage(parsed);
    if (errorMessage) return errorMessage;
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") return (parsed as { message: string }).message;
  } catch {
    return trimmed;
  }
  return trimmed;
}

export function truncateErrorString(value: string): string {
  if (value.length <= ERROR_STRING_LIMIT) return value;
  return `${value.slice(0, ERROR_STRING_LIMIT)}...[truncated, ${value.length} chars total]`;
}

export function summarizeToolsForError(tools: unknown[]): string {
  const names: string[] = [];
  const limit = Math.min(tools.length, ERROR_ARRAY_PREVIEW_LIMIT);
  for (let i = 0; i < limit; i += 1) {
    const tool = tools[i];
    if (!tool || typeof tool !== "object") continue;
    const fn = (tool as { function?: unknown }).function;
    if (fn && typeof fn === "object") {
      if (typeof (fn as { name?: unknown }).name === "string") names.push((fn as { name: string }).name);
      continue;
    }
    if (typeof (tool as { name?: unknown }).name === "string") names.push((tool as { name: string }).name);
  }
  const suffix = tools.length > ERROR_ARRAY_PREVIEW_LIMIT ? `, +${tools.length - ERROR_ARRAY_PREVIEW_LIMIT} more` : "";
  return `[${tools.length} tool(s): ${names.join(", ")}${suffix}]`;
}

export function sanitizeErrorValue(value: unknown, key: string): unknown {
  if (typeof value === "string") return truncateErrorString(value);
  if (Array.isArray(value)) {
    if (key === "tools") return summarizeToolsForError(value);
    const items = value.slice(0, ERROR_ARRAY_PREVIEW_LIMIT).map((item) => sanitizeErrorValue(item, key));
    if (value.length > ERROR_ARRAY_PREVIEW_LIMIT) items.push(`...[truncated, ${value.length} items total]`);
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) out[nestedKey] = sanitizeErrorValue(nestedValue, nestedKey);
    return out;
  }
  return value;
}

export function sanitizeErrorParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    out[key] = key === "messages" ? '[redacted: see "Messages (object keys only)"]' : sanitizeErrorValue(value, key);
  }
  return out;
}

export function errorTypeName(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "object";
}

export function summarizeErrorMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const entries: Array<Record<string, unknown>> = [];
  const limit = Math.min(messages.length, ERROR_MESSAGE_LIMIT);
  for (let i = 0; i < limit; i += 1) {
    const item = messages[i];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      entries.push({ index: i, keys: Object.keys(item as Record<string, unknown>).sort() });
    } else if (Array.isArray(item)) {
      entries.push({ index: i, type: "array" });
    } else {
      entries.push({ index: i, type: errorTypeName(item) });
    }
  }
  if (messages.length > ERROR_MESSAGE_LIMIT) entries.push({ index: ERROR_MESSAGE_LIMIT, type: `truncated_${messages.length - ERROR_MESSAGE_LIMIT}_more_items` });
  return JSON.stringify(entries, null, 2);
}

export function buildPlaygroundErrorMessage(errorMessage: string, context: { model: string; provider: string | null; endpoint: PlaygroundEndpoint; parameters: Record<string, unknown> | null; messages: unknown }): string {
  const truncatedError = errorMessage.length > ERROR_RAW_MESSAGE_LIMIT ? `${errorMessage.slice(0, ERROR_RAW_MESSAGE_LIMIT)}...[truncated, ${errorMessage.length} chars total]` : errorMessage;

  let serializedParameters = "{}";
  if (context.parameters) {
    try {
      serializedParameters = JSON.stringify(sanitizeErrorParameters(context.parameters), null, 2);
    } catch {
      serializedParameters = '"[unserializable parameters]"';
    }
  }

  const lines = [`Error: ${truncatedError}`];
  if (context.provider) lines.push(`Provider: ${context.provider}`);
  lines.push(`Endpoint: ${getEndpointPath(context.endpoint)}`, `Model: ${context.model}`, `Parameters: ${serializedParameters}`);
  const messagesSummary = summarizeErrorMessages(context.messages);
  if (messagesSummary) lines.push(`Messages (object keys only): ${messagesSummary}`);
  return lines.join("\n");
}

export function mapReasoningEffortToThinkingBudget(effort: ReasoningEffort): number {
  if (effort === "low") return 4000;
  if (effort === "medium") return 8000;
  if (effort === "high") return 16000;
  if (effort === "xhigh") return 32000;
  if (effort === "max") return 64000;
  return 0;
}

export function getEndpointPath(endpoint: PlaygroundEndpoint): string {
  if (endpoint === "messages") return "/v1/messages";
  if (endpoint === "responses") return "/v1/responses";
  return "/v1/chat/completions";
}

export function usesAdaptiveThinking(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized === "claude-opus-4-7" || normalized === "claude-opus-4.7";
}

export function convertOpenAIContentToAnthropic(content: ScenarioMessage["content"]): string | Array<Record<string, unknown>> {
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

export function convertScenarioMessagesToAnthropic(messages: ScenarioMessage[]) {
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

export function convertScenarioMessagesToResponsesInput(messages: ScenarioMessage[]) {
  return messages.map((message) => ({ type: "message", role: message.role === "system" ? "developer" : message.role === "assistant" ? "assistant" : "user", content: message.content }));
}

export function buildRequestBody(modelId: string, messages: ScenarioMessage[], currentSettings: PlaygroundSettings): Record<string, unknown> {
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

  if (currentSettings.reasoningEffort !== "none") requestBody.reasoning_effort = currentSettings.reasoningEffort;
  return requestBody;
}

export function applyRouteSelectorToRequestBody(requestBody: Record<string, unknown>, provider: string | null, accountId: string | null) {
  const selector = accountId ?? provider;
  if (!selector) return;
  const model = typeof requestBody.model === "string" ? requestBody.model.trim() : "";
  if (model && !model.startsWith(`${selector}/`)) requestBody.model = `${selector}/${model}`;
}

export function adaptRequestOverridesForEndpoint(overrides: Record<string, unknown> | undefined, endpoint: PlaygroundEndpoint): Record<string, unknown> | null {
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

export function formatToolArguments(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
