import type {
    Provider,
    ProviderRequestOptions,
    RefreshedCredentials,
} from "../base.js";
import type { ModelRegistry } from "../../registry/registry.js";
import type { ProviderAccount } from "@opendum/database";
import {
    QODER_ACCESS_TTL_MS,
    QODER_AGENT_ID,
    QODER_DEFAULT_MAX_TOKENS,
    QODER_DEFAULT_MODEL,
    QODER_DEVICE_REFRESH_PATH,
    QODER_IDE_VERSION,
    QODER_INFERENCE_BASE,
    QODER_INFERENCE_PATH,
    QODER_INFERENCE_QUERY,
    QODER_JOB_REFRESH_PATH,
    QODER_OPENAPI_BASE,
    QODER_PAT_REFRESH_PREFIX,
    QODER_REFRESH_BUFFER_SECONDS,
    QODER_SESSION_TYPE,
    QODER_TASK_ID,
    QODER_USER_INFO_PATH,
} from "./constants.js";
import {
    buildQoderAuthHeaders,
    encodeQoderBody,
    qoderMaxTokens,
    qoderSseToChatCompletion,
    splitQoderAccountId,
    transformQoderMessages,
    transformQoderSse,
} from "./protocol.js";

interface QoderRefreshResponse {
    device_token?: string;
    token?: string;
    refresh_token?: string;
    expires_in?: number | string;
    expires_at?: string;
}

export class QoderProvider implements Provider {
    public name = "qoder";

    constructor(private registry: ModelRegistry) {}

    getRefreshBuffer(): number {
        return QODER_REFRESH_BUFFER_SECONDS;
    }

    async refreshCredentials(
        refreshToken: string,
        _account: ProviderAccount,
    ): Promise<RefreshedCredentials> {
        const token = refreshToken.trim();
        const refreshPath = token.startsWith(QODER_PAT_REFRESH_PREFIX)
            ? QODER_JOB_REFRESH_PATH
            : QODER_DEVICE_REFRESH_PATH;
        const response = await fetch(`${QODER_OPENAPI_BASE}${refreshPath}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({ refresh_token: token }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `qoder token refresh failed: ${response.status} ${text}`,
            );
        }

        const data = (await response.json()) as QoderRefreshResponse;
        const accessToken = data.device_token || data.token;
        if (!accessToken)
            throw new Error("qoder token refresh returned empty token");

        return {
            accessToken,
            refreshToken: data.refresh_token || token,
            expiresAt: parseQoderExpiry(data.expires_at, data.expires_in),
        };
    }

    async makeRequest(options: ProviderRequestOptions): Promise<Response> {
        const { account, credentials, body, stream, signal } = options;
        const accessToken = credentials?.trim() ?? "";
        if (!accessToken) throw new Error("qoder access token is empty");

        let { uid, machineId } = splitQoderAccountId(account.accountId);
        if (!uid) uid = await fetchQoderUserId(accessToken, signal);
        if (!machineId) machineId = uid;

        const requestedModel = lastModelSegment(String(body.model ?? ""));
        const model = this.registry.upstreamModelName(
            requestedModel || QODER_DEFAULT_MODEL,
            "qoder",
        );
        const modelInfo = requestedModel
            ? this.registry.getModel(requestedModel)
            : undefined;
        const isReasoning = Boolean(
            modelInfo && modelInfo.meta?.reasoning !== false,
        );
        const transformed = transformQoderMessages(body.messages);
        const lastUserText = transformed.lastUserText || "ping";
        const maxTokens = qoderMaxTokens(body);
        const recordId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();

        const modelConfig = {
            key: model,
            is_reasoning: isReasoning,
            max_output_tokens: QODER_DEFAULT_MAX_TOKENS,
            source: "system",
        };
        const requestBody = {
            request_id: crypto.randomUUID(),
            request_set_id: recordId,
            chat_record_id: recordId,
            session_id: sessionId,
            stream: true,
            chat_task: "FREE_INPUT",
            is_reply: true,
            is_retry: false,
            source: 1,
            version: "3",
            session_type: QODER_SESSION_TYPE,
            agent_id: QODER_AGENT_ID,
            task_id: QODER_TASK_ID,
            code_language: "",
            chat_prompt: "",
            image_urls: null,
            aliyun_user_type: "",
            system: transformed.system,
            messages: transformed.messages,
            tools: Array.isArray(body.tools) ? body.tools : [],
            parameters: { max_tokens: maxTokens },
            chat_context: {
                chatPrompt: "",
                imageUrls: null,
                extra: {
                    context: [],
                    modelConfig: { key: model, is_reasoning: isReasoning },
                    originalContent: lastUserText,
                },
                features: [],
                text: lastUserText,
            },
            model_config: modelConfig,
            business: {
                product: "cli",
                version: QODER_IDE_VERSION,
                type: "agent",
                stage: "start",
                id: crypto.randomUUID(),
                name: truncateCodePoints(lastUserText, 30),
                begin_at: Date.now(),
            },
        };

        const encodedBody = encodeQoderBody(JSON.stringify(requestBody));
        const requestUrl =
            QODER_INFERENCE_BASE + QODER_INFERENCE_PATH + QODER_INFERENCE_QUERY;
        const response = await fetch(requestUrl, {
            method: "POST",
            headers: buildQoderAuthHeaders(
                encodedBody,
                requestUrl,
                uid,
                machineId,
                accessToken,
            ),
            body: encodedBody,
            signal,
        });

        if (!response.ok || !response.body) return response;

        if (stream) {
            const headers = transformedResponseHeaders(
                response.headers,
                "text/event-stream",
            );
            return new Response(transformQoderSse(response.body), {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }

        const completion = await qoderSseToChatCompletion(response.body, model);
        const headers = transformedResponseHeaders(
            response.headers,
            "application/json",
        );
        return new Response(JSON.stringify(completion), {
            status: 200,
            headers,
        });
    }
}

async function fetchQoderUserId(
    accessToken: string,
    signal?: AbortSignal,
): Promise<string> {
    const response = await fetch(
        `${QODER_OPENAPI_BASE}${QODER_USER_INFO_PATH}`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
            },
            signal,
        },
    );
    if (!response.ok) {
        throw new Error(`qoder userinfo failed: ${response.status}`);
    }
    const data = (await response.json()) as { id?: unknown };
    const uid = typeof data.id === "string" ? data.id.trim() : "";
    if (!uid) throw new Error("qoder userinfo returned empty id");
    return uid;
}

function parseQoderExpiry(
    expiresAt: string | undefined,
    expiresIn: number | string | undefined,
): Date {
    if (expiresAt) {
        const parsed = new Date(expiresAt);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    const seconds = Number(expiresIn);
    return new Date(
        Date.now() +
            (Number.isFinite(seconds) && seconds > 0
                ? seconds * 1000
                : QODER_ACCESS_TTL_MS),
    );
}

function lastModelSegment(model: string): string {
    const normalized = model.trim();
    const separator = normalized.lastIndexOf("/");
    return separator < 0 ? normalized : normalized.slice(separator + 1);
}

function truncateCodePoints(value: string, limit: number): string {
    return [...value].slice(0, limit).join("");
}

function transformedResponseHeaders(
    upstream: Headers,
    contentType: string,
): Headers {
    const headers = new Headers(upstream);
    headers.set("Content-Type", contentType);
    headers.delete("Content-Length");
    headers.delete("Content-Encoding");
    return headers;
}

export default QoderProvider;
