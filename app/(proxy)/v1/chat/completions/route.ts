import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, logUsage, validateModelForUser } from "@/lib/proxy/auth";
import { getNextAvailableAccount, markAccountFailed, markAccountSuccess } from "@/lib/proxy/load-balancer";
import { getProvider } from "@/lib/proxy/providers";
import type { ProviderNameType } from "@/lib/proxy/providers/types";
import { markRateLimited, parseRateLimitError, getMinWaitTime, formatWaitTimeMs } from "@/lib/proxy/rate-limit";
import { getModelFamily } from "@/lib/proxy/providers/antigravity/converter";
import { auth } from "@/lib/auth";

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

      onComplete({ inputTokens, outputTokens });
    },
  });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  const authHeader = request.headers.get("authorization");
  const xApiKeyHeader = request.headers.get("x-api-key");

  let userId: string | undefined;
  let apiKeyId: string | undefined;

  if (authHeader || xApiKeyHeader) {
    const authResult = await validateApiKey(authHeader || xApiKeyHeader);

    if (!authResult.valid) {
      return NextResponse.json(
        { error: { message: authResult.error, type: "authentication_error" } },
        { status: 401 }
      );
    }

    userId = authResult.userId;
    apiKeyId = authResult.apiKeyId;
  } else {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: {
            message: "Missing Authorization header",
            type: "authentication_error",
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
        error: {
          message: "Missing Authorization header",
          type: "authentication_error",
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
        { error: { message: "Invalid JSON in request body", type: "invalid_request_error" } },
        { status: 400 }
      );
    }
    const { model: modelParam, messages, stream = true, ...params } = body;

    const reasoningRequested = !!(
      params.reasoning || 
      params.reasoning_effort || 
      params.thinking_budget || 
      params.include_thoughts
    );

    if (!modelParam) {
      return NextResponse.json(
        { error: { message: "model is required", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    const modelValidation = await validateModelForUser(authenticatedUserId, modelParam);
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

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: { message: "messages array is required", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    for (let attempt = 0; attempt < MAX_ACCOUNT_RETRIES; attempt++) {
      const account = await getNextAvailableAccount(
        authenticatedUserId,
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
                message: "No active accounts available for this model. Please add an account in the dashboard.",
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

      const providerImpl = await getProvider(account.provider as ProviderNameType);
      const credentials = await providerImpl.getValidCredentials(account);

      const providerResponse = await providerImpl.makeRequest(
        credentials,
        account,
        { model, messages, stream, _includeReasoning: reasoningRequested, ...params },
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
          markRateLimited(account.id, family, 60 * 60 * 1000);
          continue;
        }
      }

      if (!providerResponse.ok) {
        const errorText = await providerResponse.text();
        console.error(`${account.provider} error:`, providerResponse.status, errorText);

        // Track error for this account (non-blocking)
        markAccountFailed(account.id, providerResponse.status, errorText).catch(() => undefined);

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

        return NextResponse.json(
          {
            error: {
              message: `${account.provider} API error: ${errorText}`,
              type: "api_error",
            },
          },
          { status: providerResponse.status }
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

      // Track success for this account (non-blocking)
      markAccountSuccess(account.id).catch(() => undefined);

      logUsage({
        userId: authenticatedUserId,
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
          message: error instanceof Error ? error.message : "Internal server error",
          type: "api_error",
        },
      },
      { status: 500 }
    );
  }
}
