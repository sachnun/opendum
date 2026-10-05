import { antigravityProvider } from "./client.ts";
import { CLIENT_ID, REDIRECT_URI, SCOPES } from "./constants.ts";
import { GOOGLE_OAUTH_AUTHORIZE_URL, type AccountConnector } from "../connector.ts";

export { antigravityProvider } from "./client.ts";
export { CLIENT_ID, CLIENT_SECRET, SCOPES, REDIRECT_URI, LOAD_CODE_ASSIST_ENDPOINTS, ONBOARD_USER_ENDPOINTS, AUTH_HEADERS, REFRESH_BUFFER_SECONDS, DEFAULT_PROJECT_ID } from "./constants.ts";

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
