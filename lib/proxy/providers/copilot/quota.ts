const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const COPILOT_QUOTA_USER_AGENT = "opendum/copilot-quota";

interface CopilotUsageEntry {
  model: string;
  requests: number;
}

interface CopilotUsageSnapshotSuccess {
  status: "success";
  username: string;
  year: number;
  month: number;
  totalRequests: number;
  modelUsage: CopilotUsageEntry[];
  resetTimeIso: string;
  fetchedAt: number;
}

interface CopilotUsageSnapshotError {
  status: "error";
  error: string;
  username: string | null;
  year: number;
  month: number;
  totalRequests: 0;
  modelUsage: [];
  resetTimeIso: string | null;
  fetchedAt: number;
}

export type CopilotUsageSnapshot =
  | CopilotUsageSnapshotSuccess
  | CopilotUsageSnapshotError;

interface FetchCopilotUsageOptions {
  year?: number;
  month?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function getCurrentUtcPeriod(): { year: number; month: number } {
  const now = new Date();
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
  };
}

function getNextResetIso(year: number, month: number): string {
  const nextReset = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return nextReset.toISOString();
}

function parseUsageItems(payload: unknown): CopilotUsageEntry[] {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  const usageItemsRaw =
    (Array.isArray(record.usageItems) ? record.usageItems : null) ??
    (Array.isArray(record.usage_items) ? record.usage_items : null) ??
    [];

  const byModel = new Map<string, number>();

  for (const rawItem of usageItemsRaw) {
    const item = asRecord(rawItem);
    if (!item) {
      continue;
    }

    const quantity =
      toFiniteNumber(item.grossQuantity) ??
      toFiniteNumber(item.netQuantity) ??
      toFiniteNumber(item.quantity) ??
      0;

    if (quantity <= 0) {
      continue;
    }

    const model =
      typeof item.model === "string" && item.model.trim().length > 0
        ? item.model.trim()
        : "Unknown";

    byModel.set(model, (byModel.get(model) ?? 0) + quantity);
  }

  return [...byModel.entries()]
    .map(([model, requests]) => ({ model, requests }))
    .sort((a, b) => b.requests - a.requests);
}

async function fetchGithubUsername(
  accessToken: string
): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": COPILOT_QUOTA_USER_AGENT,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        error: `Failed to fetch GitHub user: HTTP ${response.status}${
          body ? ` ${body.slice(0, 200)}` : ""
        }`,
      };
    }

    const payload = (await response.json()) as { login?: unknown };
    const login = typeof payload.login === "string" ? payload.login.trim() : "";

    if (!login) {
      return { ok: false, error: "GitHub username not found in /user response" };
    }

    return { ok: true, username: login };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown error while fetching GitHub user",
    };
  }
}

export async function fetchCopilotUsageFromApi(
  accessToken: string,
  options: FetchCopilotUsageOptions = {}
): Promise<CopilotUsageSnapshot> {
  const period = getCurrentUtcPeriod();
  const year = options.year ?? period.year;
  const month = options.month ?? period.month;
  const fetchedAt = Date.now();

  const userResult = await fetchGithubUsername(accessToken);
  if (!userResult.ok) {
    return {
      status: "error",
      error: userResult.error,
      username: null,
      year,
      month,
      totalRequests: 0,
      modelUsage: [],
      resetTimeIso: null,
      fetchedAt,
    };
  }

  const username = userResult.username;
  const query = new URLSearchParams({
    year: String(year),
    month: String(month),
  });

  try {
    const response = await fetch(
      `${GITHUB_API_BASE_URL}/users/${encodeURIComponent(
        username
      )}/settings/billing/premium_request/usage?${query.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": COPILOT_QUOTA_USER_AGENT,
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const body = await response.text();

      let error = `Copilot usage fetch failed: HTTP ${response.status}`;
      if (response.status === 403) {
        error =
          "Copilot usage endpoint denied access (403). Reconnect Copilot with broader GitHub user permissions.";
      } else if (response.status === 404) {
        error =
          "Copilot usage endpoint returned 404. Personal premium-request usage may be unavailable for this account.";
      }

      if (body) {
        error = `${error} ${body.slice(0, 220)}`;
      }

      return {
        status: "error",
        error,
        username,
        year,
        month,
        totalRequests: 0,
        modelUsage: [],
        resetTimeIso: null,
        fetchedAt,
      };
    }

    const payload = await response.json();
    const modelUsage = parseUsageItems(payload);
    const totalRequests = modelUsage.reduce((sum, item) => sum + item.requests, 0);

    return {
      status: "success",
      username,
      year,
      month,
      totalRequests,
      modelUsage,
      resetTimeIso: getNextResetIso(year, month),
      fetchedAt,
    };
  } catch (error) {
    return {
      status: "error",
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch Copilot usage",
      username,
      year,
      month,
      totalRequests: 0,
      modelUsage: [],
      resetTimeIso: null,
      fetchedAt,
    };
  }
}
