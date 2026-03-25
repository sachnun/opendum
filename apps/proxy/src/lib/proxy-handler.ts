import type { FastifyRequest, FastifyReply, RouteHandlerMethod } from "fastify";
import type { ProviderAccount } from "@opendum/shared/db/schema";
import type {
  Provider,
  ChatCompletionRequest,
  ProxyEndpointType,
  ApiKeyModelAccess,
  ApiKeyAccountAccess,
  ProviderNameType,
} from "@opendum/shared";
import {
  validateModelForUser,
  logUsage,
  isModelSupportedByProvider,
  getProvider,
  recordLatency,
} from "@opendum/shared";
import { db, providerAccount } from "@opendum/shared";
import { eq, and, sql } from "drizzle-orm";
import { authenticateRequest } from "../plugins/auth.js";
import { getNextAvailableAccount, markAccountFailed, markAccountSuccess } from "./load-balancer.js";
import {
  formatWaitTimeMs,
  getRateLimitScope,
  getMinWaitTime,
  isRateLimited,
  markRateLimited,
  parseRateLimitError,
  parseRetryAfterMs,
} from "./rate-limit.js";
import {
  buildAccountErrorMessage,
  getErrorMessage,
  getErrorStatusCode,
  getSanitizedProxyError,
  shouldRotateToNextAccount,
  type ProxyErrorType,
} from "./error-utils.js";

// ---------------------------------------------------------------------------
// Shared passthrough usage tracker (for chat-completions and responses routes)
// ---------------------------------------------------------------------------

/**
 * Parse SSE chunks to extract usage tokens.
 * Handles both OpenAI keys (prompt_tokens/completion_tokens)
 * and alternative keys (input_tokens/output_tokens).
 */
export function createPassthroughUsageTracker() {
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;

  function extractUsage(parsed: Record<string, unknown>) {
    const usage = parsed.usage as
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
        }
      | undefined;
    if (usage) {
      inputTokens =
        usage.prompt_tokens || usage.input_tokens || inputTokens;
      outputTokens =
        usage.completion_tokens || usage.output_tokens || outputTokens;
    }
  }

  function processLines(lines: string[]) {
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        extractUsage(JSON.parse(data));
      } catch {
        // Ignore parse errors
      }
    }
  }

  return {
    processChunk(chunk: string) {
      buffer += chunk;
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        processLines(event.split("\n"));
      }
    },
    flush() {
      if (buffer.trim()) {
        processLines(buffer.split("\n"));
      }
    },
    getUsage() {
      return { inputTokens, outputTokens };
    },
  };
}

// ---------------------------------------------------------------------------
// Types for the handler config
// ---------------------------------------------------------------------------

export interface StreamContext {
  response: Response;
  account: ProviderAccount;
  reply: FastifyReply;
  request: FastifyRequest;
  requestStartTime: number;
  startTime: number;
  userId: string;
  apiKeyId: string | undefined;
  model: string;
}

export interface NonStreamContext {
  response: Response;
  account: ProviderAccount;
  reply: FastifyReply;
  request: FastifyRequest;
  requestStartTime: number;
  startTime: number;
  userId: string;
  apiKeyId: string | undefined;
  model: string;
}

export interface BuildRequestContext {
  routeData: Record<string, unknown>;
  model: string;
  stream: boolean;
  reasoningRequested: boolean;
  providerImpl: Provider;
  account: ProviderAccount;
}

export interface ParsedRequest {
  modelParam: string;
  stream: boolean;
  providerAccountId: string | null;
  reasoningRequested: boolean;
  /** For error context logging */
  messagesForError: unknown;
  /** For error context logging (excludes model, messages, stream, provider_account_id) */
  paramsForError: Record<string, unknown>;
  /** Route-specific data passed through to buildRequest */
  routeData: Record<string, unknown>;
}

export interface ErrorInfo {
  message: string;
  type: string;
  param?: string;
  code?: string;
  retry_after?: string;
  retry_after_ms?: number;
}

export interface ProxyRouteConfig {
  endpoint: ProxyEndpointType;

  /**
   * Parse body, validate route-specific fields, return extracted data.
   * Return null and send reply yourself if validation fails.
   */
  parseAndValidate(
    body: Record<string, unknown>,
    reply: FastifyReply
  ): ParsedRequest | null;

  /** Build the ChatCompletionRequest to send to provider. */
  buildRequest(
    ctx: BuildRequestContext
  ): ChatCompletionRequest | Promise<ChatCompletionRequest>;

  /** Handle streaming response from provider */
  handleStream(ctx: StreamContext): Promise<void>;

  /** Handle non-streaming response from provider. Must call markAccountSuccess, recordLatency, logUsage, and send reply. */
  handleNonStream(ctx: NonStreamContext): Promise<void>;

  /** Format error for this route's API format */
  formatError(info: ErrorInfo): unknown;

  /** HTTP status code to use for rate limit errors (429 for OpenAI, 529 for Anthropic) */
  rateLimitStatusCode: number;

  /** HTTP status code for no-accounts-available (503 for OpenAI, 529 for Anthropic) */
  noAccountsStatusCode: number;
}

// ---------------------------------------------------------------------------
// Shared proxy route factory
// ---------------------------------------------------------------------------

export function createProxyRoute(config: ProxyRouteConfig): RouteHandlerMethod {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();

    // 1. Auth
    const auth = await authenticateRequest(request, reply);
    if (!auth) return;
    const { userId, apiKeyId, modelAccessMode, modelAccessList, accountAccessMode, accountAccessList } = auth;
    const apiKeyModelAccess: ApiKeyModelAccess = {
      mode: modelAccessMode,
      models: modelAccessList,
    };
    const apiKeyAccountAccess: ApiKeyAccountAccess = {
      mode: accountAccessMode,
      accounts: accountAccessList,
    };

    try {
      // 2. Parse body
      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body !== "object") {
        return reply.code(400).send(
          config.formatError({
            message: "Invalid JSON in request body",
            type: "invalid_request_error",
          })
        );
      }

      const parsed = config.parseAndValidate(body, reply);
      if (!parsed) return; // reply already sent

      const {
        modelParam,
        stream,
        providerAccountId,
        reasoningRequested,
        messagesForError,
        paramsForError,
        routeData,
      } = parsed;

      // 3. Model validation
      const modelValidation = await validateModelForUser(
        userId,
        modelParam,
        apiKeyModelAccess
      );
      if (!modelValidation.valid) {
        return reply.code(400).send(
          config.formatError({
            message: modelValidation.error!,
            type: "invalid_request_error",
            param: modelValidation.param,
            code: modelValidation.code,
          })
        );
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

      // 4. Forced account validation
      const hasProviderAccountParam =
        providerAccountId !== undefined && providerAccountId !== null;
      const normalizedProviderAccountId =
        typeof providerAccountId === "string"
          ? providerAccountId.trim()
          : "";

      if (hasProviderAccountParam && normalizedProviderAccountId.length === 0) {
        return reply.code(400).send(
          config.formatError({
            message: "provider_account_id must be a non-empty string",
            type: "invalid_request_error",
            param: "provider_account_id",
            code: "invalid_provider_account",
          })
        );
      }

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
        return reply.code(400).send(
          config.formatError({
            message: "Selected provider account was not found",
            type: "invalid_request_error",
            param: "provider_account_id",
            code: "provider_account_not_found",
          })
        );
      }

      if (forcedAccount && !forcedAccount.isActive) {
        return reply.code(400).send(
          config.formatError({
            message: "Selected provider account is inactive",
            type: "invalid_request_error",
            param: "provider_account_id",
            code: "provider_account_inactive",
          })
        );
      }

      // Check account access rules for forced account
      if (forcedAccount && apiKeyAccountAccess.mode !== "all") {
        const accountSet = new Set(apiKeyAccountAccess.accounts);
        if (apiKeyAccountAccess.mode === "whitelist" && !accountSet.has(forcedAccount.id)) {
          return reply.code(403).send(
            config.formatError({
              message: "Selected provider account is not allowed for this API key.",
              type: "invalid_request_error",
              param: "provider_account_id",
              code: "provider_account_not_whitelisted",
            })
          );
        }
        if (apiKeyAccountAccess.mode === "blacklist" && accountSet.has(forcedAccount.id)) {
          return reply.code(403).send(
            config.formatError({
              message: "Selected provider account is blocked for this API key.",
              type: "invalid_request_error",
              param: "provider_account_id",
              code: "provider_account_blacklisted",
            })
          );
        }
      }

      if (forcedAccount) {
        if (!isModelSupportedByProvider(model, forcedAccount.provider)) {
          return reply.code(400).send(
            config.formatError({
              message: `Selected account provider "${forcedAccount.provider}" does not support model "${model}"`,
              type: "invalid_request_error",
              param: "provider_account_id",
              code: "provider_account_model_mismatch",
            })
          );
        }

        if (provider !== null && forcedAccount.provider !== provider) {
          return reply.code(400).send(
            config.formatError({
              message: `Selected account provider "${forcedAccount.provider}" does not match model provider "${provider}"`,
              type: "invalid_request_error",
              param: "provider_account_id",
              code: "provider_account_provider_mismatch",
            })
          );
        }

        if (await isRateLimited(forcedAccount.id, rateLimitScope)) {
          const waitTimeMs = await getMinWaitTime(
            [forcedAccount.id],
            rateLimitScope
          );
          return reply.code(config.rateLimitStatusCode).send(
            config.formatError({
              message:
                waitTimeMs > 0
                  ? `Selected account is rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`
                  : "Selected account is rate limited.",
              type: "rate_limit_error",
              retry_after:
                waitTimeMs > 0 ? formatWaitTimeMs(waitTimeMs) : undefined,
              retry_after_ms: waitTimeMs > 0 ? waitTimeMs : undefined,
            })
          );
        }
      }

      // 5. Retry loop
      const accountRetryLimit = forcedAccount ? 1 : MAX_ACCOUNT_RETRIES;

      for (let attempt = 0; attempt < accountRetryLimit; attempt++) {
        let account = forcedAccount;

        if (!account) {
          account = await getNextAvailableAccount(
            userId,
            model,
            provider,
            triedAccountIds,
            apiKeyAccountAccess
          );
        }

        if (!account) {
          const isFirstAttempt = triedAccountIds.length === 0;

          if (isFirstAttempt) {
            return reply.code(config.noAccountsStatusCode).send(
              config.formatError({
                message:
                  "No active accounts available for this model. Please add an account in the dashboard.",
                type: "configuration_error",
              })
            );
          }

          const waitTimeMs = await getMinWaitTime(
            triedAccountIds,
            rateLimitScope
          );
          if (waitTimeMs > 0) {
            return reply.code(config.rateLimitStatusCode).send(
              config.formatError({
                message: `All accounts are rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`,
                type: "rate_limit_error",
                retry_after: formatWaitTimeMs(waitTimeMs),
                retry_after_ms: waitTimeMs,
              })
            );
          }

          if (lastAccountFailure) {
            return reply.code(lastAccountFailure.statusCode).send(
              config.formatError({
                message: lastAccountFailure.message,
                type: lastAccountFailure.type,
              })
            );
          }

          return reply.code(503).send(
            config.formatError({
              message: "No available accounts for this request.",
              type: "api_error",
            })
          );
        }

        triedAccountIds.push(account.id);

        // Update usage for forced accounts
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
          const providerImpl = await getProvider(
            account.provider as ProviderNameType
          );
          const credentials = await providerImpl.getValidCredentials(account);

          // Route-specific request building
          const requestBody = await config.buildRequest({
            routeData,
            model,
            stream,
            reasoningRequested,
            providerImpl,
            account,
          });

          const requestStartTime = Date.now();
          const providerResponse = await providerImpl.makeRequest(
            credentials,
            account,
            requestBody,
            stream
          );

          // 429 handling
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

              void logUsage({
                userId,
                providerAccountId: account.id,
                proxyApiKeyId: apiKeyId,
                model,
                inputTokens: 0,
                outputTokens: 0,
                statusCode: 429,
                duration: Date.now() - startTime,
                provider: account.provider,
              });

              continue;
            } catch {
              const retryAfterMs =
                retryAfterMsFromHeader ?? fallbackRetryAfterMs;
              await markRateLimited(account.id, rateLimitScope, retryAfterMs);
              continue;
            }
          }

          // Non-OK handling
          if (!providerResponse.ok) {
            const errorText = await providerResponse.text();

            // Timeouts (408) are transient — don't count them as account errors
            if (providerResponse.status !== 408) {
              const detailedError = buildAccountErrorMessage(errorText, {
                model,
                provider: account.provider,
                endpoint: `/${config.endpoint === "chat_completions" ? "v1/chat/completions" : config.endpoint === "messages" ? "v1/messages" : "v1/responses"}`,
                messages: messagesForError,
                parameters: paramsForError,
              });

              await markAccountFailed(
                account.id,
                providerResponse.status,
                detailedError
              );
            }

            void logUsage({
              userId,
              providerAccountId: account.id,
              proxyApiKeyId: apiKeyId,
              model,
              inputTokens: 0,
              outputTokens: 0,
              statusCode: providerResponse.status,
              duration: Date.now() - startTime,
              provider: account.provider,
            });

            const sanitizedError = getSanitizedProxyError(
              providerResponse.status,
              errorText
            );
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

            return reply.code(lastAccountFailure.statusCode).send(
              config.formatError({
                message: lastAccountFailure.message,
                type: lastAccountFailure.type,
              })
            );
          }

          // Success — streaming
          if (stream) {
            await config.handleStream({
              response: providerResponse,
              account,
              reply,
              request,
              requestStartTime,
              startTime,
              userId,
              apiKeyId,
              model,
            });
            return;
          }

          // Success — non-streaming
          await config.handleNonStream({
            response: providerResponse,
            account,
            reply,
            request,
            requestStartTime,
            startTime,
            userId,
            apiKeyId,
            model,
          });
          return;
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          const statusCode = getErrorStatusCode(error);
          const detailedError = buildAccountErrorMessage(errorMessage, {
            model,
            provider: account.provider,
            endpoint: `/${config.endpoint === "chat_completions" ? "v1/chat/completions" : config.endpoint === "messages" ? "v1/messages" : "v1/responses"}`,
            messages: messagesForError,
            parameters: paramsForError,
          });

          request.log.error(
            `[${account.provider}] request failed for account ${account.id}: ${errorMessage}`
          );

          await markAccountFailed(account.id, statusCode, detailedError);

          void logUsage({
            userId,
            providerAccountId: account.id,
            proxyApiKeyId: apiKeyId,
            model,
            inputTokens: 0,
            outputTokens: 0,
            statusCode,
            duration: Date.now() - startTime,
            provider: account.provider,
          });

          const sanitizedError = getSanitizedProxyError(
            statusCode,
            errorMessage
          );
          lastAccountFailure = {
            statusCode,
            message: sanitizedError.message,
            type: sanitizedError.type,
          };

          if (
            shouldRotateToNextAccount(statusCode) &&
            attempt < accountRetryLimit - 1
          ) {
            continue;
          }

          return reply.code(lastAccountFailure.statusCode).send(
            config.formatError({
              message: lastAccountFailure.message,
              type: lastAccountFailure.type,
            })
          );
        }
      }

      // All retries exhausted
      const waitTimeMs = await getMinWaitTime(triedAccountIds, rateLimitScope);
      if (waitTimeMs > 0) {
        return reply.code(config.rateLimitStatusCode).send(
          config.formatError({
            message: `All accounts are rate limited. Retry in ${formatWaitTimeMs(waitTimeMs)}.`,
            type: "rate_limit_error",
            retry_after: formatWaitTimeMs(waitTimeMs),
            retry_after_ms: waitTimeMs,
          })
        );
      }

      if (lastAccountFailure) {
        return reply.code(lastAccountFailure.statusCode).send(
          config.formatError({
            message: lastAccountFailure.message,
            type: lastAccountFailure.type,
          })
        );
      }

      return reply.code(503).send(
        config.formatError({
          message: "No available accounts for this request.",
          type: "api_error",
        })
      );
    } catch (error) {
      request.log.error(error, "Proxy error");
      return reply.code(500).send(
        config.formatError({
          message: "Internal server error",
          type: "api_error",
        })
      );
    }
  };
}
