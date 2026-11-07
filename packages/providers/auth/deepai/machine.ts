import { createHash } from "node:crypto";
import {
  API_KEY_HEADER,
  INSTANCE_HEADER,
  LANE_HEADER,
  LANE_VERSION,
  MACHINE_HEADER,
} from "@opendum/providers/auth/deepai/constants";

export function deepaiMachineId(apiKey: string): string {
  return createHash("sha256").update(apiKey.trim()).digest("hex");
}

export function deepaiHeaders(
  apiKey: string,
  instance: string = crypto.randomUUID().replaceAll("-", "")
): Record<string, string> {
  const key = apiKey.trim();
  return {
    [API_KEY_HEADER]: key,
    [LANE_HEADER]: LANE_VERSION,
    [INSTANCE_HEADER]: instance,
    [MACHINE_HEADER]: deepaiMachineId(key),
  };
}
