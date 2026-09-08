import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

export async function fetchKiroQuota(
  account: ProviderAccount,
  credentials?: string
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
    const record = (payload.data && typeof payload.data === "object"
      ? payload.data
      : payload) as Record<string, unknown>;

    const groups: QuotaGroupDisplay[] = [];
    const limits = Array.isArray(record.usageLimits) ? record.usageLimits : [];

    for (const item of limits) {
      if (!item || typeof item !== "object") continue;
      const name = String(item.name || item.resourceType || "standard");
      const maxRequests = Number(item.limit ?? item.max ?? 100);
      const usedRequests = Number(item.currentUsage ?? item.used ?? 0);
      const remainingRequests = Math.max(0, maxRequests - usedRequests);
      const remainingFraction = maxRequests > 0 ? remainingRequests / maxRequests : 0;

      groups.push({
        name,
        displayName: item.description ? String(item.description) : name,
        remainingFraction,
        remainingRequests,
        maxRequests,
        usedRequests,
        resetTimeIso: item.resetTime ? new Date(String(item.resetTime)).toISOString() : null,
        resetInHuman: null,
      });
    }

    if (groups.length === 0) {
      groups.push({
        name: "kiro-requests",
        displayName: "Kiro Usage",
        remainingFraction: 1,
        remainingRequests: 100,
        maxRequests: 100,
        usedRequests: 0,
        resetTimeIso: null,
        resetInHuman: null,
      });
    }

    return {
      status: "success",
      groups,
    };
  } catch (err: unknown) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Failed to fetch Kiro quota",
      groups: [],
    };
  }
}
