import { PROVIDER_CONNECTORS as raw } from "virtual:opendum-provider-connectors";
import type { AccountConnector } from "./connector";

export const PROVIDER_CONNECTORS = raw as Record<string, AccountConnector>;
export * from "./connector";
export * from "./types";
