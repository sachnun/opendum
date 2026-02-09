import {
  CODE_ASSIST_ENDPOINT_FALLBACKS,
  GEMINI_CLI_AUTH_HEADERS,
} from "./constants";

export const GEMINI_CLI_QUOTA_STALE_THRESHOLD_MS = 15 * 60 * 1000;

const DEFAULT_MAX_REQUESTS = 1000;

const MAX_REQUESTS_BY_TIER: Record<string, Record<string, number>> = {
  "standard-tier": {
    "gemini-2.5-pro": 250,
    "gemini-3-pro-preview": 250,
    "gemini-2.0-flash": 1500,
    "gemini-2.5-flash": 1500,
    "gemini-2.5-flash-lite": 1500,
    "gemini-3-flash-preview": 1500,
  },
  "free-tier": {
    "gemini-2.5-pro": 100,
    "gemini-3-pro-preview": 100,
    "gemini-2.0-flash": 1000,
    "gemini-2.5-flash": 1000,
    "gemini-2.5-flash-lite": 1000,
    "gemini-3-flash-preview": 1000,
  },
  "legacy-tier": {
    "gemini-2.5-pro": 100,
    "gemini-3-pro-preview": 100,
    "gemini-2.0-flash": 1000,
    "gemini-2.5-flash": 1000,
    "gemini-2.5-flash-lite": 1000,
    "gemini-3-flash-preview": 1000,
  },
};

export const GEMINI_CLI_QUOTA_GROUPS: Record<
  string,
  { displayName: string; models: string[] }
> = {
  pro: {
    displayName: "Gemini Pro",
    models: ["gemini-2.5-pro", "gemini-3-pro-preview"],
  },
  "25-flash": {
    displayName: "Gemini 2.5 Flash",
    models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  "3-flash": {
    displayName: "Gemini 3 Flash",
    models: ["gemini-3-flash-preview"],
  },
};

interface RetrieveUserQuotaBucket {
  modelId?: string;
  remainingFraction?: number | null;
  resetTime?: string | null;
}

interface RetrieveUserQuotaResponse {
  buckets?: RetrieveUserQuotaBucket[];
}

export interface GeminiCliModelQuotaInfo {
  modelId: string;
  remainingFraction: number;
  isExhausted: boolean;
  resetTimeIso: string | null;
  resetTimestamp: number | null;
}

export interface GeminiCliQuotaGroupInfo {
  name: string;
  displayName: string;
  models: string[];
  remainingFraction: number;
  remainingRequests: number;
  maxRequests: number;
  isExhausted: boolean;
  resetTimeIso: string | null;
  resetTimestamp: number | null;
}

export interface GeminiCliQuotaSnapshot {
  status: "success" | "error";
  error?: string;
  tier: string;
  models: Record<string, GeminiCliModelQuotaInfo>;
  groups: GeminiCliQuotaGroupInfo[];
  fetchedAt: number;
  source: "api";
}

const quotaSnapshots = new Map<string, GeminiCliQuotaSnapshot>();

function normalizeTier(tier: string | null | undefined): string {
  if (!tier) {
    return "free-tier";
  }

  const normalized = tier.trim().toLowerCase();

  if (normalized === "paid" || normalized === "standard" || normalized === "pro") {
    return "standard-tier";
  }

  if (normalized === "free") {
    return "free-tier";
  }

  return normalized;
}

export function getMaxRequestsForModel(model: string, tier: string): number {
  const cleanModel = model.includes("/") ? model.split("/").pop() ?? model : model;
  const normalizedTier = normalizeTier(tier);
  const tierLimits =
    MAX_REQUESTS_BY_TIER[normalizedTier] ?? MAX_REQUESTS_BY_TIER["free-tier"];
  return tierLimits[cleanModel] ?? DEFAULT_MAX_REQUESTS;
}

function parseResetTime(resetTime: string | null | undefined): {
  iso: string | null;
  timestamp: number | null;
} {
  if (!resetTime) {
    return { iso: null, timestamp: null };
  }

  const timestamp = new Date(resetTime).getTime();
  if (Number.isNaN(timestamp)) {
    return { iso: null, timestamp: null };
  }

  return {
    iso: new Date(timestamp).toISOString(),
    timestamp,
  };
}

function buildQuotaGroups(
  models: Record<string, GeminiCliModelQuotaInfo>,
  tier: string
): GeminiCliQuotaGroupInfo[] {
  const groups: GeminiCliQuotaGroupInfo[] = [];

  for (const [groupName, groupConfig] of Object.entries(GEMINI_CLI_QUOTA_GROUPS)) {
    const representative = groupConfig.models.find((model) => models[model]);
    if (!representative) {
      continue;
    }

    const modelQuota = models[representative];
    const maxRequests = getMaxRequestsForModel(representative, tier);
    const remainingRequests = Math.max(
      0,
      Math.floor(modelQuota.remainingFraction * maxRequests)
    );

    groups.push({
      name: groupName,
      displayName: groupConfig.displayName,
      models: groupConfig.models,
      remainingFraction: modelQuota.remainingFraction,
      remainingRequests,
      maxRequests,
      isExhausted: modelQuota.isExhausted,
      resetTimeIso: modelQuota.resetTimeIso,
      resetTimestamp: modelQuota.resetTimestamp,
    });
  }

  return groups;
}

export async function fetchGeminiCliQuotaFromApi(
  accessToken: string,
  projectId: string,
  tier: string
): Promise<GeminiCliQuotaSnapshot> {
  const errors: string[] = [];
  const normalizedTier = normalizeTier(tier);

  for (const baseEndpoint of CODE_ASSIST_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetch(
        `${baseEndpoint}/v1internal:retrieveUserQuota`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...GEMINI_CLI_AUTH_HEADERS,
          },
          body: JSON.stringify({ project: projectId }),
          cache: "no-store",
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        errors.push(
          `${baseEndpoint}: HTTP ${response.status}${
            errorBody ? ` ${errorBody.slice(0, 250)}` : ""
          }`
        );
        continue;
      }

      const payload = (await response.json()) as RetrieveUserQuotaResponse;
      const buckets = payload.buckets ?? [];

      if (buckets.length === 0) {
        errors.push(`${baseEndpoint}: No quota buckets returned`);
        continue;
      }

      const models: Record<string, GeminiCliModelQuotaInfo> = {};

      for (const bucket of buckets) {
        if (!bucket.modelId) {
          continue;
        }

        const remainingFractionRaw = bucket.remainingFraction;
        const isExhausted =
          remainingFractionRaw === null ||
          remainingFractionRaw === undefined ||
          remainingFractionRaw <= 0;
        const remainingFraction = isExhausted
          ? 0
          : Math.max(0, Math.min(1, remainingFractionRaw));
        const reset = parseResetTime(bucket.resetTime);

        models[bucket.modelId] = {
          modelId: bucket.modelId,
          remainingFraction,
          isExhausted,
          resetTimeIso: reset.iso,
          resetTimestamp: reset.timestamp,
        };
      }

      const groups = buildQuotaGroups(models, normalizedTier);
      if (groups.length === 0) {
        errors.push(`${baseEndpoint}: Quota buckets had no known Gemini CLI models`);
        continue;
      }

      return {
        status: "success",
        tier: normalizedTier,
        models,
        groups,
        fetchedAt: Date.now(),
        source: "api",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${baseEndpoint}: ${message}`);
    }
  }

  return {
    status: "error",
    error: errors.join("; "),
    tier: normalizedTier,
    models: {},
    groups: [],
    fetchedAt: Date.now(),
    source: "api",
  };
}

export function getGeminiCliQuotaSnapshot(accountId: string): GeminiCliQuotaSnapshot | null {
  return quotaSnapshots.get(accountId) ?? null;
}

export function setGeminiCliQuotaSnapshot(
  accountId: string,
  snapshot: GeminiCliQuotaSnapshot
): void {
  if (snapshot.status !== "success") {
    return;
  }

  quotaSnapshots.set(accountId, snapshot);
}

export function isGeminiCliQuotaStale(snapshot: GeminiCliQuotaSnapshot): boolean {
  return Date.now() - snapshot.fetchedAt > GEMINI_CLI_QUOTA_STALE_THRESHOLD_MS;
}
