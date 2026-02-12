"use client";

import * as React from "react";
import { Play, Plus, Square } from "lucide-react";

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
  type PlaygroundEndpoint,
  type PlaygroundSettings,
} from "./settings-sheet";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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

interface ScenarioMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

function getScenarioMessages(scenario: Scenario): ScenarioMessage[] {
  return Array.isArray(scenario.messages) && scenario.messages.length > 0
    ? scenario.messages
    : [{ role: "user", content: scenario.prompt }];
}

function getEndpointPath(endpoint: PlaygroundEndpoint): string {
  if (endpoint === "messages") {
    return "/v1/messages";
  }

  if (endpoint === "responses") {
    return "/v1/responses";
  }

  return "/v1/chat/completions";
}

function mapReasoningEffortToThinkingBudget(
  effort: PlaygroundSettings["reasoningEffort"]
): number {
  switch (effort) {
    case "low":
      return 4000;
    case "medium":
      return 8000;
    case "high":
      return 16000;
    case "xhigh":
      return 32000;
    default:
      return 0;
  }
}

function extractSystemTextFromContent(content: ScenarioMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }

      const type = (part as { type?: unknown }).type;
      if (type !== "text") {
        return "";
      }

      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n")
    .trim();
}

function convertOpenAIContentToAnthropic(
  content: ScenarioMessage["content"]
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const converted = content.flatMap((part) => {
    if (!part || typeof part !== "object") {
      return [];
    }

    const type = (part as { type?: unknown }).type;

    if (type === "text") {
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [{ type: "text", text }] : [];
    }

    if (type === "image_url") {
      const imageUrl = (part as { image_url?: unknown }).image_url;
      const url =
        typeof imageUrl === "string"
          ? imageUrl
          : imageUrl && typeof imageUrl === "object"
            ? (imageUrl as { url?: unknown }).url
            : null;

      if (typeof url === "string" && url.trim()) {
        return [
          {
            type: "image",
            source: {
              type: "url",
              url: url.trim(),
            },
          },
        ];
      }

      return [];
    }

    return [part as Record<string, unknown>];
  });

  if (converted.length === 0) {
    return "";
  }

  return converted;
}

function convertScenarioMessagesToAnthropic(messages: ScenarioMessage[]): {
  system: string | null;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
} {
  const systemParts: string[] = [];
  const convertedMessages: Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
  }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      const systemText = extractSystemTextFromContent(message.content);
      if (systemText) {
        systemParts.push(systemText);
      }
      continue;
    }

    const role = message.role === "assistant" ? "assistant" : "user";
    convertedMessages.push({
      role,
      content: convertOpenAIContentToAnthropic(message.content),
    });
  }

  if (convertedMessages.length === 0) {
    convertedMessages.push({ role: "user", content: "" });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : null,
    messages: convertedMessages,
  };
}

function convertScenarioMessagesToResponsesInput(
  messages: ScenarioMessage[]
): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const normalizedRole =
      message.role === "system"
        ? "developer"
        : message.role === "assistant"
          ? "assistant"
          : "user";

    return {
      type: "message",
      role: normalizedRole,
      content: message.content,
    };
  });
}

function convertOpenAIToolsToAnthropic(tools: unknown): unknown {
  if (!Array.isArray(tools)) {
    return tools;
  }

  const hasOpenAIShape = tools.some((tool) => {
    if (!tool || typeof tool !== "object") {
      return false;
    }

    const type = (tool as { type?: unknown }).type;
    const fn = (tool as { function?: unknown }).function;
    return type === "function" && !!fn && typeof fn === "object";
  });

  if (!hasOpenAIShape) {
    return tools;
  }

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") {
        return null;
      }

      const fn = (tool as { function?: unknown }).function;
      if (!fn || typeof fn !== "object") {
        return null;
      }

      const name = (fn as { name?: unknown }).name;
      if (typeof name !== "string" || !name.trim()) {
        return null;
      }

      const description = (fn as { description?: unknown }).description;
      const parameters = (fn as { parameters?: unknown }).parameters;

      return {
        name: name.trim(),
        ...(typeof description === "string" ? { description } : {}),
        input_schema:
          parameters && typeof parameters === "object" && !Array.isArray(parameters)
            ? (parameters as Record<string, unknown>)
            : {},
      };
    })
    .filter(Boolean);
}

function convertOpenAIToolChoiceToAnthropic(toolChoice: unknown): unknown {
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") {
      return { type: "auto" };
    }
    if (toolChoice === "none") {
      return { type: "none" };
    }
    if (toolChoice === "required") {
      return { type: "any" };
    }
    return toolChoice;
  }

  if (!toolChoice || typeof toolChoice !== "object") {
    return toolChoice;
  }

  const type = (toolChoice as { type?: unknown }).type;
  if (type !== "function") {
    return toolChoice;
  }

  const fn = (toolChoice as { function?: unknown }).function;
  const name = fn && typeof fn === "object" ? (fn as { name?: unknown }).name : null;

  if (typeof name === "string" && name.trim()) {
    return { type: "tool", name: name.trim() };
  }

  return { type: "any" };
}

function adaptRequestOverridesForEndpoint(
  requestOverrides: Record<string, unknown> | undefined,
  endpoint: PlaygroundEndpoint
): Record<string, unknown> | null {
  if (!requestOverrides) {
    return null;
  }

  if (endpoint !== "messages") {
    return requestOverrides;
  }

  const adapted: Record<string, unknown> = { ...requestOverrides };

  if (Object.hasOwn(adapted, "tools")) {
    adapted.tools = convertOpenAIToolsToAnthropic(adapted.tools);
  }

  if (Object.hasOwn(adapted, "tool_choice")) {
    adapted.tool_choice = convertOpenAIToolChoiceToAnthropic(adapted.tool_choice);
  }

  return adapted;
}

function buildChatCompletionsRequestBody(
  modelId: string,
  scenarioMessages: ScenarioMessage[],
  currentSettings: PlaygroundSettings,
  accountId: string | null
): Record<string, unknown> {
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

  return requestBody;
}

function buildMessagesRequestBody(
  modelId: string,
  scenarioMessages: ScenarioMessage[],
  currentSettings: PlaygroundSettings,
  accountId: string | null
): Record<string, unknown> {
  const anthropicPayload = convertScenarioMessagesToAnthropic(scenarioMessages);

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

  if (anthropicPayload.system) {
    requestBody.system = anthropicPayload.system;
  }

  if (accountId) {
    requestBody.provider_account_id = accountId;
  }

  if (currentSettings.reasoningEffort !== "none") {
    requestBody.thinking = {
      type: "enabled",
      budget_tokens: mapReasoningEffortToThinkingBudget(currentSettings.reasoningEffort),
    };
  }

  return requestBody;
}

function buildResponsesRequestBody(
  modelId: string,
  scenarioMessages: ScenarioMessage[],
  currentSettings: PlaygroundSettings,
  accountId: string | null
): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    model: modelId,
    input: convertScenarioMessagesToResponsesInput(scenarioMessages),
    stream: currentSettings.streamResponses,
    temperature: currentSettings.temperature,
    top_p: currentSettings.topP,
    max_output_tokens: currentSettings.maxTokens,
    presence_penalty: currentSettings.presencePenalty,
    frequency_penalty: currentSettings.frequencyPenalty,
  };

  if (accountId) {
    requestBody.provider_account_id = accountId;
  }

  if (currentSettings.reasoningEffort !== "none") {
    requestBody.reasoning_effort = currentSettings.reasoningEffort;
  }

  return requestBody;
}

function extractAnthropicToolCallsText(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) {
    return "";
  }

  const lines = content
    .map((block, index) => {
      if (!block || typeof block !== "object") {
        return null;
      }

      const type = (block as { type?: unknown }).type;
      if (type !== "tool_use") {
        return null;
      }

      const name =
        typeof (block as { name?: unknown }).name === "string"
          ? ((block as { name: string }).name || `tool_${index + 1}`)
          : `tool_${index + 1}`;

      const input = (block as { input?: unknown }).input;
      const inputText =
        typeof input === "string"
          ? input.trim() || "{}"
          : input === undefined
            ? "{}"
            : JSON.stringify(input);

      return `- ${name}(${inputText})`;
    })
    .filter((line): line is string => typeof line === "string" && line.length > 0);

  if (lines.length === 0) {
    return "";
  }

  return `Tool calls:\n${lines.join("\n")}`;
}

function extractAnthropicCompletionData(payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") {
    return { content: "", reasoning: "", toolCallsText: "", usage: null };
  }

  const contentBlocks = (payload as { content?: unknown }).content;
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    return {
      content: "",
      reasoning: "",
      toolCallsText: "",
      usage: extractUsageData(payload),
    };
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];

  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const type = (block as { type?: unknown }).type;

    if (type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        textParts.push(text);
      }
      continue;
    }

    if (type === "thinking") {
      const thinking = (block as { thinking?: unknown }).thinking;
      if (typeof thinking === "string" && thinking.length > 0) {
        reasoningParts.push(thinking);
      }
    }
  }

  return {
    content: textParts.join(""),
    reasoning: reasoningParts.join(""),
    toolCallsText: extractAnthropicToolCallsText(contentBlocks),
    usage: extractUsageData(payload),
  };
}

function extractResponsesUsageData(payload: unknown): ParsedUsageData | null {
  const directUsage = extractUsageData(payload);
  if (directUsage) {
    return directUsage;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const response = (payload as { response?: unknown }).response;
  if (!response || typeof response !== "object") {
    return null;
  }

  return extractUsageData({
    usage: (response as { usage?: unknown }).usage,
  });
}

function extractResponsesCompletionData(payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") {
    return { content: "", reasoning: "", toolCallsText: "", usage: null };
  }

  const outputItems = (payload as { output?: unknown }).output;
  if (!Array.isArray(outputItems) || outputItems.length === 0) {
    return extractChatCompletionData(payload);
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCallLines: string[] = [];

  for (const item of outputItems) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const itemType = (item as { type?: unknown }).type;

    if (itemType === "message") {
      const content = (item as { content?: unknown }).content;

      if (typeof content === "string") {
        textParts.push(content);
        continue;
      }

      if (!Array.isArray(content)) {
        continue;
      }

      for (const part of content) {
        if (!part || typeof part !== "object") {
          continue;
        }

        const partType = (part as { type?: unknown }).type;

        if (
          partType === "output_text" ||
          partType === "text" ||
          partType === "input_text"
        ) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string" && text.length > 0) {
            textParts.push(text);
          }
        }
      }

      continue;
    }

    if (itemType === "reasoning") {
      const summary = (item as { summary?: unknown }).summary;

      if (Array.isArray(summary)) {
        for (const summaryPart of summary) {
          if (!summaryPart || typeof summaryPart !== "object") {
            continue;
          }

          const text = (summaryPart as { text?: unknown }).text;
          if (typeof text === "string" && text.length > 0) {
            reasoningParts.push(text);
          }
        }
      }

      const fallbackText = (item as { content?: unknown }).content;
      if (
        reasoningParts.length === 0 &&
        typeof fallbackText === "string" &&
        fallbackText.length > 0
      ) {
        reasoningParts.push(fallbackText);
      }

      continue;
    }

    if (itemType === "function_call") {
      const name = (item as { name?: unknown }).name;
      const argumentsText = (item as { arguments?: unknown }).arguments;

      if (typeof name === "string" && name.trim()) {
        const argText =
          typeof argumentsText === "string"
            ? argumentsText.trim() || "{}"
            : argumentsText === undefined
              ? "{}"
              : JSON.stringify(argumentsText);
        toolCallLines.push(`- ${name.trim()}(${argText})`);
      }
    }
  }

  return {
    content: textParts.join(""),
    reasoning: reasoningParts.join(""),
    toolCallsText:
      toolCallLines.length > 0 ? `Tool calls:\n${toolCallLines.join("\n")}` : "",
    usage: extractResponsesUsageData(payload),
  };
}

function extractResponsesStreamChunkData(payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") {
    return { content: "", reasoning: "", toolCallsText: "", usage: null };
  }

  const type = (payload as { type?: unknown }).type;
  if (typeof type !== "string") {
    if (Array.isArray((payload as { choices?: unknown }).choices)) {
      return extractStreamChunkData(payload);
    }

    return { content: "", reasoning: "", toolCallsText: "", usage: null };
  }

  if (type.includes("output_text")) {
    const deltaOrText =
      (payload as { delta?: unknown }).delta ??
      (payload as { text?: unknown }).text;

    return {
      content: typeof deltaOrText === "string" ? deltaOrText : "",
      reasoning: "",
      toolCallsText: "",
      usage: null,
    };
  }

  if (type.includes("reasoning")) {
    const deltaOrText =
      (payload as { delta?: unknown }).delta ??
      (payload as { text?: unknown }).text;

    return {
      content: "",
      reasoning: typeof deltaOrText === "string" ? deltaOrText : "",
      toolCallsText: "",
      usage: null,
    };
  }

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = (payload as { item?: unknown }).item;
    if (!item || typeof item !== "object") {
      return { content: "", reasoning: "", toolCallsText: "", usage: null };
    }

    if ((item as { type?: unknown }).type !== "function_call") {
      return { content: "", reasoning: "", toolCallsText: "", usage: null };
    }

    const name = (item as { name?: unknown }).name;
    const argumentsText = (item as { arguments?: unknown }).arguments;

    if (typeof name !== "string" || !name.trim()) {
      return { content: "", reasoning: "", toolCallsText: "", usage: null };
    }

    const argText =
      typeof argumentsText === "string"
        ? argumentsText.trim() || "{}"
        : argumentsText === undefined
          ? "{}"
          : JSON.stringify(argumentsText);

    return {
      content: "",
      reasoning: "",
      toolCallsText: `Tool calls:\n- ${name.trim()}(${argText})`,
      usage: null,
    };
  }

  if (type === "response.completed") {
    return {
      content: "",
      reasoning: "",
      toolCallsText: "",
      usage: extractResponsesUsageData(payload),
    };
  }

  return { content: "", reasoning: "", toolCallsText: "", usage: null };
}

function extractAnthropicStreamChunkData(
  eventName: string,
  payload: unknown
): ParsedCompletionData {
  if (!payload || typeof payload !== "object") {
    return { content: "", reasoning: "", toolCallsText: "", usage: null };
  }

  if (eventName === "content_block_delta") {
    const delta = (payload as { delta?: unknown }).delta;
    if (!delta || typeof delta !== "object") {
      return { content: "", reasoning: "", toolCallsText: "", usage: null };
    }

    const deltaType = (delta as { type?: unknown }).type;
    if (deltaType === "text_delta") {
      const text = (delta as { text?: unknown }).text;
      return {
        content: typeof text === "string" ? text : "",
        reasoning: "",
        toolCallsText: "",
        usage: null,
      };
    }

    if (deltaType === "thinking_delta") {
      const thinking = (delta as { thinking?: unknown }).thinking;
      return {
        content: "",
        reasoning: typeof thinking === "string" ? thinking : "",
        toolCallsText: "",
        usage: null,
      };
    }
  }

  if (eventName === "message_delta") {
    return {
      content: "",
      reasoning: "",
      toolCallsText: "",
      usage: extractUsageData({
        usage: (payload as { usage?: unknown }).usage,
      }),
    };
  }

  return { content: "", reasoning: "", toolCallsText: "", usage: null };
}

function processAnthropicSseEvents(
  events: string[],
  onChunk: (chunk: ParsedCompletionData) => void
) {
  for (const event of events) {
    const lines = event.split(/\r?\n/);
    let eventName = "";
    const dataParts: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        dataParts.push(line.slice(5).trim());
      }
    }

    const data = dataParts.join("\n").trim();
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

    const chunk = extractAnthropicStreamChunkData(eventName, parsed);
    if (chunk.content || chunk.reasoning || chunk.toolCallsText || chunk.usage) {
      onChunk(chunk);
    }
  }
}

async function consumeAnthropicMessageStream(
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
    processAnthropicSseEvents(events, onChunk);
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    processAnthropicSseEvents([buffer], onChunk);
  }
}

function processResponsesSseEvents(
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

      const chunk = extractResponsesStreamChunkData(parsed);
      if (chunk.content || chunk.reasoning || chunk.toolCallsText || chunk.usage) {
        onChunk(chunk);
      }
    }
  }
}

async function consumeResponsesStream(
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
    processResponsesSseEvents(events, onChunk);
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    processResponsesSseEvents([buffer], onChunk);
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
  const controllersRef = React.useRef(new Map<string, AbortController>());
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

  const handleScenarioSelect = (scenario: Scenario) => {
    setSelectedScenario(scenario);

    if (scenario.isReasoning && settings.reasoningEffort === "none") {
      setSettings((prev) => ({ ...prev, reasoningEffort: "medium" }));
    }
  };

  const runSelectedScenario = async () => {
    if (!selectedScenario) {
      return;
    }

    let currentSettings = settings;
    if (selectedScenario.isReasoning && settings.reasoningEffort === "none") {
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
        selectedScenario,
        currentSettings,
        getValidAccountIdForPanel(panel)
      )
    );

    await Promise.all(promises);
    setIsAnyLoading(false);
  };

  const stopAllRequests = React.useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    setIsAnyLoading(false);

    setResponses((prev) => {
      const next: Record<string, ResponseData> = {};

      for (const [panelId, response] of Object.entries(prev)) {
        next[panelId] = response.isLoading ? { ...response, isLoading: false } : response;
      }

      return next;
    });
  }, []);

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
      const scenarioMessages = getScenarioMessages(scenario);
      const endpoint = currentSettings.endpoint;

      const requestBody =
        endpoint === "messages"
          ? buildMessagesRequestBody(modelId, scenarioMessages, currentSettings, accountId)
          : endpoint === "responses"
            ? buildResponsesRequestBody(modelId, scenarioMessages, currentSettings, accountId)
            : buildChatCompletionsRequestBody(
                modelId,
                scenarioMessages,
                currentSettings,
                accountId
              );

      const endpointOverrides = adaptRequestOverridesForEndpoint(
        scenario.requestOverrides,
        endpoint
      );
      if (endpointOverrides) {
        Object.assign(requestBody, endpointOverrides);
      }

      const streamValue = requestBody.stream;
      const shouldStream = typeof streamValue === "boolean" ? streamValue : true;

      const controller = new AbortController();
      controllersRef.current.set(panelId, controller);

      const response = await fetch(getEndpointPath(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
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

        const handleStreamChunk = (chunk: ParsedCompletionData) => {
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
        };

        if (endpoint === "messages") {
          await consumeAnthropicMessageStream(response, handleStreamChunk);
        } else if (endpoint === "responses") {
          await consumeResponsesStream(response, handleStreamChunk);
        } else {
          await consumeChatCompletionStream(response, handleStreamChunk);
        }

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
      const parsedData =
        endpoint === "messages"
          ? extractAnthropicCompletionData(data)
          : endpoint === "responses"
            ? extractResponsesCompletionData(data)
            : extractChatCompletionData(data);
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
      if (error instanceof DOMException && error.name === "AbortError") {
        setResponses((prev) => {
          const existing = prev[panelId];
          if (!existing) {
            return prev;
          }

          return {
            ...prev,
            [panelId]: {
              ...existing,
              isLoading: false,
              error: undefined,
            },
          };
        });
        return;
      }

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
    } finally {
      controllersRef.current.delete(panelId);
    }
  };

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">Playground</h1>
          <div className="flex items-center gap-2">
            {isAnyLoading ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={stopAllRequests}
              >
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={runSelectedScenario}
                disabled={!selectedScenario || !hasSelectedModel}
              >
                <Play className="h-4 w-4" />
                Start
              </Button>
            )}
            <SettingsSheet
              settings={settings}
              onSettingsChange={setSettings}
              disabled={isAnyLoading}
            />
          </div>
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
