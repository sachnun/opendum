import { Hono } from "hono";
import { decrypt, type ProviderAccount } from "@opendum/database";
import type { ModelRegistry, ProviderRegistry } from "@opendum/ai";
import type { AuthService } from "../auth/service.js";
import { LoadBalancer } from "../proxy/balancer.js";
import { writeOpenAIError } from "../errors.js";
import { markRateLimited, parseRetryAfterMs, getRateLimitScope } from "../proxy/rate-limit.js";
import { checkAndIncrementRateLimit } from "../proxy/key-limit.js";
import { createAnthropicStreamTransformer } from "@opendum/ai";
import { convertOpenAIToAnthropicJSON, sanitizeErrorMessage, prefixWithProvider } from "@opendum/ai";

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown> | string;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

function convertAnthropicToOpenAI(body: any): Record<string, unknown> {
  const messages: any[] = [];

  if (body.system) {
    const systemText =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((s: any) => s.text || "").join("\n\n")
          : "";
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg.content === "string") {
        messages.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let textParts = "";
        const toolCalls: any[] = [];

        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            textParts += block.text;
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments:
                  typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input || {}),
              },
            });
          } else if (block.type === "tool_result") {
            const content =
              typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: any) => c.text || "").join("\n")
                  : JSON.stringify(block.content || "");
            messages.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content,
            });
          }
        }

        if (textParts || toolCalls.length > 0) {
          const openAiMsg: any = { role: msg.role, content: textParts };
          if (toolCalls.length > 0) {
            openAiMsg.tool_calls = toolCalls;
          }
          messages.push(openAiMsg);
        }
      }
    }
  }

  const payload: any = {
    ...body,
    messages,
    max_tokens: body.max_tokens ?? 4096,
  };

  if (Array.isArray(body.tools)) {
    payload.tools = body.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  return payload;
}

export function createMessagesRoute(
  authService: AuthService,
  registry: ModelRegistry,
  providers: ProviderRegistry,
  loadBalancer: LoadBalancer
) {
  const router = new Hono();

  router.post("/v1/messages", async (c) => {
    const startMs = Date.now();
    const authHeader =
      c.req.header("authorization") || c.req.header("x-api-key");

    let authResult: any = null;
    const playgroundUser = c.req.header("x-opendum-playground-user-id");
    const playgroundTs = c.req.header("x-opendum-playground-timestamp");
    const playgroundSig = c.req.header("x-opendum-playground-signature");

    if (playgroundUser && playgroundTs && playgroundSig) {
      authResult = authService.validatePlaygroundAuth(
        playgroundUser,
        playgroundTs,
        playgroundSig,
        c.req.method,
        c.req.path
      );
    }

    if (!authResult) {
      if (!authHeader) {
        return writeOpenAIError(c, 401, {
          message: "Missing API key.",
          type: "authentication_error",
        });
      }
      authResult = await authService.validateAPIKey(authHeader);
    }

    if (!authResult.valid) {
      return writeOpenAIError(c, 401, {
        message: authResult.error || "Unauthorized",
        type: "authentication_error",
      });
    }

    let anthropicBody: any;
    try {
      anthropicBody = await c.req.json();
    } catch {
      return writeOpenAIError(c, 400, {
        message: "Invalid JSON in request body",
        type: "invalid_request_error",
      });
    }

    const openAIBody = convertAnthropicToOpenAI(anthropicBody);
    const rawModel = String(anthropicBody.model || "");
    const canonicalModel = registry.resolveAlias(rawModel);

    if (authResult.apiKeyId && authResult.rateLimitRules?.length) {
      const rl = await checkAndIncrementRateLimit(
        authResult.apiKeyId,
        canonicalModel,
        authResult.rateLimitRules
      );
      if (!rl.allowed) {
        if (rl.retryAfterSeconds) {
          c.header("Retry-After", String(rl.retryAfterSeconds));
        }
        return writeOpenAIError(c, 429, {
          message: `Rate limit exceeded for ${canonicalModel}: ${rl.current}/${rl.limit} requests per ${rl.exceededWindow}. Retry after ${rl.retryAfterSeconds}s.`,
          type: "rate_limit_error",
        });
      }
    }

    const isStream = Boolean(anthropicBody.stream);

    const eligibleAccounts = await loadBalancer.getEligibleAccounts({
      userId: authResult.userId!,
      model: canonicalModel,
      roamingEnabled: authResult.roamingEnabled,
      accountAccessMode: authResult.accountAccessMode,
      accountAccessList: authResult.accountAccessList,
    });

    if (eligibleAccounts.length === 0) {
      return writeOpenAIError(c, 529, {
        message: `No active accounts available for model '${canonicalModel}'.`,
        type: "api_error",
      });
    }

    let lastError: Error | null = null;
    let selectedAccount: ProviderAccount | null = null;
    let upstreamResponse: Response | null = null;

    for (const account of eligibleAccounts) {
      const provider = providers.get(account.provider);
      if (!provider) continue;

      let credentials = "";
      if (!provider.isAuthless?.()) {
        try {
          credentials = account.apiKey
            ? decrypt(account.apiKey)
            : decrypt(account.accessToken);
        } catch {
          continue;
        }
      }

      try {
        const resp = await provider.makeRequest({
          account,
          credentials,
          body: openAIBody,
          stream: isStream,
        });

        if (resp.status === 429) {
          const retryAfterMs =
            parseRetryAfterMs(resp.headers.get("retry-after")) || 60000;
          await markRateLimited(
            account.id,
            getRateLimitScope(canonicalModel),
            retryAfterMs,
            canonicalModel
          );
          await loadBalancer.markAccountFailed(account.id, canonicalModel, 429);
          const rawErr = await resp.text().catch(() => "");
          const { message } = sanitizeErrorMessage(429, rawErr);
          lastError = new Error(prefixWithProvider(account.provider, message));
          continue;
        }

        if (resp.status >= 500) {
          await loadBalancer.markAccountFailed(account.id, canonicalModel, resp.status);
          const rawErr = await resp.text().catch(() => "");
          const { message } = sanitizeErrorMessage(resp.status, rawErr);
          lastError = new Error(prefixWithProvider(account.provider, message));
          continue;
        }

        selectedAccount = account;
        upstreamResponse = resp;
        break;
      } catch (err: any) {
        lastError = err;
        await loadBalancer.markAccountFailed(account.id, canonicalModel, 500);
      }
    }

    if (!selectedAccount || !upstreamResponse) {
      return writeOpenAIError(c, 529, {
        message:
          lastError?.message ||
          "All eligible provider accounts failed for this request.",
        type: "api_error",
      });
    }

    await loadBalancer.markAccountSuccess(selectedAccount.id, canonicalModel);
    c.header("x-provider-account-id", selectedAccount.id);

    if (isStream && upstreamResponse.body) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const reader = upstreamResponse.body.getReader();

      let sseBuffer = "";
      let finalUsage = { inputTokens: 0, outputTokens: 0 };

      const stream = new ReadableStream({
        async pull(controller) {
          const transformer = createAnthropicStreamTransformer(canonicalModel, {
            onEvent(event, data) {
              const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
              controller.enqueue(encoder.encode(payload));
            },
            onUsage(inputTokens, outputTokens) {
              finalUsage = { inputTokens, outputTokens };
            },
          });

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                transformer.finish();
                controller.close();
                loadBalancer.logUsage({
                  userId: authResult.userId!,
                  providerAccountId: selectedAccount!.id,
                  proxyApiKeyId: authResult.apiKeyId,
                  model: canonicalModel,
                  inputTokens: finalUsage.inputTokens,
                  outputTokens: finalUsage.outputTokens,
                  statusCode: 200,
                  durationMs: Date.now() - startMs,
                });
                return;
              }

              sseBuffer += decoder.decode(value, { stream: true });
              const lines = sseBuffer.split("\n");
              sseBuffer = lines.pop() ?? "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const raw = trimmed.slice(5).trim();
                if (!raw || raw === "[DONE]") continue;

                try {
                  const chunk = JSON.parse(raw);
                  transformer.processChunk(chunk);
                } catch {
                  // ignore
                }
              }
            }
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return c.body(stream);
    }

    const data: any = await upstreamResponse.json();
    const anthropicResponse = convertOpenAIToAnthropicJSON(data, canonicalModel);
    const durationMs = Date.now() - startMs;

    loadBalancer.logUsage({
      userId: authResult.userId!,
      providerAccountId: selectedAccount.id,
      proxyApiKeyId: authResult.apiKeyId,
      model: canonicalModel,
      inputTokens: (anthropicResponse.usage as any)?.input_tokens ?? 0,
      outputTokens: (anthropicResponse.usage as any)?.output_tokens ?? 0,
      statusCode: upstreamResponse.status,
      durationMs,
    });

    return c.json(anthropicResponse, upstreamResponse.status as any);
  });

  return router;
}
