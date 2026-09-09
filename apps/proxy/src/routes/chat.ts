import { Hono } from "hono";
import { createHash } from "node:crypto";
import {
    db,
    reserveRoamingPoint,
    refundRoamingPoint,
    creditSharingPoint,
    type ProviderAccount,
    type PointReservation,
} from "@opendum/database";
import type { ModelRegistry, ProviderRegistry } from "@opendum/ai";
import type { AuthService } from "../auth/service.js";
import { LoadBalancer } from "../proxy/balancer.js";
import { SessionAffinity } from "../proxy/affinity.js";
import { writeOpenAIError } from "../errors.js";
import {
    markRateLimited,
    parseRetryAfterMs,
    getRateLimitScope,
} from "../proxy/rate-limit.js";
import { checkAndIncrementRateLimit } from "../proxy/key-limit.js";
import { createSSEUsageTracker } from "../proxy/usage.js";
import { credentialsForAccount } from "../proxy/credentials.js";
import {
    getEffectiveModelCapabilities,
    sanitizeErrorMessage,
    prefixWithProvider,
} from "@opendum/ai";

function sessionID(body: any, headers: Headers): string | undefined {
    for (const name of [
        "x-claude-code-session-id",
        "session_id",
        "x-session-id",
        "session-id",
        "x-session-affinity",
        "x-client-request-id",
    ]) {
        const value = headers.get(name)?.trim();
        if (value) return value;
    }
    for (const key of [
        "prompt_cache_key",
        "session_id",
        "sessionId",
        "conversation_id",
    ]) {
        const value = body?.[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    const metadataUser = body?.metadata?.user_id;
    if (typeof metadataUser === "string" && metadataUser.trim()) {
        const match = metadataUser.match(/_session_([a-f0-9-]+)$/);
        return match ? `claude:${match[1]}` : metadataUser.trim();
    }
    if (Array.isArray(body?.messages)) {
        for (const message of body.messages) {
            if (
                message?.role === "user" &&
                typeof message.content === "string" &&
                message.content.trim().length > 20
            ) {
                const sample = message.content.trim().slice(0, 100);
                return `prompt:${createHash("sha256").update(sample).digest("hex").slice(0, 16)}`;
            }
        }
    }
    return undefined;
}

function stripUnsupportedCapabilities(
    body: any,
    registry: ModelRegistry,
    model: string,
) {
    const capabilities = getEffectiveModelCapabilities(
        registry.getModel(model)?.meta,
    );
    if (!capabilities.toolCall) {
        delete body.tools;
        delete body.tool_choice;
        delete body.parallel_tool_calls;
    }
    if (!capabilities.vision && Array.isArray(body.messages)) {
        body.messages = body.messages.map((message: any) => {
            if (!Array.isArray(message?.content)) return message;
            return {
                ...message,
                content: message.content.filter(
                    (part: any) =>
                        part?.type !== "image_url" && part?.type !== "image",
                ),
            };
        });
    }
}

export function createChatRoute(
    authService: AuthService,
    registry: ModelRegistry,
    providers: ProviderRegistry,
    loadBalancer: LoadBalancer,
    affinity?: SessionAffinity,
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

        if (playgroundUser || playgroundTs || playgroundSig) {
            authResult = authService.validatePlaygroundAuth(
                playgroundUser,
                playgroundTs,
                playgroundSig,
                c.req.method,
                c.req.path,
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

        if (!Array.isArray(body.messages)) {
            return writeOpenAIError(c, 400, {
                message: "Missing 'messages' array in request body",
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

        const modelValidation = await authService.validateModelForUser(
            authResult.userId!,
            rawModel,
            authResult,
        );
        if (!modelValidation.valid || !modelValidation.model) {
            return writeOpenAIError(c, 400, {
                message: modelValidation.error || "Invalid model.",
                type: "invalid_request_error",
                code: modelValidation.code,
            });
        }

        const canonicalModel = modelValidation.model;
        body.model = canonicalModel;
        stripUnsupportedCapabilities(body, registry, canonicalModel);

        if (authResult.apiKeyId && authResult.rateLimitRules?.length) {
            const rl = await checkAndIncrementRateLimit(
                authResult.apiKeyId,
                canonicalModel,
                authResult.rateLimitRules,
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

        const isStream = Boolean(body.stream);
        const sessionId = sessionID(body, c.req.raw.headers);
        const forcedAccountId =
            body._account || body.accountId || modelValidation.forcedAccountId;

        let eligibleAccounts = await loadBalancer.getEligibleAccounts({
            userId: authResult.userId!,
            model: canonicalModel,
            forcedAccountId,
            roamingEnabled: authResult.roamingEnabled,
            accountAccessMode: authResult.accountAccessMode,
            accountAccessList: authResult.accountAccessList,
        });

        if (affinity && sessionId && !forcedAccountId) {
            const stickyAccountId = await affinity.lookup(
                authResult.userId!,
                sessionId,
            );
            if (stickyAccountId) {
                eligibleAccounts = affinity.preferStickyAccount(
                    eligibleAccounts,
                    stickyAccountId,
                );
            }
        }

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
        let lastStatus = 503;

        for (const account of eligibleAccounts) {
            const provider = providers.get(account.provider);
            if (!provider) continue;

            const isShared = account.userId !== authResult.userId;
            if (isShared && !forcedAccountId) {
                const pointRes = await reserveRoamingPoint(
                    db,
                    authResult.userId!,
                );
                if (!pointRes.sufficient) {
                    return writeOpenAIError(c, 402, {
                        message:
                            "Insufficient points. Please add more points to continue.",
                        type: "insufficient_quota",
                        code: "insufficient_points",
                    });
                }
                pointReservation = pointRes.reservation;
            }

            let credentials = "";
            try {
                credentials = await credentialsForAccount(account, provider);
            } catch (error) {
                console.error(
                    "Failed to resolve credentials for account:",
                    account.id,
                    error,
                );
                if (pointReservation) {
                    await refundRoamingPoint(db, pointReservation);
                    pointReservation = null;
                }
                continue;
            }

            try {
                const resp = await provider.makeRequest({
                    account,
                    credentials,
                    body,
                    stream: isStream,
                });

                if (!resp.ok) {
                    lastStatus = resp.status;
                    if (pointReservation) {
                        await refundRoamingPoint(db, pointReservation);
                        pointReservation = null;
                    }
                    if (resp.status === 429) {
                        const retryAfterMs =
                            parseRetryAfterMs(
                                resp.headers.get("retry-after"),
                            ) || 60000;
                        await markRateLimited(
                            account.id,
                            getRateLimitScope(canonicalModel),
                            retryAfterMs,
                            canonicalModel,
                        );
                    }
                    if (resp.status !== 400 && resp.status !== 408) {
                        await loadBalancer.markAccountFailed(
                            account.id,
                            canonicalModel,
                            resp.status,
                        );
                    }
                    const rawErr = await resp.text().catch(() => "");
                    const { message } = sanitizeErrorMessage(
                        resp.status,
                        rawErr,
                    );
                    lastError = new Error(
                        prefixWithProvider(account.provider, message),
                    );
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
                await loadBalancer.markAccountFailed(
                    account.id,
                    canonicalModel,
                    500,
                );
            }
        }

        if (!selectedAccount || !upstreamResponse) {
            return writeOpenAIError(c, lastStatus as any, {
                message:
                    lastError?.message ||
                    "All eligible provider accounts failed for this request.",
                type: lastStatus === 429 ? "rate_limit_error" : "api_error",
            });
        }

        const recordSuccess = async () => {
            await loadBalancer.markAccountSuccess(
                selectedAccount!.id,
                canonicalModel,
            );
            if (
                affinity &&
                sessionId &&
                affinity.isEnabled(selectedAccount!.provider)
            ) {
                void affinity.store(
                    authResult.userId!,
                    sessionId,
                    selectedAccount!.id,
                );
            }
            if (pointReservation) {
                const reservation = pointReservation;
                pointReservation = null;
                await creditSharingPoint(
                    db,
                    selectedAccount!.userId,
                    reservation.debitId,
                    reservation.amount,
                );
            }
        };

        c.header("x-provider-account-id", selectedAccount.id);

        if (isStream && upstreamResponse.body) {
            c.header("Content-Type", "text/event-stream");
            c.header("Cache-Control", "no-cache");
            c.header("Connection", "keep-alive");
            c.header("X-Accel-Buffering", "no");

            const usageTracker = createSSEUsageTracker();
            const reader = upstreamResponse.body.getReader();
            const decoder = new TextDecoder();

            const stream = new ReadableStream({
                async pull(controller) {
                    try {
                        const { done, value } = await reader.read();
                        if (done) {
                            await recordSuccess();
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
                        if (pointReservation) {
                            void refundRoamingPoint(db, pointReservation);
                            pointReservation = null;
                        }
                        void loadBalancer.markAccountFailed(
                            selectedAccount!.id,
                            canonicalModel,
                            500,
                        );
                        controller.error(err);
                    }
                },
                async cancel(reason) {
                    await reader.cancel(reason).catch(() => undefined);
                    if (pointReservation) {
                        const reservation = pointReservation;
                        pointReservation = null;
                        await refundRoamingPoint(db, reservation);
                    }
                },
            });

            return c.body(stream);
        }

        let data: any;
        try {
            data = await upstreamResponse.json();
        } catch (err) {
            if (pointReservation)
                await refundRoamingPoint(db, pointReservation);
            await loadBalancer.markAccountFailed(
                selectedAccount.id,
                canonicalModel,
                500,
            );
            return writeOpenAIError(c, 502, {
                message: `Invalid JSON response from ${selectedAccount.provider}.`,
                type: "api_error",
            });
        }
        await recordSuccess();
        const durationMs = Date.now() - startMs;

        const inputTokens =
            data?.usage?.prompt_tokens ?? data?.usage?.input_tokens ?? 0;
        const outputTokens =
            data?.usage?.completion_tokens ?? data?.usage?.output_tokens ?? 0;

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
