const PROVIDER_NAMES: Record<string, string> = {
  antigravity: "Google Code Assist",
  kiro: "Kiro",
  cline: "Cline",
  codex: "Codex",
  opencode: "OpenCode",
  qoder: "Qoder",
  perch: "Perch",
  openrouter: "OpenRouter",
  nvidia_nim: "NVIDIA NIM",
  kilo_code: "Kilo Code",
  harbor: "Harbor",
  zenmux: "ZenMux",
  hyper: "Hyper",
  workers_ai: "Cloudflare",
};

export function providerDisplayName(provider: string): string {
  return PROVIDER_NAMES[provider.trim().toLowerCase()] || provider;
}

export function prefixWithProvider(provider: string, message: string): string {
  if (!message) return message;
  const name = providerDisplayName(provider);
  if (!name || message.startsWith(`[${name}]`)) return message;
  return `[${name}] ${message}`;
}

export function sanitizeErrorMessage(status: number, rawBody: string): { message: string; type: string } {
  let type = "api_error";
  if (status === 401 || status === 403) type = "authentication_error";
  else if (status === 429) type = "rate_limit_error";
  else if (status === 408 || status === 504) type = "timeout_error";
  else if (status >= 400 && status < 500) type = "invalid_request_error";

  let message = "";
  try {
    const parsed = JSON.parse(rawBody);
    message = parsed.error?.message || parsed.message || parsed.error || "";
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }
  } catch {
    message = rawBody.slice(0, 300).trim();
  }

  if (!message) {
    message = `Provider request failed with status ${status}`;
  }

  return { message, type };
}
