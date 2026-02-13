import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, logUsage, validateModelForUser } from "@/lib/proxy/auth";
import type { ApiKeyModelAccess } from "@/lib/proxy/auth";
import { getNextAvailableAccount, markAccountFailed, markAccountSuccess } from "@/lib/proxy/load-balancer";
import { getProvider } from "@/lib/proxy/providers";
import type { ProviderNameType } from "@/lib/proxy/providers/types";
import {
  clearExpiredRateLimits,
  formatWaitTimeMs,
  getRateLimitScope,
  getMinWaitTime,
  isRateLimited,
  markRateLimited,
  parseRateLimitError,
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
  let apiKeyModelAccess: ApiKeyModelAccess | undefined;

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
    apiKeyModelAccess = {
      mode: authResult.modelAccessMode ?? "all",
      models: authResult.modelAccessList ?? [],
    };
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
    const {
      model: modelParam,
      messages,
      stream = true,
      provider_account_id: providerAccountIdParam,
      ...params
    } = body;

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

    const modelValidation = await validateModelForUser(
      authenticatedUserId,
      modelParam,
      apiKeyModelAccess
    );
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
    const hasProviderAccountParam =
      providerAccountIdParam !== undefined && providerAccountIdParam !== null;
    const normalizedProviderAccountId =
      typeof providerAccountIdParam === "string" ? providerAccountIdParam.trim() : "";

    if (hasProviderAccountParam && normalizedProviderAccountId.length === 0) {
      return NextResponse.json(
        {
          error: {
            message: "provider_account_id must be a non-empty string",
            type: "invalid_request_error",
            param: "provider_account_id",
            code: "invalid_provider_account",
          },
        },
        { status: 400 }
      );
    }

    const requestParamsForError: Record<string, unknown> = {
      stream,
      ...params,
      ...(normalizedProviderAccountId
        ? { provider_account_id: normalizedProviderAccountId }
        : {}),
    };

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: { message: "messages array is required", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

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
          error: {
            message: "Selected provider account was not found",
            type: "invalid_request_error",
            param: "provider_account_id",
            code: "provider_account_not_found",
          },
        },
        { status: 400 }
      );
    }

    if (forcedAccount && !forcedAccount.isActive) {
      return NextResponse.json(
        {
          error: {
            message: "Selected provider account is inactive",
            type: "invalid_request_error",
            param: "provider_account_id",
            code: "provider_account_inactive",
          },
        },
        { status: 400 }
      );
    }

    if (forcedAccount) {
      if (!isModelSupportedByProvider(model, forcedAccount.provider)) {
        return NextResponse.json(
          {
            error: {
              message: `Selected account provider "${forcedAccount.provider}" does not support model "${model}"`,
              type: "invalid_request_error",
              param: "provider_account_id",
              code: "provider_account_model_mismatch",
            },
          },
          { status: 400 }
        );
      }

      if (provider !== null && forcedAccount.provider !== provider) {
        return NextResponse.json(
          {
            error: {
              message: `Selected account provider "${forcedAccount.provider}" does not match model provider "${provider}"`,
              type: "invalid_request_error",
              param: "provider_account_id",
              code: "provider_account_provider_mismatch",
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
            error: {
              message:
                waitTimeMs > 0
                  ? `Selected account is rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`
                  : "Selected account is rate limited.",
              type: "rate_limit_error",
              retry_after: waitTimeMs > 0 ? formatWaitTimeMs(waitTimeMs) : undefined,
              retry_after_ms: waitTimeMs > 0 ? waitTimeMs : undefined,
            },
          },
          { status: 429 }
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
              error: {
                message: "No active accounts available for this model. Please add an account in the dashboard.",
                type: "configuration_error",
              },
            },
            { status: 503 }
          );
        }

        const waitTimeMs = await getMinWaitTime(triedAccountIds, rateLimitScope);
        if (waitTimeMs > 0) {
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

        if (lastAccountFailure) {
          return NextResponse.json(
            {
              error: {
                message: lastAccountFailure.message,
                type: lastAccountFailure.type,
              },
            },
            { status: lastAccountFailure.statusCode }
          );
        }

        return NextResponse.json(
          {
            error: {
              message: "No available accounts for this request.",
              type: "api_error",
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

        const requestBody = providerImpl.prepareRequest
          ? providerImpl.prepareRequest(
              account,
              {
                model,
                messages,
                stream,
                _includeReasoning: reasoningRequested,
                ...params,
              },
              "chat_completions"
            )
          : {
              model,
              messages,
              stream,
              _includeReasoning: reasoningRequested,
              ...params,
            };

        const providerResponse = await providerImpl.makeRequest(
          credentials,
          account,
          requestBody,
          stream
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
            endpoint: "/v1/chat/completions",
            messages,
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
              error: {
                message: lastAccountFailure.message,
                type: lastAccountFailure.type,
              },
            },
            { status: lastAccountFailure.statusCode }
          );
        }

        if (stream) {
          const responseBody = providerResponse.body;

          if (!responseBody) {
            return NextResponse.json(
              {
                error: {
                  message: "Provider returned an invalid response.",
                  type: "api_error",
                },
              },
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
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const statusCode = getErrorStatusCode(error);
        const detailedError = buildAccountErrorMessage(errorMessage, {
          model,
          provider: account.provider,
          endpoint: "/v1/chat/completions",
          messages,
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
            error: {
              message: lastAccountFailure.message,
              type: lastAccountFailure.type,
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

    if (lastAccountFailure) {
      return NextResponse.json(
        {
          error: {
            message: lastAccountFailure.message,
            type: lastAccountFailure.type,
          },
        },
        { status: lastAccountFailure.statusCode }
      );
    }

    return NextResponse.json(
      {
        error: {
          message: "No available accounts for this request.",
          type: "api_error",
        },
      },
      { status: 503 }
    );
  } catch (error) {
    console.error("Proxy error:", error);

    return NextResponse.json(
      {
        error: {
          message: "Internal server error",
          type: "api_error",
        },
      },
      { status: 500 }
    );
  }
}
