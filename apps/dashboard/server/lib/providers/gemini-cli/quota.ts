import {
  ENDPOINT_FALLBACKS,
  AUTH_HEADERS,
} from "./constants.js";
import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import { formatQuotaHttpError } from "../provider-http-errors.js";

const NORMALIZED_MAX_REQUESTS = 100;

const MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
};

const QUOTA_GROUPS: Record<
  string,
  { displayName: string; models: string[] }
> = {
  pro: {
    displayName: "Gemini Pro",
    models: ["gemini-3.1-pro-preview", "gemini-2.5-pro"],
  },
  "25-flash": {
    displayName: "Gemini 2.5 Flash",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  "3-flash": {
    displayName: "Gemini 3 Flash",
    models: ["gemini-3-flash-preview", "gemini-3.1-flash-lite"],
  },
};

interface RetrieveUserQuotaBucket {
  modelId?: string;
  remainingAmount?: string | null;
  remainingFraction?: number | null;
  resetTime?: string | null;
}

interface RetrieveUserQuotaResponse {
  buckets?: RetrieveUserQuotaBucket[];
}

export interface GeminiCliModelQuotaInfo {
  modelId: string;
  remainingFraction: number;
  remainingRequests: number;
  maxRequests: number;
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

function isFreeGeminiCliTier(tier: string): boolean {
  const normalizedTier = normalizeTier(tier);
  return normalizedTier === "free-tier" || normalizedTier === "legacy-tier";
}

function normalizeModelId(model: string): string {
  const cleanModel = model.includes("/") ? model.split("/").pop() ?? model : model;
  return MODEL_ALIASES[cleanModel] ?? cleanModel;
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

  for (const [groupName, groupConfig] of Object.entries(QUOTA_GROUPS)) {
    if (isFreeGeminiCliTier(tier) && groupName === "pro") {
      continue;
    }

    const representative = groupConfig.models.find((model) => models[model]);
    if (!representative) {
      continue;
    }

    const modelQuota = models[representative];
    if (!modelQuota) {
      continue;
    }
    groups.push({
      name: groupName,
      displayName: groupConfig.displayName,
      models: groupConfig.models,
      remainingFraction: modelQuota.remainingFraction,
      remainingRequests: modelQuota.remainingRequests,
      maxRequests: modelQuota.maxRequests,
      isExhausted: modelQuota.isExhausted,
      resetTimeIso: modelQuota.resetTimeIso,
      resetTimestamp: modelQuota.resetTimestamp,
    });
  }

  return groups;
}

function quotaFromBucket(
  bucket: RetrieveUserQuotaBucket,
  _tier: string
): { remainingRequests: number; maxRequests: number; remainingFraction: number } | null {
  if (!bucket.modelId || bucket.remainingFraction === null || bucket.remainingFraction === undefined) {
    return null;
  }

  const remainingFraction = Math.max(0, Math.min(1, bucket.remainingFraction));
  const maxRequests = NORMALIZED_MAX_REQUESTS;
  return {
    remainingRequests: Math.round(remainingFraction * maxRequests),
    maxRequests,
    remainingFraction,
  };
}

export async function fetchGeminiCliQuotaFromApi(
  accessToken: string,
  projectId: string,
  tier: string
): Promise<GeminiCliQuotaSnapshot> {
  const errors: string[] = [];
  const normalizedTier = normalizeTier(tier);

  for (const baseEndpoint of ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchInternalProvider(
        `${baseEndpoint}/v1internal:retrieveUserQuota`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...AUTH_HEADERS,
          },
          body: { project: projectId },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        errors.push(
          `${baseEndpoint}: ${formatQuotaHttpError("Gemini CLI", response, errorBody, { endpointLabel: "quota endpoint", bodyLimit: 250 })}`
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

        const quota = quotaFromBucket(bucket, normalizedTier);
        if (!quota) {
          continue;
        }
        const reset = parseResetTime(bucket.resetTime);

        const modelId = normalizeModelId(bucket.modelId);
        models[modelId] = {
          modelId,
          remainingFraction: quota.remainingFraction,
          remainingRequests: quota.remainingRequests,
          maxRequests: quota.maxRequests,
          isExhausted: quota.remainingFraction <= 0,
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
