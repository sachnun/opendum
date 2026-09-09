import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

export async function fetchKiroQuota(
    account: ProviderAccount,
    credentials?: string,
): Promise<AccountQuotaInfo> {
    if (!credentials) {
        return {
            status: "expired",
            error: "No active Kiro token available.",
            groups: [],
        };
    }

    const queryParams = new URLSearchParams({ origin: "AI_EDITOR" });
    if (account.accountId?.trim()) {
        queryParams.set("profileArn", account.accountId.trim());
    }

    const url = `https://q.us-east-1.amazonaws.com/?${queryParams.toString()}`;
    const body: Record<string, string> = { origin: "AI_EDITOR" };
    if (account.accountId?.trim()) {
        body.profileArn = account.accountId.trim();
    }

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${credentials.trim()}`,
                "Content-Type": "application/x-amz-json-1.0",
                Accept: "application/json",
                "User-Agent": "KiroIDE-0.7.45",
                "x-amz-user-agent": "KiroIDE-0.7.45",
                "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
                "x-amzn-codewhisperer-optout": "true",
                "x-amzn-kiro-agent-mode": "vibe",
                "amz-sdk-request": "attempt=1; max=3",
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            return {
                status: "error",
                error: `Kiro usage limits quota endpoint failed: HTTP ${res.status}`,
                groups: [],
            };
        }

        const payload = (await res.json()) as Record<string, unknown>;
        const record = (
            payload.data && typeof payload.data === "object"
                ? payload.data
                : payload
        ) as Record<string, unknown>;

        const groups = kiroGroups(record);
        if (groups.length === 0) {
            return {
                status: "error",
                error: "Kiro usage limits are unavailable for this account",
                groups: [],
            };
        }

        return { status: "success", groups };
    } catch (err: unknown) {
        return {
            status: "error",
            error:
                err instanceof Error
                    ? err.message
                    : "Failed to fetch Kiro quota",
            groups: [],
        };
    }
}

const KIRO_LABELS: Record<string, string> = {
    AI_EDITOR: "Kiro requests",
    AGENTIC_REQUEST: "Agentic requests",
    CODE_COMPLETIONS: "Code completions",
    TRANSFORM: "Transform",
    CREDIT: "Credits",
    VIBE: "Vibe usage",
    SPEC: "Spec usage",
};

function kiroGroups(record: Record<string, unknown>): QuotaGroupDisplay[] {
    const metrics = [
        ...asArray(record.limits),
        ...asArray(record.usageBreakdownList),
    ];
    const groups: QuotaGroupDisplay[] = [];

    for (const rawMetric of metrics) {
        const metric = asRecord(rawMetric);
        if (!metric) continue;

        const rawName = firstString(
            metric.type,
            metric.resourceType,
            metric.displayName,
        );
        const name = rawName.toUpperCase();
        if (!name) continue;

        const currentUsage = firstNumber(
            metric.currentUsage,
            metric.currentUsageWithPrecision,
        );
        const maxRequests = firstNumber(
            metric.totalUsageLimit,
            metric.usageLimitWithPrecision,
            metric.usageLimit,
        );
        if (currentUsage === null || maxRequests === null || maxRequests <= 0)
            continue;

        const remainingRequests = Math.max(0, maxRequests - currentUsage);
        const resetTimeIso = parseResetTime(
            metric.nextDateReset ?? record.nextDateReset,
        );
        groups.push({
            name: name.toLowerCase(),
            displayName: KIRO_LABELS[name] || titleCase(name),
            remainingFraction: clampFraction(remainingRequests / maxRequests),
            remainingRequests: displayNumber(remainingRequests),
            maxRequests: displayNumber(maxRequests),
            usedRequests: displayNumber(currentUsage),
            resetTimeIso,
            resetInHuman: formatTimeUntil(resetTimeIso),
        });
    }

    return groups;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

function firstNumber(...values: unknown[]): number | null {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string" && value.trim()) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return null;
}

function parseResetTime(value: unknown): string | null {
    let timestamp: number | null = null;
    if (typeof value === "string") {
        timestamp = Date.parse(value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
        timestamp = value > 10_000_000_000 ? value : value * 1000;
    } else {
        const seconds = firstNumber(asRecord(value)?.seconds);
        if (seconds !== null) timestamp = seconds * 1000;
    }

    return timestamp !== null && Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString()
        : null;
}

function titleCase(name: string): string {
    return name
        .toLowerCase()
        .replaceAll("_", " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());
}

function displayNumber(value: number): number {
    return Math.round(value * 100) / 100;
}

function clampFraction(value: number): number {
    return Math.max(0, Math.min(1, value));
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
