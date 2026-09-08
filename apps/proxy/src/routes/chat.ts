import { Hono } from "hono";
import {
  db,
  decrypt,
  reserveRoamingPoint,
  refundRoamingPoint,
  creditSharingPoint,
  type ProviderAccount,
  type PointReservation,
} from "@opendum/database";
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

    let authResult: any = null;

    // Check Playground HMAC auth
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
    const forcedAccountId = body._account || body.accountId || (typeof body.model === "string" && body.model.includes("/") && !registry.getProvidersForModel(registry.resolveAlias(body.model)).length ? body.model.split("/")[0] : undefined);

    const eligibleAccounts = await loadBalancer.getEligibleAccounts({
      userId: authResult.userId!,
      model: canonicalModel,
      forcedAccountId,
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
    let pointReservation: PointReservation | null = null;

    for (const account of eligibleAccounts) {
      const isShared = account.userId !== authResult.userId;

      if (isShared && !forcedAccountId) {
        const pointRes = await reserveRoamingPoint(db, authResult.userId!);
        if (!pointRes.sufficient) {
          return writeOpenAIError(c, 402, {
            message: "Insufficient points. Please add more points to continue.",
            type: "insufficient_quota",
            code: "insufficient_points",
          });
        }
        pointReservation = pointRes.reservation;
      }

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
          if (pointReservation) {
            await refundRoamingPoint(db, pointReservation);
            pointReservation = null;
          }
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
          if (pointReservation) {
            await refundRoamingPoint(db, pointReservation);
            pointReservation = null;
          }
          await loadBalancer.markAccountFailed(account.id, canonicalModel, resp.status);
          continue;
        }

        selectedAccount = account;
        upstreamResponse = resp;
        break;
      } catch (err: any) {
        if (pointReservation) {
          await refundRoamingPoint(db, pointReservation);
          pointReservation = null;
        }
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

    if (pointReservation) {
      await creditSharingPoint(
        db,
        selectedAccount.userId,
        pointReservation.debitId,
        pointReservation.amount
      );
    }

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
