import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

const PERCH_ACCOUNT_URL = "https://app.perchai.app/api/perchai/account";
const MONTHLY_PT_FALLBACK = 20_000;
const PT_PER_USD = 1_000;

type Numeric = number | string | null | undefined;

interface PerchEntitlement {
    key?: string;
    value_json?: { limit?: Numeric };
}

interface PerchRollingWindow {
    enabled?: boolean;
    window5hUsd?: Numeric;
    window5hCapUsd?: Numeric;
    window5hNextFreedAt?: unknown;
    window7dUsd?: Numeric;
    window7dCapUsd?: Numeric;
    window7dNextFreedAt?: unknown;
}

interface PerchAccountResponse {
    ok?: boolean;
    session?: {
        tierSelectionRequired?: boolean;
        entitlements?: PerchEntitlement[];
    };
    usageMeter?: {
        monthlyPt?: Numeric;
        monthlyUsd?: Numeric;
        roostRolling?: PerchRollingWindow;
    };
    creditBalancePt?: Numeric;
}

export async function fetchPerchQuota(
    _account: ProviderAccount,
    credentials?: string,
): Promise<AccountQuotaInfo> {
    if (!credentials?.trim()) {
        return {
            status: "expired",
            error: "No active Perch token available.",
            groups: [],
        };
    }

    try {
        const response = await fetch(PERCH_ACCOUNT_URL, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${credentials.trim()}`,
                Accept: "application/json",
            },
        });

        if (response.status === 401 || response.status === 403) {
            return {
                status: "expired",
                error: "Perch session is invalid or expired. Re-authenticate this account.",
                groups: [],
            };
        }
        if (!response.ok) {
            return {
                status: "error",
                error: `Perch account quota endpoint failed: HTTP ${response.status} ${await response.text()}`.trim(),
                groups: [],
            };
        }

        const payload = (await response.json()) as PerchAccountResponse;
        if (!payload.ok) {
            return {
                status: "error",
                error: "Perch account request was rejected. Re-authenticate this account.",
                groups: [],
            };
        }
        if (payload.session?.tierSelectionRequired) {
            return {
                status: "expired",
                error: "Perch account has no active plan yet. Re-authenticate to select the Starter plan.",
                groups: [],
            };
        }

        const groups = perchGroups(payload);
        if (groups.length === 0) {
            return {
                status: "error",
                error: "Perch account has no usage or allowance data",
                groups: [],
            };
        }
        return { status: "success", groups };
    } catch (error) {
        return {
            status: "error",
            error:
                error instanceof Error
                    ? error.message
                    : "Failed to fetch Perch quota",
            groups: [],
        };
    }
}

function perchGroups(payload: PerchAccountResponse): QuotaGroupDisplay[] {
    const groups: QuotaGroupDisplay[] = [];
    const meter = payload.usageMeter || {};
    const limit = monthlyPtLimit(payload);
    const monthlyPt = toNumber(meter.monthlyPt);
    const monthlyUsd = toNumber(meter.monthlyUsd);
    const monthlyUsed = Math.max(
        0,
        monthlyPt ?? (monthlyUsd ?? 0) * PT_PER_USD,
    );
    const used = Math.min(monthlyUsed, limit);
    const remaining = Math.max(0, limit - used);

    groups.push({
        name: "monthly-allowance",
        displayName: "Monthly allowance",
        remainingFraction: clampFraction(remaining / limit),
        remainingRequests: displayNumber(remaining),
        maxRequests: displayNumber(limit),
        usedRequests: displayNumber(used),
        resetTimeIso: null,
        resetInHuman: null,
    });

    const rolling = meter.roostRolling;
    if (rolling?.enabled) {
        const sevenDayCap = toNumber(rolling.window7dCapUsd);
        if (sevenDayCap !== null && sevenDayCap > 0) {
            groups.push(
                windowGroup(
                    "fair-use-7d",
                    "7-day fair use",
                    rolling.window7dUsd,
                    sevenDayCap,
                    rolling.window7dNextFreedAt,
                ),
            );
        }

        const fiveHourCap = toNumber(rolling.window5hCapUsd);
        if (fiveHourCap !== null && fiveHourCap > 0) {
            groups.push(
                windowGroup(
                    "fair-use-5h",
                    "5-hour fair use",
                    rolling.window5hUsd,
                    fiveHourCap,
                    rolling.window5hNextFreedAt,
                ),
            );
        }
    }

    const credits = toNumber(payload.creditBalancePt);
    if (credits !== null && credits > 0) {
        const balance = Math.floor(credits);
        groups.push({
            name: "credits",
            displayName: "Credits",
            remainingFraction: 1,
            remainingRequests: displayNumber(balance),
            maxRequests: displayNumber(balance),
            usedRequests: 0,
            resetTimeIso: null,
            resetInHuman: null,
        });
    }

    return groups;
}

function monthlyPtLimit(payload: PerchAccountResponse): number {
    for (const entitlement of payload.session?.entitlements || []) {
        const limit = toNumber(entitlement.value_json?.limit);
        if (
            entitlement.key === "usage.monthly_pt" &&
            limit !== null &&
            limit > 0
        ) {
            return limit;
        }
    }
    return MONTHLY_PT_FALLBACK;
}

function windowGroup(
    name: string,
    displayName: string,
    rawUsed: Numeric,
    cap: number,
    rawReset: unknown,
): QuotaGroupDisplay {
    const used = Math.max(0, toNumber(rawUsed) ?? 0);
    const remaining = Math.max(0, cap - used);
    const resetTimeIso = parseResetTime(rawReset);
    return {
        name,
        displayName,
        remainingFraction: clampFraction(remaining / cap),
        remainingRequests: displayNumber(remaining),
        maxRequests: displayNumber(cap),
        usedRequests: displayNumber(used),
        resetTimeIso,
        resetInHuman: formatTimeUntil(resetTimeIso),
    };
}

function toNumber(value: Numeric): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
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

function parseResetTime(value: unknown): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const timestamp = Date.parse(value.trim());
    return Number.isFinite(timestamp)
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
