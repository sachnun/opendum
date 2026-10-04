import { antigravityProvider } from "./client.js";
import { CLIENT_ID, REDIRECT_URI, SCOPES } from "./constants.js";
import { GOOGLE_OAUTH_AUTHORIZE_URL, type AccountConnector } from "../connector.js";

export { antigravityProvider } from "./client.js";
export * from "./constants.js";

export const connector: AccountConnector = {
  name: "antigravity",
  label: "Antigravity",
  async buildAuthUrl() {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
    });
    return { authUrl: `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`, state: null, codeVerifier: null };
  },
  exchangeCode: (code) => antigravityProvider.exchangeCode(code, REDIRECT_URI),
};
