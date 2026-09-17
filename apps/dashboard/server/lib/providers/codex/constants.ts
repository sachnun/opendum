import os from "node:os";

// Based on Opencode's codex plugin: https://github.com/anomalyco/opencode

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_ISSUER = "https://auth.openai.com";
export const AUTHORIZE_ENDPOINT = `${AUTH_ISSUER}/oauth/authorize`;
export const BROWSER_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";

export const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const DEVICE_CODE_ENDPOINT = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const DEVICE_TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/deviceauth/token";
export const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";

export const REFRESH_BUFFER_SECONDS = 5 * 60;

export const ORIGINATOR = "opencode";

// Match Opencode's Codex plugin headers.
const OPENCODE_VERSION = "1.14.28";
export const CODEX_CHAT_USER_AGENT = `opencode/${OPENCODE_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`;
