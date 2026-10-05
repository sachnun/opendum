import { initiateClineDeviceCodeFlow, pollClineDeviceCodeAuthorization } from "./client.ts";
import type { AccountConnector } from "../connector.ts";

export { initiateClineDeviceCodeFlow, pollClineDeviceCodeAuthorization } from "./client.ts";
export { CLINE_BASE_URL, WORKOS_BASE_URL, CLIENT_ID, DEVICE_AUTHORIZE_PATH, DEVICE_AUTHENTICATE_PATH, CLINE_REGISTER_PATH, DEVICE_CODE_EXPIRY_SECONDS, POLLING_INTERVAL_SECONDS, ACCESS_TOKEN_TTL_SECONDS } from "./constants.ts";

export const connector: AccountConnector = {
  name: "cline",
  label: "Cline",
  device: {
    emailPrefix: "cline",
    initiate: async () => {
      const result = await initiateClineDeviceCodeFlow();
      return {
        deviceCode: result.deviceCode,
        userCode: result.userCode,
        verificationUrl: result.verificationUrl,
        verificationUrlComplete: result.verificationUrlComplete,
        expiresIn: result.expiresIn,
        interval: result.interval,
      };
    },
    poll: (input) => pollClineDeviceCodeAuthorization(input.deviceCode),
  },
};
