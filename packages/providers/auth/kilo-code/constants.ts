import type { ProviderEntry } from "@opendum/providers/core/spec";

export const API_BASE_URL = "https://api.kilo.ai/api/gateway";
export const FALLBACK_BASE_URL = "https://unroxy.koyeb.app/api.kilo.ai/api/gateway";

export const PROVIDER: ProviderEntry = {
  compat: { name: "kilo_code", baseUrl: API_BASE_URL, fallbackBaseUrl: FALLBACK_BASE_URL },
};
