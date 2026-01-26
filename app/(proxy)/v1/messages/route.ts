import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, logUsage } from "@/lib/proxy/auth";
import { getNextAccount } from "@/lib/proxy/load-balancer";
import { getValidApiKey, makeIFlowRequest } from "@/lib/proxy/iflow-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Transform Anthropic messages format to OpenAI format
 */
function transformAnthropicToOpenAI(body: any): any {
  const { model, messages, system, max_tokens, stream, ...params } = body;

  // Build OpenAI-style messages
  const openaiMessages: any[] = [];

  // Add system message if present
  if (system) {
    if (typeof system === "string") {
      openaiMessages.push({ role: "system", content: system });
    } else if (Array.isArray(system)) {
      // System can be array of content blocks
      const systemContent = system
        .map((block: any) => {
          if (typeof block === "string") return block;
          if (block.type === "text") return block.text;
          return "";
        })
        .join("\n");
      openaiMessages.push({ role: "system", content: systemContent });
    }
  }

  // Transform messages
  for (const msg of messages || []) {
    const role = msg.role === "assistant" ? "assistant" : "user";

    // Handle content that can be string or array of content blocks
    let content: any;
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Transform content blocks
      content = msg.content
        .map((block: any) => {
          if (block.type === "text") return block.text;
          if (block.type === "tool_result") {
            return `Tool result for ${block.tool_use_id}: ${JSON.stringify(block.content)}`;
          }
          if (block.type === "tool_use") {
            return `[Tool call: ${block.name}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    openaiMessages.push({ role, content });
  }

  return {
    model,
    messages: openaiMessages,
    max_tokens: max_tokens || 4096,
    ...params,
  };
}

/**
 * Transform OpenAI response to Anthropic format (non-streaming)
 */
function transformOpenAIToAnthropic(openaiResponse: any, model: string): any {
  const choice = openaiResponse.choices?.[0];
  const message = choice?.message;
  const usage = openaiResponse.usage;

  return {
    id: `msg_${openaiResponse.id || Date.now()}`,
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: message?.content || "",
      },
    ],
    model: model,
    stop_reason: choice?.finish_reason === "stop" ? "end_turn" : choice?.finish_reason || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
    },
  };
}

/**
 * Transform OpenAI streaming response to Anthropic format
 */
function createAnthropicStreamTransformer(model: string) {
  let messageId = `msg_${Date.now()}`;
  let outputTokens = 0;
  let buffer = "";

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
      controller.enqueue(`event: message_start\ndata: ${JSON.stringify(startEvent)}\n\n`);

      // Send content_block_start
      const blockStart = {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      };
      controller.enqueue(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`);
    },

    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      buffer += text;

      // Process complete SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);

          if (data === "[DONE]") {
            // Send content_block_stop
            const blockStop = { type: "content_block_stop", index: 0 };
            controller.enqueue(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);

            // Send message_delta with stop_reason
            const messageDelta = {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: outputTokens },
            };
            controller.enqueue(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);

            // Send message_stop
            const messageStop = { type: "message_stop" };
            controller.enqueue(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`);
            return;
          }

          try {
            const parsed = JSON.parse(data);

            // Extract content from OpenAI format
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              outputTokens += 1; // Rough estimate

              const delta = {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: content },
              };
              controller.enqueue(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`);
            }

            // Check for finish reason
            const finishReason = parsed.choices?.[0]?.finish_reason;
            if (finishReason) {
              const blockStop = { type: "content_block_stop", index: 0 };
              controller.enqueue(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);

              const stopReason = finishReason === "stop" ? "end_turn" : finishReason;
              const messageDelta = {
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: outputTokens },
              };
              controller.enqueue(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);

              const messageStop = { type: "message_stop" };
              controller.enqueue(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`);
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    },

    flush(controller) {
      // Process any remaining buffer
      if (buffer.trim()) {
        // Handle remaining data if any
      }
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
    const body = await request.json();
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

    // Get next iFlow account using round-robin
    const account = await getNextAccount(userId!);

    if (!account) {
      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "overloaded_error",
            message: "No active iFlow accounts. Please add an account in the dashboard.",
          },
        },
        { status: 529 }
      );
    }

    // Get valid API key (refreshes token if needed)
    const iflowApiKey = await getValidApiKey(account.id);

    // Transform Anthropic format to OpenAI format
    const openaiPayload = transformAnthropicToOpenAI(body);

    // Make request to iFlow with correct stream parameter
    const iflowResponse = await makeIFlowRequest(iflowApiKey, model, openaiPayload, stream);

    // Handle errors from iFlow
    if (!iflowResponse.ok) {
      const errorText = await iflowResponse.text();
      console.error("iFlow error:", iflowResponse.status, errorText);

      // Log failed request
      await logUsage({
        userId: userId!,
        iflowAccountId: account.id,
        proxyApiKeyId: apiKeyId,
        model,
        statusCode: iflowResponse.status,
        duration: Date.now() - startTime,
      });

      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: `iFlow API error: ${errorText}`,
          },
        },
        { status: iflowResponse.status }
      );
    }

    // Log successful request
    logUsage({
      userId: userId!,
      iflowAccountId: account.id,
      proxyApiKeyId: apiKeyId,
      model,
      statusCode: 200,
      duration: Date.now() - startTime,
    });

    // Streaming response
    if (stream && iflowResponse.body) {
      // Transform OpenAI stream to Anthropic stream
      const transformer = createAnthropicStreamTransformer(model);
      const transformedStream = iflowResponse.body.pipeThrough(transformer);

      return new Response(transformedStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Non-streaming response - transform OpenAI to Anthropic format
    const openaiResponse = await iflowResponse.json();
    const anthropicResponse = transformOpenAIToAnthropic(openaiResponse, model);
    
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
