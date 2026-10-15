/**
 * Per-provider paid-tier classification used for routing priority.
 * Adding a provider means adding one policy entry instead of editing a switch.
 */
export interface AccountTierPolicy {
  /** True when the tier counts as a paid plan for routing priority. */
  isPaid(tier: string | null): boolean;
}

function normalizedTier(tier: string | null): string {
  return tier ? tier.trim().toLowerCase() : "";
}

export class AntigravityTierPolicy implements AccountTierPolicy {
  isPaid(tier: string | null): boolean {
    const value = normalizedTier(tier);
    return value === "paid" || value === "standard-tier" || value.startsWith("g1-");
  }
}

export class KiroTierPolicy implements AccountTierPolicy {
  isPaid(tier: string | null): boolean {
    const value = normalizedTier(tier);
    return value === "pro" || value === "pro+" || value === "pro-plus" || value === "power";
  }
}

const GENERIC_PAID_TIERS = new Set([
  "paid", "standard-tier", "plus", "pro", "pro-plus", "pro+", "prolite", "power", "team", "go",
  "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "edu",
  "education", "hc",
]);

export class GenericTierPolicy implements AccountTierPolicy {
  isPaid(tier: string | null): boolean {
    return GENERIC_PAID_TIERS.has(normalizedTier(tier));
  }
}

export const GENERIC_TIER_POLICY: AccountTierPolicy = new GenericTierPolicy();

const TIER_POLICIES: Record<string, AccountTierPolicy> = {
  antigravity: new AntigravityTierPolicy(),
  kiro: new KiroTierPolicy(),
};

export function tierPolicyFor(provider: string): AccountTierPolicy {
  return TIER_POLICIES[provider] ?? GENERIC_TIER_POLICY;
}
