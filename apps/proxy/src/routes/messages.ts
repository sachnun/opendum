import { Hono } from "hono";
import {
    db,
    reserveRoamingPoint,
    refundRoamingPoint,
    creditSharingPoint,
    type PointReservation,
    type ProviderAccount,
} from "@opendum/database";
import type { ModelRegistry, ProviderRegistry } from "@opendum/ai";
import type { AuthService } from "../auth/service.js";
import { LoadBalancer } from "../proxy/balancer.js";
import { SessionAffinity } from "../proxy/affinity.js";
import { credentialsForAccount } from "../proxy/credentials.js";

import {
    markRateLimited,
    parseRetryAfterMs,
    getRateLimitScope,
} from "../proxy/rate-limit.js";
import { checkAndIncrementRateLimit } from "../proxy/key-limit.js";
import { createAnthropicStreamTransformer } from "@opendum/ai";
import {
    convertOpenAIToAnthropicJSON,
    sanitizeErrorMessage,
    prefixWithProvider,
} from "@opendum/ai";

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function anthropicSystemToText(system: unknown): string {
    if (typeof system === "string") return system;
    if (!Array.isArray(system)) return "";
    return system
        .filter((block) => isRecord(block) && block.type === "text")
        .map((block) => stringValue(block.text))
        .join("\n");
}

function convertAnthropicToolChoice(toolChoice: unknown): unknown {
    if (typeof toolChoice === "string") return toolChoice;
    if (!isRecord(toolChoice)) return toolChoice;
    if (toolChoice.function != null) return toolChoice;

    switch (toolChoice.type) {
        case "auto":
            return "auto";
        case "any":
        case "required":
            return "required";
        case "none":
            return "none";
        case "tool":
        case "function": {
            const nestedFunction = isRecord(toolChoice.function)
                ? toolChoice.function
                : undefined;
            return {
                type: "function",
                function: {
                    name:
                        stringValue(toolChoice.name) ||
                        stringValue(nestedFunction?.name),
                },
            };
        }
        default:
            return toolChoice;
    }
}

function convertAnthropicToOpenAI(body: any): Record<string, unknown> {
    const payload: Record<string, any> = {
        model: body.model,
        messages: [],
        max_tokens: body.max_tokens ?? 4096,
    };

    for (const key of ["stream", "temperature", "top_p"] as const) {
        if (body[key] !== undefined) payload[key] = body[key];
    }
    if (body.stop_sequences !== undefined) payload.stop = body.stop_sequences;

    const messages: any[] = payload.messages;
    if (body.system !== undefined && body.system !== null) {
        messages.push({
            role: "system",
            content: anthropicSystemToText(body.system),
        });
    }

    const toolResultIDs = new Set<string>();
    for (const message of body.messages) {
        if (!isRecord(message) || !Array.isArray(message.content)) continue;
        for (const block of message.content) {
            if (isRecord(block) && block.type === "tool_result") {
                const id = stringValue(block.tool_use_id);
                if (id) toolResultIDs.add(id);
            }
        }
    }

    for (const message of body.messages) {
        if (!isRecord(message)) continue;
        const role = stringValue(message.role);
        if (typeof message.content === "string") {
            messages.push({ role, content: message.content });
            continue;
        }
        if (!Array.isArray(message.content)) continue;

        const parts: any[] = [];
        const toolCalls: any[] = [];
        const extraMessages: any[] = [];
        for (const block of message.content) {
            if (!isRecord(block)) continue;
            switch (block.type) {
                case "text": {
                    const text = stringValue(block.text);
                    if (text) parts.push({ type: "text", text });
                    break;
                }
                case "image": {
                    const source = isRecord(block.source)
                        ? block.source
                        : undefined;
                    const url = stringValue(source?.url);
                    if (url)
                        parts.push({ type: "image_url", image_url: { url } });
                    break;
                }
                case "tool_use": {
                    const id = stringValue(block.id);
                    if (id && !toolResultIDs.has(id)) break;
                    toolCalls.push({
                        id,
                        type: "function",
                        function: {
                            name: stringValue(block.name),
                            arguments: JSON.stringify(block.input ?? {}),
                        },
                    });
                    break;
                }
                case "tool_result":
                    extraMessages.push({
                        role: "tool",
                        tool_call_id: stringValue(block.tool_use_id),
                        content:
                            typeof block.content === "string"
                                ? block.content
                                : JSON.stringify(block.content ?? null),
                    });
                    break;
            }
        }

        messages.push(...extraMessages);
        if (parts.length > 0 || toolCalls.length > 0) {
            const content = parts.every((part) => part.type === "text")
                ? parts.map((part) => part.text).join("")
                : parts.length > 0
                  ? parts
                  : null;
            const converted: Record<string, unknown> = { role, content };
            if (toolCalls.length > 0) converted.tool_calls = toolCalls;
            messages.push(converted);
        }
    }

    if (Array.isArray(body.tools)) {
        payload.tools = body.tools.flatMap((tool: unknown) => {
            if (!isRecord(tool)) return [];
            if (Object.prototype.hasOwnProperty.call(tool, "function"))
                return [tool];
            const name = stringValue(tool.name);
            if (!name) return [];
            return [
                {
                    type: "function",
                    function: {
                        name,
                        description: stringValue(tool.description),
                        parameters: tool.input_schema ?? {},
                    },
                },
            ];
        });
    }

    if (body.tool_choice !== undefined) {
        payload.tool_choice = convertAnthropicToolChoice(body.tool_choice);
    }

    if (isRecord(body.thinking)) {
        if (body.thinking.type === "adaptive") {
            payload.reasoning_effort = isRecord(body.output_config)
                ? stringValue(body.output_config.effort) || "high"
                : "high";
            payload._includeReasoning = true;
        } else if (body.thinking.type === "enabled") {
            payload.thinking_budget = body.thinking.budget_tokens ?? 10000;
            payload._includeReasoning = true;
        }
    }

    return payload;
}

function writeAnthropicError(
    c: any,
    status: number,
    error: { message: string; type: string },
) {
    return c.json({ type: "error", error }, status);
}

export function createMessagesRoute(
    authService: AuthService,
    registry: ModelRegistry,
    providers: ProviderRegistry,
    loadBalancer: LoadBalancer,
    affinity?: SessionAffinity,
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
                return writeAnthropicError(c, 401, {
                    message: "Missing API key.",
                    type: "authentication_error",
                });
            }
            authResult = await authService.validateAPIKey(authHeader);
        }

        if (!authResult.valid) {
            return writeAnthropicError(c, 401, {
                message: authResult.error || "Unauthorized",
                type: "authentication_error",
            });
        }

        let anthropicBody: any;
        try {
            anthropicBody = await c.req.json();
        } catch {
            return writeAnthropicError(c, 400, {
                message: "Invalid JSON in request body",
                type: "invalid_request_error",
            });
        }

        if (
            typeof anthropicBody?.model !== "string" ||
            !anthropicBody.model.trim()
        ) {
            return writeAnthropicError(c, 400, {
                message: "model is required",
                type: "invalid_request_error",
            });
        }
        if (!Array.isArray(anthropicBody.messages)) {
            return writeAnthropicError(c, 400, {
                message: "messages array is required",
                type: "invalid_request_error",
            });
        }

        const rawModel = anthropicBody.model;
        const modelValidation = await authService.validateModelForUser(
            authResult.userId!,
            rawModel,
            authResult,
        );
        if (!modelValidation.valid || !modelValidation.model) {
            return writeAnthropicError(c, 400, {
                message: modelValidation.error || "Invalid model.",
                type: "invalid_request_error",
            });
        }
        const canonicalModel = modelValidation.model;
        anthropicBody.model = canonicalModel;
        const openAIBody = convertAnthropicToOpenAI(anthropicBody);

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
                return writeAnthropicError(c, 529, {
                    message: `Rate limit exceeded for ${canonicalModel}: ${rl.current}/${rl.limit} requests per ${rl.exceededWindow}. Retry after ${rl.retryAfterSeconds}s.`,
                    type: "rate_limit_error",
                });
            }
        }

        const isStream = Boolean(anthropicBody.stream);
        const sessionId = [
            c.req.header("x-claude-code-session-id"),
            c.req.header("x-session-id"),
            anthropicBody.prompt_cache_key,
            anthropicBody.session_id,
            anthropicBody.sessionId,
            anthropicBody.conversation_id,
            anthropicBody.metadata?.user_id,
        ]
            .find((value) => typeof value === "string" && value.trim())
            ?.trim();

        let eligibleAccounts = await loadBalancer.getEligibleAccounts({
            userId: authResult.userId!,
            model: canonicalModel,
            roamingEnabled: authResult.roamingEnabled,
            accountAccessMode: authResult.accountAccessMode,
            accountAccessList: authResult.accountAccessList,
            forcedAccountId: modelValidation.forcedAccountId,
        });

        if (affinity && sessionId && !modelValidation.forcedAccountId) {
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
            return writeAnthropicError(c, 529, {
                message: `No active accounts available for model '${canonicalModel}'.`,
                type: "configuration_error",
            });
        }

        let lastError: Error | null = null;
        let selectedAccount: ProviderAccount | null = null;
        let upstreamResponse: Response | null = null;
        let lastStatus = 529;
        let pointReservation: PointReservation | null = null;

        for (const account of eligibleAccounts) {
            const provider = providers.get(account.provider);
            if (!provider) continue;

            if (
                account.userId !== authResult.userId &&
                !modelValidation.forcedAccountId
            ) {
                const pointResult = await reserveRoamingPoint(
                    db,
                    authResult.userId!,
                );
                if (!pointResult.sufficient) {
                    return writeAnthropicError(c, 402, {
                        message:
                            "Insufficient points. Please add more points to continue.",
                        type: "insufficient_quota",
                    });
                }
                pointReservation = pointResult.reservation;
            }

            let credentials = "";
            try {
                credentials = await credentialsForAccount(account, provider);
            } catch {
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
                    body: openAIBody,
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
            return writeAnthropicError(c, lastStatus, {
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

            const encoder = new TextEncoder();
            const decoder = new TextDecoder();
            const reader = upstreamResponse.body.getReader();

            let sseBuffer = "";
            let finalUsage = { inputTokens: 0, outputTokens: 0 };

            const stream = new ReadableStream({
                async pull(controller) {
                    const transformer = createAnthropicStreamTransformer(
                        canonicalModel,
                        {
                            onEvent(event, data) {
                                const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
                                controller.enqueue(encoder.encode(payload));
                            },
                            onUsage(inputTokens, outputTokens) {
                                finalUsage = { inputTokens, outputTokens };
                            },
                        },
                    );

                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) {
                                if (sseBuffer.trim()) {
                                    const raw = sseBuffer
                                        .trim()
                                        .replace(/^data:\s*/, "");
                                    if (raw && raw !== "[DONE]") {
                                        try {
                                            transformer.processChunk(
                                                JSON.parse(raw),
                                            );
                                        } catch {
                                            // Ignore malformed trailing SSE data.
                                        }
                                    }
                                }
                                transformer.finish();
                                await recordSuccess();
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

                            sseBuffer += decoder.decode(value, {
                                stream: true,
                            });
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
        } catch {
            if (pointReservation) {
                await refundRoamingPoint(db, pointReservation);
                pointReservation = null;
            }
            await loadBalancer.markAccountFailed(
                selectedAccount.id,
                canonicalModel,
                500,
            );
            return writeAnthropicError(c, 502, {
                message: `Invalid JSON response from ${selectedAccount.provider}.`,
                type: "api_error",
            });
        }
        await recordSuccess();
        const anthropicResponse = convertOpenAIToAnthropicJSON(
            data,
            canonicalModel,
        );
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
