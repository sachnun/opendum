import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, logUsage, validateModel } from "@/lib/proxy/auth";
import { getNextAccount } from "@/lib/proxy/load-balancer";
import { getProvider } from "@/lib/proxy/providers";
import type { ProviderNameType } from "@/lib/proxy/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Type definitions
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
  // Anthropic thinking parameter for extended thinking
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

  // Determine if thinking/reasoning was explicitly requested
  const thinkingRequested = thinking?.type === "enabled";

  // Build OpenAI-style messages
  const openaiMessages: OpenAIMessage[] = [];

  // Add system message if present
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

  // Transform messages
  for (const msg of messages || []) {
    const role = msg.role;

    // Handle content that can be string or array of content blocks
    if (typeof msg.content === "string") {
      openaiMessages.push({ role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Process content blocks
      const toolCalls: OpenAIMessage["tool_calls"] = [];
      let textContent = "";

      for (const block of msg.content) {
        if (block.type === "text") {
          textContent += block.text || "";
        } else if (block.type === "tool_use") {
          // Anthropic tool_use -> OpenAI tool_calls (for assistant messages)
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
          // Tool results become separate messages in OpenAI format
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
          continue; // Don't add to current message
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          // Skip thinking blocks - they are for context only
          continue;
        }
      }

      // Build the message
      if (role === "assistant" && toolCalls.length > 0) {
        // Assistant message with tool calls
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

  // Build OpenAI payload
  const openaiPayload: OpenAIPayload = {
    model,
    messages: openaiMessages,
    max_tokens: max_tokens || 4096,
    stream,
    ...params,
  };

  // Convert Anthropic tools to OpenAI format
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

  // Convert tool_choice
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

  // Handle Anthropic thinking parameter - convert to OpenAI format
  if (thinkingRequested) {
    (openaiPayload as OpenAIPayload & { thinking_budget?: number }).thinking_budget = 
      thinking?.budget_tokens || 10000; // Default to medium budget
  }

  // Return with internal flag for conditional thinking output
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

  // Build content blocks
  const contentBlocks: AnthropicContentBlockOutput[] = [];

  // 1. Add thinking block if reasoning_content is present AND thinking was requested
  const reasoningContent = messageData?.reasoning_content;
  if (reasoningContent && includeThinking) {
    contentBlocks.push({
      type: "thinking",
      thinking: reasoningContent,
    });
  }

  // 2. Add text block if content is present
  const textContent = messageData?.content;
  if (textContent) {
    contentBlocks.push({
      type: "text",
      text: textContent,
    });
  }

  // 3. Add tool_use blocks if tool_calls are present
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

  // If no content blocks, add empty text block
  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: "text",
      text: "",
    });
  }

  // Map finish_reason to stop_reason
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
  
  // State tracking
  let buffer = "";
  let thinkingBlockStarted = false;
  let contentBlockStarted = false;
  let currentBlockIndex = 0;
  const toolCallsByIndex: Record<number, ToolCall> = {};
  const toolBlockIndices: Record<number, number> = {};
  
  // Usage tracking
  let inputTokens = 0;
  let outputTokens = 0;
  let usageReported = false;

  const encoder = new TextEncoder();
  
  // Helper to report usage only once
  const reportUsage = () => {
    if (!usageReported && onComplete) {
      usageReported = true;
      onComplete({ inputTokens, outputTokens });
    }
  };

  return new TransformStream({
    start(controller) {
      // Send message_start event
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

      // Process complete SSE events (split by double newline)
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

            // Extract usage if present
            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens || inputTokens;
              outputTokens = parsed.usage.completion_tokens || outputTokens;
            }

            const choices = parsed.choices || [];
            if (choices.length === 0) continue;

            const delta = choices[0].delta || {};

            // Handle reasoning/thinking content - only include if thinking was requested
            const reasoningContent = delta.reasoning_content;
            if (reasoningContent && includeThinking) {
              if (!thinkingBlockStarted) {
                // Start a thinking content block
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

              // Send thinking delta
              const blockDelta = {
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: { type: "thinking_delta", thinking: reasoningContent },
              };
              controller.enqueue(encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}\n\n`
              ));
            }

            // Handle text content (skip whitespace-only if thinking hasn't started yet)
            const content = delta.content;
            if (content && (content.trim() || contentBlockStarted)) {
              // If we were in a thinking block, close it first
              if (thinkingBlockStarted && !contentBlockStarted) {
                controller.enqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
                ));
                currentBlockIndex++;
                thinkingBlockStarted = false;
              }

              if (!contentBlockStarted) {
                // Start a text content block
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

              // Send content delta
              const blockDelta = {
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: { type: "text_delta", text: content },
              };
              controller.enqueue(encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}\n\n`
              ));
            }

            // Handle tool calls
            const toolCalls = delta.tool_calls || [];
            for (const tc of toolCalls) {
              const tcIndex = tc.index ?? 0;

              if (!(tcIndex in toolCallsByIndex)) {
                // Close previous thinking block if open
                if (thinkingBlockStarted) {
                  controller.enqueue(encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
                  ));
                  currentBlockIndex++;
                  thinkingBlockStarted = false;
                }

                // Close previous text block if open
                if (contentBlockStarted) {
                  controller.enqueue(encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
                  ));
                  currentBlockIndex++;
                  contentBlockStarted = false;
                }

                // Initialize new tool call
                toolCallsByIndex[tcIndex] = {
                  id: tc.id || `toolu_${Date.now()}_${tcIndex}`,
                  name: tc.function?.name || "",
                  arguments: "",
                };
                // Track which block index this tool call uses
                toolBlockIndices[tcIndex] = currentBlockIndex;

                // Start new tool use block
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
                // Increment for the next block
                currentBlockIndex++;
              }

              // Accumulate function data
              const func = tc.function || {};
              if (func.name) {
                toolCallsByIndex[tcIndex].name = func.name;
              }
              if (func.arguments) {
                toolCallsByIndex[tcIndex].arguments += func.arguments;

                // Send partial JSON delta
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

            // Handle finish_reason (Iflow doesn't send [DONE], uses finish_reason instead)
            const finishReason = choices[0].finish_reason;
            if (finishReason) {
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
              
              // Report usage to callback
              reportUsage();
            }

          } catch (e) {
            // Ignore parse errors
            console.error("Parse error in stream:", e);
          }
        }
      }
    },

    flush(controller) {
      // Process any remaining buffer
      if (buffer.trim()) {
        // Check if there's a final [DONE] in the buffer
        if (buffer.includes("[DONE]")) {
          // Close any open blocks
          if (thinkingBlockStarted) {
            controller.enqueue(encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
            ));
          } else if (contentBlockStarted) {
            controller.enqueue(encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`
            ));
          }

          // Close tool blocks
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
          
          // Report usage to callback
          reportUsage();
        }
      }
      
      // Always report usage at the end of flush (fallback)
      reportUsage();
    },
  });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  // Validate API key
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

  try {
    // Parse request body
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
    const { model, stream = true } = body;

    if (!model) {
      return NextResponse.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "model is required" },
        },
        { status: 400 }
      );
    }

    const modelValidation = validateModel(model);
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

    // Get next account using round-robin (now supports multi-provider)
    const account = await getNextAccount(userId!, model);

    if (!account) {
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

    // Get the provider implementation
    const provider = await getProvider(account.provider as ProviderNameType);

    // Get valid credentials (handles token refresh if needed)
    const credentials = await provider.getValidCredentials(account);

    // Transform Anthropic format to OpenAI format
    const openaiPayload = transformAnthropicToOpenAI(body);
    
    // Extract includeThinking flag for response filtering
    const includeThinking = openaiPayload._includeReasoning ?? false;

    // Make request to provider's API
    const providerResponse = await provider.makeRequest(
      credentials,
      account,
      openaiPayload as unknown as import("@/lib/proxy/providers/types").ChatCompletionRequest,
      stream
    );

    // Handle errors from provider
    if (!providerResponse.ok) {
      const errorText = await providerResponse.text();
      console.error(`${account.provider} error:`, providerResponse.status, errorText);

      // Log failed request with 0 tokens
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

      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: `${account.provider} API error: ${errorText}`,
          },
        },
        { status: providerResponse.status }
      );
    }

    // Streaming response
    if (stream && providerResponse.body) {
      // Transform OpenAI stream to Anthropic stream with usage callback
      // Pass includeThinking to control whether thinking blocks are emitted
      const transformer = createAnthropicStreamTransformer(model, (usage) => {
        logUsage({
          userId: userId!,
          providerAccountId: account.id,
          proxyApiKeyId: apiKeyId,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          statusCode: 200,
          duration: Date.now() - startTime,
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

    // Non-streaming response - transform OpenAI to Anthropic format
    const openaiResponse = await providerResponse.json();
    const anthropicResponse = transformOpenAIToAnthropic(openaiResponse, model, includeThinking);
    
    // Log with actual token usage from response
    logUsage({
      userId: userId!,
      providerAccountId: account.id,
      proxyApiKeyId: apiKeyId,
      model,
      inputTokens: openaiResponse.usage?.prompt_tokens ?? 0,
      outputTokens: openaiResponse.usage?.completion_tokens ?? 0,
      statusCode: 200,
      duration: Date.now() - startTime,
    });
    
    return NextResponse.json(anthropicResponse);
  } catch (error) {
    console.error("Proxy error:", error);

    return NextResponse.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: error instanceof Error ? error.message : "Internal server error",
        },
      },
      { status: 500 }
    );
  }
}
