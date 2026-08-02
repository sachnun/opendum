// Qoder OAuth device-code flow constants (reverse-engineered from qodercli).

// OAuth client_id decoded from the official qodercli bundle.
export const CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";

// Hosts.
export const OPENAPI_BASE_URL = "https://openapi.qoder.sh";
export const AUTHORIZE_BASE_URL = "https://qoder.com";

// Device-code endpoints.
export const DEVICE_AUTHORIZE_PATH = "/device/selectAccounts";
export const DEVICE_TOKEN_POLL_PATH = "/api/v1/deviceToken/poll";
export const DEVICE_TOKEN_REFRESH_PATH = "/api/v1/deviceToken/refresh";

// Identity & quota endpoints (Bearer device token).
export const USERINFO_PATH = "/api/v1/userinfo";

// PAT exchange endpoint (CI/headless alternative auth path).
export const JOB_TOKEN_EXCHANGE_PATH = "/api/v1/jobToken/exchange";

// Polling defaults. The server returns 404 while the user has not yet
// completed consent; the CLI polls for up to 5 minutes.
export const DEVICE_CODE_EXPIRY_SECONDS = 300;
export const POLLING_INTERVAL_SECONDS = 4;

// Qoder CLI verifier alphabet (RFC 7636 unreserved). Used to build PKCE
// verifiers that the server accepts.
export const PKCE_VERIFIER_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
export const PKCE_VERIFIER_MIN_LENGTH = 43;
export const PKCE_VERIFIER_MAX_LENGTH = 128;
