/**
 * Antigravity Quota Monitoring
 * 
 * Provides quota tracking, fetching, and estimation for Antigravity accounts.
 * Based on empirical testing from LLM-API-Key-Proxy reference implementation.
 */

import { CODE_ASSIST_HEADERS, LOAD_CODE_ASSIST_ENDPOINTS } from "./constants";

// =============================================================================
// QUOTA LIMITS (max requests per 100% quota)
// =============================================================================

/**
 * Max requests per model per tier (source of truth)
 * Cost percentage is derived as: 100 / max_requests
 * 
 * Verified empirically - see LLM-API-Key-Proxy quota testing guide
 */
export const QUOTA_MAX_REQUESTS: Record<string, Record<string, number>> = {
  "standard-tier": {
    // Claude/GPT-OSS group (0.6667% per request = 150 requests)
    "claude-sonnet-4-5": 150,
    "claude-sonnet-4-5-thinking": 150,
    "claude-opus-4-5": 150,
    "claude-opus-4-5-thinking": 150,
    "gpt-oss-120b-medium": 150,
    // Gemini 3 Pro group (0.3125% per request = 320 requests)
    "gemini-3-pro-high": 320,
    "gemini-3-pro-low": 320,
    "gemini-3-pro-preview": 320,
    // Gemini 3 Flash (0.25% per request = 400 requests)
    "gemini-3-flash": 400,
    // Gemini 2.5 Flash group (0.0333% per request = 3000 requests)
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-thinking": 3000,
    // Gemini 2.5 Flash Lite - SEPARATE pool (0.02% per request = 5000 requests)
    "gemini-2.5-flash-lite": 5000,
  },
  "free-tier": {
    // Claude/GPT-OSS group (2.0% per request = 50 requests)
    "claude-sonnet-4-5": 50,
    "claude-sonnet-4-5-thinking": 50,
    "claude-opus-4-5": 50,
    "claude-opus-4-5-thinking": 50,
    "gpt-oss-120b-medium": 50,
    // Gemini 3 Pro group (0.6667% per request = 150 requests)
    "gemini-3-pro-high": 150,
    "gemini-3-pro-low": 150,
    "gemini-3-pro-preview": 150,
    // Gemini 3 Flash (0.2% per request = 500 requests)
    "gemini-3-flash": 500,
    // Gemini 2.5 Flash group (0.0333% per request = 3000 requests)
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-thinking": 3000,
    // Gemini 2.5 Flash Lite - SEPARATE pool (0.02% per request = 5000 requests)
    "gemini-2.5-flash-lite": 5000,
  },
  // Legacy tier uses same limits as free-tier
  "legacy-tier": {
    "claude-sonnet-4-5": 50,
    "claude-opus-4-5": 50,
    "gpt-oss-120b-medium": 50,
    "gemini-3-pro-high": 150,
    "gemini-3-flash": 500,
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-lite": 5000,
  },
};

// Default max requests for unknown models
export const QUOTA_MAX_REQUESTS_DEFAULT = 100;

// =============================================================================
// QUOTA GROUPS (models that share the same quota pool)
// =============================================================================

export const QUOTA_GROUPS: Record<string, { displayName: string; models: string[] }> = {
  claude: {
    displayName: "Claude / GPT-OSS",
    models: [
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-thinking",
      "claude-opus-4-5",
      "claude-opus-4-5-thinking",
      "gpt-oss-120b-medium",
    ],
  },
  "g3-pro": {
    displayName: "Gemini 3 Pro",
    models: ["gemini-3-pro-high", "gemini-3-pro-low", "gemini-3-pro-preview"],
  },
  "g3-flash": {
    displayName: "Gemini 3 Flash",
    models: ["gemini-3-flash"],
  },
  "g25-flash": {
    displayName: "Gemini 2.5 Flash",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-thinking"],
  },
  "g25-lite": {
    displayName: "Gemini 2.5 Lite",
    models: ["gemini-2.5-flash-lite"],
  },
};

// =============================================================================
// MODEL NAME MAPPINGS
// =============================================================================

// User-facing name -> API name (for looking up quota in API response)
const USER_TO_API_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-5": "claude-opus-4-5-thinking", // Opus only exists as -thinking in API
  "gemini-3-pro-preview": "gemini-3-pro-high", // Preview maps to high by default
};

// API name -> User-facing name (for normalizing API responses)
const API_TO_USER_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-5-thinking": "claude-opus-4-5",
  "claude-sonnet-4-5-thinking": "claude-sonnet-4-5",
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

// =============================================================================
// TYPES
// =============================================================================

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

// =============================================================================
// QUOTA FETCHING
// =============================================================================

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

      // Parse models
      const models: Record<string, ModelQuotaInfo> = {};
      
      for (const [apiModelName, modelInfo] of Object.entries(modelsData)) {
        const quotaInfo = (modelInfo.quotaInfo ?? {}) as Record<string, unknown>;
        
        // CRITICAL: NULL remainingFraction means EXHAUSTED (0.0)
        let remaining = quotaInfo.remainingFraction as number | null;
        const isExhausted = remaining === null || remaining <= 0;
        if (remaining === null) {
          remaining = 0;
        }

        const resetTimeIso = (quotaInfo.resetTime as string) ?? null;
        let resetTimestamp: number | null = null;
        
        if (resetTimeIso) {
          try {
            resetTimestamp = new Date(resetTimeIso).getTime();
          } catch {
            // Invalid date format
          }
        }

        // Normalize to user-facing model name
        const userModel = apiToUserModel(apiModelName);
        
        models[userModel] = {
          remainingFraction: remaining,
          isExhausted,
          resetTimeIso,
          resetTimestamp,
          displayName: (modelInfo.displayName as string) ?? null,
        };
      }

      // Build quota groups
      const groups: QuotaGroupInfo[] = [];
      
      for (const [groupName, groupConfig] of Object.entries(QUOTA_GROUPS)) {
        // Find a representative model with quota info
        let groupRemaining = 1.0;
        let groupResetTimeIso: string | null = null;
        let groupResetTimestamp: number | null = null;
        let foundQuotaInfo = false;

        for (const model of groupConfig.models) {
          const apiModel = userToApiModel(model);
          const modelInfo = models[model] ?? models[apiModel];
          
          if (modelInfo) {
            groupRemaining = modelInfo.remainingFraction;
            groupResetTimeIso = modelInfo.resetTimeIso;
            groupResetTimestamp = modelInfo.resetTimestamp;
            foundQuotaInfo = true;
            break;
          }
        }

        // Get max requests for this group (use first model as representative)
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
