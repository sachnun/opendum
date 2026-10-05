export const providerDisplayNames: Record<string, string> = {
  antigravity: "Antigravity",
  perch: "Perch",
  cline: "Cline",
  codex: "Codex",
  harbor: "Harbor",
  hyper: "Charm",
  kiro: "Kiro",
  nvidia_nim: "Nvidia",
  openrouter: "OpenRouter",
  workers_ai: "Cloudflare",
  workbuddy: "WorkBuddy",
  zenmux: "ZenMux",
  opencode: "Opencode",
  kilo_code: "Kilo Code",
};

export function displayName(provider: string): string {
  if (provider in providerDisplayNames) return providerDisplayNames[provider];
  return provider;
}
