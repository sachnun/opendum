const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const COPILOT_QUOTA_USER_AGENT = "opendum/copilot-quota";

/**
 * Headers mimicking a VS Code Copilot Chat client, required by the
 * internal /copilot_internal/user endpoint.
 */
const COPILOT_INTERNAL_HEADERS = {
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "Editor-Version": "vscode/1.96.2",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
};

/**
 * Known Copilot plan monthly premium-request limits.
 * Used as a fallback when the internal API does not return an entitlement.
 */
const COPILOT_PLAN_LIMITS: Record<string, number> = {
  free: 50,
  student: 300,
  pro: 300,
  "pro+": 1500,
  business: 300,
  enterprise: 1000,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CopilotUsageEntry {
  model: string;
  requests: number;
}

/** Data source that produced the snapshot. */
export type CopilotUsageSource =
  | "internal_api"
  | "billing_api"
  | "both"
  | "none";

interface CopilotUsageSnapshotSuccess {
  status: "success";
  username: string;
  year: number;
  month: number;
  totalRequests: number;
  modelUsage: CopilotUsageEntry[];
  resetTimeIso: string;
  fetchedAt: number;
  /** Detected Copilot plan (e.g. "free", "pro", "pro+"). */
  plan?: string;
  /** Auto-detected monthly entitlement from the API. */
  planLimit?: number;
  /** Number of requests exceeding the entitlement. */
  overageCount?: number;
  /** Whether the account is allowed to exceed the entitlement. */
  overagePermitted?: boolean;
  /** Which API produced this data. */
  source: CopilotUsageSource;
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
  plan?: string;
  planLimit?: number;
  overageCount?: undefined;
  overagePermitted?: undefined;
  source: CopilotUsageSource;
}

export type CopilotUsageSnapshot =
  | CopilotUsageSnapshotSuccess
  | CopilotUsageSnapshotError;

interface FetchCopilotUsageOptions {
  year?: number;
  month?: number;
}

// ---------------------------------------------------------------------------
// Internal API types (GET /copilot_internal/user)
// ---------------------------------------------------------------------------

interface InternalQuotaSnapshot {
  quota_id?: string;
  entitlement?: number;
  quota_remaining?: number;
  remaining?: number;
  percent_remaining?: number;
  unlimited?: boolean;
  overage_permitted?: boolean;
  overage_count?: number;
}

interface InternalUserResult {
  ok: true;
  username: string | null;
  plan: string;
  entitlement: number;
  remaining: number;
  overageCount: number;
  overagePermitted: boolean;
  unlimited: boolean;
  resetDateUtc: string | null;
}

interface InternalUserError {
  ok: false;
  error: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function normalizePlanName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Billing API helpers (existing)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fetch GitHub username (/user)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal Copilot API (GET /copilot_internal/user)
// ---------------------------------------------------------------------------

/**
 * Fetches quota data from the internal Copilot API used by VS Code.
 * Works for ALL plan types (Free, Student, Pro, Pro+, Business, Enterprise).
 *
 * Returns exact entitlement and remaining counts for premium interactions.
 */
async function fetchCopilotInternalUser(
  accessToken: string
): Promise<InternalUserResult | InternalUserError> {
  try {
    const response = await fetch(
      `${GITHUB_API_BASE_URL}/copilot_internal/user`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...COPILOT_INTERNAL_HEADERS,
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        error: `Internal Copilot API returned HTTP ${response.status}${
          body ? ` ${body.slice(0, 200)}` : ""
        }`,
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;

    const plan = normalizePlanName(payload.copilot_plan);

    // quota_snapshots can be an object keyed by quota_id or an array
    const rawSnapshots = payload.quota_snapshots;
    let premiumSnapshot: InternalQuotaSnapshot | null = null;

    if (rawSnapshots && typeof rawSnapshots === "object") {
      // Could be { premium_interactions: {...} } or { "0": {...}, "1": {...} }
      const snapshotValues = Array.isArray(rawSnapshots)
        ? rawSnapshots
        : Object.values(rawSnapshots);

      for (const snap of snapshotValues) {
        const s = asRecord(snap);
        if (!s) continue;

        // Match by quota_id or by key name
        if (
          s.quota_id === "premium_interactions" ||
          (s as Record<string, unknown>).quota_id === undefined
        ) {
          premiumSnapshot = s as unknown as InternalQuotaSnapshot;
          if (s.quota_id === "premium_interactions") {
            break; // exact match, stop looking
          }
        }
      }

      // Also try direct key access
      if (!premiumSnapshot) {
        const direct = asRecord(
          (rawSnapshots as Record<string, unknown>).premium_interactions
        );
        if (direct) {
          premiumSnapshot = direct as unknown as InternalQuotaSnapshot;
        }
      }
    }

    const entitlement =
      toFiniteNumber(premiumSnapshot?.entitlement) ??
      COPILOT_PLAN_LIMITS[plan] ??
      0;
    const remaining =
      toFiniteNumber(premiumSnapshot?.quota_remaining) ??
      toFiniteNumber(premiumSnapshot?.remaining) ??
      entitlement;
    const overageCount = toFiniteNumber(premiumSnapshot?.overage_count) ?? 0;
    const overagePermitted = premiumSnapshot?.overage_permitted === true;
    const unlimited = premiumSnapshot?.unlimited === true;

    const resetDateUtc =
      typeof payload.quota_reset_date_utc === "string"
        ? payload.quota_reset_date_utc
        : typeof payload.quota_reset_date === "string"
          ? payload.quota_reset_date
          : null;

    // Try to get username from the same response or fall back to null
    const login =
      typeof payload.login === "string" ? payload.login.trim() : null;

    return {
      ok: true,
      username: login,
      plan,
      entitlement,
      remaining,
      overageCount,
      overagePermitted,
      unlimited,
      resetDateUtc,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown error fetching internal Copilot data",
    };
  }
}

// ---------------------------------------------------------------------------
// Billing API (GET /users/{username}/settings/billing/premium_request/usage)
// ---------------------------------------------------------------------------

/**
 * Fetches detailed per-model usage from the official billing API.
 * Only works for users who purchased their own paid Copilot plan.
 * Returns null on 404 (plan not supported) so caller can fall back.
 */
async function fetchBillingUsage(
  accessToken: string,
  username: string,
  year: number,
  month: number
): Promise<
  | { ok: true; modelUsage: CopilotUsageEntry[]; totalRequests: number }
  | { ok: false; status: number; error: string }
> {
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
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: `Billing API returned HTTP ${response.status}${
          body ? ` ${body.slice(0, 200)}` : ""
        }`,
      };
    }

    const payload = await response.json();
    const modelUsage = parseUsageItems(payload);
    const totalRequests = modelUsage.reduce(
      (sum, item) => sum + item.requests,
      0
    );

    return { ok: true, modelUsage, totalRequests };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch billing usage",
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches Copilot premium-request usage using a dual strategy:
 *
 * 1. **Internal API** (`/copilot_internal/user`) — works for all plans.
 *    Returns exact entitlement, remaining, plan type, and reset date.
 *
 * 2. **Billing API** (`/users/{u}/settings/billing/premium_request/usage`)
 *    — only works for paid personal plans. Returns per-model breakdown.
 *
 * If the billing API returns 404 (unsupported plan), the internal API data
 * is used alone. If the internal API fails, the billing API is tried as a
 * fallback (preserving the previous behaviour).
 */
export async function fetchCopilotUsageFromApi(
  accessToken: string,
  options: FetchCopilotUsageOptions = {}
): Promise<CopilotUsageSnapshot> {
  const period = getCurrentUtcPeriod();
  const year = options.year ?? period.year;
  const month = options.month ?? period.month;
  const fetchedAt = Date.now();

  // ------------------------------------------------------------------
  // Step 1: Try the internal Copilot API (works for all plan types)
  // ------------------------------------------------------------------
  const internalResult = await fetchCopilotInternalUser(accessToken);

  // We need a username for the billing API. The internal API may not
  // return one, so fetch it separately if needed.
  let username: string | null = null;
  if (internalResult.ok && internalResult.username) {
    username = internalResult.username;
  }

  if (!username) {
    const userResult = await fetchGithubUsername(accessToken);
    if (userResult.ok) {
      username = userResult.username;
    }
  }

  // ------------------------------------------------------------------
  // Step 2: Try the billing API for per-model breakdown
  // ------------------------------------------------------------------
  let billingResult:
    | { ok: true; modelUsage: CopilotUsageEntry[]; totalRequests: number }
    | { ok: false; status: number; error: string }
    | null = null;

  if (username) {
    billingResult = await fetchBillingUsage(accessToken, username, year, month);
  }

  // ------------------------------------------------------------------
  // Step 3: Merge results
  // ------------------------------------------------------------------

  // Case A: Internal API succeeded
  if (internalResult.ok) {
    const entitlement = internalResult.entitlement;
    const remaining = internalResult.remaining;
    const totalFromInternal = Math.max(0, entitlement - remaining);

    // Determine reset time — prefer internal API's reset date
    let resetTimeIso: string;
    if (internalResult.resetDateUtc) {
      const parsed = new Date(internalResult.resetDateUtc);
      resetTimeIso = Number.isFinite(parsed.getTime())
        ? parsed.toISOString()
        : getNextResetIso(year, month);
    } else {
      resetTimeIso = getNextResetIso(year, month);
    }

    // Use billing API model breakdown if available, otherwise empty
    let modelUsage: CopilotUsageEntry[] = [];
    let totalRequests = totalFromInternal;
    let source: CopilotUsageSource = "internal_api";

    if (billingResult !== null && billingResult.ok) {
      modelUsage = billingResult.modelUsage;
      totalRequests = billingResult.totalRequests;
      source = "both";
    }

    return {
      status: "success",
      username: username ?? internalResult.username ?? "unknown",
      year,
      month,
      totalRequests,
      modelUsage,
      resetTimeIso,
      fetchedAt,
      plan: internalResult.plan || undefined,
      planLimit: entitlement > 0 ? entitlement : undefined,
      overageCount:
        internalResult.overageCount > 0
          ? internalResult.overageCount
          : undefined,
      overagePermitted: internalResult.overagePermitted || undefined,
      source,
    };
  }

  // Case B: Internal API failed, but billing API succeeded
  if (billingResult?.ok === true && username) {
    return {
      status: "success",
      username,
      year,
      month,
      totalRequests: billingResult.totalRequests,
      modelUsage: billingResult.modelUsage,
      resetTimeIso: getNextResetIso(year, month),
      fetchedAt,
      source: "billing_api",
    };
  }

  // Case C: Both APIs failed
  const internalError = !internalResult.ok ? internalResult.error : "";
  const billingError =
    billingResult && !billingResult.ok ? billingResult.error : "";

  let error: string;
  if (billingResult && !billingResult.ok && billingResult.status === 404) {
    error =
      "Copilot usage data is unavailable for this account. " +
      "The billing API returned 404 (plan may not support it) " +
      "and the internal Copilot API also failed.";
  } else {
    error = [internalError, billingError].filter(Boolean).join(" | ") ||
      "Failed to fetch Copilot usage from all sources.";
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
    source: "none",
  };
}
