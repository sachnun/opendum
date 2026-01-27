import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, logUsage, validateModel } from "@/lib/proxy/auth";
import { getNextAccount } from "@/lib/proxy/load-balancer";
import { getValidApiKey, makeIFlowRequest } from "@/lib/proxy/iflow-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a TransformStream that tracks usage from OpenAI streaming response
 * and calls onComplete when the stream ends
 */
function createUsageTrackingStream(
  onComplete: (usage: { inputTokens: number; outputTokens: number }) => void
) {
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;

  return new TransformStream({
    transform(chunk, controller) {
      // Pass through the chunk unchanged
      controller.enqueue(chunk);

      // Try to extract usage from the chunk
      const text = new TextDecoder().decode(chunk);
      buffer += text;

      // Process complete SSE events
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        const lines = event.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            // Extract usage if present (iFlow sends usage in the final chunk)
            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens || inputTokens;
              outputTokens = parsed.usage.completion_tokens || outputTokens;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    },

    flush() {
      // Process any remaining buffer
      if (buffer.trim()) {
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens || inputTokens;
              outputTokens = parsed.usage.completion_tokens || outputTokens;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      // Call onComplete with the tracked usage
      onComplete({ inputTokens, outputTokens });
    },
  });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  // Validate API key
  const authHeader = request.headers.get("authorization");
  const authResult = await validateApiKey(authHeader);

  if (!authResult.valid) {
    return NextResponse.json(
      { error: { message: authResult.error, type: "authentication_error" } },
      { status: 401 }
    );
  }

  const { userId, apiKeyId } = authResult;

  try {
    // Parse request body
    const body = await request.json();
    const { model, messages, stream = true, ...params } = body;

    if (!model) {
      return NextResponse.json(
        { error: { message: "model is required", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    const modelValidation = validateModel(model);
    if (!modelValidation.valid) {
      return NextResponse.json(
        {
          error: {
            message: modelValidation.error,
            type: "invalid_request_error",
            param: modelValidation.param,
            code: modelValidation.code,
          },
        },
        { status: 400 }
      );
    }

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: { message: "messages array is required", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    // Get next iFlow account using round-robin
    const account = await getNextAccount(userId!);

    if (!account) {
      return NextResponse.json(
        {
          error: {
            message: "No active iFlow accounts. Please add an account in the dashboard.",
            type: "configuration_error",
          },
        },
        { status: 503 }
      );
    }

    // Get valid API key (refreshes token if needed)
    const iflowApiKey = await getValidApiKey(account.id);

    // Make request to iFlow (respects stream parameter)
    const iflowResponse = await makeIFlowRequest(
      iflowApiKey,
      model,
      { messages, ...params },
      stream
    );

    // Handle errors from iFlow
    if (!iflowResponse.ok) {
      const errorText = await iflowResponse.text();
      console.error("iFlow error:", iflowResponse.status, errorText);

      // Log failed request with 0 tokens
      await logUsage({
        userId: userId!,
        iflowAccountId: account.id,
        proxyApiKeyId: apiKeyId,
        model,
        inputTokens: 0,
        outputTokens: 0,
        statusCode: iflowResponse.status,
        duration: Date.now() - startTime,
      });

      return NextResponse.json(
        {
          error: {
            message: `iFlow API error: ${errorText}`,
            type: "api_error",
          },
        },
        { status: iflowResponse.status }
      );
    }

    // Streaming response
    if (stream) {
      const responseBody = iflowResponse.body;

      if (!responseBody) {
        return NextResponse.json(
          { error: { message: "No response body", type: "api_error" } },
          { status: 500 }
        );
      }

      // Create usage tracking stream that logs when complete
      const usageTracker = createUsageTrackingStream((usage) => {
        logUsage({
          userId: userId!,
          iflowAccountId: account.id,
          proxyApiKeyId: apiKeyId,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          statusCode: 200,
          duration: Date.now() - startTime,
        });
      });

      return new Response(responseBody.pipeThrough(usageTracker), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // Non-streaming response
    const responseData = await iflowResponse.json();

    // Log with actual token usage from response
    logUsage({
      userId: userId!,
      iflowAccountId: account.id,
      proxyApiKeyId: apiKeyId,
      model,
      inputTokens: responseData.usage?.prompt_tokens ?? 0,
      outputTokens: responseData.usage?.completion_tokens ?? 0,
      statusCode: 200,
      duration: Date.now() - startTime,
    });

    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Proxy error:", error);

    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Internal server error",
          type: "api_error",
        },
      },
      { status: 500 }
    );
  }
}
