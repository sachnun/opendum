import { exchangePerchOAuthCode, initiatePerchOAuth } from "./client.js";
import type { AccountConnector } from "../connector.js";

export { initiatePerchOAuth, exchangePerchOAuthCode } from "./client.js";
export * from "./constants.js";

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
