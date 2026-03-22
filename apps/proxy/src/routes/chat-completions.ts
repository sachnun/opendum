import type { FastifyRequest, FastifyReply, RouteHandlerMethod } from "fastify";
import {
  validateModelForUser,
  logUsage,
  isModelSupportedByProvider,
  getProvider,
  recordLatency,
  type ApiKeyModelAccess,
  type ProviderNameType,
} from "@opendum/shared";
import { db, providerAccount } from "@opendum/shared";
import { eq, and, sql } from "drizzle-orm";
import { authenticateRequest } from "../plugins/auth.js";
import { getNextAvailableAccount, markAccountFailed, markAccountSuccess } from "../lib/load-balancer.js";
import {
  formatWaitTimeMs,
  getRateLimitScope,
  getMinWaitTime,
  isRateLimited,
  markRateLimited,
  parseRateLimitError,
  parseRetryAfterMs,
} from "../lib/rate-limit.js";
import {
  buildAccountErrorMessage,
  getErrorMessage,
  getErrorStatusCode,
  getSanitizedProxyError,
  shouldRotateToNextAccount,
  type ProxyErrorType,
} from "../lib/error-utils.js";

/**
 * Parse SSE chunks to extract usage tokens
 */
function createUsageTracker() {
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;

  return {
    processChunk(chunk: string) {
      buffer += chunk;
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
    },
    getUsage() {
      return { inputTokens, outputTokens };
    },
  };
}

export const chatCompletionsRoute: RouteHandlerMethod = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const startTime = Date.now();

  // Auth — API key only (no session auth in proxy)
  const auth = await authenticateRequest(request, reply);
  if (!auth) return; // Response already sent

  const { userId, apiKeyId, modelAccessMode, modelAccessList } = auth;
  const apiKeyModelAccess: ApiKeyModelAccess = {
    mode: modelAccessMode,
    models: modelAccessList,
  };

  try {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({
        error: { message: "Invalid JSON in request body", type: "invalid_request_error" },
      });
    }

    const {
      model: modelParam,
      messages,
      stream = true,
      provider_account_id: providerAccountIdParam,
      ...params
    } = body as Record<string, unknown>;

    const reasoningRequested = !!(
      params.reasoning ||
      params.reasoning_effort ||
      params.thinking_budget ||
      params.include_thoughts
    );

    if (!modelParam) {
      return reply.code(400).send({
        error: { message: "model is required", type: "invalid_request_error" },
      });
    }

    const modelValidation = await validateModelForUser(
      userId,
      modelParam as string,
      apiKeyModelAccess
    );
    if (!modelValidation.valid) {
      return reply.code(400).send({
        error: {
          message: modelValidation.error,
          type: "invalid_request_error",
          param: modelValidation.param,
          code: modelValidation.code,
        },
      });
    }

    const { provider, model } = modelValidation;
    const rateLimitScope = getRateLimitScope(model);
    const MAX_ACCOUNT_RETRIES = 5;
    const triedAccountIds: string[] = [];
    let lastAccountFailure: {
      statusCode: number;
      message: string;
      type: ProxyErrorType;
    } | null = null;

    const hasProviderAccountParam =
      providerAccountIdParam !== undefined && providerAccountIdParam !== null;
    const normalizedProviderAccountId =
      typeof providerAccountIdParam === "string"
        ? (providerAccountIdParam as string).trim()
        : "";

    if (hasProviderAccountParam && normalizedProviderAccountId.length === 0) {
      return reply.code(400).send({
        error: {
          message: "provider_account_id must be a non-empty string",
          type: "invalid_request_error",
          param: "provider_account_id",
          code: "invalid_provider_account",
        },
      });
    }

    const requestParamsForError: Record<string, unknown> = {
      stream,
      ...params,
      ...(normalizedProviderAccountId
        ? { provider_account_id: normalizedProviderAccountId }
        : {}),
    };

    if (!messages || !Array.isArray(messages)) {
      return reply.code(400).send({
        error: { message: "messages array is required", type: "invalid_request_error" },
      });
    }

    // Forced account validation
    const forcedAccount = normalizedProviderAccountId
      ? (
          await db
            .select()
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.id, normalizedProviderAccountId),
                eq(providerAccount.userId, userId)
              )
            )
            .limit(1)
        )[0] ?? null
      : null;

    if (normalizedProviderAccountId && !forcedAccount) {
      return reply.code(400).send({
        error: {
          message: "Selected provider account was not found",
          type: "invalid_request_error",
          param: "provider_account_id",
          code: "provider_account_not_found",
        },
      });
    }

    if (forcedAccount && !forcedAccount.isActive) {
      return reply.code(400).send({
        error: {
          message: "Selected provider account is inactive",
          type: "invalid_request_error",
          param: "provider_account_id",
          code: "provider_account_inactive",
        },
      });
    }

    if (forcedAccount) {
      if (!isModelSupportedByProvider(model, forcedAccount.provider)) {
        return reply.code(400).send({
          error: {
            message: `Selected account provider "${forcedAccount.provider}" does not support model "${model}"`,
            type: "invalid_request_error",
            param: "provider_account_id",
            code: "provider_account_model_mismatch",
          },
        });
      }

      if (provider !== null && forcedAccount.provider !== provider) {
        return reply.code(400).send({
          error: {
            message: `Selected account provider "${forcedAccount.provider}" does not match model provider "${provider}"`,
            type: "invalid_request_error",
            param: "provider_account_id",
            code: "provider_account_provider_mismatch",
          },
        });
      }

      if (await isRateLimited(forcedAccount.id, rateLimitScope)) {
        const waitTimeMs = await getMinWaitTime([forcedAccount.id], rateLimitScope);
        return reply.code(429).send({
          error: {
            message:
              waitTimeMs > 0
                ? `Selected account is rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`
                : "Selected account is rate limited.",
            type: "rate_limit_error",
            retry_after: waitTimeMs > 0 ? formatWaitTimeMs(waitTimeMs) : undefined,
            retry_after_ms: waitTimeMs > 0 ? waitTimeMs : undefined,
          },
        });
      }
    }

    const accountRetryLimit = forcedAccount ? 1 : MAX_ACCOUNT_RETRIES;

    for (let attempt = 0; attempt < accountRetryLimit; attempt++) {
      let account = forcedAccount;

      if (!account) {
        account = await getNextAvailableAccount(userId, model, provider, triedAccountIds);
      }

      if (!account) {
        const isFirstAttempt = triedAccountIds.length === 0;

        if (isFirstAttempt) {
          return reply.code(503).send({
            error: {
              message:
                "No active accounts available for this model. Please add an account in the dashboard.",
              type: "configuration_error",
            },
          });
        }

        const waitTimeMs = await getMinWaitTime(triedAccountIds, rateLimitScope);
        if (waitTimeMs > 0) {
          return reply.code(429).send({
            error: {
              message: `All accounts are rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`,
              type: "rate_limit_error",
              retry_after: formatWaitTimeMs(waitTimeMs),
              retry_after_ms: waitTimeMs,
            },
          });
        }

        if (lastAccountFailure) {
          return reply.code(lastAccountFailure.statusCode).send({
            error: {
              message: lastAccountFailure.message,
              type: lastAccountFailure.type,
            },
          });
        }

        return reply.code(503).send({
          error: { message: "No available accounts for this request.", type: "api_error" },
        });
      }

      triedAccountIds.push(account.id);

      if (forcedAccount) {
        await db
          .update(providerAccount)
          .set({
            lastUsedAt: new Date(),
            requestCount: sql`${providerAccount.requestCount} + 1`,
          })
          .where(eq(providerAccount.id, account.id));
      }

      try {
        const providerImpl = await getProvider(account.provider as ProviderNameType);
        const credentials = await providerImpl.getValidCredentials(account);

        const requestBody = providerImpl.prepareRequest
          ? await providerImpl.prepareRequest(
              account,
              {
                model,
                messages: messages as ChatCompletionRequest["messages"],
                stream: stream as boolean,
                _includeReasoning: reasoningRequested,
                ...params,
              },
              "chat_completions"
            )
          : {
              model,
              messages: messages as ChatCompletionRequest["messages"],
              stream: stream as boolean,
              _includeReasoning: reasoningRequested,
              ...params,
            };

        const requestStartTime = Date.now();
        const providerResponse = await providerImpl.makeRequest(
          credentials,
          account,
          requestBody,
          stream as boolean
        );

        // Handle 429 rate limit
        if (providerResponse.status === 429) {
          const retryAfterMsFromHeader = parseRetryAfterMs(providerResponse);
          const fallbackRetryAfterMs =
            account.provider === "kiro" ? 60 * 1000 : 60 * 60 * 1000;
          const clonedResponse = providerResponse.clone();
          try {
            const errorBody = await clonedResponse.json();
            const rateLimitInfo = parseRateLimitError(errorBody);
            const retryAfterMs =
              rateLimitInfo?.retryAfterMs ?? retryAfterMsFromHeader ?? fallbackRetryAfterMs;

            await markRateLimited(
              account.id,
              rateLimitScope,
              retryAfterMs,
              rateLimitInfo?.model,
              rateLimitInfo?.message
            );

            await logUsage({
              userId,
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

        // Handle non-OK response
        if (!providerResponse.ok) {
          const errorText = await providerResponse.text();

          // Timeouts (408) are transient — don't count them as account errors
          if (providerResponse.status !== 408) {
            const detailedError = buildAccountErrorMessage(errorText, {
              model,
              provider: account.provider,
              endpoint: "/v1/chat/completions",
              messages,
              parameters: requestParamsForError,
            });

            await markAccountFailed(account.id, providerResponse.status, detailedError);
          }

          await logUsage({
            userId,
            providerAccountId: account.id,
            proxyApiKeyId: apiKeyId,
            model,
            inputTokens: 0,
            outputTokens: 0,
            statusCode: providerResponse.status,
            duration: Date.now() - startTime,
          });

          const sanitizedError = getSanitizedProxyError(providerResponse.status, errorText);
          lastAccountFailure = {
            statusCode: providerResponse.status,
            message: sanitizedError.message,
            type: sanitizedError.type,
          };

          if (shouldRotateToNextAccount(providerResponse.status) && attempt < accountRetryLimit - 1) {
            continue;
          }

          return reply.code(lastAccountFailure.statusCode).send({
            error: {
              message: lastAccountFailure.message,
              type: lastAccountFailure.type,
            },
          });
        }

        // Success — streaming
        if (stream) {
          const responseBody = providerResponse.body;
          if (!responseBody) {
            return reply.code(500).send({
              error: { message: "Provider returned an invalid response.", type: "api_error" },
            });
          }

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

          const tracker = createUsageTracker();
          const reader = responseBody.getReader();
          const decoder = new TextDecoder();
          const accountId = account.id;
          const accountProvider = account.provider;

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              tracker.processChunk(text);
              reply.raw.write(value);
            }
          } catch {
            // Stream may have been closed by the client
          } finally {
            tracker.flush();
            reply.raw.end();

            const usage = tracker.getUsage();
            markAccountSuccess(accountId).catch(() => undefined);
            recordLatency(accountProvider, model, true, Date.now() - requestStartTime).catch(
              () => undefined
            );

            logUsage({
              userId,
              providerAccountId: accountId,
              proxyApiKeyId: apiKeyId,
              model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              statusCode: 200,
              duration: Date.now() - startTime,
              provider: accountProvider,
            });
          }

          return;
        }

        // Success — non-streaming
        const responseData = await providerResponse.json() as Record<string, unknown> & { usage?: { prompt_tokens?: number; completion_tokens?: number } };
        markAccountSuccess(account.id).catch(() => undefined);
        recordLatency(account.provider, model, false, Date.now() - requestStartTime).catch(
          () => undefined
        );

        logUsage({
          userId,
          providerAccountId: account.id,
          proxyApiKeyId: apiKeyId,
          model,
          inputTokens: responseData.usage?.prompt_tokens ?? 0,
          outputTokens: responseData.usage?.completion_tokens ?? 0,
          statusCode: 200,
          duration: Date.now() - startTime,
          provider: account.provider,
        });

        return reply
          .code(200)
          .header("X-Provider-Account-Id", account.id)
          .send(responseData);
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

        request.log.error(
          `[${account.provider}] request failed for account ${account.id}: ${errorMessage}`
        );

        await markAccountFailed(account.id, statusCode, detailedError);

        await logUsage({
          userId,
          providerAccountId: account.id,
          proxyApiKeyId: apiKeyId,
          model,
          inputTokens: 0,
          outputTokens: 0,
          statusCode,
          duration: Date.now() - startTime,
        });

        const sanitizedError = getSanitizedProxyError(statusCode, errorMessage);
        lastAccountFailure = {
          statusCode,
          message: sanitizedError.message,
          type: sanitizedError.type,
        };

        if (shouldRotateToNextAccount(statusCode) && attempt < accountRetryLimit - 1) {
          continue;
        }

        return reply.code(lastAccountFailure.statusCode).send({
          error: {
            message: lastAccountFailure.message,
            type: lastAccountFailure.type,
          },
        });
      }
    }

    // All retries exhausted
    const waitTimeMs = await getMinWaitTime(triedAccountIds, rateLimitScope);
    if (waitTimeMs > 0) {
      return reply.code(429).send({
        error: {
          message: `All accounts are rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`,
          type: "rate_limit_error",
          retry_after: formatWaitTimeMs(waitTimeMs),
          retry_after_ms: waitTimeMs,
        },
      });
    }

    if (lastAccountFailure) {
      return reply.code(lastAccountFailure.statusCode).send({
        error: {
          message: lastAccountFailure.message,
          type: lastAccountFailure.type,
        },
      });
    }

    return reply.code(503).send({
      error: { message: "No available accounts for this request.", type: "api_error" },
    });
  } catch (error) {
    request.log.error(error, "Proxy error");
    return reply.code(500).send({
      error: { message: "Internal server error", type: "api_error" },
    });
  }
};

// Type import for readability
import type { ChatCompletionRequest } from "@opendum/shared";
