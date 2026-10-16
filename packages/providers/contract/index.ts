import type { ContractRouterClient } from "@orpc/contract";

import { accountsContract } from "./accounts.js";
import { analyticsContract } from "./analytics.js";
import { apiKeysContract } from "./apiKeys.js";
import { customProvidersContract } from "./customProviders.js";
import { eventsContract } from "./events.js";
import { maintainerContract, meContract, playgroundContract, pointsContract, sharingContract } from "./misc.js";
import { modelsContract } from "./models.js";
import { opsContract } from "./ops.js";

export const contract = {
  models: modelsContract,
  events: eventsContract,
  ops: opsContract,
  accounts: accountsContract,
  apiKeys: apiKeysContract,
  customProviders: customProvidersContract,
  analytics: analyticsContract,
  me: meContract,
  points: pointsContract,
  sharing: sharingContract,
  playground: playgroundContract,
  maintainer: maintainerContract,
};

export type ApiContract = typeof contract;
export type ApiContractClient = ContractRouterClient<ApiContract>;

export * from "./accounts.js";
export * from "./analytics.js";
export * from "./apiKeys.js";
export * from "./customProviders.js";
export * from "./events.js";
export * from "./misc.js";
export * from "./models.js";
export * from "./ops.js";
