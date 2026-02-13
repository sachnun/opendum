import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, logUsage, validateModelForUser } from "@/lib/proxy/auth";
import type { ApiKeyModelAccess } from "@/lib/proxy/auth";
import { getNextAvailableAccount, markAccountFailed, markAccountSuccess } from "@/lib/proxy/load-balancer";
import { getProvider } from "@/lib/proxy/providers";
import type { ProviderNameType } from "@/lib/proxy/providers/types";
import {
  clearExpiredRateLimits,
  getRateLimitScope,
  isRateLimited,
  markRateLimited,
  parseRateLimitError,
  getMinWaitTime,
  formatWaitTimeMs,
  parseRetryAfterMs,
} from "@/lib/proxy/rate-limit";
import { isModelSupportedByProvider } from "@/lib/proxy/models";
import {
  buildAccountErrorMessage,
  getErrorMessage,
  getErrorStatusCode,
  getSanitizedProxyError,
  type ProxyErrorType,
  shouldRotateToNextAccount,
} from "@/lib/proxy/error-utils";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
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

/**
 * Transform Anthropic messages format to OpenAI format
 * @returns OpenAI payload with _includeReasoning flag for conditional thinking output
 */
function transformAnthropicToOpenAI(body: AnthropicRequestBody): OpenAIPayload & { _includeReasoning?: boolean } {
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
      // System can be array of content blocks
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

    // Handle content that can be string or array of content blocks
    if (typeof msg.content === "string") {
      openaiMessages.push({ role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const toolCalls: OpenAIMessage["tool_calls"] = [];
      const structuredContentParts: Array<{ type: string; [key: string]: unknown }> = [];

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
              arguments: typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input || {}),
            },
          });
        } else if (block.type === "tool_result") {
          const toolContent = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter((b: AnthropicContentBlock) => b.type === "text")
                  .map((b: AnthropicContentBlock) => b.text || "")
                  .join("\n")
              : JSON.stringify(block.content);

          openaiMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id || "",
            content: toolContent,
          });
          continue;
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
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
      openaiPayload.tools = tools as unknown as OpenAIPayload["tools"];
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

          const description = (tool as { description?: unknown }).description;
          const inputSchema = (tool as { input_schema?: unknown }).input_schema;

          return {
            type: "function",
            function: {
              name,
              description: typeof description === "string" ? description : "",
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
      if (tool_choice === "auto" || tool_choice === "none") {
        (openaiPayload as OpenAIPayload & { tool_choice?: string }).tool_choice =
          tool_choice;
      } else if (tool_choice === "required") {
        (openaiPayload as OpenAIPayload & { tool_choice?: string }).tool_choice =
          "required";
      }
    } else if (typeof tool_choice === "object") {
      const choiceType = (tool_choice as { type?: unknown }).type;

      if (choiceType === "auto") {
        (openaiPayload as OpenAIPayload & { tool_choice?: string }).tool_choice =
          "auto";
      } else if (choiceType === "any") {
        (openaiPayload as OpenAIPayload & { tool_choice?: string }).tool_choice =
          "required";
      } else if (choiceType === "tool") {
        const name = (tool_choice as { name?: unknown }).name;
        (openaiPayload as OpenAIPayload & {
          tool_choice?: { type: string; function: { name: string } };
        }).tool_choice = {
          type: "function",
          function: { name: typeof name === "string" ? name : "" },
        };
      } else if (choiceType === "none") {
        (openaiPayload as OpenAIPayload & { tool_choice?: string }).tool_choice =
          "none";
      } else if (choiceType === "function") {
        const fn = (tool_choice as { function?: unknown }).function;
        const functionName =
          fn && typeof fn === "object"
            ? (fn as { name?: unknown }).name
            : null;

        (openaiPayload as OpenAIPayload & {
          tool_choice?: { type: string; function: { name: string } };
        }).tool_choice = {
          type: "function",
          function: {
            name: typeof functionName === "string" ? functionName : "",
          },
        };
      }
    }
  }

  if (thinkingRequested) {
    (openaiPayload as OpenAIPayload & { thinking_budget?: number }).thinking_budget = 
      thinking?.budget_tokens || 10000;
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
  const message = choice as unknown as { message?: { reasoning_content?: string; content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } };
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
  const stopReason = finishReason ? stopReasonMap[finishReason] : "end_turn";

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
 * Transform OpenAI streaming response to Anthropic format
 * Handles reasoning_content (thinking), text content, and tool_calls
 * @param model - The model name to include in responses
 * @param onComplete - Optional callback called when stream ends with usage data
 * @param includeThinking - Whether to include thinking blocks in response (default: true)
 */
function createAnthropicStreamTransformer(
  model: string,
  onComplete?: (usage: { inputTokens: number; outputTokens: number }) => void,
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

  const encoder = new TextEncoder();
  
  const reportUsage = () => {
    if (!usageReported && onComplete) {
      usageReported = true;
      onComplete({ inputTokens, outputTokens });
    }
  };

  return new TransformStream({
    start(controller) {
      const startEvent = {
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
      };
      controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(startEvent)}\n\n`));
    },

    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      buffer += text;

      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        const lines = event.split("\n");
        
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") {
            if (data === "[DONE]") {
              // Close any open thinking block
              if (thinkingBlockStarted) {
                controller.enqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
                ));
                currentBlockIndex++;
                thinkingBlockStarted = false;
              }

              // Close any open text block
              if (contentBlockStarted) {
                controller.enqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
                ));
                currentBlockIndex++;
                contentBlockStarted = false;
              }

              // Close all open tool_use blocks
              for (const tcIndex of Object.keys(toolBlockIndices).map(Number).sort((a, b) => a - b)) {
                const blockIdx = toolBlockIndices[tcIndex];
                controller.enqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`
                ));
              }

              // Determine stop_reason based on whether we had tool calls
              const stopReason = Object.keys(toolCallsByIndex).length > 0 ? "tool_use" : "end_turn";

              // Send message_delta with final info (include input_tokens from usage)
              const messageDelta = {
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { input_tokens: inputTokens, output_tokens: outputTokens },
              };
              controller.enqueue(encoder.encode(
                `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`
              ));

              // Send message_stop
              controller.enqueue(encoder.encode(
                `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
              ));
            }
            continue;
          }

          try {
            const parsed = JSON.parse(data);

            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens || inputTokens;
              outputTokens = parsed.usage.completion_tokens || outputTokens;
            }

            const choices = parsed.choices || [];
            if (choices.length === 0) continue;

            const delta = choices[0].delta || {};

            const reasoningContent = delta.reasoning_content;
            if (reasoningContent && includeThinking) {
              if (!thinkingBlockStarted) {
                const blockStart = {
                  type: "content_block_start",
                  index: currentBlockIndex,
                  content_block: { type: "thinking", thinking: "" },
                };
                controller.enqueue(encoder.encode(
                  `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`
                ));
                thinkingBlockStarted = true;
              }

              const blockDelta = {
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: { type: "thinking_delta", thinking: reasoningContent },
              };
              controller.enqueue(encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}\n\n`
              )              );
            }

            const content = delta.content;
            if (content && (content.trim() || contentBlockStarted)) {
              if (thinkingBlockStarted && !contentBlockStarted) {
                controller.enqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
                ));
                currentBlockIndex++;
                thinkingBlockStarted = false;
              }

              if (!contentBlockStarted) {
                const blockStart = {
                  type: "content_block_start",
                  index: currentBlockIndex,
                  content_block: { type: "text", text: "" },
                };
                controller.enqueue(encoder.encode(
                  `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`
                ));
                contentBlockStarted = true;
              }

              const blockDelta = {
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: { type: "text_delta", text: content },
              };
              controller.enqueue(encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}\n\n`
              )              );
            }

            const toolCalls = delta.tool_calls || [];
            for (const tc of toolCalls) {
              const tcIndex = tc.index ?? 0;

              if (!(tcIndex in toolCallsByIndex)) {
                if (thinkingBlockStarted) {
                  controller.enqueue(encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
                  ));
                  currentBlockIndex++;
                  thinkingBlockStarted = false;
                }

                if (contentBlockStarted) {
                  controller.enqueue(encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
                  ));
                  currentBlockIndex++;
                  contentBlockStarted = false;
                }

                toolCallsByIndex[tcIndex] = {
                  id: tc.id || `toolu_${Date.now()}_${tcIndex}`,
                  name: tc.function?.name || "",
                  arguments: "",
                };
                toolBlockIndices[tcIndex] = currentBlockIndex;

                const blockStart = {
                  type: "content_block_start",
                  index: currentBlockIndex,
                  content_block: {
                    type: "tool_use",
                    id: toolCallsByIndex[tcIndex].id,
                    name: toolCallsByIndex[tcIndex].name,
                    input: {},
                  },
                };
                controller.enqueue(encoder.encode(
                  `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`
                ));
                currentBlockIndex++;
              }

              const func = tc.function || {};
              if (func.name) {
                toolCallsByIndex[tcIndex].name = func.name;
              }
              if (func.arguments) {
                toolCallsByIndex[tcIndex].arguments += func.arguments;

                const blockDelta = {
                  type: "content_block_delta",
                  index: toolBlockIndices[tcIndex],
                  delta: {
                    type: "input_json_delta",
                    partial_json: func.arguments,
                  },
                };
                controller.enqueue(encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}\n\n`
                ));
              }
            }

            const finishReason = choices[0].finish_reason;
            if (finishReason) {
              if (thinkingBlockStarted) {
                controller.enqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
                ));
                currentBlockIndex++;
                thinkingBlockStarted = false;
              }

              // Close any open text block
              if (contentBlockStarted) {
                controller.enqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
                ));
                currentBlockIndex++;
                contentBlockStarted = false;
              }

              // Close all open tool_use blocks
              for (const tcIdx of Object.keys(toolBlockIndices).map(Number).sort((a, b) => a - b)) {
                const blockIdx = toolBlockIndices[tcIdx];
                controller.enqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`
                ));
              }

              // Map finish_reason to Anthropic stop_reason
              let stopReason = "end_turn";
              if (finishReason === "tool_calls" || Object.keys(toolCallsByIndex).length > 0) {
                stopReason = "tool_use";
              } else if (finishReason === "length") {
                stopReason = "max_tokens";
              }

              const messageDelta = {
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { input_tokens: inputTokens, output_tokens: outputTokens },
              };
              controller.enqueue(encoder.encode(
                `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`
              ));

              controller.enqueue(encoder.encode(
                `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
              ));
              
              reportUsage();
            }

          } catch {
            // Ignore parse errors
          }
        }
      }
    },

    flush(controller) {
      if (buffer.trim()) {
        if (buffer.includes("[DONE]")) {
          if (thinkingBlockStarted) {
            controller.enqueue(encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
            ));
          } else if (contentBlockStarted) {
            controller.enqueue(encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
            ));
          }

          for (const tcIndex of Object.keys(toolBlockIndices).map(Number).sort((a, b) => a - b)) {
            const blockIdx = toolBlockIndices[tcIndex];
            controller.enqueue(encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`
            ));
          }

          const stopReason = Object.keys(toolCallsByIndex).length > 0 ? "tool_use" : "end_turn";
          
          controller.enqueue(encoder.encode(
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { input_tokens: inputTokens, output_tokens: outputTokens },
            })}\n\n`
          ));
          
          controller.enqueue(encoder.encode(
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
          ));
          
          reportUsage();
        }
      }
      
      reportUsage();
    },
  });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  const authHeader = request.headers.get("authorization");
  const xApiKeyHeader = request.headers.get("x-api-key");

  let userId: string | undefined;
  let apiKeyId: string | undefined;
  let apiKeyModelAccess: ApiKeyModelAccess | undefined;

  if (authHeader || xApiKeyHeader) {
    const authResult = await validateApiKey(authHeader || xApiKeyHeader);

    if (!authResult.valid) {
      return NextResponse.json(
        {
          type: "error",
          error: { type: "authentication_error", message: authResult.error },
        },
        { status: 401 }
      );
    }

    userId = authResult.userId;
    apiKeyId = authResult.apiKeyId;
    apiKeyModelAccess = {
      mode: authResult.modelAccessMode ?? "all",
      models: authResult.modelAccessList ?? [],
    };
  } else {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message: "Missing Authorization header",
          },
        },
        { status: 401 }
      );
    }

    userId = session.user.id;
  }

  if (!userId) {
    return NextResponse.json(
      {
        type: "error",
        error: {
          type: "authentication_error",
          message: "Missing Authorization header",
        },
      },
      { status: 401 }
    );
  }

  const authenticatedUserId = userId;

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "Invalid JSON in request body" },
        },
        { status: 400 }
      );
    }
    const {
      model: modelParam,
      stream: streamParam,
      provider_account_id: providerAccountIdParam,
    } = body as {
      model?: unknown;
      stream?: unknown;
      provider_account_id?: unknown;
    };

    const streamEnabled = typeof streamParam === "boolean" ? streamParam : true;

    const requestedModel = typeof modelParam === "string" ? modelParam.trim() : "";

    if (!requestedModel) {
      return NextResponse.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "model is required" },
        },
        { status: 400 }
      );
    }

    const modelValidation = await validateModelForUser(
      authenticatedUserId,
      requestedModel,
      apiKeyModelAccess
    );
    if (!modelValidation.valid) {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
      return NextResponse.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: modelValidation.error },
          request_id: requestId,
        },
        { status: 400 }
      );
    }

    const { provider, model } = modelValidation;
    const rateLimitScope = getRateLimitScope(model);
    const MAX_ACCOUNT_RETRIES = 5;
    const triedAccountIds: string[] = [];
    let lastAccountFailure:
      | {
          statusCode: number;
          message: string;
          type: ProxyErrorType;
        }
      | null = null;
    const rawErrorParams = Object.fromEntries(
      Object.entries(body as Record<string, unknown>).filter(
        ([key]) =>
          key !== "model" &&
          key !== "messages" &&
          key !== "stream" &&
          key !== "provider_account_id"
      )
    );
    const hasProviderAccountParam =
      providerAccountIdParam !== undefined && providerAccountIdParam !== null;
    const normalizedProviderAccountId =
      typeof providerAccountIdParam === "string" ? providerAccountIdParam.trim() : "";

    if (hasProviderAccountParam && normalizedProviderAccountId.length === 0) {
      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "provider_account_id must be a non-empty string",
          },
        },
        { status: 400 }
      );
    }

    const requestParamsForError: Record<string, unknown> = {
      stream: streamEnabled,
      ...rawErrorParams,
      ...(normalizedProviderAccountId
        ? { provider_account_id: normalizedProviderAccountId }
        : {}),
    };
    const requestMessagesForError = (body as { messages?: unknown }).messages;

    const forcedAccount = normalizedProviderAccountId
      ? await prisma.providerAccount.findFirst({
          where: {
            id: normalizedProviderAccountId,
            userId: authenticatedUserId,
          },
        })
      : null;

    if (normalizedProviderAccountId && !forcedAccount) {
      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Selected provider account was not found",
          },
        },
        { status: 400 }
      );
    }

    if (forcedAccount && !forcedAccount.isActive) {
      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Selected provider account is inactive",
          },
        },
        { status: 400 }
      );
    }

    if (forcedAccount) {
      if (!isModelSupportedByProvider(model, forcedAccount.provider)) {
        return NextResponse.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: `Selected account provider "${forcedAccount.provider}" does not support model "${model}"`,
            },
          },
          { status: 400 }
        );
      }

      if (provider !== null && forcedAccount.provider !== provider) {
        return NextResponse.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: `Selected account provider "${forcedAccount.provider}" does not match model provider "${provider}"`,
            },
          },
          { status: 400 }
        );
      }

      clearExpiredRateLimits(forcedAccount.id);
      if (await isRateLimited(forcedAccount.id, rateLimitScope)) {
        const waitTimeMs = await getMinWaitTime([forcedAccount.id], rateLimitScope);
        return NextResponse.json(
          {
            type: "error",
            error: {
              type: "overloaded_error",
              message:
                waitTimeMs > 0
                  ? `Selected account is rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`
                  : "Selected account is rate limited.",
              retry_after: waitTimeMs > 0 ? formatWaitTimeMs(waitTimeMs) : undefined,
              retry_after_ms: waitTimeMs > 0 ? waitTimeMs : undefined,
            },
          },
          { status: 529 }
        );
      }
    }

    const accountRetryLimit = forcedAccount ? 1 : MAX_ACCOUNT_RETRIES;

    for (let attempt = 0; attempt < accountRetryLimit; attempt++) {
      let account = forcedAccount;

      if (!account) {
        account = await getNextAvailableAccount(
          authenticatedUserId,
          model,
          provider,
          triedAccountIds
        );
      }

      if (!account) {
        const isFirstAttempt = triedAccountIds.length === 0;
        
        if (isFirstAttempt) {
          return NextResponse.json(
            {
              type: "error",
              error: {
                type: "overloaded_error",
                message: "No active accounts available for this model. Please add an account in the dashboard.",
              },
            },
            { status: 529 }
          );
        }

        const waitTimeMs = await getMinWaitTime(triedAccountIds, rateLimitScope);
        if (waitTimeMs > 0) {
          return NextResponse.json(
            {
              type: "error",
              error: {
                type: "overloaded_error",
                message: `All accounts are rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`,
                retry_after: formatWaitTimeMs(waitTimeMs),
                retry_after_ms: waitTimeMs,
              },
            },
            { status: 529 }
          );
        }

        if (lastAccountFailure) {
          return NextResponse.json(
            {
              type: "error",
              error: {
                type: lastAccountFailure.type,
                message: lastAccountFailure.message,
              },
            },
            { status: lastAccountFailure.statusCode }
          );
        }

        return NextResponse.json(
          {
            type: "error",
            error: {
              type: "api_error",
              message: "No available accounts for this request.",
            },
          },
          { status: 503 }
        );
      }

      triedAccountIds.push(account.id);

      if (forcedAccount) {
        await prisma.providerAccount.update({
          where: { id: account.id },
          data: {
            lastUsedAt: new Date(),
            requestCount: { increment: 1 },
          },
        });
      }

      try {
        const providerImpl = await getProvider(account.provider as ProviderNameType);
        const credentials = await providerImpl.getValidCredentials(account);

        const openaiPayload = transformAnthropicToOpenAI(body as AnthropicRequestBody);

        // Override model with validated model (without provider prefix)
        openaiPayload.model = model;
        openaiPayload.stream = streamEnabled;

        const includeThinking = openaiPayload._includeReasoning ?? false;

        const normalizedOpenAIPayload =
          openaiPayload as unknown as import("@/lib/proxy/providers/types").ChatCompletionRequest;

        const requestBody = providerImpl.prepareRequest
          ? providerImpl.prepareRequest(account, normalizedOpenAIPayload, "messages")
          : normalizedOpenAIPayload;

        const providerResponse = await providerImpl.makeRequest(
          credentials,
          account,
          requestBody,
          streamEnabled
        );

        if (providerResponse.status === 429) {
          const retryAfterMsFromHeader = parseRetryAfterMs(providerResponse);
          const fallbackRetryAfterMs =
            account.provider === "kiro" ? 60 * 1000 : 60 * 60 * 1000;
          const clonedResponse = providerResponse.clone();
          try {
            const errorBody = await clonedResponse.json();
            const rateLimitInfo = parseRateLimitError(errorBody);
            const retryAfterMs =
              rateLimitInfo?.retryAfterMs ??
              retryAfterMsFromHeader ??
              fallbackRetryAfterMs;

            await markRateLimited(
              account.id,
              rateLimitScope,
              retryAfterMs,
              rateLimitInfo?.model,
              rateLimitInfo?.message
            );

            await logUsage({
              userId: authenticatedUserId,
              providerAccountId: account.id,
              proxyApiKeyId: apiKeyId,
              model,
              inputTokens: 0,
              outputTokens: 0,
              statusCode: 429,
              duration: Date.now() - startTime,
            });

            continue;
          } catch {
            const retryAfterMs = retryAfterMsFromHeader ?? fallbackRetryAfterMs;
            await markRateLimited(account.id, rateLimitScope, retryAfterMs);
            continue;
          }
        }

        if (!providerResponse.ok) {
          const errorText = await providerResponse.text();

          const detailedError = buildAccountErrorMessage(errorText, {
            model,
            provider: account.provider,
            endpoint: "/v1/messages",
            messages: requestMessagesForError,
            parameters: requestParamsForError,
          });

          await markAccountFailed(account.id, providerResponse.status, detailedError);

          await logUsage({
            userId: authenticatedUserId,
            providerAccountId: account.id,
            proxyApiKeyId: apiKeyId,
            model,
            inputTokens: 0,
            outputTokens: 0,
            statusCode: providerResponse.status,
            duration: Date.now() - startTime,
          });

          const sanitizedError = getSanitizedProxyError(providerResponse.status);

          lastAccountFailure = {
            statusCode: providerResponse.status,
            message: sanitizedError.message,
            type: sanitizedError.type,
          };

          if (
            shouldRotateToNextAccount(providerResponse.status) &&
            attempt < accountRetryLimit - 1
          ) {
            continue;
          }

          return NextResponse.json(
            {
              type: "error",
              error: {
                type: lastAccountFailure.type,
                message: lastAccountFailure.message,
              },
            },
            { status: lastAccountFailure.statusCode }
          );
        }

        if (streamEnabled && providerResponse.body) {
          const transformer = createAnthropicStreamTransformer(model, (usage) => {
            // Track success for this account (non-blocking)
            markAccountSuccess(account.id).catch(() => undefined);

            logUsage({
              userId: authenticatedUserId,
              providerAccountId: account.id,
              proxyApiKeyId: apiKeyId,
              model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              statusCode: 200,
              duration: Date.now() - startTime,
              provider: account.provider,
            });
          }, includeThinking);
          const transformedStream = providerResponse.body.pipeThrough(transformer);

          return new Response(transformedStream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        }

        const openaiResponse = await providerResponse.json();
        const anthropicResponse = transformOpenAIToAnthropic(openaiResponse, model, includeThinking);

        // Track success for this account (non-blocking)
        markAccountSuccess(account.id).catch(() => undefined);

        logUsage({
          userId: authenticatedUserId,
          providerAccountId: account.id,
          proxyApiKeyId: apiKeyId,
          model,
          inputTokens: openaiResponse.usage?.prompt_tokens ?? 0,
          outputTokens: openaiResponse.usage?.completion_tokens ?? 0,
          statusCode: 200,
          duration: Date.now() - startTime,
          provider: account.provider,
        });

        return NextResponse.json(anthropicResponse);
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const statusCode = getErrorStatusCode(error);
        const detailedError = buildAccountErrorMessage(errorMessage, {
          model,
          provider: account.provider,
          endpoint: "/v1/messages",
          messages: requestMessagesForError,
          parameters: requestParamsForError,
        });

        console.error(
          `[${account.provider}] request failed for account ${account.id}:`,
          error
        );

        await markAccountFailed(account.id, statusCode, detailedError);

        await logUsage({
          userId: authenticatedUserId,
          providerAccountId: account.id,
          proxyApiKeyId: apiKeyId,
          model,
          inputTokens: 0,
          outputTokens: 0,
          statusCode,
          duration: Date.now() - startTime,
        });

        const sanitizedError = getSanitizedProxyError(statusCode);

        lastAccountFailure = {
          statusCode,
          message: sanitizedError.message,
          type: sanitizedError.type,
        };

        if (shouldRotateToNextAccount(statusCode) && attempt < accountRetryLimit - 1) {
          continue;
        }

        return NextResponse.json(
          {
            type: "error",
            error: {
              type: lastAccountFailure.type,
              message: lastAccountFailure.message,
            },
          },
          { status: lastAccountFailure.statusCode }
        );
      }
    }

    const waitTimeMs = await getMinWaitTime(triedAccountIds, rateLimitScope);
    if (waitTimeMs > 0) {
      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "overloaded_error",
            message: `All accounts are rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`,
            retry_after: formatWaitTimeMs(waitTimeMs),
            retry_after_ms: waitTimeMs,
          },
        },
        { status: 529 }
      );
    }

    if (lastAccountFailure) {
      return NextResponse.json(
        {
          type: "error",
          error: {
            type: lastAccountFailure.type,
            message: lastAccountFailure.message,
          },
        },
        { status: lastAccountFailure.statusCode }
      );
    }

    return NextResponse.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: "No available accounts for this request.",
        },
      },
      { status: 503 }
    );
  } catch (error) {
    console.error("Proxy error:", error);

    return NextResponse.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: "Internal server error",
        },
      },
      { status: 500 }
    );
  }
}
