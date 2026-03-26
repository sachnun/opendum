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

/**
 * Convert Responses API input[] to Chat Completions messages[]
 * This is the inverse of what the Codex provider does internally
 */
function convertInputToMessages(
  input: Array<Record<string, unknown>>,
  instructions?: string
): Array<{
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  tool_call_id?: string;
  tool_calls?: unknown[];
}> {
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
            content: content as
              | string
              | Array<{ type: string; [key: string]: unknown }>,
          });
        }
        break;
      }

      case "function_call": {
        const rawId =
          (item.call_id as string) ||
          (item.id as string) ||
          `call_${Date.now()}`;
        // Normalize fc_-prefixed IDs to call_ for Chat Completions format
        const normalizedId = rawId.startsWith("fc_")
          ? "call_" + rawId.slice(3)
          : rawId.startsWith("fc-")
            ? "call_" + rawId.slice(3)
            : rawId;
        pendingToolCalls.push({
          id: normalizedId,
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

        const rawCallId = (item.call_id as string) || "";
        // Normalize fc_-prefixed IDs to call_ for Chat Completions format
        const normalizedCallId = rawCallId.startsWith("fc_")
          ? "call_" + rawCallId.slice(3)
          : rawCallId.startsWith("fc-")
            ? "call_" + rawCallId.slice(3)
            : rawCallId;

        messages.push({
          role: "tool",
          content: (item.output as string) || "",
          tool_call_id: normalizedCallId,
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

/**
 * POST /v1/responses
 * OpenAI Responses API format endpoint
 * Converts to Chat Completions internally and proxies to providers
 */
export const responsesRoute: RouteHandlerMethod = createProxyRoute({
  endpoint: "responses",
  rateLimitStatusCode: 429,
  noAccountsStatusCode: 503,
  formatError: formatOpenAIError,

  parseAndValidate(body, reply) {
    const {
      model: modelParam,
      input,
      instructions,
      stream: streamParam,
      provider_account_id: providerAccountIdParam,
      ...params
    } = body as {
      model?: unknown;
      input?: unknown;
      instructions?: unknown;
      stream?: unknown;
      provider_account_id?: unknown;
      [key: string]: unknown;
    };

    const streamEnabled =
      typeof streamParam === "boolean" ? streamParam : true;
    const requestedModel =
      typeof modelParam === "string" ? (modelParam as string).trim() : "";
    const instructionsText =
      typeof instructions === "string" && (instructions as string).trim()
        ? (instructions as string)
        : undefined;

    if (!requestedModel) {
      reply.code(400).send(
        formatOpenAIError({
          message: "model is required",
          type: "invalid_request_error",
        })
      );
      return null;
    }

    if (!input || !Array.isArray(input)) {
      reply.code(400).send(
        formatOpenAIError({
          message: "input array is required",
          type: "invalid_request_error",
        })
      );
      return null;
    }

    const responsesInput = input as Array<Record<string, unknown>>;
    const messages = convertInputToMessages(responsesInput, instructionsText);

    // Map Responses API params to Chat Completions params
    const chatParams: Record<string, unknown> = { ...params };
    if (params.max_output_tokens !== undefined) {
      chatParams.max_tokens = params.max_output_tokens;
      delete chatParams.max_output_tokens;
    }

    const normalizedProviderAccountId =
      typeof providerAccountIdParam === "string"
        ? (providerAccountIdParam as string).trim()
        : "";

    const requestParamsForError: Record<string, unknown> = {
      stream: streamEnabled,
      ...(instructionsText ? { instructions: instructionsText } : {}),
      ...chatParams,
      ...(normalizedProviderAccountId
        ? { provider_account_id: normalizedProviderAccountId }
        : {}),
    };

    const reasoningRequested = !!(
      chatParams.reasoning || chatParams.reasoning_effort
    );

    return {
      modelParam: requestedModel,
      stream: streamEnabled,
      providerAccountId:
        providerAccountIdParam !== undefined &&
        providerAccountIdParam !== null
          ? (providerAccountIdParam as string)
          : null,
      reasoningRequested,
      messagesForError: messages,
      paramsForError: requestParamsForError,
      routeData: {
        messages,
        responsesInput,
        instructionsText,
        chatParams,
      },
    };
  },

  async buildRequest({
    routeData,
    model,
    stream,
    reasoningRequested,
    providerImpl,
    account,
  }) {
    const { messages, responsesInput, instructionsText, chatParams } =
      routeData as {
        messages: ChatCompletionRequest["messages"];
        responsesInput: Array<Record<string, unknown>>;
        instructionsText: string | undefined;
        chatParams: Record<string, unknown>;
      };

    const baseBody = {
      model,
      messages,
      instructions: instructionsText,
      stream,
      _includeReasoning: reasoningRequested,
      _responsesInput: responsesInput,
      ...chatParams,
    } as ChatCompletionRequest;

    return providerImpl.prepareRequest
      ? await providerImpl.prepareRequest(account, baseBody, "responses")
      : baseBody;
  },

  async handleStream(ctx) {
    const {
      response,
      account,
      reply,
      request,
      requestStartTime,
      startTime,
      userId,
      apiKeyId,
      model,
    } = ctx;

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
      markAccountSuccess(accountId).catch(() => undefined);
      recordLatency(
        accountProvider,
        model,
        true,
        Date.now() - requestStartTime
      ).catch(() => undefined);

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
    const {
      response,
      account,
      reply,
      requestStartTime,
      startTime,
      userId,
      apiKeyId,
      model,
    } = ctx;

    const responseData = (await response.json()) as Record<string, unknown> & {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    markAccountSuccess(account.id).catch(() => undefined);
    recordLatency(
      account.provider,
      model,
      false,
      Date.now() - requestStartTime
    ).catch(() => undefined);

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
