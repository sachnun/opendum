import { flag } from "flags/next";
import { vercelAdapter } from "@flags-sdk/vercel";

const maintenanceModeAdapter = process.env.FLAGS ? vercelAdapter<boolean, unknown>() : null;

export const maintenanceMode = flag<boolean>({
  key: "maintenance-mode",
  ...(maintenanceModeAdapter
    ? { adapter: maintenanceModeAdapter }
    : {
        decide: async () => false,
      }),
  defaultValue: false,
  description: "When enabled, the app returns a maintenance page/response for all routes",
  options: [
    { value: true, label: "On" },
    { value: false, label: "Off" },
  ],
});
