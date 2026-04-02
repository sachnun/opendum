import type { RouteHandlerMethod } from "fastify";
import {
  logUsage,
  recordLatency,
} from "@opendum/shared";
import { markAccountSuccess } from "../lib/load-balancer.js";
import {
  createProxyRoute,
  createPassthroughUsageTracker,
  type ErrorInfo,
} from "../lib/proxy-handler.js";

import type { ChatCompletionRequest } from "@opendum/shared";

function formatOpenAIError(info: ErrorInfo): unknown {
  return {
    error: {
      message: info.message,
      type: info.type,
      ...(info.param !== undefined ? { param: info.param } : {}),
      ...(info.code !== undefined ? { code: info.code } : {}),
      ...(info.retry_after !== undefined
        ? { retry_after: info.retry_after }
        : {}),
      ...(info.retry_after_ms !== undefined
        ? { retry_after_ms: info.retry_after_ms }
        : {}),
    },
  };
}

export const chatCompletionsRoute: RouteHandlerMethod = createProxyRoute({
  endpoint: "chat_completions",
  rateLimitStatusCode: 429,
  noAccountsStatusCode: 503,
  formatError: formatOpenAIError,

  parseAndValidate(body, reply) {
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
      reply.code(400).send(
        formatOpenAIError({
          message: "model is required",
          type: "invalid_request_error",
        })
      );
      return null;
    }

    if (!messages || !Array.isArray(messages)) {
      reply.code(400).send(
        formatOpenAIError({
          message: "messages array is required",
          type: "invalid_request_error",
        })
      );
      return null;
    }

    const normalizedProviderAccountId =
      typeof providerAccountIdParam === "string"
        ? (providerAccountIdParam as string).trim()
        : "";

    const requestParamsForError: Record<string, unknown> = {
      stream,
      ...params,
      ...(normalizedProviderAccountId
        ? { provider_account_id: normalizedProviderAccountId }
        : {}),
    };

    return {
      modelParam: modelParam as string,
      stream: stream as boolean,
      providerAccountId:
        providerAccountIdParam !== undefined &&
        providerAccountIdParam !== null
          ? (providerAccountIdParam as string)
          : null,
      reasoningRequested,
      messagesForError: messages,
      paramsForError: requestParamsForError,
      routeData: { messages, params },
    };
  },

  async buildRequest({ routeData, model, stream, reasoningRequested, providerImpl, account }) {
    const { messages, params } = routeData as {
      messages: ChatCompletionRequest["messages"];
      params: Record<string, unknown>;
    };

    const baseBody = {
      model,
      messages,
      stream,
      _includeReasoning: reasoningRequested,
      ...params,
    } as ChatCompletionRequest;

    return providerImpl.prepareRequest
      ? await providerImpl.prepareRequest(account, baseBody, "chat_completions")
      : baseBody;
  },

  async handleStream(ctx) {
    const { response, account, reply, request, requestStartTime, startTime, userId, apiKeyId, model } = ctx;

    const responseBody = response.body;
    if (!responseBody) {
      reply.code(500).send(
        formatOpenAIError({
          message: "Provider returned an invalid response.",
          type: "api_error",
        })
      );
      return;
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

    const tracker = createPassthroughUsageTracker();
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
      markAccountSuccess(accountId, model).catch(() => undefined);
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
  },

  async handleNonStream(ctx) {
    const { response, account, reply, requestStartTime, startTime, userId, apiKeyId, model } = ctx;

    const responseData = (await response.json()) as Record<string, unknown> & {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    markAccountSuccess(account.id, model).catch(() => undefined);
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
  },
});
