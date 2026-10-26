const API_BASE_URL = "https://api.cloudflare.com/client/v4/accounts";

export function validationUrl(accountId: string): string {
  return `${API_BASE_URL}/${accountId}/ai/models/search`;
}

export const PROVIDER = {
  spec: {
    key: "workers_ai" as const,
    slug: "cloudflare",
    label: "Cloudflare",
    category: "api_key" as const,
    showTier: false,
    authMethods: ["api_key_with_account_id"] as const,
    supportsQuota: false,
    apiKeyPortalUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
    apiKeyPlaceholder: "Bearer token...",
    accountIdPlaceholder: "e.g. 1a2b3c4d5e6f...",
    accountIdLabel: "Cloudflare Account ID",
    displayOrder: 8,
    navOrder: 10,
  },
};
