import { Hono } from "hono";
import { decrypt, type ProviderAccount } from "@opendum/database";
import type { ModelRegistry, ProviderRegistry } from "@opendum/ai";
import type { AuthService } from "../auth/service.js";
import { LoadBalancer } from "../proxy/balancer.js";
import { writeOpenAIError } from "../errors.js";
import { markRateLimited, parseRetryAfterMs, getRateLimitScope } from "../proxy/rate-limit.js";
import { createSSEUsageTracker } from "../proxy/usage.js";

export function createChatRoute(
  authService: AuthService,
  registry: ModelRegistry,
  providers: ProviderRegistry,
  loadBalancer: LoadBalancer
) {
  const router = new Hono();

  router.post("/v1/chat/completions", async (c) => {
    const startMs = Date.now();
    const authHeader =
      c.req.header("authorization") || c.req.header("x-api-key");

    if (!authHeader) {
      return writeOpenAIError(c, 401, {
        message: "Missing API key.",
        type: "authentication_error",
      });
    }

    const authResult = await authService.validateAPIKey(authHeader);
    if (!authResult.valid) {
      return writeOpenAIError(c, 401, {
        message: authResult.error || "Unauthorized",
        type: "authentication_error",
      });
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return writeOpenAIError(c, 400, {
        message: "Invalid JSON in request body",
        type: "invalid_request_error",
      });
    }

    const rawModel = String(body.model || "");
    if (!rawModel) {
      return writeOpenAIError(c, 400, {
        message: "Missing 'model' field in request body",
        type: "invalid_request_error",
      });
    }

    const canonicalModel = registry.resolveAlias(rawModel);
    const isStream = Boolean(body.stream);

    const eligibleAccounts = await loadBalancer.getEligibleAccounts({
      userId: authResult.userId!,
      model: canonicalModel,
      roamingEnabled: authResult.roamingEnabled,
      accountAccessMode: authResult.accountAccessMode,
      accountAccessList: authResult.accountAccessList,
    });

    if (eligibleAccounts.length === 0) {
      return writeOpenAIError(c, 503, {
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
        } catch (e) {
          console.error("Failed to decrypt credentials for account:", account.id, e);
          continue;
        }
      }

      try {
        const resp = await provider.makeRequest({
          account,
          credentials,
          body,
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
          continue;
        }

        if (resp.status >= 500) {
          await loadBalancer.markAccountFailed(account.id, canonicalModel, resp.status);
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
      return writeOpenAIError(c, 503, {
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

      const usageTracker = createSSEUsageTracker();
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();

      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              const usage = usageTracker.getUsage();
              loadBalancer.logUsage({
                userId: authResult.userId!,
                providerAccountId: selectedAccount!.id,
                proxyApiKeyId: authResult.apiKeyId,
                model: canonicalModel,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                statusCode: 200,
                durationMs: Date.now() - startMs,
              });
              return;
            }
            const text = decoder.decode(value, { stream: true });
            usageTracker.processChunk(text);
            controller.enqueue(value);
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return c.body(stream);
    }

    const data: any = await upstreamResponse.json();
    const durationMs = Date.now() - startMs;

    const inputTokens = data?.usage?.prompt_tokens ?? data?.usage?.input_tokens ?? 0;
    const outputTokens = data?.usage?.completion_tokens ?? data?.usage?.output_tokens ?? 0;

    loadBalancer.logUsage({
      userId: authResult.userId!,
      providerAccountId: selectedAccount.id,
      proxyApiKeyId: authResult.apiKeyId,
      model: canonicalModel,
      inputTokens,
      outputTokens,
      statusCode: upstreamResponse.status,
      durationMs,
    });

    return c.json(data, upstreamResponse.status as any);
  });

  return router;
}
