import type { RouteHandlerMethod } from "fastify";
import {
  logUsage,
  recordLatency,
  type ChatCompletionRequest,
} from "@opendum/shared";
import { markAccountSuccess } from "../lib/load-balancer.js";
import {
  createProxyRoute,
  type ErrorInfo,
} from "../lib/proxy-handler.js";

// ---------------------------------------------------------------------------
// Interfaces (route-specific)
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface OpenAIMessage {
  role: string;
  content?: string | null | Array<{ type: string; [key: string]: unknown }>;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown> | string;
  source?: {
    type?: string;
    url?: string;
  };
  tool_use_id?: string;
  content?: AnthropicContentBlock[];
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequestBody {
  model: string;
  messages?: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: {
    type: string;
    name?: string;
  };
  thinking?: {
    type: "enabled" | "disabled";
    budget_tokens?: number;
  };
  [key: string]: unknown;
}

interface OpenAIPayload {
  model: string;
  messages: OpenAIMessage[];
  max_tokens: number;
  stream?: boolean;
  tools?: Array<{
    type: string;
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?: string | { type: string; function: { name: string } };
  [key: string]: unknown;
}

interface OpenAIChoice {
  delta: {
    content?: string;
    reasoning_content?: string;
    role?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string;
}

interface OpenAIResponse {
  id?: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
  [key: string]: unknown;
}

interface AnthropicContentBlockOutput {
  type: string;
  thinking?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlockOutput[];
  model: string;
  stop_reason: string;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Transform functions (route-specific)
// ---------------------------------------------------------------------------

/**
 * Transform Anthropic messages format to OpenAI format
 * @returns OpenAI payload with _includeReasoning flag for conditional thinking output
 */
function transformAnthropicToOpenAI(
  body: AnthropicRequestBody
): OpenAIPayload & { _includeReasoning?: boolean } {
  const {
    model,
    messages,
    system,
    max_tokens,
    stream,
    tools,
    tool_choice,
    thinking,
    ...params
  } = body as AnthropicRequestBody & { provider_account_id?: unknown };

  delete (params as Record<string, unknown>).provider_account_id;

  const thinkingRequested = thinking?.type === "enabled";

  const toolResultIds = new Set<string>();
  for (const msg of messages || []) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  const openaiMessages: OpenAIMessage[] = [];

  if (system) {
    if (typeof system === "string") {
      openaiMessages.push({ role: "system", content: system });
    } else if (Array.isArray(system)) {
      const systemContent = system
        .map((block: AnthropicContentBlock | string) => {
          if (typeof block === "string") return block;
          if (block.type === "text") return block.text || "";
          return "";
        })
        .join("\n");
      openaiMessages.push({ role: "system", content: systemContent });
    }
  }

  for (const msg of messages || []) {
    const role = msg.role;

    if (typeof msg.content === "string") {
      openaiMessages.push({ role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const toolCalls: OpenAIMessage["tool_calls"] = [];
      const structuredContentParts: Array<{
        type: string;
        [key: string]: unknown;
      }> = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          const text = block.text || "";
          if (text) {
            structuredContentParts.push({
              type: "text",
              text,
            });
          }
        } else if (block.type === "image") {
          const source = block.source;
          const url =
            source && typeof source === "object"
              ? (source as { url?: unknown }).url
              : null;

          if (typeof url === "string" && url.trim()) {
            structuredContentParts.push({
              type: "image_url",
              image_url: { url: url.trim() },
            });
          }
        } else if (block.type === "tool_use") {
          if (block.id && !toolResultIds.has(block.id)) {
            continue;
          }
          toolCalls.push({
            id: block.id || "",
            type: "function",
            function: {
              name: block.name || "",
              arguments:
                typeof block.input === "string"
                  ? block.input
                  : JSON.stringify(block.input || {}),
            },
          });
        } else if (block.type === "tool_result") {
          const toolContent =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter(
                      (b: AnthropicContentBlock) => b.type === "text"
                    )
                    .map((b: AnthropicContentBlock) => b.text || "")
                    .join("\n")
                : JSON.stringify(block.content);

          openaiMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id || "",
            content: toolContent,
          });
          continue;
        } else if (
          block.type === "thinking" ||
          block.type === "redacted_thinking"
        ) {
          continue;
        }
      }

      const hasStructuredContent = structuredContentParts.length > 0;

      if (role === "assistant" && toolCalls.length > 0) {
        openaiMessages.push({
          role: "assistant",
          content: hasStructuredContent ? structuredContentParts : null,
          tool_calls: toolCalls,
        });
      } else if (hasStructuredContent) {
        const hasNonTextPart = structuredContentParts.some(
          (part) => part.type !== "text"
        );

        if (hasNonTextPart) {
          openaiMessages.push({ role, content: structuredContentParts });
        } else {
          openaiMessages.push({
            role,
            content: structuredContentParts
              .map((part) =>
                typeof part.text === "string" ? part.text : ""
              )
              .join(""),
          });
        }
      }
    }
  }

  const openaiPayload: OpenAIPayload = {
    model,
    messages: openaiMessages,
    max_tokens: max_tokens || 4096,
    stream,
    ...params,
  };

  if (Array.isArray(tools) && tools.length > 0) {
    const hasOpenAIToolShape = tools.some((tool) => {
      if (!tool || typeof tool !== "object") {
        return false;
      }

      return Object.hasOwn(tool, "function");
    });

    if (hasOpenAIToolShape) {
      openaiPayload.tools =
        tools as unknown as OpenAIPayload["tools"];
    } else {
      openaiPayload.tools = tools
        .map((tool) => {
          if (!tool || typeof tool !== "object") {
            return null;
          }

          const name = (tool as { name?: unknown }).name;
          if (typeof name !== "string" || !name.trim()) {
            return null;
          }

          const description = (tool as { description?: unknown })
            .description;
          const inputSchema = (tool as { input_schema?: unknown })
            .input_schema;

          return {
            type: "function",
            function: {
              name,
              description:
                typeof description === "string" ? description : "",
              parameters:
                inputSchema &&
                typeof inputSchema === "object" &&
                !Array.isArray(inputSchema)
                  ? (inputSchema as Record<string, unknown>)
                  : {},
            },
          };
        })
        .filter(Boolean) as OpenAIPayload["tools"];
    }
  }

  if (tool_choice) {
    if (typeof tool_choice === "string") {
      if (
        tool_choice === "auto" ||
        tool_choice === "none"
      ) {
        (
          openaiPayload as OpenAIPayload & { tool_choice?: string }
        ).tool_choice = tool_choice;
      } else if (tool_choice === "required") {
        (
          openaiPayload as OpenAIPayload & { tool_choice?: string }
        ).tool_choice = "required";
      }
    } else if (typeof tool_choice === "object") {
      const choiceType = (tool_choice as { type?: unknown }).type;

      if (choiceType === "auto") {
        (
          openaiPayload as OpenAIPayload & { tool_choice?: string }
        ).tool_choice = "auto";
      } else if (choiceType === "any") {
        (
          openaiPayload as OpenAIPayload & { tool_choice?: string }
        ).tool_choice = "required";
      } else if (choiceType === "tool") {
        const name = (tool_choice as { name?: unknown }).name;
        (
          openaiPayload as OpenAIPayload & {
            tool_choice?: {
              type: string;
              function: { name: string };
            };
          }
        ).tool_choice = {
          type: "function",
          function: {
            name: typeof name === "string" ? name : "",
          },
        };
      } else if (choiceType === "none") {
        (
          openaiPayload as OpenAIPayload & { tool_choice?: string }
        ).tool_choice = "none";
      } else if (choiceType === "function") {
        const fn = (tool_choice as { function?: unknown }).function;
        const functionName =
          fn && typeof fn === "object"
            ? (fn as { name?: unknown }).name
            : null;

        (
          openaiPayload as OpenAIPayload & {
            tool_choice?: {
              type: string;
              function: { name: string };
            };
          }
        ).tool_choice = {
          type: "function",
          function: {
            name:
              typeof functionName === "string"
                ? functionName
                : "",
          },
        };
      }
    }
  }

  if (thinkingRequested) {
    (
      openaiPayload as OpenAIPayload & { thinking_budget?: number }
    ).thinking_budget = thinking?.budget_tokens || 10000;
  }

  return {
    ...openaiPayload,
    _includeReasoning: thinkingRequested,
  };
}

/**
 * Transform OpenAI response to Anthropic format (non-streaming)
 * @param openaiResponse - Response from OpenAI-compatible API
 * @param model - Model name for response
 * @param includeThinking - Whether to include thinking blocks in response (default: true)
 */
function transformOpenAIToAnthropic(
  openaiResponse: OpenAIResponse,
  model: string,
  includeThinking: boolean = true
): AnthropicResponse {
  const choice = openaiResponse.choices?.[0];
  const message = choice as unknown as {
    message?: {
      reasoning_content?: string;
      content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  };
  const messageData = message?.message;
  const usage = openaiResponse.usage;

  const contentBlocks: AnthropicContentBlockOutput[] = [];

  const reasoningContent = messageData?.reasoning_content;
  if (reasoningContent && includeThinking) {
    contentBlocks.push({
      type: "thinking",
      thinking: reasoningContent,
    });
  }

  const textContent = messageData?.content;
  if (textContent) {
    contentBlocks.push({
      type: "text",
      text: textContent,
    });
  }

  const toolCalls = messageData?.tool_calls || [];
  for (const tc of toolCalls) {
    let inputData: Record<string, unknown> = {};
    try {
      inputData = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      inputData = {};
    }

    contentBlocks.push({
      type: "tool_use",
      id: tc.id || `toolu_${Date.now()}`,
      name: tc.function?.name || "",
      input: inputData,
    });
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: "text",
      text: "",
    });
  }

  const finishReason = choice?.finish_reason;
  const stopReasonMap: Record<string, string> = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
    function_call: "tool_use",
  };
  const stopReason = finishReason
    ? stopReasonMap[finishReason]
    : "end_turn";

  return {
    id: `msg_${openaiResponse.id || Date.now()}`,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
    },
  };
}

/**
 * Create a usage tracker that processes SSE chunks and transforms OpenAI streaming
 * to Anthropic SSE format.
 * Handles reasoning_content (thinking), text content, and tool_calls.
 * @param model - The model name to include in responses
 * @param onComplete - Optional callback called when stream ends with usage data
 * @param includeThinking - Whether to include thinking blocks in response (default: true)
 */
function createAnthropicStreamTracker(
  model: string,
  onComplete?: (usage: {
    inputTokens: number;
    outputTokens: number;
  }) => void,
  includeThinking: boolean = true
) {
  const messageId = `msg_${Date.now()}`;

  let buffer = "";
  let thinkingBlockStarted = false;
  let contentBlockStarted = false;
  let currentBlockIndex = 0;
  const toolCallsByIndex: Record<number, ToolCall> = {};
  const toolBlockIndices: Record<number, number> = {};

  let inputTokens = 0;
  let outputTokens = 0;
  let usageReported = false;
  let startEventSent = false;

  const reportUsage = () => {
    if (!usageReported && onComplete) {
      usageReported = true;
      onComplete({ inputTokens, outputTokens });
    }
  };

  const formatSSE = (eventType: string, data: unknown): string => {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  };

  return {
    getStartEvent(): string {
      if (startEventSent) return "";
      startEventSent = true;
      return formatSSE("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    },

    processChunk(chunk: string): string {
      buffer += chunk;
      let output = "";

      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        const lines = event.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") {
            if (data === "[DONE]") {
              if (thinkingBlockStarted) {
                output += formatSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: currentBlockIndex,
                });
                currentBlockIndex++;
                thinkingBlockStarted = false;
              }

              if (contentBlockStarted) {
                output += formatSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: currentBlockIndex,
                });
                currentBlockIndex++;
                contentBlockStarted = false;
              }

              for (const tcIndex of Object.keys(toolBlockIndices)
                .map(Number)
                .sort((a, b) => a - b)) {
                const blockIdx = toolBlockIndices[tcIndex];
                output += formatSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: blockIdx,
                });
              }

              const stopReason =
                Object.keys(toolCallsByIndex).length > 0
                  ? "tool_use"
                  : "end_turn";

              output += formatSSE("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: stopReason,
                  stop_sequence: null,
                },
                usage: {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                },
              });

              output += formatSSE("message_stop", {
                type: "message_stop",
              });
            }
            continue;
          }

          try {
            const parsed = JSON.parse(data);

            if (parsed.usage) {
              inputTokens =
                parsed.usage.prompt_tokens || inputTokens;
              outputTokens =
                parsed.usage.completion_tokens || outputTokens;
            }

            const choices = parsed.choices || [];
            if (choices.length === 0) continue;

            const delta = choices[0].delta || {};

            const reasoningContent = delta.reasoning_content;
            if (reasoningContent && includeThinking) {
              if (!thinkingBlockStarted) {
                output += formatSSE("content_block_start", {
                  type: "content_block_start",
                  index: currentBlockIndex,
                  content_block: {
                    type: "thinking",
                    thinking: "",
                  },
                });
                thinkingBlockStarted = true;
              }

              output += formatSSE("content_block_delta", {
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: {
                  type: "thinking_delta",
                  thinking: reasoningContent,
                },
              });
            }

            const content = delta.content;
            if (
              content &&
              (content.trim() || contentBlockStarted)
            ) {
              if (
                thinkingBlockStarted &&
                !contentBlockStarted
              ) {
                output += formatSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: currentBlockIndex,
                });
                currentBlockIndex++;
                thinkingBlockStarted = false;
              }

              if (!contentBlockStarted) {
                output += formatSSE("content_block_start", {
                  type: "content_block_start",
                  index: currentBlockIndex,
                  content_block: { type: "text", text: "" },
                });
                contentBlockStarted = true;
              }

              output += formatSSE("content_block_delta", {
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: { type: "text_delta", text: content },
              });
            }

            const toolCallsDelta = delta.tool_calls || [];
            for (const tc of toolCallsDelta) {
              const tcIndex = tc.index ?? 0;

              if (!(tcIndex in toolCallsByIndex)) {
                if (thinkingBlockStarted) {
                  output += formatSSE("content_block_stop", {
                    type: "content_block_stop",
                    index: currentBlockIndex,
                  });
                  currentBlockIndex++;
                  thinkingBlockStarted = false;
                }

                if (contentBlockStarted) {
                  output += formatSSE("content_block_stop", {
                    type: "content_block_stop",
                    index: currentBlockIndex,
                  });
                  currentBlockIndex++;
                  contentBlockStarted = false;
                }

                toolCallsByIndex[tcIndex] = {
                  id:
                    tc.id ||
                    `toolu_${Date.now()}_${tcIndex}`,
                  name: tc.function?.name || "",
                  arguments: "",
                };
                toolBlockIndices[tcIndex] = currentBlockIndex;

                output += formatSSE("content_block_start", {
                  type: "content_block_start",
                  index: currentBlockIndex,
                  content_block: {
                    type: "tool_use",
                    id: toolCallsByIndex[tcIndex].id,
                    name: toolCallsByIndex[tcIndex].name,
                    input: {},
                  },
                });
                currentBlockIndex++;
              }

              const func = tc.function || {};
              if (func.name) {
                toolCallsByIndex[tcIndex].name = func.name;
              }
              if (func.arguments) {
                toolCallsByIndex[tcIndex].arguments +=
                  func.arguments;

                output += formatSSE("content_block_delta", {
                  type: "content_block_delta",
                  index: toolBlockIndices[tcIndex],
                  delta: {
                    type: "input_json_delta",
                    partial_json: func.arguments,
                  },
                });
              }
            }

            const finishReason = choices[0].finish_reason;
            if (finishReason) {
              if (thinkingBlockStarted) {
                output += formatSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: currentBlockIndex,
                });
                currentBlockIndex++;
                thinkingBlockStarted = false;
              }

              if (contentBlockStarted) {
                output += formatSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: currentBlockIndex,
                });
                currentBlockIndex++;
                contentBlockStarted = false;
              }

              for (const tcIdx of Object.keys(toolBlockIndices)
                .map(Number)
                .sort((a, b) => a - b)) {
                const blockIdx = toolBlockIndices[tcIdx];
                output += formatSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: blockIdx,
                });
              }

              let stopReason = "end_turn";
              if (
                finishReason === "tool_calls" ||
                Object.keys(toolCallsByIndex).length > 0
              ) {
                stopReason = "tool_use";
              } else if (finishReason === "length") {
                stopReason = "max_tokens";
              }

              output += formatSSE("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: stopReason,
                  stop_sequence: null,
                },
                usage: {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                },
              });

              output += formatSSE("message_stop", {
                type: "message_stop",
              });

              reportUsage();
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      return output;
    },

    flush(): string {
      let output = "";

      if (buffer.trim()) {
        if (buffer.includes("[DONE]")) {
          if (thinkingBlockStarted) {
            output += formatSSE("content_block_stop", {
              type: "content_block_stop",
              index: currentBlockIndex,
            });
          } else if (contentBlockStarted) {
            output += formatSSE("content_block_stop", {
              type: "content_block_stop",
              index: currentBlockIndex,
            });
          }

          for (const tcIndex of Object.keys(toolBlockIndices)
            .map(Number)
            .sort((a, b) => a - b)) {
            const blockIdx = toolBlockIndices[tcIndex];
            output += formatSSE("content_block_stop", {
              type: "content_block_stop",
              index: blockIdx,
            });
          }

          const stopReason =
            Object.keys(toolCallsByIndex).length > 0
              ? "tool_use"
              : "end_turn";

          output += formatSSE("message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: stopReason,
              stop_sequence: null,
            },
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
            },
          });

          output += formatSSE("message_stop", {
            type: "message_stop",
          });

          reportUsage();
        }
      }

      reportUsage();
      return output;
    },
  };
}

// ---------------------------------------------------------------------------
// Error formatting (Anthropic format)
// ---------------------------------------------------------------------------

function formatAnthropicError(info: ErrorInfo): unknown {
  return {
    type: "error",
    error: {
      type: info.type,
      message: info.message,
      ...(info.retry_after !== undefined
        ? { retry_after: info.retry_after }
        : {}),
      ...(info.retry_after_ms !== undefined
        ? { retry_after_ms: info.retry_after_ms }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Route export
// ---------------------------------------------------------------------------

export const messagesRoute: RouteHandlerMethod = createProxyRoute({
  endpoint: "messages",
  rateLimitStatusCode: 529,
  noAccountsStatusCode: 529,
  formatError: formatAnthropicError,

  parseAndValidate(body, reply) {
    const {
      model: modelParam,
      stream: streamParam,
      provider_account_id: providerAccountIdParam,
    } = body as {
      model?: unknown;
      stream?: unknown;
      provider_account_id?: unknown;
    };

    const streamEnabled =
      typeof streamParam === "boolean" ? streamParam : true;
    const requestedModel =
      typeof modelParam === "string"
        ? (modelParam as string).trim()
        : "";

    if (!requestedModel) {
      reply.code(400).send(
        formatAnthropicError({
          message: "model is required",
          type: "invalid_request_error",
        })
      );
      return null;
    }

    const rawErrorParams = Object.fromEntries(
      Object.entries(body as Record<string, unknown>).filter(
        ([key]) =>
          key !== "model" &&
          key !== "messages" &&
          key !== "stream" &&
          key !== "provider_account_id"
      )
    );

    const normalizedProviderAccountId =
      typeof providerAccountIdParam === "string"
        ? (providerAccountIdParam as string).trim()
        : "";

    const requestParamsForError: Record<string, unknown> = {
      stream: streamEnabled,
      ...rawErrorParams,
      ...(normalizedProviderAccountId
        ? { provider_account_id: normalizedProviderAccountId }
        : {}),
    };
    const requestMessagesForError = (body as { messages?: unknown })
      .messages;

    return {
      modelParam: requestedModel,
      stream: streamEnabled,
      providerAccountId:
        providerAccountIdParam !== undefined &&
        providerAccountIdParam !== null
          ? (providerAccountIdParam as string)
          : null,
      reasoningRequested: false, // handled inside transformAnthropicToOpenAI
      messagesForError: requestMessagesForError,
      paramsForError: requestParamsForError,
      routeData: { body },
    };
  },

  async buildRequest({
    routeData,
    model,
    stream,
    providerImpl,
    account,
  }) {
    const { body } = routeData as {
      body: Record<string, unknown>;
    };

    const openaiPayload = transformAnthropicToOpenAI(
      body as AnthropicRequestBody
    );

    openaiPayload.model = model;
    openaiPayload.stream = stream;

    const normalizedOpenAIPayload =
      openaiPayload as unknown as ChatCompletionRequest;

    return providerImpl.prepareRequest
      ? await providerImpl.prepareRequest(
          account,
          normalizedOpenAIPayload,
          "messages"
        )
      : normalizedOpenAIPayload;
  },

  async handleStream(ctx) {
    const {
      response,
      account,
      reply,
      request,
      requestStartTime,
      startTime,
      userId,
      apiKeyId,
      model,
    } = ctx;

    // Reconstruct includeThinking from the original body stored in routeData
    // We need the thinking param from the original anthropic body
    const body = (request.body as Record<string, unknown>) || {};
    const thinking = body.thinking as
      | { type?: string }
      | undefined;
    const includeThinking = thinking?.type === "enabled";

    const origin = request.headers.origin;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Provider-Account-Id": account.id,
      ...(origin
        ? {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Expose-Headers": "*",
            Vary: "Origin",
          }
        : {}),
    });

    const tracker = createAnthropicStreamTracker(
      model,
      (usage) => {
        markAccountSuccess(account.id).catch(() => undefined);
        recordLatency(
          account.provider,
          model,
          true,
          Date.now() - requestStartTime
        ).catch(() => undefined);

        logUsage({
          userId,
          providerAccountId: account.id,
          proxyApiKeyId: apiKeyId,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          statusCode: 200,
          duration: Date.now() - startTime,
          provider: account.provider,
        });
      },
      includeThinking
    );

    const startEvent = tracker.getStartEvent();
    if (startEvent) {
      reply.raw.write(startEvent);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const transformed = tracker.processChunk(text);
        if (transformed) {
          reply.raw.write(transformed);
        }
      }
    } catch {
      // Stream may have been closed by the client
    } finally {
      const flushed = tracker.flush();
      if (flushed) {
        reply.raw.write(flushed);
      }
      reply.raw.end();
    }
  },

  async handleNonStream(ctx) {
    const {
      response,
      account,
      reply,
      request,
      requestStartTime,
      startTime,
      userId,
      apiKeyId,
      model,
    } = ctx;

    const body = (request.body as Record<string, unknown>) || {};
    const thinking = body.thinking as
      | { type?: string }
      | undefined;
    const includeThinking = thinking?.type === "enabled";

    const openaiResponse =
      (await response.json()) as OpenAIResponse;
    const anthropicResponse = transformOpenAIToAnthropic(
      openaiResponse,
      model,
      includeThinking
    );

    markAccountSuccess(account.id).catch(() => undefined);
    recordLatency(
      account.provider,
      model,
      false,
      Date.now() - requestStartTime
    ).catch(() => undefined);

    logUsage({
      userId,
      providerAccountId: account.id,
      proxyApiKeyId: apiKeyId,
      model,
      inputTokens: openaiResponse.usage?.prompt_tokens ?? 0,
      outputTokens: openaiResponse.usage?.completion_tokens ?? 0,
      statusCode: 200,
      duration: Date.now() - startTime,
      provider: account.provider,
    });

    return reply
      .code(200)
      .header("X-Provider-Account-Id", account.id)
      .send(anthropicResponse);
  },
});
