import { relations } from "drizzle-orm";
import {
  user,
  userPointBalance,
  userSharingSetting,
  session,
  account,
  providerAccount,
  accountModelHealth,
  accountDisabledModel,
  pinnedProvider,
  proxyApiKey,
  keyRateLimit,
  usageLog,
  pointTransaction,
  disabledModel,
  customProvider,
  customProviderModel,
} from "./schema/index.js";

export const userRelations = relations(user, ({ one, many }) => ({
  accounts: many(account),
  sessions: many(session),
  pointBalance: one(userPointBalance, {
    fields: [user.id],
    references: [userPointBalance.userId],
  }),
  sharingSetting: one(userSharingSetting, {
    fields: [user.id],
    references: [userSharingSetting.userId],
  }),
  pointTransactions: many(pointTransaction),
  providerAccounts: many(providerAccount),
  pinnedProviders: many(pinnedProvider),
  proxyApiKeys: many(proxyApiKey),
  usageLogs: many(usageLog),
  disabledModels: many(disabledModel),
  customProviders: many(customProvider),
}));

export const balanceRelations = relations(
  userPointBalance,
  ({ one }) => ({
    user: one(user, {
      fields: [userPointBalance.userId],
      references: [user.id],
    }),
  }),
);

export const sharingRelations = relations(
  userSharingSetting,
  ({ one }) => ({
    user: one(user, {
      fields: [userSharingSetting.userId],
      references: [user.id],
    }),
  }),
);

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const providerAccountRelations = relations(
  providerAccount,
  ({ one, many }) => ({
    user: one(user, {
      fields: [providerAccount.userId],
      references: [user.id],
    }),
    modelHealth: many(accountModelHealth),
    usageLogs: many(usageLog),
    disabledModels: many(accountDisabledModel),
  }),
);

export const keyRelations = relations(
  proxyApiKey,
  ({ one, many }) => ({
    user: one(user, {
      fields: [proxyApiKey.userId],
      references: [user.id],
    }),
    usageLogs: many(usageLog),
    rateLimits: many(keyRateLimit),
  }),
);

export const rateLimitRelations = relations(
  keyRateLimit,
  ({ one }) => ({
    apiKey: one(proxyApiKey, {
      fields: [keyRateLimit.apiKeyId],
      references: [proxyApiKey.id],
    }),
  }),
);

export const usageLogRelations = relations(usageLog, ({ one }) => ({
  user: one(user, {
    fields: [usageLog.userId],
    references: [user.id],
  }),
  providerAccount: one(providerAccount, {
    fields: [usageLog.providerAccountId],
    references: [providerAccount.id],
  }),
  proxyApiKey: one(proxyApiKey, {
    fields: [usageLog.proxyApiKeyId],
    references: [proxyApiKey.id],
  }),
}));

export const pointTransactionRelations = relations(
  pointTransaction,
  ({ one }) => ({
    user: one(user, {
      fields: [pointTransaction.userId],
      references: [user.id],
    }),
  }),
);

export const disabledModelRelations = relations(disabledModel, ({ one }) => ({
  user: one(user, {
    fields: [disabledModel.userId],
    references: [user.id],
  }),
}));

export const accountDisabledRelations = relations(
  accountDisabledModel,
  ({ one }) => ({
    providerAccount: one(providerAccount, {
      fields: [accountDisabledModel.providerAccountId],
      references: [providerAccount.id],
    }),
  }),
);

export const pinnedProviderRelations = relations(pinnedProvider, ({ one }) => ({
  user: one(user, {
    fields: [pinnedProvider.userId],
    references: [user.id],
  }),
}));

export const modelHealthRelations = relations(
  accountModelHealth,
  ({ one }) => ({
    providerAccount: one(providerAccount, {
      fields: [accountModelHealth.providerAccountId],
      references: [providerAccount.id],
    }),
  }),
);

export const customProviderRelations = relations(
  customProvider,
  ({ one, many }) => ({
    user: one(user, {
      fields: [customProvider.userId],
      references: [user.id],
    }),
    models: many(customProviderModel),
  }),
);

export const customModelRelations = relations(
  customProviderModel,
  ({ one }) => ({
    provider: one(customProvider, {
      fields: [customProviderModel.providerId],
      references: [customProvider.id],
    }),
  }),
);
