import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

function extractQuotaAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return "";
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    const authClaims = payload["https://api.openai.com/auth"];
    if (authClaims && typeof authClaims === "object") {
      for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
        if (typeof authClaims[key] === "string" && authClaims[key].trim()) {
          return authClaims[key].trim();
        }
      }
    }
    for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
      if (typeof payload[key] === "string" && payload[key].trim()) {
        return payload[key].trim();
      }
    }
    return "";
  } catch {
    return "";
  }
}

function codexWindowDisplayName(windowMinutes: number): string {
  const rounded = Math.round(windowMinutes);
  if (rounded === 300) return "5 hour usage";
  if (rounded > 0 && rounded % 1440 === 0) return `${rounded / 1440}d usage`;
  if (rounded > 0 && rounded % 60 === 0) return `${rounded / 60} hour usage`;
  return `${Math.round(windowMinutes)}m usage`;
}

function parseCodexWindow(
  name: string,
  record: Record<string, unknown> | null | undefined,
  apiNames: boolean
): QuotaGroupDisplay | null {
  if (!record || typeof record !== "object") return null;

  const used = Number(record.used_percent);
  if (isNaN(used)) return null;

  let windowMinutes = Number(record.window_minutes);
  if (!apiNames) {
    windowMinutes = Number(record.limit_window_minutes);
  } else if (!windowMinutes || isNaN(windowMinutes)) {
    const seconds = Number(record.limit_window_seconds);
    windowMinutes = Math.ceil((isNaN(seconds) ? 0 : seconds) / 60);
  }

  const resetAt = Number(record.reset_at);
  const resetTimestamp =
    resetAt > 10_000_000_000 ? resetAt : resetAt > 0 ? resetAt * 1000 : 0;

  const remainingPercent = Math.max(0, 100 - used);
  let displayName = "Usage";
  if (name === "secondary") {
    displayName = "Weekly usage";
  } else if (windowMinutes > 0) {
    displayName = codexWindowDisplayName(windowMinutes);
  }

  return {
    name,
    displayName,
    remainingFraction: remainingPercent / 100,
    remainingRequests: Math.round(remainingPercent),
    maxRequests: 100,
    usedRequests: 100 - Math.round(remainingPercent),
    resetTimeIso: resetTimestamp > 0 ? new Date(resetTimestamp).toISOString() : null,
    resetInHuman: null,
  };
}

export async function fetchCodexQuota(
  account: ProviderAccount,
  credentials?: string
): Promise<AccountQuotaInfo> {
  if (!credentials) {
    return {
      status: "expired",
      error: "No active Codex token available.",
      groups: [],
    };
  }

  const accountId = account.accountId || extractQuotaAccountId(credentials);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.trim()}`,
    Accept: "application/json",
    "User-Agent": "opencode/1.14.28 (linux linux; amd64)",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    originator: "opencode",
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers,
    });

    const headerPrimary = {
      used_percent: res.headers.get("x-codex-primary-used-percent"),
      limit_window_minutes: res.headers.get("x-codex-primary-window-minutes"),
      reset_at: res.headers.get("x-codex-primary-reset-at"),
    };
    const headerSecondary = {
      used_percent: res.headers.get("x-codex-secondary-used-percent"),
      limit_window_minutes: res.headers.get("x-codex-secondary-window-minutes"),
      reset_at: res.headers.get("x-codex-secondary-reset-at"),
    };

    const headerGroups: QuotaGroupDisplay[] = [];
    const pGroup = parseCodexWindow("primary", headerPrimary, false);
    if (pGroup) headerGroups.push(pGroup);
    const sGroup = parseCodexWindow("secondary", headerSecondary, false);
    if (sGroup) headerGroups.push(sGroup);

    if (!res.ok) {
      if (headerGroups.length > 0) {
        return { status: "success", groups: headerGroups };
      }
      return {
        status: "error",
        error: `Codex quota endpoint failed with HTTP ${res.status}`,
        groups: [],
      };
    }

    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const rateLimit = (payload.rate_limit || {}) as Record<string, unknown>;

    const apiGroups: QuotaGroupDisplay[] = [];
    const apiP = parseCodexWindow(
      "primary",
      rateLimit.primary_window as Record<string, unknown>,
      true
    );
    if (apiP) apiGroups.push(apiP);
    const apiS = parseCodexWindow(
      "secondary",
      rateLimit.secondary_window as Record<string, unknown>,
      true
    );
    if (apiS) apiGroups.push(apiS);

    if (apiGroups.length > 0) {
      return { status: "success", groups: apiGroups };
    }
    if (headerGroups.length > 0) {
      return { status: "success", groups: headerGroups };
    }

    return {
      status: "error",
      error: "Codex quota payload did not include usable quota data",
      groups: [],
    };
  } catch (err: unknown) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Failed to fetch Codex quota",
      groups: [],
    };
  }
}
