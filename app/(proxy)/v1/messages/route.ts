import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, logUsage, validateModelForUser } from "@/lib/proxy/auth";
import type { ApiKeyModelAccess } from "@/lib/proxy/auth";
import { getNextAvailableAccount, markAccountFailed, markAccountSuccess } from "@/lib/proxy/load-balancer";
import { getProvider } from "@/lib/proxy/providers";
import type { ProviderNameType } from "@/lib/proxy/providers/types";
import { markRateLimited, parseRateLimitError, getMinWaitTime, formatWaitTimeMs } from "@/lib/proxy/rate-limit";
import { getModelFamily } from "@/lib/proxy/providers/antigravity/converter";
import {
  buildAccountErrorMessage,
  getErrorMessage,
  getErrorStatusCode,
  getSanitizedProxyError,
  type ProxyErrorType,
  shouldRotateToNextAccount,
} from "@/lib/proxy/error-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface OpenAIMessage {
  role: string;
  content?: string | null;
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
  const { model, messages, system, max_tokens, stream, tools, tool_choice, thinking, ...params } = body;

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
      let textContent = "";

      for (const block of msg.content) {
        if (block.type === "text") {
          textContent += block.text || "";
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

      if (role === "assistant" && toolCalls.length > 0) {
        openaiMessages.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolCalls,
        });
      } else if (textContent) {
        openaiMessages.push({ role, content: textContent });
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

  if (tools && tools.length > 0) {
    openaiPayload.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || {},
      },
    }));
  }

  if (tool_choice) {
    const choiceType = tool_choice.type;
    if (choiceType === "auto") {
      (openaiPayload as OpenAIPayload & { tool_choice?: string }).tool_choice = "auto";
    } else if (choiceType === "any") {
      (openaiPayload as OpenAIPayload & { tool_choice?: string }).tool_choice = "required";
    } else if (choiceType === "tool") {
      (openaiPayload as OpenAIPayload & { tool_choice?: { type: string; function: { name: string } } }).tool_choice = {
        type: "function",
        function: { name: tool_choice.name || "" },
      };
    } else if (choiceType === "none") {
      (openaiPayload as OpenAIPayload & { tool_choice?: string }).tool_choice = "none";
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

  const authHeader = request.headers.get("authorization") || request.headers.get("x-api-key");
  const authResult = await validateApiKey(authHeader);

  if (!authResult.valid) {
    return NextResponse.json(
      {
        type: "error",
        error: { type: "authentication_error", message: authResult.error },
      },
      { status: 401 }
    );
  }

  const { userId, apiKeyId } = authResult;
  const apiKeyModelAccess: ApiKeyModelAccess = {
    mode: authResult.modelAccessMode ?? "all",
    models: authResult.modelAccessList ?? [],
  };

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
    const { model: modelParam, stream = true } = body;

    if (!modelParam) {
      return NextResponse.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "model is required" },
        },
        { status: 400 }
      );
    }

    const modelValidation = await validateModelForUser(
      userId!,
      modelParam,
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
    const family = getModelFamily(model);
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
        ([key]) => key !== "model" && key !== "messages" && key !== "stream"
      )
    );
    const requestParamsForError: Record<string, unknown> = {
      stream,
      ...rawErrorParams,
    };

    for (let attempt = 0; attempt < MAX_ACCOUNT_RETRIES; attempt++) {
      const account = await getNextAvailableAccount(
        userId!,
        model,
        provider,
        triedAccountIds
      );

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

        const waitTimeMs = getMinWaitTime(triedAccountIds, family);
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

      try {
        const providerImpl = await getProvider(account.provider as ProviderNameType);
        const credentials = await providerImpl.getValidCredentials(account);

        const openaiPayload = transformAnthropicToOpenAI(body);

        // Override model with validated model (without provider prefix)
        openaiPayload.model = model;

        const includeThinking = openaiPayload._includeReasoning ?? false;

        const providerResponse = await providerImpl.makeRequest(
          credentials,
          account,
          openaiPayload as unknown as import("@/lib/proxy/providers/types").ChatCompletionRequest,
          stream
        );

        if (providerResponse.status === 429) {
          const clonedResponse = providerResponse.clone();
          try {
            const errorBody = await clonedResponse.json();
            const rateLimitInfo = parseRateLimitError(errorBody);

            if (rateLimitInfo) {
              markRateLimited(
                account.id,
                family,
                rateLimitInfo.retryAfterMs,
                rateLimitInfo.model,
                rateLimitInfo.message
              );
            } else {
              markRateLimited(account.id, family, 60 * 60 * 1000);
            }

            await logUsage({
              userId: userId!,
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
            markRateLimited(account.id, family, 60 * 60 * 1000);
            continue;
          }
        }

        if (!providerResponse.ok) {
          const errorText = await providerResponse.text();
          console.error(`${account.provider} error:`, providerResponse.status, errorText);

          const detailedError = buildAccountErrorMessage(errorText, {
            model,
            parameters: requestParamsForError,
          });

          await markAccountFailed(account.id, providerResponse.status, detailedError);

          await logUsage({
            userId: userId!,
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
            attempt < MAX_ACCOUNT_RETRIES - 1
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

        if (stream && providerResponse.body) {
          const transformer = createAnthropicStreamTransformer(model, (usage) => {
            // Track success for this account (non-blocking)
            markAccountSuccess(account.id).catch(() => undefined);

            logUsage({
              userId: userId!,
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
          userId: userId!,
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
          parameters: requestParamsForError,
        });

        console.error(
          `[${account.provider}] request failed for account ${account.id}:`,
          error
        );

        await markAccountFailed(account.id, statusCode, detailedError);

        await logUsage({
          userId: userId!,
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

        if (shouldRotateToNextAccount(statusCode) && attempt < MAX_ACCOUNT_RETRIES - 1) {
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

    const waitTimeMs = getMinWaitTime(triedAccountIds, family);
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
