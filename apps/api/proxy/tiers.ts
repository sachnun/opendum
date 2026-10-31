export interface TierPolicy {
  isPaid(tier: string | null): boolean;
}

function normalizedTier(tier: string | null): string {
  return tier ? tier.trim().toLowerCase() : "";
}

export class Antigravity implements TierPolicy {
  isPaid(tier: string | null): boolean {
    const value = normalizedTier(tier);
    return value === "paid" || value === "standard-tier" || value.startsWith("g1-");
  }
}

export class Kiro implements TierPolicy {
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

export class Generic implements TierPolicy {
  isPaid(tier: string | null): boolean {
    return GENERIC_PAID_TIERS.has(normalizedTier(tier));
  }
}

export const GENERIC_TIER: TierPolicy = new Generic();

const TIERS: Record<string, TierPolicy> = {
  antigravity: new Antigravity(),
  kiro: new Kiro(),
};

export function tierFor(provider: string): TierPolicy {
  return TIERS[provider] ?? GENERIC_TIER;
}
