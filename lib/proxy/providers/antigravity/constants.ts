// Antigravity OAuth and API Constants

// OAuth Configuration (Google OAuth)
export const ANTIGRAVITY_CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ||
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET ||
  "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";

export const ANTIGRAVITY_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

// OAuth callback - same as Iflow, redirect to localhost (user will copy URL)
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:11451/oauth2callback";

// User Agent & API Client headers
// Dynamically detect OS/arch for accurate User-Agent header
function getAntigravityPlatform(): string {
  const platformMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };
  const archMap: Record<string, string> = {
    arm64: "arm64",
    x64: "amd64",
    ia32: "386",
  };
  const platform = platformMap[process.platform] ?? "linux";
  const arch = archMap[process.arch] ?? "amd64";
  return `${platform}/${arch}`;
}

export const ANTIGRAVITY_USER_AGENT = `antigravity/1.15.8 ${getAntigravityPlatform()}`;
export const ANTIGRAVITY_API_CLIENT = "google-cloud-sdk vscode_cloudshelleditor/0.1";
export const ANTIGRAVITY_CLIENT_METADATA =
  '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';

// Endpoint fallbacks (daily → autopush → prod)
export const CODE_ASSIST_ENDPOINT_DAILY =
  "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const CODE_ASSIST_ENDPOINT_AUTOPUSH =
  "https://autopush-cloudcode-pa.sandbox.googleapis.com";
export const CODE_ASSIST_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

export const CODE_ASSIST_ENDPOINT_FALLBACKS = [
  CODE_ASSIST_ENDPOINT_DAILY,
  CODE_ASSIST_ENDPOINT_AUTOPUSH,
  CODE_ASSIST_ENDPOINT_PROD,
] as const;

// Endpoint order for loadCodeAssist (project discovery)
// Production FIRST for better project resolution, then fallback to sandbox
// (Different from API request order which uses sandbox first)
export const LOAD_CODE_ASSIST_ENDPOINTS = [
  CODE_ASSIST_ENDPOINT_PROD,  // Prod first for discovery
  CODE_ASSIST_ENDPOINT_DAILY, // Daily fallback
] as const;

// Endpoint order for onboardUser (daily first, then prod)
export const ONBOARD_USER_ENDPOINTS = [
  CODE_ASSIST_ENDPOINT_DAILY,
  CODE_ASSIST_ENDPOINT_PROD,
] as const;

export const CODE_ASSIST_ENDPOINT = CODE_ASSIST_ENDPOINT_DAILY;

// Headers for auth/discovery calls (loadCodeAssist, onboardUser)
// CRITICAL: User-Agent MUST be google-api-nodejs-client/* for standard-tier detection.
// Using antigravity/* UA causes server to return free-tier only (tested via matrix test).
export const ANTIGRAVITY_AUTH_HEADERS = {
  "User-Agent": "google-api-nodejs-client/10.3.0",
  "X-Goog-Api-Client": "gl-node/22.18.0",
  "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
} as const;
export const CODE_ASSIST_API_VERSION = "v1internal";

export const CODE_ASSIST_HEADERS = {
  "User-Agent": ANTIGRAVITY_USER_AGENT,
  "X-Goog-Api-Client": ANTIGRAVITY_API_CLIENT,
  "Client-Metadata": ANTIGRAVITY_CLIENT_METADATA,
} as const;

// Model aliases (map public names to internal names)
export const MODEL_ALIASES: Record<string, string> = {
  "gemini-2.5-computer-use-preview-10-2025": "rev19-uic3-1p",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-3-pro-preview": "gemini-3-pro-high",
  "gemini-3-flash-preview": "gemini-3-flash",
  // Legacy gemini- prefixed aliases for backward compatibility
  "gemini-claude-sonnet-4-5": "claude-sonnet-4-5",
  "gemini-claude-sonnet-4-5-thinking": "claude-sonnet-4-5-thinking",
  "gemini-claude-opus-4-5": "claude-opus-4-5",
  "gemini-claude-opus-4-5-thinking": "claude-opus-4-5-thinking",
};

export const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
};

// Available Antigravity models
export const ANTIGRAVITY_MODELS = new Set([
  // Gemini models
  "gemini-2.5-flash",
  "gemini-2.5-flash-thinking",
  "gemini-2.5-flash-lite",
  "gemini-3-flash",
  "gemini-3-flash-preview",
  "gemini-3-pro-high",
  "gemini-3-pro-low",
  "gemini-3-pro-preview",
  "gemini-3-pro-image",
  "gemini-3-pro-image-preview",
  // Claude models (via Antigravity)
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-thinking",
  "claude-opus-4-5",
  "claude-opus-4-5-thinking",
  "gemini-claude-sonnet-4-5",
  "gemini-claude-sonnet-4-5-thinking",
  "gemini-claude-opus-4-5",
  "gemini-claude-opus-4-5-thinking",
  // Other models
  "gpt-oss-120b-medium",
]);

// Token refresh buffer (1 hour before expiry)
export const ANTIGRAVITY_REFRESH_BUFFER_SECONDS = 60 * 60;
