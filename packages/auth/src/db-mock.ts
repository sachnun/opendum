import { mock } from "node:test";

export function mockDatabaseQueries(): void {
  mock.module("@opendum/database/queries", {
    namedExports: {
      deactivateAPIKey: async () => {},
      getAPIKeyByHash: async () => null,
      listDisabledModelsByUser: async () => [],
      listAPIKeyRateLimits: async () => [],
      touchAPIKeyLastUsed: async () => {},
      listActiveAccountTiers: async () => [],
      listDisabledModelsByAccounts: async () => [],
      listSharedAccounts: async () => [],
      getCustomProvider: async () => null,
      listCustomProviderModels: async () => [],
      listCustomProviders: async () => [],
    },
  });
}
