const PAID_TIERS = [
  "paid",
  "standard-tier",
  "plus",
  "pro",
  "pro-plus",
  "pro+",
  "prolite",
  "power",
  "team",
  "go",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "student",
  "edu",
  "education",
  "hc",
];

const FREE_TIERS = ["free", "free-tier", "legacy-tier"];

const ANTIGRAVITY_PAID = ["paid", "standard-tier"];
const KIRO_PAID = ["pro", "pro-plus", "pro+", "power"];

export function paidTier(tier: string, provider?: string): boolean {
  const value = tier.trim().toLowerCase();
  if (provider === "antigravity") {
    return ANTIGRAVITY_PAID.includes(value) || value.startsWith("g1-");
  }
  if (provider === "kiro") return KIRO_PAID.includes(value);
  return PAID_TIERS.includes(value);
}

export function freeTier(tier: string): boolean {
  return FREE_TIERS.includes(tier.trim().toLowerCase());
}

export function tierLabel(tier: string, provider?: string): "Paid" | "Free" | "" {
  if (paidTier(tier, provider)) return "Paid";
  if (freeTier(tier)) return "Free";
  return "";
}
