/**
 * Antigravity Quota Monitoring
 * 
 * Provides quota tracking, fetching, and estimation for Antigravity accounts.
 * Based on empirical testing from LLM-API-Key-Proxy reference implementation.
 */

import { CODE_ASSIST_HEADERS, LOAD_CODE_ASSIST_ENDPOINTS } from "./constants";

/**
 * Max requests per model per tier (source of truth)
 * Cost percentage is derived as: 100 / max_requests
 * 
 * Verified empirically - see LLM-API-Key-Proxy quota testing guide
 */
export const QUOTA_MAX_REQUESTS: Record<string, Record<string, number>> = {
  "standard-tier": {
    "claude-sonnet-4-5": 150,
    "claude-opus-4-5": 150,
    "claude-opus-4-6": 150,
    "gpt-oss-120b-medium": 150,
    "gemini-3-pro-preview": 320,
    "gemini-3-flash-preview": 400,
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-lite": 5000,
  },
  "free-tier": {
    "claude-sonnet-4-5": 50,
    "claude-opus-4-5": 50,
    "claude-opus-4-6": 50,
    "gpt-oss-120b-medium": 50,
    "gemini-3-pro-preview": 150,
    "gemini-3-flash-preview": 500,
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-lite": 5000,
  },
  "legacy-tier": {
    "claude-sonnet-4-5": 50,
    "claude-opus-4-5": 50,
    "claude-opus-4-6": 50,
    "gpt-oss-120b-medium": 50,
    "gemini-3-pro-preview": 150,
    "gemini-3-flash-preview": 500,
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-lite": 5000,
  },
};

export const QUOTA_MAX_REQUESTS_DEFAULT = 100;

export const QUOTA_GROUPS: Record<string, { displayName: string; models: string[] }> = {
  claude: {
    displayName: "Claude / GPT-OSS",
    models: [
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "gpt-oss-120b-medium",
    ],
  },
  "g3-pro": {
    displayName: "Gemini 3 Pro",
    models: ["gemini-3-pro-preview"],
  },
  "g3-flash": {
    displayName: "Gemini 3 Flash",
    models: ["gemini-3-flash-preview"],
  },
  "g25-flash": {
    displayName: "Gemini 2.5 Flash",
    models: ["gemini-2.5-flash"],
  },
  "g25-lite": {
    displayName: "Gemini 2.5 Lite",
    models: ["gemini-2.5-flash-lite"],
  },
};

const USER_TO_API_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-5": "claude-opus-4-5-thinking", // Opus only exists as -thinking in API
  "claude-opus-4-6": "claude-opus-4-6-thinking", // Opus only exists as -thinking in API
  "gemini-3-pro-preview": "gemini-3-pro-high", // Preview maps to high by default
  "gemini-3-flash-preview": "gemini-3-flash",
};

// API name -> User-facing name (for normalizing API responses)
const API_TO_USER_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-5-thinking": "claude-opus-4-5",
  "claude-opus-4-6-thinking": "claude-opus-4-6",
  "claude-sonnet-4-5-thinking": "claude-sonnet-4-5",
  "gemini-3-pro-high": "gemini-3-pro-preview",
  "gemini-3-pro-low": "gemini-3-pro-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
  "gemini-2.5-flash-thinking": "gemini-2.5-flash",
};

/**
 * Get API model name from user-facing model name
 */
export function userToApiModel(userModel: string): string {
  return USER_TO_API_MODEL_MAP[userModel] ?? userModel;
}

/**
 * Get user-facing model name from API model name
 */
export function apiToUserModel(apiModel: string): string {
  return API_TO_USER_MODEL_MAP[apiModel] ?? apiModel;
}

/**
 * Get quota group for a model
 */
export function getQuotaGroupForModel(model: string): string | null {
  const cleanModel = model.includes("/") ? model.split("/").pop()! : model;
  
  for (const [groupName, group] of Object.entries(QUOTA_GROUPS)) {
    if (group.models.includes(cleanModel)) {
      return groupName;
    }
  }
  return null;
}

/**
 * Get max requests for a model/tier combination
 */
export function getMaxRequestsForModel(model: string, tier: string): number {
  const cleanModel = model.includes("/") ? model.split("/").pop()! : model;
  const tierLimits = QUOTA_MAX_REQUESTS[tier] ?? QUOTA_MAX_REQUESTS["free-tier"];
  return tierLimits[cleanModel] ?? QUOTA_MAX_REQUESTS_DEFAULT;
}

/**
 * Get quota cost per request (as percentage)
 */
export function getQuotaCostPercent(model: string, tier: string): number {
  const maxRequests = getMaxRequestsForModel(model, tier);
  return maxRequests > 0 ? 100 / maxRequests : 100;
}

export interface ModelQuotaInfo {
  remainingFraction: number; // 0.0 - 1.0 (null from API = exhausted = 0.0)
  isExhausted: boolean;
  resetTimeIso: string | null;
  resetTimestamp: number | null;
  displayName: string | null;
}

export interface QuotaGroupInfo {
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

export interface FetchQuotaResult {
  status: "success" | "error";
  error?: string;
  models: Record<string, ModelQuotaInfo>;
  groups: QuotaGroupInfo[];
  fetchedAt: number;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseRemainingFraction(value: unknown): {
  remainingFraction: number;
  isExhausted: boolean;
} {
  // Null from API explicitly means exhausted.
  if (value === null) {
    return { remainingFraction: 0, isExhausted: true };
  }

  const parsed = toFiniteNumber(value);
  if (parsed === null) {
    // Unknown value: fail open to avoid accidentally marking quota as exhausted.
    return { remainingFraction: 1, isExhausted: false };
  }

  const clamped = Math.max(0, Math.min(1, parsed));
  return {
    remainingFraction: clamped,
    isExhausted: clamped <= 0,
  };
}

function parseResetTime(resetTime: unknown): {
  iso: string | null;
  timestamp: number | null;
} {
  let timestamp: number | null = null;

  if (typeof resetTime === "string") {
    const parsed = new Date(resetTime).getTime();
    if (Number.isFinite(parsed)) {
      timestamp = parsed;
    } else {
      const numeric = toFiniteNumber(resetTime);
      if (numeric !== null) {
        timestamp = numeric > 10_000_000_000 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
      }
    }
  } else {
    const numeric = toFiniteNumber(resetTime);
    if (numeric !== null) {
      timestamp = numeric > 10_000_000_000 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
    } else if (resetTime && typeof resetTime === "object") {
      const record = resetTime as Record<string, unknown>;

      // Handle protobuf Timestamp-like objects: { seconds, nanos }.
      const seconds = toFiniteNumber(record.seconds);
      if (seconds !== null) {
        const nanos = toFiniteNumber(record.nanos) ?? 0;
        timestamp = Math.trunc(seconds * 1000 + nanos / 1_000_000);
      } else {
        const nestedIso =
          (typeof record.iso === "string" && record.iso) ||
          (typeof record.time === "string" && record.time) ||
          (typeof record.value === "string" && record.value) ||
          null;

        if (nestedIso) {
          const parsed = new Date(nestedIso).getTime();
          if (Number.isFinite(parsed)) {
            timestamp = parsed;
          }
        }
      }
    }
  }

  if (timestamp === null || timestamp <= 0 || Number.isNaN(timestamp)) {
    return { iso: null, timestamp: null };
  }

  return {
    iso: new Date(timestamp).toISOString(),
    timestamp,
  };
}

/**
 * Fetch quota from Antigravity fetchAvailableModels API
 */
export async function fetchQuotaFromApi(
  accessToken: string,
  projectId: string,
  tier: string = "free-tier"
): Promise<FetchQuotaResult> {
  const errors: string[] = [];

  // Try endpoints with fallback
  for (const baseEndpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
    try {
      const response = await fetch(`${baseEndpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...CODE_ASSIST_HEADERS,
        },
        body: JSON.stringify({ project: projectId }),
      });

      if (!response.ok) {
        errors.push(`${baseEndpoint}: HTTP ${response.status}`);
        continue;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const modelsData = (data.models ?? {}) as Record<string, Record<string, unknown>>;

      const models: Record<string, ModelQuotaInfo> = {};
      
      for (const [apiModelName, modelInfo] of Object.entries(modelsData)) {
        const quotaInfo = (modelInfo.quotaInfo ?? {}) as Record<string, unknown>;

        const { remainingFraction, isExhausted } = parseRemainingFraction(
          quotaInfo.remainingFraction
        );
        const { iso: resetTimeIso, timestamp: resetTimestamp } = parseResetTime(
          quotaInfo.resetTime
        );

        const userModel = apiToUserModel(apiModelName);
        
        models[userModel] = {
          remainingFraction,
          isExhausted,
          resetTimeIso,
          resetTimestamp,
          displayName: (modelInfo.displayName as string) ?? null,
        };
      }

      const groups: QuotaGroupInfo[] = [];
      
      for (const [groupName, groupConfig] of Object.entries(QUOTA_GROUPS)) {
        let groupRemaining = 1.0;
        let groupResetTimeIso: string | null = null;
        let groupResetTimestamp: number | null = null;

        for (const model of groupConfig.models) {
          const apiModel = userToApiModel(model);
          const modelInfo = models[model] ?? models[apiModel];
          
          if (modelInfo) {
            groupRemaining = modelInfo.remainingFraction;
            groupResetTimeIso = modelInfo.resetTimeIso;
            groupResetTimestamp = modelInfo.resetTimestamp;
            break;
          }
        }

        const representativeModel = groupConfig.models[0];
        const maxRequests = getMaxRequestsForModel(representativeModel, tier);
        const remainingRequests = Math.max(0, Math.floor(groupRemaining * maxRequests));

        groups.push({
          name: groupName,
          displayName: groupConfig.displayName,
          models: groupConfig.models,
          remainingFraction: groupRemaining,
          remainingRequests,
          maxRequests,
          isExhausted: groupRemaining <= 0,
          resetTimeIso: groupResetTimeIso,
          resetTimestamp: groupResetTimestamp,
        });
      }

      return {
        status: "success",
        models,
        groups,
        fetchedAt: Date.now(),
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`${baseEndpoint}: ${errorMsg}`);
    }
  }

  return {
    status: "error",
    error: errors.join("; "),
    models: {},
    groups: [],
    fetchedAt: Date.now(),
  };
}
