// Cline device-code OAuth flow (WorkOS device flow + Cline session register).

export const WORKOS_BASE_URL = "https://api.workos.com";
export const CLINE_BASE_URL = "https://api.cline.bot/api/v1";

// WorkOS OAuth client_id decoded from the Cline CLI.
export const CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

export const DEVICE_AUTHORIZE_PATH = "/user_management/authorize/device";
export const DEVICE_AUTHENTICATE_PATH = "/user_management/authenticate";
export const CLINE_REGISTER_PATH = "/auth/register";
export const CLINE_REFRESH_PATH = "/auth/refresh";

export const DEVICE_CODE_EXPIRY_SECONDS = 600;
export const POLLING_INTERVAL_SECONDS = 5;
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

// Headers sent on every Cline inference request (mirrors the Cline SDK).
export const CLINE_REQUEST_HEADERS = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Pi",
  "X-CLIENT-TYPE": "cline-sdk",
} as const;