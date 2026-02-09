// Gemini CLI OAuth and API Constants

// OAuth Configuration (Gemini CLI specific - different from Antigravity)
export const GEMINI_CLI_CLIENT_ID =
  process.env.GEMINI_CLI_CLIENT_ID ||
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
export const GEMINI_CLI_CLIENT_SECRET =
  process.env.GEMINI_CLI_CLIENT_SECRET ||
  "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";

export const GEMINI_CLI_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

// OAuth callback - same pattern as other providers
export const GEMINI_CLI_REDIRECT_URI = "http://localhost:11451/oauth2callback";

// User Agent format: GeminiCLI/${version}/${model} (${platform}; ${arch})
export const GEMINI_CLI_VERSION = "0.26.0";
export const GEMINI_CLI_USER_AGENT_BASE = `GeminiCLI/${GEMINI_CLI_VERSION}`;

// Build User-Agent for a specific model
export function buildGeminiCliUserAgent(model: string): string {
  const modelName = model.split("/").pop()?.replace(":thinking", "") ?? model;
  return `${GEMINI_CLI_USER_AGENT_BASE}/${modelName} (win32; x64)`;
}

// API Endpoints (same as Antigravity - both use Google Code Assist)
export const CODE_ASSIST_ENDPOINT_DAILY =
  "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const CODE_ASSIST_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

export const CODE_ASSIST_ENDPOINT_FALLBACKS = [
  CODE_ASSIST_ENDPOINT_DAILY,
  CODE_ASSIST_ENDPOINT_PROD,
] as const;

// Endpoint order for loadCodeAssist (project discovery)
// Production first tends to return better project metadata.
export const GEMINI_CLI_LOAD_CODE_ASSIST_ENDPOINTS = [
  CODE_ASSIST_ENDPOINT_PROD,
  CODE_ASSIST_ENDPOINT_DAILY,
] as const;

// Endpoint order for onboardUser (daily first, then production fallback)
export const GEMINI_CLI_ONBOARD_USER_ENDPOINTS = [
  CODE_ASSIST_ENDPOINT_DAILY,
  CODE_ASSIST_ENDPOINT_PROD,
] as const;

// Default endpoint
export const CODE_ASSIST_ENDPOINT = CODE_ASSIST_ENDPOINT_DAILY;
export const CODE_ASSIST_API_VERSION = "v1internal";

// Headers for Gemini CLI requests
// Note: Gemini CLI uses simpler headers than Antigravity
export const GEMINI_CLI_AUTH_HEADERS = {
  "User-Agent": `${GEMINI_CLI_USER_AGENT_BASE} (win32; x64)`,
} as const;

// Available Gemini CLI models
export const GEMINI_CLI_MODELS = new Set([
  // Gemini 2.5 models
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  // Gemini 3 preview models
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
]);

// Model aliases (map public names to internal names if different)
export const MODEL_ALIASES: Record<string, string> = {
  // Currently no aliases needed - names are same as Antigravity
};

// Token refresh buffer (30 minutes before expiry)
export const GEMINI_CLI_REFRESH_BUFFER_SECONDS = 30 * 60;

// Gemini 3 tool prefix for avoiding name conflicts
export const GEMINI3_TOOL_PREFIX = "gemini3_";

// Default thinking configuration for reasoning_effort mapping
export const THINKING_BUDGET_MAP = {
  // Gemini 2.5 Flash budgets
  "gemini-2.5-flash": {
    none: 0,
    low: 6144,
    medium: 12288,
    high: 24576,
  },
  // Gemini 2.5 Pro budgets
  "gemini-2.5-pro": {
    none: 0,
    low: 8192,
    medium: 16384,
    high: 32768,
  },
  // Default budgets for other models
  default: {
    none: 0,
    low: 8192,
    medium: 16384,
    high: 32768,
  },
} as const;

// Gemini 3 thinking levels (different from 2.5 which uses budgets)
export const GEMINI3_THINKING_LEVELS = {
  // Gemini 3 Flash: minimal/low/medium/high
  "gemini-3-flash": {
    none: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
  },
  // Gemini 3 Pro: only low/high
  "gemini-3-pro": {
    none: "low",
    low: "low",
    medium: "high",
    high: "high",
  },
} as const;

// Default safety settings - disable content filtering for all categories
export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
] as const;
