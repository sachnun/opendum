import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, logUsage, validateModel } from "@/lib/proxy/auth";
import {
  getNextAvailableAccount,
  markAccountFailed,
  markAccountSuccess,
} from "@/lib/proxy/load-balancer";
import { getProvider } from "@/lib/proxy/providers";
import type { ProviderNameType } from "@/lib/proxy/providers/types";
import {
  markRateLimited,
  parseRateLimitError,
  getMinWaitTime,
  formatWaitTimeMs,
} from "@/lib/proxy/rate-limit";
import { getModelFamily } from "@/lib/proxy/providers/antigravity/converter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a TransformStream that tracks usage from streaming response
 */
function createUsageTrackingStream(
  onComplete: (usage: { inputTokens: number; outputTokens: number }) => void
) {
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;

  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      const text = new TextDecoder().decode(chunk);
      buffer += text;

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
            if (parsed.usage) {
              inputTokens =
                parsed.usage.prompt_tokens ||
                parsed.usage.input_tokens ||
                inputTokens;
              outputTokens =
                parsed.usage.completion_tokens ||
                parsed.usage.output_tokens ||
                outputTokens;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    },

    flush() {
      if (buffer.trim()) {
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) {
              inputTokens =
                parsed.usage.prompt_tokens ||
                parsed.usage.input_tokens ||
                inputTokens;
              outputTokens =
                parsed.usage.completion_tokens ||
                parsed.usage.output_tokens ||
                outputTokens;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      onComplete({ inputTokens, outputTokens });
    },
  });
}

/**
 * Convert Responses API input[] to Chat Completions messages[]
 * This is the inverse of what the Codex provider does internally
 */
function convertInputToMessages(
  input: Array<Record<string, unknown>>,
  instructions?: string
): Array<{ role: string; content: string | Array<{ type: string; [key: string]: unknown }>; tool_call_id?: string; tool_calls?: unknown[] }> {
  const messages: Array<{
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
    tool_call_id?: string;
    tool_calls?: unknown[];
  }> = [];

  // Add system instructions if provided
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  // Collect function calls to group with assistant messages
  const pendingToolCalls: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> = [];

  for (const item of input) {
    const type = item.type as string;

    switch (type) {
      case "message": {
        // Flush any pending tool calls as an assistant message
        if (pendingToolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: "",
            tool_calls: [...pendingToolCalls],
          });
          pendingToolCalls.length = 0;
        }

        const role = item.role as string;
        const content = item.content;

        if (role === "developer") {
          messages.push({
            role: "system",
            content: content as string,
          });
        } else {
          messages.push({
            role: role || "user",
            content: content as string | Array<{ type: string; [key: string]: unknown }>,
          });
        }
        break;
      }

      case "function_call": {
        pendingToolCalls.push({
          id: (item.call_id as string) || (item.id as string) || `call_${Date.now()}`,
          type: "function",
          function: {
            name: item.name as string,
            arguments: (item.arguments as string) || "{}",
          },
        });
        break;
      }

      case "function_call_output": {
        // Flush pending tool calls first
        if (pendingToolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: "",
            tool_calls: [...pendingToolCalls],
          });
          pendingToolCalls.length = 0;
        }

        messages.push({
          role: "tool",
          content: (item.output as string) || "",
          tool_call_id: (item.call_id as string) || "",
        });
        break;
      }
    }
  }

  // Flush remaining tool calls
  if (pendingToolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [...pendingToolCalls],
    });
  }

  return messages;
}

/**
 * POST /v1/responses
 * OpenAI Responses API format endpoint
 * Converts to Chat Completions internally and proxies to providers
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();

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
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: {
            message: "Invalid JSON in request body",
            type: "invalid_request_error",
          },
        },
        { status: 400 }
      );
    }

    const {
      model: modelParam,
      input,
      instructions,
      stream = true,
      ...params
    } = body;

    if (!modelParam) {
      return NextResponse.json(
        {
          error: {
            message: "model is required",
            type: "invalid_request_error",
          },
        },
        { status: 400 }
      );
    }

    if (!input || !Array.isArray(input)) {
      return NextResponse.json(
        {
          error: {
            message: "input array is required",
            type: "invalid_request_error",
          },
        },
        { status: 400 }
      );
    }

    const modelValidation = validateModel(modelParam);
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

    const { provider, model } = modelValidation;
    const family = getModelFamily(model);
    const MAX_ACCOUNT_RETRIES = 5;
    const triedAccountIds: string[] = [];

    // Convert Responses API input to Chat Completions messages
    const messages = convertInputToMessages(input, instructions);

    // Map Responses API params to Chat Completions params
    const chatParams: Record<string, unknown> = { ...params };
    if (params.max_output_tokens !== undefined) {
      chatParams.max_tokens = params.max_output_tokens;
      delete chatParams.max_output_tokens;
    }

    const reasoningRequested = !!(
      chatParams.reasoning ||
      chatParams.reasoning_effort
    );

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
              error: {
                message:
                  "No active accounts available for this model. Please add an account in the dashboard.",
                type: "configuration_error",
              },
            },
            { status: 503 }
          );
        }

        const waitTimeMs = getMinWaitTime(triedAccountIds, family) || 60000;
        return NextResponse.json(
          {
            error: {
              message: `All accounts are rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`,
              type: "rate_limit_error",
              retry_after: formatWaitTimeMs(waitTimeMs),
              retry_after_ms: waitTimeMs,
            },
          },
          { status: 429 }
        );
      }

      triedAccountIds.push(account.id);

      const providerImpl = await getProvider(
        account.provider as ProviderNameType
      );
      const credentials = await providerImpl.getValidCredentials(account);

      const providerResponse = await providerImpl.makeRequest(
        credentials,
        account,
        {
          model,
          messages,
          stream,
          _includeReasoning: reasoningRequested,
          ...chatParams,
        },
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

          console.log(
            `[rate-limit] Account ${account.id} (${account.email}) hit rate limit for ${family}, trying next account...`
          );

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
        console.error(
          `${account.provider} error:`,
          providerResponse.status,
          errorText
        );

        markAccountFailed(
          account.id,
          providerResponse.status,
          errorText
        ).catch((e) =>
          console.error("[error-tracking] Failed to mark account failed:", e)
        );

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

        // Return sanitized error — don't leak raw upstream error details
        const statusCode = providerResponse.status;
        const sanitizedMessage =
          statusCode === 401 || statusCode === 403
            ? "Provider authentication failed. Please re-authenticate your account."
            : statusCode >= 500
              ? "Provider service temporarily unavailable."
              : `Provider returned error (HTTP ${statusCode}).`;

        return NextResponse.json(
          {
            error: {
              message: sanitizedMessage,
              type: "api_error",
            },
          },
          { status: statusCode }
        );
      }

      if (stream) {
        const responseBody = providerResponse.body;

        if (!responseBody) {
          return NextResponse.json(
            { error: { message: "No response body", type: "api_error" } },
            { status: 500 }
          );
        }

        const usageTracker = createUsageTrackingStream((usage) => {
          markAccountSuccess(account.id).catch((e) =>
            console.error(
              "[error-tracking] Failed to mark account success:",
              e
            )
          );

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

      const responseData = await providerResponse.json();

      markAccountSuccess(account.id).catch((e) =>
        console.error(
          "[error-tracking] Failed to mark account success:",
          e
        )
      );

      logUsage({
        userId: userId!,
        providerAccountId: account.id,
        proxyApiKeyId: apiKeyId,
        model,
        inputTokens: responseData.usage?.prompt_tokens ?? 0,
        outputTokens: responseData.usage?.completion_tokens ?? 0,
        statusCode: 200,
        duration: Date.now() - startTime,
        provider: account.provider,
      });

      return NextResponse.json(responseData);
    }

    const waitTimeMs = getMinWaitTime(triedAccountIds, family) || 60000;
    return NextResponse.json(
      {
        error: {
          message: `All accounts are rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`,
          type: "rate_limit_error",
          retry_after: formatWaitTimeMs(waitTimeMs),
          retry_after_ms: waitTimeMs,
        },
      },
      { status: 429 }
    );
  } catch (error) {
    console.error("Proxy error:", error);

    return NextResponse.json(
      {
        error: {
          message:
            error instanceof Error ? error.message : "Internal server error",
          type: "api_error",
        },
      },
      { status: 500 }
    );
  }
}
