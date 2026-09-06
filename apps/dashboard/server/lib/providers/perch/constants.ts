// Perch OAuth constants (reversed from the perchai-cli npm package).

export const PERCH_APP_URL = "https://app.perchai.app";

// Public Perch CLI auth bootstrap: Supabase project + enabled OAuth providers.
export const PERCH_AUTH_CONFIG_PATH = "/api/perch-terminal/cli-auth/config";
// Account session/usage (allowance, fair-use windows, credit balance).
export const PERCH_ACCOUNT_PATH = "/api/perchai/account";
// Supabase endpoints resolved from the auth config.
export const PERCH_AUTH_TOKEN_PATH = "/auth/v1/token";

// The Perch CLI listens on 127.0.0.1 with an arbitrary port and "/callback"
// path; the Supabase project allowlists localhost redirects, so the dashboard
// reuses that shape for its browser popup flow.
export const PERCH_REDIRECT_HOST = "127.0.0.1";
export const PERCH_REDIRECT_PORT = 47321;
export const PERCH_REDIRECT_PATH = "/callback";
export const PERCH_REDIRECT_URI = `http://${PERCH_REDIRECT_HOST}:${PERCH_REDIRECT_PORT}${PERCH_REDIRECT_PATH}`;

// Free Starter plan selected right after login (the CLI does the same).
export const PERCH_STARTER_PLAN_CODE = "pilot";
