import { flag } from "flags/next";
import { vercelAdapter } from "@flags-sdk/vercel";

export const maintenanceMode = flag<boolean>({
  key: "maintenance-mode",
  adapter: vercelAdapter(),
  defaultValue: false,
  description: "When enabled, the app returns a maintenance page/response for all routes",
  options: [
    { value: true, label: "On" },
    { value: false, label: "Off" },
  ],
});
