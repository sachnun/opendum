import type { ContractRouterClient } from "@orpc/contract";

import { accountsContract } from "./accounts.js";
import { adminContract } from "./admin.js";
import { analyticsContract } from "./analytics.js";
import { eventsContract } from "./events.js";
import { keysContract } from "./keys.js";
import { modelsContract } from "./models.js";
import { playgroundContract } from "./playground.js";
import { pointsContract } from "./points.js";
import { providersContract } from "./providers.js";
import { sessionContract } from "./session.js";
import { sharingContract } from "./sharing.js";

export const contract = {
  models: modelsContract,
  events: eventsContract,
  admin: adminContract,
  accounts: accountsContract,
  keys: keysContract,
  providers: providersContract,
  analytics: analyticsContract,
  session: sessionContract,
  points: pointsContract,
  sharing: sharingContract,
  playground: playgroundContract,
};

export type ApiContract = typeof contract;
export type ApiContractClient = ContractRouterClient<ApiContract>;

export * from "./accounts.js";
export * from "./admin.js";
export * from "./analytics.js";
export * from "./common.js";
export * from "./events.js";
export * from "./keys.js";
export * from "./models.js";
export * from "./playground.js";
export * from "./points.js";
export * from "./providers.js";
export * from "./session.js";
export * from "./sharing.js";
