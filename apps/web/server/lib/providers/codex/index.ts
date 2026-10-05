import {
  buildOAuthResultFromChatGPTSession,
  codexProvider,
  generateCodeChallenge,
  generateCodeVerifier,
  initiateCodexDeviceCodeFlow,
  pollCodexDeviceCodeAuthorization,
} from "./client.ts";
import { AUTHORIZE_ENDPOINT, BROWSER_REDIRECT_URI, CLIENT_ID, ORIGINATOR, SCOPE } from "./constants.ts";
import { generateOAuthState, type AccountConnector } from "../connector.ts";

export {
  buildOAuthResultFromChatGPTSession,
  codexProvider,
  generateCodeChallenge,
  generateCodeVerifier,
  initiateCodexDeviceCodeFlow,
  pollCodexDeviceCodeAuthorization,
} from "./client.ts";
export { AUTHORIZE_ENDPOINT, BROWSER_REDIRECT_URI, CLIENT_ID, DEVICE_CODE_ENDPOINT, DEVICE_REDIRECT_URI, DEVICE_TOKEN_ENDPOINT, DEVICE_VERIFICATION_URL, ORIGINATOR, REFRESH_BUFFER_SECONDS, SCOPE, TOKEN_ENDPOINT, CODEX_CHAT_USER_AGENT } from "./constants.ts";

export const connector: AccountConnector = {
  name: "codex",
  label: "Codex",
  requiresCodeVerifier: true,
  async buildAuthUrl() {
    const state = generateOAuthState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: BROWSER_REDIRECT_URI,
      scope: SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: ORIGINATOR,
    });
    return { authUrl: `${AUTHORIZE_ENDPOINT}?${params.toString()}`, state, codeVerifier };
  },
  exchangeCode: (code, codeVerifier) =>
    codexProvider.exchangeCode(code, BROWSER_REDIRECT_URI, codeVerifier ?? undefined),
  accountOptions(oauthResult) {
    const chatgptAccountId = oauthResult.accountId || null;
    const workspaceAccountId = oauthResult.workspaceId || chatgptAccountId || null;
    const isPersonalAccount = !workspaceAccountId || workspaceAccountId === chatgptAccountId;
    return {
      email: oauthResult.email && isPersonalAccount ? oauthResult.email : workspaceAccountId ? `codex-${workspaceAccountId}` : `codex-${Date.now()}`,
      accountId: chatgptAccountId,
      dedupeByAccountId: !workspaceAccountId || workspaceAccountId === chatgptAccountId,
    };
  },
  device: {
    emailPrefix: "codex",
    initiate: () => initiateCodexDeviceCodeFlow(),
    poll: (input) => pollCodexDeviceCodeAuthorization(input.deviceCode, input.userCode ?? ""),
  },
  connectSession: (sessionJson) => buildOAuthResultFromChatGPTSession(sessionJson),
};
