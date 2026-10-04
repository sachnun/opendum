import { BROWSER_REDIRECT_URI } from "./constants.js";
import { buildKiroAuthUrl, generateCodeVerifier, kiroProvider } from "./client.js";
import { generateOAuthState, type AccountConnector } from "../connector.js";

export { kiroProvider, generateCodeVerifier, buildKiroAuthUrl } from "./client.js";
export * from "./constants.js";

export const connector: AccountConnector = {
  name: "kiro",
  label: "Kiro",
  requiresCodeVerifier: true,
  async buildAuthUrl() {
    const state = generateOAuthState();
    const codeVerifier = generateCodeVerifier();
    return { authUrl: await buildKiroAuthUrl(state, codeVerifier), state, codeVerifier };
  },
  exchangeCode: (code, codeVerifier) =>
    kiroProvider.exchangeCode(code, BROWSER_REDIRECT_URI, codeVerifier ?? undefined),
  accountOptions(oauthResult) {
    return {
      email: oauthResult.email || `kiro-${Date.now()}`,
      accountId: oauthResult.accountId || null,
      dedupeByAccountId: false,
    };
  },
};
