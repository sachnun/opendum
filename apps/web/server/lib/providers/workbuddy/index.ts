import { initiateWorkbuddyDeviceCodeFlow, pollWorkbuddyDeviceCodeAuthorization } from "./client.ts";
import type { AccountConnector } from "../connector.ts";

export { initiateWorkbuddyDeviceCodeFlow, pollWorkbuddyDeviceCodeAuthorization } from "./client.ts";
export { WORKBUDDY_BASE_URL, WORKBUDDY_DOMAIN, WORKBUDDY_PLATFORM, AUTH_STATE_PATH, AUTH_TOKEN_PATH, LOGIN_ACCOUNT_PATH, ACCOUNTS_PATH, PENDING_TOKEN_CODE, PENDING_ACCOUNT_CODE, DEVICE_CODE_EXPIRY_SECONDS, POLLING_INTERVAL_SECONDS } from "./constants.ts";

export const connector: AccountConnector = {
  name: "workbuddy",
  label: "WorkBuddy",
  device: {
    emailPrefix: "workbuddy",
    initiate: async () => {
      const result = await initiateWorkbuddyDeviceCodeFlow();
      return {
        deviceCode: result.deviceCode,
        userCode: result.userCode,
        verificationUrl: result.verificationUrl,
        verificationUrlComplete: result.verificationUrlComplete,
        expiresIn: result.expiresIn,
        interval: result.interval,
      };
    },
    poll: (input) => pollWorkbuddyDeviceCodeAuthorization(input.deviceCode),
  },
};
