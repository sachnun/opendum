import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

const QUOTA_MAX_REQUESTS: Record<string, Record<string, number>> = {
    "standard-tier": {
        "claude-opus-4-6": 150,
        "claude-sonnet-4-6": 150,
        "gemini-3.1-pro-preview": 320,
        "gemini-3.5-flash": 400,
        "gpt-oss-120b": 100,
    },
    "free-tier": {
        "claude-opus-4-6": 50,
        "claude-sonnet-4-6": 50,
        "gemini-3.1-pro-preview": 150,
        "gemini-3.5-flash": 500,
        "gpt-oss-120b": 100,
    },
    "legacy-tier": {
        "claude-opus-4-6": 50,
        "claude-sonnet-4-6": 50,
        "gemini-3.1-pro-preview": 150,
        "gemini-3.5-flash": 500,
        "gpt-oss-120b": 100,
    },
};

const ENDPOINTS = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.googleapis.com",
];

const MODEL_GROUPS = [
    {
        name: "claude",
        displayName: "Claude",
        models: ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-oss-120b"],
    },
    {
        name: "gemini",
        displayName: "Gemini",
        models: [
            "gemini-3.1-pro-preview",
            "gemini-3.5-flash",
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
        ],
    },
];

const API_MODEL_NAMES: Record<string, string> = {
    "claude-opus-4-6": "claude-opus-4-6-thinking",
    "gemini-2.5-flash": "gemini-2.5-flash-thinking",
    "gemini-3.1-pro-preview": "gemini-3.1-pro-high",
    "gemini-3.5-flash": "gemini-3.5-flash-medium",
    "gpt-oss-120b": "gpt-oss-120b-medium",
};

export async function fetchAntigravityQuota(
    account: ProviderAccount,
    credentials?: string,
): Promise<AccountQuotaInfo> {
    if (!credentials?.trim()) {
        return {
            status: "expired",
            error: "No active access token available.",
            groups: [],
        };
    }

    const projectId = account.projectId?.trim();
    if (!projectId) {
        return {
            status: "error",
            error: "Antigravity account is missing projectId. Re-authenticate this account.",
            groups: [],
        };
    }

    let lastError = "no endpoint was available";
    for (const endpoint of ENDPOINTS) {
        try {
            const response = await fetch(
                `${endpoint}/v1internal:fetchAvailableModels`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${credentials.trim()}`,
                        "Content-Type": "application/json",
                        "User-Agent": "antigravity/1.23.2 linux/amd64",
                    },
                    body: JSON.stringify({ project: projectId }),
                },
            );

            if (!response.ok) {
                lastError =
                    `HTTP ${response.status} ${await response.text()}`.trim();
                continue;
            }

            const payload = (await response.json()) as Record<string, unknown>;
            return {
                status: "success",
                groups: antigravityGroups(payload, account.tier || "free-tier"),
            };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }

    return {
        status: "error",
        error: `Failed to fetch Antigravity quota data: ${lastError}`,
        groups: [],
    };
}

function antigravityGroups(
    payload: Record<string, unknown>,
    tier: string,
): QuotaGroupDisplay[] {
    const models = asRecord(payload.models) || {};

    return MODEL_GROUPS.map((group) => {
        let remainingFraction = 1;
        let resetTimeIso: string | null = null;

        for (const model of group.models) {
            const apiModel = API_MODEL_NAMES[model] || model;
            const quotaInfo = asRecord(asRecord(models[apiModel])?.quotaInfo);
            if (!quotaInfo) continue;

            remainingFraction =
                quotaInfo.remainingFraction == null
                    ? 0
                    : clampFraction(toNumber(quotaInfo.remainingFraction) ?? 0);
            resetTimeIso = parseResetTime(quotaInfo.resetTime);
            break;
        }

        const maxRequests = maxRequestsFor(group.models[0]!, tier);
        const remainingRequests = Math.max(
            0,
            Math.floor(remainingFraction * maxRequests),
        );

        return {
            name: group.name,
            displayName: group.displayName,
            remainingFraction,
            remainingRequests,
            maxRequests,
            usedRequests: maxRequests - remainingRequests,
            resetTimeIso,
            resetInHuman: formatTimeUntil(resetTimeIso),
        };
    });
}

function maxRequestsFor(model: string, tier: string): number {
    const normalizedTier = normalizeTier(tier);
    return (
        QUOTA_MAX_REQUESTS[normalizedTier]?.[model] ??
        QUOTA_MAX_REQUESTS["free-tier"]?.[model] ??
        100
    );
}

function normalizeTier(tier: string): string {
    switch (tier.trim().toLowerCase()) {
        case "paid":
        case "standard-tier":
            return "standard-tier";
        case "legacy-tier":
            return "legacy-tier";
        case "free":
        case "free-tier":
            return "free-tier";
        default:
            return tier.trim().toLowerCase();
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function clampFraction(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function parseResetTime(value: unknown): string | null {
    let timestamp: number | null = null;
    if (typeof value === "string") {
        timestamp = Date.parse(value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
        timestamp = value > 10_000_000_000 ? value : value * 1000;
    } else {
        const record = asRecord(value);
        const seconds = toNumber(record?.seconds);
        if (seconds !== null) timestamp = seconds * 1000;
    }

    return timestamp !== null && Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString()
        : null;
}

function formatTimeUntil(resetTimeIso: string | null): string | null {
    if (!resetTimeIso) return null;
    const milliseconds = Date.parse(resetTimeIso) - Date.now();
    if (milliseconds <= 0) return "now";
    const minutes = Math.ceil(milliseconds / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.ceil(minutes / 60);
    return hours < 48 ? `${hours}h` : `${Math.ceil(hours / 24)}d`;
}
