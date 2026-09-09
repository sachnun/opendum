import type {
    Provider,
    ProviderRequestOptions,
    RefreshedCredentials,
} from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";
import type { ProviderAccount } from "@opendum/database";
import {
    createPerchSSEToChatTransformer,
    perchSSEToChatCompletion,
    PerchUpstreamError,
    readPerchSSE,
} from "../protocol/responses/perch-stream.js";

const PERCH_APP_URL = "https://app.perchai.app";
const PERCH_AUTH_CONFIG_PATH = "/api/perch-terminal/cli-auth/config";
const PERCH_ACCOUNT_PATH = "/api/perchai/account";
const PERCH_TURN_TICKET_PATH = "/api/perch-terminal/turn-ticket";
const PERCH_CHAT_PATH = "/api/perch-terminal/model-call";
const PERCH_TURN_TICKET_HEADER = "x-perch-turn-ticket";
const PERCH_CLI_VERSION = "2.4.98";
const PERCH_USER_AGENT = `perchai-cli/${PERCH_CLI_VERSION}`;
const PERCH_REFRESH_BUFFER_SECONDS = 300;
const PERCH_CONFIG_CACHE_MS = 15 * 60 * 1000;
const PERCH_SESSION_CACHE_MS = 10 * 60 * 1000;
const PERCH_ACCOUNT_TIMEOUT_MS = 5_000;
const PERCH_FALLBACK_ALIAS = "qwen-3.6";

const PERCH_MANUAL_OPTION_IDS: Record<string, string> = {
    "minimax-m3-free": "gmi-minimaxai-minimax-m3",
    "minimax-m2.7-free": "openrouter-minimax-minimax-m2-7-free",
    "qwen-3.6": "wandb-qwen3-6-35b-a3b",
    "kimi-2.5": "bedrock-mantle-moonshotai-kimi-k2-5",
    "glm-5": "bedrock-mantle-zai-glm-5",
    "qwen3-coder": "bedrock-mantle-qwen-qwen3-coder-480b-a35b-instruct",
    "nemotron-super": "bedrock-mantle-nvidia-nemotron-super-3-120b",
    "gemma-4-e2b": "bedrock-mantle-google-gemma-4-e2b",
    "gemma-4-31b": "bedrock-mantle-google-gemma-4-31b",
};

interface PerchAuthConfig {
    supabaseUrl: string;
    supabaseAnonKey: string;
}

interface PerchSessionIds {
    userId: string;
    workspaceId: string;
}

let authConfigCache: { value: PerchAuthConfig; fetchedAt: number } | undefined;
const sessionCache = new Map<
    string,
    { value: PerchSessionIds; fetchedAt: number }
>();

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

async function responseText(response: Response): Promise<string> {
    return (await response.text()).slice(0, 1024 * 1024);
}

async function fetchAuthConfig(): Promise<PerchAuthConfig> {
    if (
        authConfigCache &&
        Date.now() - authConfigCache.fetchedAt < PERCH_CONFIG_CACHE_MS
    ) {
        return authConfigCache.value;
    }

    const response = await fetch(`${PERCH_APP_URL}${PERCH_AUTH_CONFIG_PATH}`, {
        headers: { Accept: "application/json" },
    });
    if (!response.ok) {
        throw new Error(`perch auth config request failed: ${response.status}`);
    }

    const raw: unknown = await response.json();
    const payload =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const supabaseUrl =
        typeof payload.supabaseUrl === "string"
            ? payload.supabaseUrl.trim().replace(/\/+$/, "")
            : "";
    const supabaseAnonKey =
        typeof payload.supabaseAnonKey === "string"
            ? payload.supabaseAnonKey.trim()
            : "";
    if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error("perch auth config is incomplete");
    }

    const value = { supabaseUrl, supabaseAnonKey };
    authConfigCache = { value, fetchedAt: Date.now() };
    return value;
}

function textFromContent(value: unknown): string {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value
        .map((part) => {
            if (!part || typeof part !== "object") return "";
            const record = part as Record<string, unknown>;
            return record.type === "text" && typeof record.text === "string"
                ? record.text
                : "";
        })
        .filter(Boolean)
        .join("\n");
}

function perchMessages(
    body: Record<string, unknown>,
): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    const system = textFromContent(body.system).trim();
    if (system) messages.push({ role: "system", content: system });

    if (!Array.isArray(body.messages)) return messages;
    for (const rawMessage of body.messages) {
        if (!rawMessage || typeof rawMessage !== "object") continue;
        const message = rawMessage as Record<string, unknown>;
        const role = typeof message.role === "string" ? message.role : "";
        if (role === "system" || role === "developer") {
            const content = textFromContent(message.content).trim();
            if (content) messages.push({ role: "system", content });
        } else if (role === "user") {
            messages.push({
                role: "user",
                content: textFromContent(message.content),
            });
        } else if (role === "assistant") {
            const converted: Record<string, unknown> = {
                role: "assistant",
                content: textFromContent(message.content),
            };
            if (
                Array.isArray(message.tool_calls) &&
                message.tool_calls.length > 0
            ) {
                converted.tool_calls = message.tool_calls.flatMap((rawCall) => {
                    if (!rawCall || typeof rawCall !== "object") return [];
                    const call = rawCall as Record<string, unknown>;
                    const fn =
                        call.function && typeof call.function === "object"
                            ? (call.function as Record<string, unknown>)
                            : {};
                    return [
                        {
                            id: typeof call.id === "string" ? call.id : "",
                            type: "function",
                            function: {
                                name:
                                    typeof fn.name === "string" ? fn.name : "",
                                arguments:
                                    typeof fn.arguments === "string" &&
                                    fn.arguments
                                        ? fn.arguments
                                        : "{}",
                            },
                        },
                    ];
                });
            }
            messages.push(converted);
        } else if (role === "tool") {
            messages.push({
                role: "tool",
                tool_call_id:
                    typeof message.tool_call_id === "string"
                        ? message.tool_call_id
                        : "",
                content: textFromContent(message.content),
            });
        }
    }
    return messages;
}

function perchTools(
    body: Record<string, unknown>,
): Array<Record<string, unknown>> {
    if (!Array.isArray(body.tools)) return [];
    return body.tools.flatMap((rawTool) => {
        if (!rawTool || typeof rawTool !== "object") return [];
        const tool = rawTool as Record<string, unknown>;
        if (!tool.function || typeof tool.function !== "object") return [];
        const fn = tool.function as Record<string, unknown>;
        if (typeof fn.name !== "string" || !fn.name) return [];
        const converted: Record<string, unknown> = {
            name: fn.name,
            parameters: fn.parameters ?? { type: "object", properties: {} },
        };
        if (typeof fn.description === "string" && fn.description) {
            converted.description = fn.description;
        }
        return [{ type: "function", function: converted }];
    });
}

function effortFromBody(body: Record<string, unknown>): {
    level: string;
    reasoningEnabled: boolean;
} {
    const raw =
        typeof body.reasoning_effort === "string"
            ? body.reasoning_effort.trim().toLowerCase()
            : "";
    if (raw === "off" || raw === "none")
        return { level: "off", reasoningEnabled: false };
    if (raw === "low" || raw === "medium")
        return { level: raw, reasoningEnabled: true };
    return { level: "high", reasoningEnabled: true };
}

function isTruthy(value: unknown): boolean {
    if (value === true) return true;
    if (typeof value === "number") return value !== 0;
    return (
        typeof value === "string" &&
        ["1", "true", "yes", "on"].includes(value.toLowerCase())
    );
}

async function turnTicket(
    accessToken: string,
    signal?: AbortSignal,
): Promise<{ ticket: string; runId: string }> {
    const response = await fetch(`${PERCH_APP_URL}${PERCH_TURN_TICKET_PATH}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${accessToken.trim()}`,
            "User-Agent": PERCH_USER_AGENT,
        },
        body: JSON.stringify({ surface: "cli", profile: "standard" }),
        signal,
    });
    if (!response.ok) {
        throw new Error(
            `perch turn ticket failed: ${response.status} ${await responseText(response)}`,
        );
    }

    let raw: unknown;
    try {
        raw = await response.json();
    } catch {
        throw new Error("perch turn ticket was not valid JSON");
    }
    const result =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const error = typeof result.error === "string" ? result.error.trim() : "";
    if (result.ok === false) {
        throw new Error(error || "Perch turn ticket request failed");
    }
    const ticket =
        typeof result.ticket === "string" ? result.ticket.trim() : "";
    const runId = typeof result.runId === "string" ? result.runId.trim() : "";
    if (!ticket || !runId) {
        throw new Error(
            error || "Perch turn ticket returned incomplete credentials",
        );
    }
    return { ticket, runId };
}

async function sessionIdsForAccount(
    account: ProviderAccount,
    accessToken: string,
    signal?: AbortSignal,
): Promise<PerchSessionIds | null> {
    if (!account.id) return null;
    const cached = sessionCache.get(account.id);
    if (cached && Date.now() - cached.fetchedAt < PERCH_SESSION_CACHE_MS)
        return cached.value;

    const timeoutSignal = AbortSignal.timeout(PERCH_ACCOUNT_TIMEOUT_MS);
    const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
    try {
        const response = await fetch(`${PERCH_APP_URL}${PERCH_ACCOUNT_PATH}`, {
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${accessToken.trim()}`,
            },
            signal: requestSignal,
        });
        if (!response.ok) return null;
        const raw: unknown = await response.json();
        if (!raw || typeof raw !== "object") return null;
        const payload = raw as Record<string, unknown>;
        if (
            payload.ok !== true ||
            !payload.session ||
            typeof payload.session !== "object"
        )
            return null;
        const session = payload.session as Record<string, unknown>;
        const userId = typeof session.userId === "string" ? session.userId : "";
        const workspaceId =
            typeof session.workspaceId === "string" ? session.workspaceId : "";
        const value = { userId, workspaceId };
        sessionCache.set(account.id, { value, fetchedAt: Date.now() });
        return value;
    } catch {
        return null;
    }
}

export class PerchProvider implements Provider {
    public name = "perch";

    constructor(private registry: ModelRegistry) {}

    getRefreshBuffer(): number {
        return PERCH_REFRESH_BUFFER_SECONDS;
    }

    async refreshCredentials(
        refreshToken: string,
        _account: ProviderAccount,
    ): Promise<RefreshedCredentials> {
        const config = await fetchAuthConfig();
        const response = await fetch(
            `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    apikey: config.supabaseAnonKey,
                    Authorization: `Bearer ${config.supabaseAnonKey}`,
                },
                body: JSON.stringify({ refresh_token: refreshToken.trim() }),
            },
        );
        if (!response.ok) {
            throw new Error(
                `perch token refresh failed: ${response.status} ${await responseText(response)}`,
            );
        }

        const raw: unknown = await response.json();
        const token =
            raw && typeof raw === "object"
                ? (raw as Record<string, unknown>)
                : {};
        const accessToken =
            typeof token.access_token === "string"
                ? token.access_token.trim()
                : "";
        if (!accessToken)
            throw new Error("perch token refresh returned empty access token");

        let expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        if (typeof token.expires_at === "number" && token.expires_at > 0) {
            expiresAt = new Date(token.expires_at * 1000);
        } else if (
            typeof token.expires_in === "number" &&
            token.expires_in > 0
        ) {
            expiresAt = new Date(Date.now() + token.expires_in * 1000);
        }
        return {
            accessToken,
            refreshToken:
                typeof token.refresh_token === "string" &&
                token.refresh_token.trim()
                    ? token.refresh_token.trim()
                    : refreshToken.trim(),
            expiresAt,
        };
    }

    async makeRequest(options: ProviderRequestOptions): Promise<Response> {
        const { account, body, stream, signal } = options;
        const credentials = options.credentials?.trim() ?? "";
        const requestedModel = String(body.model ?? "");
        const normalizedModel = requestedModel.trim().startsWith("perch/")
            ? requestedModel.trim().slice("perch/".length)
            : requestedModel.trim();
        const upstreamModel =
            this.registry.upstreamModelName(normalizedModel, "perch") ||
            PERCH_FALLBACK_ALIAS;
        const optionId = PERCH_MANUAL_OPTION_IDS[upstreamModel];
        if (!optionId) {
            const supported = Object.keys(
                this.registry.getProviderModelMap("perch"),
            );
            const names = (
                supported.length > 0
                    ? supported
                    : Object.keys(PERCH_MANUAL_OPTION_IDS)
            ).sort();
            return jsonResponse(400, {
                error: {
                    message: `Model ${JSON.stringify(requestedModel)} is not supported for Perch. Supported models: ${names.join(", ")}.`,
                    type: "invalid_request_error",
                    param: "model",
                    code: "unsupported_perch_model",
                },
            });
        }

        const includeReasoning = isTruthy(body._includeReasoning);
        const { ticket, runId } = await turnTicket(credentials, signal);
        const sessionIds = await sessionIdsForAccount(
            account,
            credentials,
            signal,
        );
        const attribution =
            sessionIds?.userId && sessionIds.workspaceId
                ? {
                      userId: sessionIds.userId,
                      workspaceId: sessionIds.workspaceId,
                      runId,
                      lane: "chat",
                      source: "cli",
                      billingMultiplier: null,
                  }
                : null;

        const request: Record<string, unknown> = {
            lane: "chat",
            messages: perchMessages(body),
        };
        const tools = perchTools(body);
        if (tools.length > 0) {
            request.tools = tools;
            request.toolChoice = "auto";
        }
        if (body.temperature !== undefined && body.temperature !== null) {
            request.temperature = body.temperature;
        }
        const maxTokens = body.max_tokens ?? body.max_completion_tokens;
        if (maxTokens !== undefined && maxTokens !== null)
            request.maxOutputTokens = maxTokens;

        const effort = effortFromBody(body);
        const payload = {
            request,
            runId,
            lane: "chat",
            strictManual: false,
            preferredModelId: null,
            avoidModelIds: [],
            attribution,
            clientSurface: "cli",
            manualModelOptionId: optionId,
            roostModelChoice: "standard",
            roostReasoning: effort.reasoningEnabled,
            effort: { level: effort.level, orchestration: false },
        };

        const upstreamResponse = await fetch(
            `${PERCH_APP_URL}${PERCH_CHAT_PATH}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "text/event-stream",
                    Authorization: `Bearer ${credentials}`,
                    [PERCH_TURN_TICKET_HEADER]: ticket,
                    "User-Agent": PERCH_USER_AGENT,
                },
                body: JSON.stringify(payload),
                signal,
            },
        );
        if (!upstreamResponse.ok || !upstreamResponse.body)
            return upstreamResponse;

        if (!stream) {
            try {
                const completion = await perchSSEToChatCompletion(
                    upstreamResponse.body,
                    requestedModel,
                    includeReasoning,
                );
                return jsonResponse(200, completion);
            } catch (error) {
                if (error instanceof PerchUpstreamError) {
                    return jsonResponse(error.quota ? 429 : 502, {
                        error: {
                            message: error.message,
                            type: error.quota
                                ? "rate_limit_error"
                                : "api_error",
                        },
                    });
                }
                throw error;
            }
        }

        const encoder = new TextEncoder();
        let transformer: ReturnType<typeof createPerchSSEToChatTransformer>;
        const output = new ReadableStream<Uint8Array>({
            start(controller) {
                transformer = createPerchSSEToChatTransformer(
                    requestedModel,
                    {
                        onChunk(chunk) {
                            controller.enqueue(
                                encoder.encode(
                                    `data: ${JSON.stringify(chunk)}\n\n`,
                                ),
                            );
                        },
                        onDone() {
                            controller.enqueue(
                                encoder.encode("data: [DONE]\n\n"),
                            );
                        },
                    },
                    includeReasoning,
                );

                void readPerchSSE(upstreamResponse.body!, (event) =>
                    transformer.processEvent(event),
                )
                    .then(() => {
                        transformer.finish();
                        controller.close();
                    })
                    .catch((error) => controller.error(error));
            },
        });

        return new Response(output, {
            status: 200,
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            },
        });
    }
}

export default PerchProvider;
