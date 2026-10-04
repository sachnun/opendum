import { initiateClineDeviceCodeFlow, pollClineDeviceCodeAuthorization } from "./client.js";
import type { AccountConnector } from "../connector.js";

export { initiateClineDeviceCodeFlow, pollClineDeviceCodeAuthorization } from "./client.js";
export * from "./constants.js";

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
