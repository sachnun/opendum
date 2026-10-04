import { initiateWorkbuddyDeviceCodeFlow, pollWorkbuddyDeviceCodeAuthorization } from "./client.js";
import type { AccountConnector } from "../connector.js";

export { initiateWorkbuddyDeviceCodeFlow, pollWorkbuddyDeviceCodeAuthorization } from "./client.js";
export * from "./constants.js";

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
