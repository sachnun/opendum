import { exchangePerchOAuthCode, initiatePerchOAuth } from "./client.ts";
import type { AccountConnector } from "../connector.ts";

export { initiatePerchOAuth, exchangePerchOAuthCode } from "./client.ts";
export { PERCH_ACCOUNT_PATH, PERCH_APP_URL, PERCH_AUTH_CONFIG_PATH, PERCH_AUTH_TOKEN_PATH, PERCH_REDIRECT_URI, PERCH_STARTER_PLAN_CODE } from "./constants.ts";

export const connector: AccountConnector = {
  name: "perch",
  label: "Perch",
  requiresCodeVerifier: true,
  async buildAuthUrl() {
    const result = await initiatePerchOAuth();
    return { authUrl: result.authUrl, state: null, codeVerifier: result.codeVerifier };
  },
  exchangeCode: (code, codeVerifier) => exchangePerchOAuthCode(code, codeVerifier ?? ""),
};
