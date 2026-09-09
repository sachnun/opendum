import type {
    Provider,
    ProviderRequestOptions,
    RefreshedCredentials,
} from "../base.js";
import type {
    ModelRegistry,
    ProviderModelConfig,
} from "../../registry/registry.js";
import type { ProviderAccount } from "@opendum/database";
import { randomUUID } from "node:crypto";
import { ANTIGRAVITY_USER_AGENT } from "./version.js";
import {
    GOOGLE_OAUTH_TOKEN_ENDPOINT,
    ANTIGRAVITY_CLAUDE_BETA_HEADER,
} from "./constants.js";
import {
    buildToolSchemaMap,
    stableNumericSessionId,
    transformAntigravityRequest,
} from "./transform/index.js";
import {
    geminiSSEToOpenAICompletion,
    geminiToOpenAICompletion,
    transformGeminiSSE,
} from "./transform/response.js";
import type { ModelFamily } from "./transform/types.js";

const ANTIGRAVITY_ENDPOINTS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://autopush-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
];
const LOAD_ENDPOINTS = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.googleapis.com",
];
const ONBOARD_ENDPOINTS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
];
const DEFAULT_PROJECT = "rising-fact-p41fc";
const DEFAULT_CLIENT_ID =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
// This is an installed-application OAuth credential already distributed in the
// original Antigravity client; environment variables still take precedence.
const DEFAULT_CLIENT_SECRET = "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";
const CLIENT_METADATA = JSON.stringify({
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
});
const API_CLIENT = "google-cloud-sdk vscode_cloudshelleditor/0.1";

type JsonObject = Record<string, any>;

interface AccountInfo {
    projectId?: string;
    tier: string;
    email?: string;
}

function object(value: unknown): JsonObject | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;
}

function array(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function metadata(): JsonObject {
    return {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
    };
}

function generationHeaders(
    accessToken: string,
    stream: boolean,
): Record<string, string> {
    return {
        Authorization: `Bearer ${accessToken.trim()}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        "User-Agent": `${ANTIGRAVITY_USER_AGENT}${process.platform}/${process.arch}`,
        "X-Goog-Api-Client": API_CLIENT,
        "Client-Metadata": CLIENT_METADATA,
    };
}

function extractProjectId(data: JsonObject): string {
    return (
        text(data.cloudaicompanionProject) ||
        text(object(data.cloudaicompanionProject)?.id)
    );
}

function extractTier(data: JsonObject): string {
    const tier = data.currentTier;
    return (text(tier) || text(object(tier)?.id) || text(object(tier)?.name))
        .trim()
        .toLowerCase();
}

function providerConfig(
    registry: ModelRegistry,
    model: string,
): ProviderModelConfig {
    const canonical = registry.resolveAlias(model);
    const internal = registry as unknown as {
        effective?: Record<
            string,
            { providerConfig?: Record<string, ProviderModelConfig> }
        >;
    };
    return internal.effective?.[canonical]?.providerConfig?.antigravity ?? {};
}

function modelFamily(model: string, config: ProviderModelConfig): ModelFamily {
    const family = text(config.signature_family);
    if (
        family === "claude" ||
        family === "gemini-flash" ||
        family === "gemini-pro"
    )
        return family;
    return model.toLowerCase().includes("claude")
        ? "claude"
        : model.toLowerCase().includes("flash")
          ? "gemini-flash"
          : "gemini-pro";
}

function normalizeGemini3Level(model: string, level: string): string {
    const normalized = level.trim().toLowerCase();
    if (normalized === "xhigh") return "high";
    if (normalized === "minimal")
        return model.toLowerCase().includes("pro") ? "low" : "minimal";
    if (
        normalized === "medium" &&
        model.toLowerCase().includes("pro") &&
        !model.toLowerCase().includes("gemini-3.1-pro")
    )
        return "high";
    return ["low", "medium", "high"].includes(normalized) ? normalized : "";
}

function requestedThinkingLevel(
    model: string,
    body: JsonObject,
    config: ProviderModelConfig,
): string {
    const thinking = object(body.thinking);
    let level = text(thinking?.thinkingLevel);
    const budget =
        typeof thinking?.budget_tokens === "number"
            ? thinking.budget_tokens
            : typeof body.thinking_budget === "number"
              ? body.thinking_budget
              : 0;
    const effort =
        text(body.reasoning_effort) || text(object(body.reasoning)?.effort);
    const levels = object(config.thinking_levels) ?? {};
    const budgets = object(config.thinking_budgets) ?? {};
    if (!level && budget > 0) {
        const selected =
            typeof budgets.low === "number" && budget <= budgets.low
                ? "low"
                : typeof budgets.medium === "number" && budget <= budgets.medium
                  ? "medium"
                  : budget <= 8192
                    ? "low"
                    : budget <= 16384
                      ? "medium"
                      : "high";
        level = text(levels[selected]) || selected;
    }
    if (!level && effort) level = text(levels[effort]) || effort;
    return normalizeGemini3Level(model, level);
}

function resolveModel(
    registry: ModelRegistry,
    body: JsonObject,
): { requested: string; upstream: string; config: ProviderModelConfig } {
    const requested = text(body.model)
        .split("/")
        .pop()!
        .replace(/:thinking$/, "");
    const config = providerConfig(registry, requested);
    let upstream = registry.upstreamModelName(requested, "antigravity");
    if (
        upstream.toLowerCase().startsWith("gemini-3") &&
        (upstream.toLowerCase().includes("pro") ||
            (upstream.toLowerCase().startsWith("gemini-3.5-flash") &&
                !upstream.toLowerCase().includes("lite")))
    ) {
        const base = upstream.replace(/-(minimal|low|medium|high)$/i, "");
        const embedded =
            /-(minimal|low|medium|high)$/i.exec(upstream)?.[1]?.toLowerCase() ??
            "";
        upstream = `${base}-${requestedThinkingLevel(upstream, body, config) || embedded || (upstream.toLowerCase().includes("pro") ? "high" : "medium")}`;
    }
    return { requested, upstream, config };
}

function projectContextError(value: string): boolean {
    const lower = value.toLowerCase();
    return (
        lower.includes("#3501") ||
        (lower.includes("google cloud project") &&
            lower.includes("code assist license")) ||
        lower.includes("invalid project resource name projects/") ||
        (lower.includes("resource projects/") &&
            lower.includes("could not be found")) ||
        (lower.includes("project") && lower.includes("not found"))
    );
}

async function externalImagesToData(
    body: JsonObject,
    signal?: AbortSignal,
): Promise<JsonObject> {
    const copy = structuredClone(body);
    for (const rawMessage of array(copy.messages)) {
        const message = object(rawMessage);
        if (!message || !Array.isArray(message.content)) continue;
        for (const rawPart of message.content) {
            const part = object(rawPart);
            const image = object(part?.image_url);
            const url = text(image?.url);
            if (!image || !/^https?:\/\//i.test(url)) continue;
            try {
                const response = await fetch(url, { signal });
                if (!response.ok) continue;
                const mime =
                    response.headers.get("content-type")?.split(";")[0] ||
                    "image/jpeg";
                const data = Buffer.from(await response.arrayBuffer()).toString(
                    "base64",
                );
                image.url = `data:${mime};base64,${data}`;
            } catch (error) {
                if (signal?.aborted) throw error;
            }
        }
    }
    return copy;
}

export class AntigravityProvider implements Provider {
    public name = "antigravity";

    constructor(private registry: ModelRegistry) {}

    getRefreshBuffer(): number {
        return 3600;
    }

    async refreshCredentials(
        refreshToken: string,
        _account: ProviderAccount,
    ): Promise<RefreshedCredentials> {
        const form = new URLSearchParams({
            client_id:
                process.env.GOOGLE_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID,
            client_secret:
                process.env.GOOGLE_CLIENT_SECRET?.trim() ||
                DEFAULT_CLIENT_SECRET,
            refresh_token: refreshToken.trim(),
            grant_type: "refresh_token",
        });
        const response = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            body: form.toString(),
        });
        if (!response.ok)
            throw new Error(
                `antigravity token refresh failed: ${response.status} ${await response.text()}`,
            );
        const token = object(await response.json()) ?? {};
        const accessToken = text(token.access_token);
        if (!accessToken)
            throw new Error(
                "antigravity token refresh returned empty access token",
            );
        const info = await this.fetchAccountInfo(accessToken);
        return {
            accessToken,
            refreshToken: text(token.refresh_token) || refreshToken,
            expiresAt: new Date(
                Date.now() +
                    (typeof token.expires_in === "number" &&
                    token.expires_in > 0
                        ? token.expires_in
                        : 3600) *
                        1000,
            ),
            projectId: info.projectId,
            tier: info.tier,
            email: info.email,
        };
    }

    async makeRequest(options: ProviderRequestOptions): Promise<Response> {
        const { account, credentials = "", stream, signal } = options;
        const initialBody = options.body as JsonObject;
        const { upstream, config } = resolveModel(this.registry, initialBody);
        const body =
            upstream.toLowerCase().includes("claude") &&
            config.convert_external_images === true
                ? await externalImagesToData(initialBody, signal)
                : { ...initialBody };
        delete body.logit_bias;
        if (
            config.top_p_min_095 === true &&
            typeof body.top_p === "number" &&
            body.top_p < 0.95
        )
            delete body.top_p;
        const projectId = text(account.projectId).trim() || DEFAULT_PROJECT;
        if (!projectId)
            throw new Error("antigravity account missing projectId");
        const sessionId = stableNumericSessionId(body);
        const gemini = transformAntigravityRequest(body, upstream, sessionId, {
            config,
        });
        const schemas = buildToolSchemaMap(gemini);
        const envelope = {
            project: projectId,
            model: upstream,
            userAgent: "antigravity",
            requestType: "agent",
            requestId: `agent-${randomUUID()}`,
            request: gemini,
        };
        const actualStream =
            stream ||
            !upstream.toLowerCase().includes("gemini") ||
            config.force_stream_non_stream === true;
        const action = actualStream
            ? "streamGenerateContent?alt=sse"
            : "generateContent";
        const headers = generationHeaders(credentials, actualStream);
        if (
            config.anthropic_beta === true ||
            (upstream.toLowerCase().includes("claude") &&
                upstream.toLowerCase().includes("thinking"))
        ) {
            headers["anthropic-beta"] = ANTIGRAVITY_CLAUDE_BETA_HEADER;
        }

        let lastResponse: Response | undefined;
        let lastError: unknown;
        for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
            try {
                const response = await fetch(
                    `${endpoint}/v1internal:${action}`,
                    {
                        method: "POST",
                        headers,
                        body: JSON.stringify(envelope),
                        signal,
                    },
                );
                if (response.status === 429) return response;
                if (
                    [401, 403, 404].includes(response.status) ||
                    response.status >= 500
                ) {
                    const responseBody = await response.text();
                    lastResponse = new Response(responseBody, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                    if (projectContextError(responseBody)) return lastResponse;
                    continue;
                }
                if (!response.ok) return response;
                lastResponse = response;
                lastError = undefined;
                break;
            } catch (error) {
                if (signal?.aborted) throw error;
                lastError = error;
            }
        }
        if (!lastResponse || !lastResponse.ok) {
            if (lastError && !lastResponse) throw lastError;
            return (
                lastResponse ??
                new Response("Antigravity endpoints unavailable", {
                    status: 502,
                })
            );
        }
        const family = modelFamily(upstream, config);
        if (stream)
            return transformGeminiSSE(
                lastResponse,
                upstream,
                schemas,
                family,
                sessionId,
            );
        if (actualStream)
            return geminiSSEToOpenAICompletion(
                lastResponse,
                upstream,
                schemas,
                family,
                sessionId,
            );
        const value: unknown = await lastResponse.json();
        return Response.json(
            geminiToOpenAICompletion(
                value,
                upstream,
                schemas,
                family,
                sessionId,
            ),
        );
    }

    private async fetchAccountInfo(accessToken: string): Promise<AccountInfo> {
        const info: AccountInfo = { tier: "free-tier" };
        let currentTierPresent = false;
        let allowedTiers: JsonObject[] = [];
        let hadError = false;
        for (const endpoint of LOAD_ENDPOINTS) {
            try {
                const response = await fetch(
                    `${endpoint}/v1internal:loadCodeAssist`,
                    {
                        method: "POST",
                        headers: generationHeaders(accessToken, false),
                        body: JSON.stringify({ metadata: metadata() }),
                    },
                );
                if (!response.ok) {
                    hadError = true;
                    continue;
                }
                const data = object(await response.json()) ?? {};
                info.projectId ||= extractProjectId(data) || undefined;
                currentTierPresent ||= data.currentTier !== undefined;
                info.tier =
                    extractTier(data) || this.detectTier(data) || info.tier;
                const tiers = array(data.allowedTiers)
                    .map(object)
                    .filter((tier): tier is JsonObject => !!tier);
                if (tiers.length) allowedTiers = tiers;
                if (info.projectId) break;
            } catch {
                hadError = true;
            }
        }
        if (!info.projectId && !currentTierPresent && allowedTiers.length) {
            const onboarded = await this.onboard(
                accessToken,
                info.tier,
                allowedTiers,
            );
            if (onboarded.projectId) Object.assign(info, onboarded);
        }
        if (!info.projectId && hadError) info.projectId = DEFAULT_PROJECT;
        try {
            const response = await fetch(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                { headers: generationHeaders(accessToken, false) },
            );
            if (response.ok)
                info.email =
                    text(object(await response.json())?.email) || undefined;
        } catch {
            /* Account metadata is best effort. */
        }
        return info;
    }

    private detectTier(data: JsonObject): string {
        const paid = text(object(data.paidTier)?.id).toLowerCase();
        if (paid === "paid" || paid === "standard-tier") return paid;
        const fallback = array(data.allowedTiers)
            .map(object)
            .find((tier) => tier?.isDefault === true);
        return text(fallback?.id).toLowerCase();
    }

    private async onboard(
        accessToken: string,
        fallbackTier: string,
        tiers: JsonObject[],
    ): Promise<AccountInfo> {
        const tierId =
            text(tiers.find((tier) => tier.isDefault === true)?.id) ||
            text(tiers.find((tier) => tier.id === "legacy-tier")?.id) ||
            text(tiers[0]?.id) ||
            fallbackTier;
        if (!tierId) return { tier: fallbackTier };
        const body = JSON.stringify({ tierId, metadata: metadata() });
        for (const endpoint of ONBOARD_ENDPOINTS) {
            let data = await this.postOnboard(endpoint, accessToken, body);
            if (!data) continue;
            for (
                let attempt = 0;
                attempt < 30 && data.done === false;
                attempt++
            ) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                data =
                    (await this.postOnboard(endpoint, accessToken, body)) ??
                    data;
            }
            if (data.done === false) continue;
            data = object(data.response) ?? data;
            const projectId = extractProjectId(data);
            if (projectId) return { projectId, tier: tierId.toLowerCase() };
        }
        return { tier: fallbackTier };
    }

    private async postOnboard(
        endpoint: string,
        accessToken: string,
        body: string,
    ): Promise<JsonObject | undefined> {
        try {
            const response = await fetch(`${endpoint}/v1internal:onboardUser`, {
                method: "POST",
                headers: generationHeaders(accessToken, false),
                body,
            });
            return response.ok ? object(await response.json()) : undefined;
        } catch {
            return undefined;
        }
    }
}

export default AntigravityProvider;
