// Cloudflare Workers AI API constants

const API_BASE_URL = "https://api.cloudflare.com/client/v4/accounts";

export function getWorkersAiValidationUrl(accountId: string): string {
  return `${API_BASE_URL}/${accountId}/ai/models/search`;
}
