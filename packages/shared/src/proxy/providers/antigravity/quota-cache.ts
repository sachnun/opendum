/**
 * Antigravity Quota Cache
 * 
 * In-memory caching for quota baselines and request tracking.
 * Allows estimation of remaining quota between API fetches.
 */

import { getQuotaCostPercent, getQuotaGroupForModel, QUOTA_GROUPS } from "./quota";

// =============================================================================
// TYPES
// =============================================================================

interface QuotaBaseline {
  remainingFraction: number;
  fetchedAt: number;
  requestCountAtBaseline: number;
  resetTimestamp: number | null;
}

interface QuotaEstimate {
  remainingFraction: number;
  remainingRequests: number;
  maxRequests: number;
  isExhausted: boolean;
  isEstimated: boolean;
  confidence: "high" | "medium" | "low";
  baselineAgeSeconds: number | null;
}

// =============================================================================
// CACHE STORAGE (in-memory)
// =============================================================================

// Cache: accountId -> groupName -> baseline
const quotaBaselines = new Map<string, Map<string, QuotaBaseline>>();

// Request counts: accountId -> groupName -> count since baseline
const requestCounts = new Map<string, Map<string, number>>();

// =============================================================================
// BASELINE MANAGEMENT
// =============================================================================

/**
 * Update quota baseline after API fetch
 */
export function updateQuotaBaseline(
  accountId: string,
  groupName: string,
  remainingFraction: number,
  resetTimestamp: number | null = null
): void {
  let accountBaselines = quotaBaselines.get(accountId);
  if (!accountBaselines) {
    accountBaselines = new Map();
    quotaBaselines.set(accountId, accountBaselines);
  }

  // Get current request count to use as baseline
  const currentCount = getRequestCount(accountId, groupName);

  accountBaselines.set(groupName, {
    remainingFraction,
    fetchedAt: Date.now(),
    requestCountAtBaseline: currentCount,
    resetTimestamp,
  });
}

/**
 * Update baselines for all groups from fetch result
 */
export function updateAllBaselines(
  accountId: string,
  groups: Array<{
    name: string;
    remainingFraction: number;
    resetTimestamp: number | null;
  }>
): void {
  for (const group of groups) {
    updateQuotaBaseline(
      accountId,
      group.name,
      group.remainingFraction,
      group.resetTimestamp
    );
  }
}

/**
 * Get baseline for an account/group
 */
export function getQuotaBaseline(
  accountId: string,
  groupName: string
): QuotaBaseline | null {
  const accountBaselines = quotaBaselines.get(accountId);
  if (!accountBaselines) return null;
  return accountBaselines.get(groupName) ?? null;
}

/**
 * Clear baseline (e.g., when quota resets)
 */
export function clearQuotaBaseline(accountId: string, groupName?: string): void {
  if (groupName) {
    const accountBaselines = quotaBaselines.get(accountId);
    if (accountBaselines) {
      accountBaselines.delete(groupName);
    }
  } else {
    quotaBaselines.delete(accountId);
  }
}

// =============================================================================
// REQUEST COUNTING
// =============================================================================

/**
 * Get current request count for an account/group
 */
export function getRequestCount(accountId: string, groupName: string): number {
  const accountCounts = requestCounts.get(accountId);
  if (!accountCounts) return 0;
  return accountCounts.get(groupName) ?? 0;
}

/**
 * Increment request count after successful request
 */
export function incrementRequestCount(accountId: string, model: string): void {
  const groupName = getQuotaGroupForModel(model);
  if (!groupName) {
    return;
  }

  let accountCounts = requestCounts.get(accountId);
  if (!accountCounts) {
    accountCounts = new Map();
    requestCounts.set(accountId, accountCounts);
  }

  const current = accountCounts.get(groupName) ?? 0;
  accountCounts.set(groupName, current + 1);
}

/**
 * Reset request count (e.g., when quota resets)
 */
export function resetRequestCount(accountId: string, groupName?: string): void {
  if (groupName) {
    const accountCounts = requestCounts.get(accountId);
    if (accountCounts) {
      accountCounts.set(groupName, 0);
    }
  } else {
    requestCounts.delete(accountId);
  }
}

// =============================================================================
// QUOTA ESTIMATION
// =============================================================================

/**
 * Estimate remaining quota based on baseline + request tracking
 */
export function estimateRemainingQuota(
  accountId: string,
  groupName: string,
  tier: string,
  maxRequests: number
): QuotaEstimate {
  const baseline = getQuotaBaseline(accountId, groupName);
  const currentCount = getRequestCount(accountId, groupName);

  // No baseline - can't estimate
  if (!baseline) {
    return {
      remainingFraction: 1.0,
      remainingRequests: maxRequests,
      maxRequests,
      isExhausted: false,
      isEstimated: false,
      confidence: "low",
      baselineAgeSeconds: null,
    };
  }

  // Check if quota has reset since baseline
  if (baseline.resetTimestamp && Date.now() >= baseline.resetTimestamp) {
    // Quota has reset - clear old baseline
    clearQuotaBaseline(accountId, groupName);
    resetRequestCount(accountId, groupName);
    
    return {
      remainingFraction: 1.0,
      remainingRequests: maxRequests,
      maxRequests,
      isExhausted: false,
      isEstimated: false,
      confidence: "low",
      baselineAgeSeconds: null,
    };
  }

  // Calculate requests since baseline
  const requestsSinceBaseline = currentCount - baseline.requestCountAtBaseline;
  
  // Get cost per request (as fraction)
  const group = QUOTA_GROUPS[groupName];
  const representativeModel = group?.models[0] ?? "";
  const costPercent = getQuotaCostPercent(representativeModel, tier);
  const costFraction = costPercent / 100;

  // Estimate remaining
  const estimatedRemaining = Math.max(
    0,
    Math.min(1, baseline.remainingFraction - requestsSinceBaseline * costFraction)
  );

  // Calculate confidence based on baseline age
  const baselineAgeSeconds = (Date.now() - baseline.fetchedAt) / 1000;
  let confidence: "high" | "medium" | "low";
  
  if (baselineAgeSeconds < 5 * 60) {
    // Less than 5 minutes
    confidence = "high";
  } else if (baselineAgeSeconds < 30 * 60) {
    // Less than 30 minutes
    confidence = "medium";
  } else {
    confidence = "low";
  }

  const remainingRequests = Math.max(0, Math.floor(estimatedRemaining * maxRequests));

  return {
    remainingFraction: estimatedRemaining,
    remainingRequests,
    maxRequests,
    isExhausted: estimatedRemaining <= 0,
    isEstimated: true,
    confidence,
    baselineAgeSeconds,
  };
}

// =============================================================================
// UTILITY
// =============================================================================

/**
 * Get all cached data for an account (for debugging)
 */
export function getAccountCacheData(accountId: string): {
  baselines: Record<string, QuotaBaseline>;
  requestCounts: Record<string, number>;
} {
  const baselines: Record<string, QuotaBaseline> = {};
  const counts: Record<string, number> = {};

  const accountBaselines = quotaBaselines.get(accountId);
  if (accountBaselines) {
    for (const [group, baseline] of accountBaselines) {
      baselines[group] = baseline;
    }
  }

  const accountCounts = requestCounts.get(accountId);
  if (accountCounts) {
    for (const [group, count] of accountCounts) {
      counts[group] = count;
    }
  }

  return { baselines, requestCounts: counts };
}

/**
 * Clear all cache data (for testing)
 */
export function clearAllCache(): void {
  quotaBaselines.clear();
  requestCounts.clear();
}
