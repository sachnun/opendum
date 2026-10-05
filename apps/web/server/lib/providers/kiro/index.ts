import { BROWSER_REDIRECT_URI } from "./constants.ts";
import { buildKiroAuthUrl, generateCodeVerifier, kiroProvider } from "./client.ts";
import { generateOAuthState, type AccountConnector } from "../connector.ts";

export { kiroProvider, generateCodeVerifier, buildKiroAuthUrl } from "./client.ts";
export { AUTHORIZE_ENDPOINT, BROWSER_REDIRECT_URI, IDP, REFRESH_BUFFER_SECONDS, REFRESH_ENDPOINT, TOKEN_ENDPOINT } from "./constants.ts";

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
