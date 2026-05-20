// GitHub Copilot OAuth and API constants

export type CopilotAuthMethod = "opencode" | "official";

export const DEFAULT_AUTH_METHOD: CopilotAuthMethod = "opencode";

// OAuth App client ids used by each supported device flow.
export const CLIENT_IDS: Record<CopilotAuthMethod, string> = {
  opencode: "Ov23li8tweQw6odWQebz",
  official: "Ov23ctDVkRmgkPke0Mmm",
};

// OAuth endpoints (GitHub device flow)
export const DEVICE_CODE_ENDPOINT =
  "https://github.com/login/device/code";
export const TOKEN_ENDPOINT =
  "https://github.com/login/oauth/access_token";

// Basic user identity endpoint
export const USER_ENDPOINT = "https://api.github.com/user";

// OAuth scopes. The official scope matches @github/copilot CLI 1.0.50.
export const SCOPES: Record<CopilotAuthMethod, string> = {
  opencode: "read:user",
  official: "read:user,read:org,repo,gist",
};

// Keep Copilot request headers aligned with OpenCode plugin behavior.
export const USER_AGENT = "opencode/1.1.65";

// Polling defaults
export const POLLING_INTERVAL = 5;
export const DEVICE_CODE_EXPIRY = 900;

// Refresh buffer for expiring OAuth tokens
export const REFRESH_BUFFER_SECONDS = 5 * 60;
