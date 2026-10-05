import { PROVIDER_CONNECTORS as raw } from "virtual:opendum-provider-connectors";
import type { AccountConnector } from "./connector.ts";

export const PROVIDER_CONNECTORS = raw as Record<string, AccountConnector>;
export { GOOGLE_OAUTH_AUTHORIZE_URL, generateOAuthState } from "./connector.ts";
export type {
  AuthUrlResult,
  DeviceInitiation,
  DevicePollInput,
  DevicePollResult,
  AccountOptionOverrides,
  AccountConnector,
} from "./connector.ts";
export type { OAuthResult } from "./types.ts";
