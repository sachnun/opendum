import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

interface UpstreamResult {
    data: Record<string, unknown> | null;
    error: string | null;
    expired: boolean;
}

export async function fetchOpenRouterQuota(
    _account: ProviderAccount,
    credentials?: string,
): Promise<AccountQuotaInfo> {
    if (!credentials?.trim()) {
        return {
            status: "expired",
            error: "No active OpenRouter API key available.",
            groups: [],
        };
    }

    const headers = {
        Authorization: `Bearer ${credentials.trim()}`,
        Accept: "application/json",
    };
    const [keyResult, creditsResult] = await Promise.all([
        fetchData("/key", headers),
        fetchData("/credits", headers),
    ]);

    if (!keyResult.data && !creditsResult.data) {
        const expired = keyResult.expired || creditsResult.expired;
        return {
            status: expired ? "expired" : "error",
            error: expired
                ? "OpenRouter API key is invalid or expired. Reconnect this account."
                : keyResult.error ||
                  creditsResult.error ||
                  "Failed to fetch OpenRouter quota",
            groups: [],
        };
    }

    const groups = openRouterGroups(
        keyResult.data || {},
        creditsResult.data || {},
    );
    return { status: "success", groups };
}

async function fetchData(
    path: string,
    headers: Record<string, string>,
): Promise<UpstreamResult> {
    try {
        const response = await fetch(`https://openrouter.ai/api/v1${path}`, {
            headers,
        });
        if (!response.ok) {
            return {
                data: null,
                error: `OpenRouter${path} request failed: HTTP ${response.status} ${await response.text()}`.trim(),
                expired: response.status === 401 || response.status === 403,
            };
        }

        const payload = (await response.json()) as Record<string, unknown>;
        const data = asRecord(payload.data);
        return data
            ? { data, error: null, expired: false }
            : {
                  data: null,
                  error: `OpenRouter${path} response did not include a data object`,
                  expired: false,
              };
    } catch (error) {
        return {
            data: null,
            error:
                error instanceof Error
                    ? error.message
                    : `OpenRouter${path} request failed`,
            expired: false,
        };
    }
}

function openRouterGroups(
    keyData: Record<string, unknown>,
    creditsData: Record<string, unknown>,
): QuotaGroupDisplay[] {
    const groups: QuotaGroupDisplay[] = [];
    const totalCredits = toNumber(creditsData.total_credits);
    const totalUsage = toNumber(creditsData.total_usage);
    if (totalCredits !== null && totalUsage !== null && totalCredits > 0) {
        const remaining = Math.max(0, totalCredits - totalUsage);
        groups.push(
            group(
                "account-credits",
                "Account credits",
                remaining,
                totalCredits,
            ),
        );
    }

    const limit = toNumber(keyData.limit);
    const limitRemaining = toNumber(keyData.limit_remaining);
    const usage = toNumber(keyData.usage);
    if (
        limit !== null &&
        limitRemaining !== null &&
        usage !== null &&
        limit > 0
    ) {
        groups.push(group("key-limit", "API key limit", limitRemaining, limit));
    }

    if (groups.length > 0) return groups;

    const dailyUsage = toNumber(keyData.usage_daily);
    if (dailyUsage !== null) {
        return [
            {
                name: "daily-usage",
                displayName: "Today usage",
                remainingFraction: 1,
                remainingRequests: 1,
                maxRequests: 1,
                usedRequests: 0,
                resetTimeIso: null,
                resetInHuman: "resets daily",
            },
        ];
    }

    return [
        {
            name: "key-status",
            displayName: "OpenRouter key",
            remainingFraction: 1,
            remainingRequests: 1,
            maxRequests: 1,
            usedRequests: 0,
            resetTimeIso: null,
            resetInHuman: null,
        },
    ];
}

function group(
    name: string,
    displayName: string,
    rawRemaining: number,
    maxRequests: number,
): QuotaGroupDisplay {
    const remaining = Math.max(0, rawRemaining);
    return {
        name,
        displayName,
        remainingFraction: clampFraction(remaining / maxRequests),
        remainingRequests: displayNumber(remaining),
        maxRequests: displayNumber(maxRequests),
        usedRequests: displayNumber(Math.max(0, maxRequests - remaining)),
        resetTimeIso: null,
        resetInHuman: null,
    };
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function displayNumber(value: number): number {
    return Math.round(value * 100) / 100;
}

function clampFraction(value: number): number {
    return Math.max(0, Math.min(1, value));
}
