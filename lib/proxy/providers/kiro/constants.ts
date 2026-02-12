// Kiro OAuth and API constants

export const KIRO_REGION = process.env.KIRO_REGION || "us-east-1";
export const KIRO_AUTH_SERVICE_ENDPOINT =
  process.env.KIRO_AUTH_SERVICE_ENDPOINT ||
  `https://prod.${KIRO_REGION}.auth.desktop.kiro.dev`;
export const KIRO_API_BASE_URL =
  process.env.KIRO_API_BASE_URL ||
  `https://q.${KIRO_REGION}.amazonaws.com/generateAssistantResponse`;

export const KIRO_BROWSER_REDIRECT_URI =
  process.env.KIRO_BROWSER_REDIRECT_URI ||
  "http://localhost:49153/oauth/callback";

export const KIRO_OAUTH_AUTHORIZE_ENDPOINT = `${KIRO_AUTH_SERVICE_ENDPOINT}/login`;
export const KIRO_OAUTH_TOKEN_ENDPOINT = `${KIRO_AUTH_SERVICE_ENDPOINT}/oauth/token`;
export const KIRO_OAUTH_REFRESH_ENDPOINT = `${KIRO_AUTH_SERVICE_ENDPOINT}/refreshToken`;

export const KIRO_OAUTH_IDP = process.env.KIRO_OAUTH_IDP || "Google";

export const KIRO_DEFAULT_MODEL = "claude-sonnet-4-5";

export const KIRO_MODEL_MAP: Record<string, string> = {
  // Claude Haiku
  "claude-3-haiku": "claude-3-haiku",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-haiku-4.5": "claude-haiku-4.5",
  "claude-haiku4.5": "claude-haiku-4.5",

  // Claude Sonnet (legacy)
  "claude-3-7-sonnet": "CLAUDE_3_7_SONNET_20250219_V1_0",
  "claude-3.7-sonnet": "CLAUDE_3_7_SONNET_20250219_V1_0",
  "claude-3-7-sonnet-latest": "CLAUDE_3_7_SONNET_20250219_V1_0",
  "claude-3.7-sonnet-latest": "CLAUDE_3_7_SONNET_20250219_V1_0",

  // Claude Opus 4.5
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4.5": "claude-opus-4.5",
  "claude-opus4.5": "claude-opus-4.5",

  // Claude Opus
  "claude-opus-4": "claude-opus-4",
  "claude-opus-4-0": "claude-opus-4",
  "claude-opus-4.0": "claude-opus-4",

  "claude-opus-4-1": "claude-opus-4.1",
  "claude-opus-4.1": "claude-opus-4.1",

  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4.6": "claude-opus-4.6",
  "claude-opus4.6": "claude-opus-4.6",

  "claude-sonnet-4": "claude-sonnet-4",
  "claude-sonnet-4-0": "claude-sonnet-4",
  "claude-sonnet-4.0": "claude-sonnet-4",
  "claude-sonnet4.0": "claude-sonnet-4",

  "claude-sonnet-4-5": "CLAUDE_SONNET_4_5_20250929_V1_0",
  "claude-sonnet-4.5": "CLAUDE_SONNET_4_5_20250929_V1_0",
  "claude-sonnet4.5": "CLAUDE_SONNET_4_5_20250929_V1_0",
};

export const KIRO_MODELS = new Set(Object.keys(KIRO_MODEL_MAP));

export const KIRO_REFRESH_BUFFER_SECONDS = 5 * 60;
