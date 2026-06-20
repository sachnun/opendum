/**
 * Antigravity Quota Monitoring
 * 
 * Provides quota tracking, fetching, and estimation for Antigravity accounts.
 * Based on empirical testing from LLM-API-Key-Proxy reference implementation.
 */

import { CODE_ASSIST_HEADERS, LOAD_CODE_ASSIST_ENDPOINTS } from "./constants.js";
import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import { formatQuotaHttpError } from "../provider-http-errors.js";

/**
 * Max requests per model per tier (source of truth)
 * Cost percentage is derived as: 100 / max_requests
 * 
 * Verified empirically - see LLM-API-Key-Proxy quota testing guide
 */
const QUOTA_MAX_REQUESTS: Record<string, Record<string, number>> = {
  "standard-tier": {
    "claude-opus-4-6": 150,
    "claude-sonnet-4-6": 150,
    "gemini-3.1-pro-preview": 320,
    "gemini-3-flash-preview": 400,
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-lite": 5000,
  },
  "free-tier": {
    "claude-opus-4-6": 50,
    "claude-sonnet-4-6": 50,
    "gemini-3.1-pro-preview": 150,
    "gemini-3-flash-preview": 500,
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-lite": 5000,
  },
  "legacy-tier": {
    "claude-opus-4-6": 50,
    "claude-sonnet-4-6": 50,
    "gemini-3.1-pro-preview": 150,
    "gemini-3-flash-preview": 500,
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-lite": 5000,
  },
};

const QUOTA_MAX_REQUESTS_DEFAULT = 100;

const QUOTA_GROUPS: Record<string, { displayName: string; models: string[] }> = {
  claude: {
    displayName: "Claude",
    models: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gpt-oss-120b",
    ],
  },
  gemini: {
    displayName: "Gemini",
    models: [
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ],
  },
};

const USER_TO_API_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-6": "claude-opus-4-6-thinking",
  "gemini-3-flash-preview": "gemini-3-flash",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image",
  "gemini-3.1-pro-preview": "gemini-3.1-pro-high",
  "gemini-3.5-flash": "gemini-3.5-flash-medium",
  "gpt-oss-120b": "gpt-oss-120b-medium",
};

// API name -> User-facing name (for normalizing API responses)
const API_TO_USER_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-6-1m": "claude-opus-4-6",
  "claude-opus-4-6-thinking": "claude-opus-4-6",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4.6-1m": "claude-opus-4-6",
  "claude-opus4.6": "claude-opus-4-6",
  "claude-sonnet-4-6-1m": "claude-sonnet-4-6",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.6-1m": "claude-sonnet-4-6",
  "claude-sonnet4.6": "claude-sonnet-4-6",
  "gemini-2.5-flash-thinking": "gemini-2.5-flash",
  "gemini-3-flash": "gemini-3-flash-preview",
  "gemini-3-flash-preview-latest": "gemini-3-flash-preview",
  "gemini-3-pro-image": "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image": "gemini-3.1-flash-image-preview",
  "gemini-3.1-pro-high": "gemini-3.1-pro-preview",
  "gemini-3.1-pro-low": "gemini-3.1-pro-preview",
  "gemini-3.1-pro-medium": "gemini-3.1-pro-preview",
  "gemini-3.5-flash-high": "gemini-3.5-flash",
  "gemini-3.5-flash-low": "gemini-3.5-flash",
  "gemini-3.5-flash-medium": "gemini-3.5-flash",
  "gemini-3.5-flash-minimal": "gemini-3.5-flash",
  "gpt-oss-120b-medium": "gpt-oss-120b",
};

/**
 * Get API model name from user-facing model name
 */
function userToApiModel(userModel: string): string {
  return USER_TO_API_MODEL_MAP[userModel] ?? userModel;
}

/**
 * Get user-facing model name from API model name
 */
function apiToUserModel(apiModel: string): string {
  return API_TO_USER_MODEL_MAP[apiModel] ?? apiModel;
}

/**
 * Get max requests for a model/tier combination
 */
function getMaxRequestsForModel(model: string, tier: string): number {
  const cleanModel = model.includes("/") ? model.split("/").pop()! : model;
  const tierLimits = QUOTA_MAX_REQUESTS[tier] ?? QUOTA_MAX_REQUESTS["free-tier"] ?? {};
  return tierLimits[cleanModel] ?? QUOTA_MAX_REQUESTS_DEFAULT;
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

function toUnixMillis(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return null;
  }

  return numeric > 10_000_000_000 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function parseResetObjectTimestamp(resetTime: unknown): number | null {
  if (!resetTime || typeof resetTime !== "object") {
    return null;
  }

  const record = resetTime as Record<string, unknown>;

  // Handle protobuf Timestamp-like objects: { seconds, nanos }.
  const seconds = toFiniteNumber(record.seconds);
  if (seconds !== null) {
    const nanos = toFiniteNumber(record.nanos) ?? 0;
    return Math.trunc(seconds * 1000 + nanos / 1_000_000);
  }

  const nestedIso =
    (typeof record.iso === "string" && record.iso) ||
    (typeof record.time === "string" && record.time) ||
    (typeof record.value === "string" && record.value) ||
    null;

  return parseIsoTimestamp(nestedIso);
}

function parseResetTime(resetTime: unknown): {
  iso: string | null;
  timestamp: number | null;
} {
  const timestamp =
    parseIsoTimestamp(resetTime) ??
    toUnixMillis(resetTime) ??
    parseResetObjectTimestamp(resetTime);

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
      const response = await fetchInternalProvider(`${baseEndpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...CODE_ASSIST_HEADERS,
        },
        body: { project: projectId },
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        errors.push(
          `${baseEndpoint}: ${formatQuotaHttpError("Antigravity", response, errorBody, { endpointLabel: "quota endpoint" })}`
        );
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
        if (!representativeModel) continue;

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
