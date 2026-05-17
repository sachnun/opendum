import { relations } from "drizzle-orm";
import {
  user,
  userPointBalance,
  userSharingSetting,
  session,
  account,
  providerAccount,
  providerAccountErrorHistory,
  providerAccountModelHealth,
  providerAccountDisabledModel,
  pinnedProvider,
  proxyApiKey,
  proxyApiKeyRateLimit,
  usageLog,
  pointTransaction,
  disabledModel,
} from "./schema.js";

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
  providerAccountErrorHistoryEntries: many(providerAccountErrorHistory),
  pinnedProviders: many(pinnedProvider),
  proxyApiKeys: many(proxyApiKey),
  usageLogs: many(usageLog),
  disabledModels: many(disabledModel),
}));

export const userPointBalanceRelations = relations(
  userPointBalance,
  ({ one }) => ({
    user: one(user, {
      fields: [userPointBalance.userId],
      references: [user.id],
    }),
  }),
);

export const userSharingSettingRelations = relations(
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
    errorHistory: many(providerAccountErrorHistory),
    modelHealth: many(providerAccountModelHealth),
    usageLogs: many(usageLog),
    disabledModels: many(providerAccountDisabledModel),
  }),
);

export const providerAccountErrorHistoryRelations = relations(
  providerAccountErrorHistory,
  ({ one }) => ({
    user: one(user, {
      fields: [providerAccountErrorHistory.userId],
      references: [user.id],
    }),
    providerAccount: one(providerAccount, {
      fields: [providerAccountErrorHistory.providerAccountId],
      references: [providerAccount.id],
    }),
  }),
);

export const proxyApiKeyRelations = relations(
  proxyApiKey,
  ({ one, many }) => ({
    user: one(user, {
      fields: [proxyApiKey.userId],
      references: [user.id],
    }),
    usageLogs: many(usageLog),
    rateLimits: many(proxyApiKeyRateLimit),
  }),
);

export const proxyApiKeyRateLimitRelations = relations(
  proxyApiKeyRateLimit,
  ({ one }) => ({
    apiKey: one(proxyApiKey, {
      fields: [proxyApiKeyRateLimit.apiKeyId],
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
    usageLog: one(usageLog, {
      fields: [pointTransaction.usageLogId],
      references: [usageLog.id],
    }),
  }),
);

export const disabledModelRelations = relations(disabledModel, ({ one }) => ({
  user: one(user, {
    fields: [disabledModel.userId],
    references: [user.id],
  }),
}));

export const providerAccountDisabledModelRelations = relations(
  providerAccountDisabledModel,
  ({ one }) => ({
    providerAccount: one(providerAccount, {
      fields: [providerAccountDisabledModel.providerAccountId],
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

export const providerAccountModelHealthRelations = relations(
  providerAccountModelHealth,
  ({ one }) => ({
    providerAccount: one(providerAccount, {
      fields: [providerAccountModelHealth.providerAccountId],
      references: [providerAccount.id],
    }),
  }),
);
