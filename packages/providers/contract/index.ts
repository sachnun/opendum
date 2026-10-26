import type { ContractRouterClient } from "@orpc/contract";

import { accountsContract } from "@opendum/providers/contract/accounts";
import { adminContract } from "@opendum/providers/contract/admin";
import { analyticsContract } from "@opendum/providers/contract/analytics";
import { eventsContract } from "@opendum/providers/contract/events";
import { keysContract } from "@opendum/providers/contract/keys";
import { modelsContract } from "@opendum/providers/contract/models";
import { playgroundContract } from "@opendum/providers/contract/playground";
import { pointsContract } from "@opendum/providers/contract/points";
import { providersContract } from "@opendum/providers/contract/providers";
import { sessionContract } from "@opendum/providers/contract/session";
import { sharingContract } from "@opendum/providers/contract/sharing";

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

export * from "@opendum/providers/contract/accounts";
export * from "@opendum/providers/contract/admin";
export * from "@opendum/providers/contract/analytics";
export * from "@opendum/providers/contract/common";
export * from "@opendum/providers/contract/events";
export * from "@opendum/providers/contract/keys";
export * from "@opendum/providers/contract/models";
export * from "@opendum/providers/contract/playground";
export * from "@opendum/providers/contract/points";
export * from "@opendum/providers/contract/providers";
export * from "@opendum/providers/contract/session";
export * from "@opendum/providers/contract/sharing";
