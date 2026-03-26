import { relations } from "drizzle-orm";
import {
  user,
  session,
  account,
  providerAccount,
  providerAccountErrorHistory,
  providerAccountDisabledModel,
  proxyApiKey,
  proxyApiKeyRateLimit,
  usageLog,
  disabledModel,
} from "./schema.js";

export const userRelations = relations(user, ({ many }) => ({
  accounts: many(account),
  sessions: many(session),
  providerAccounts: many(providerAccount),
  providerAccountErrorHistoryEntries: many(providerAccountErrorHistory),
  proxyApiKeys: many(proxyApiKey),
  usageLogs: many(usageLog),
  disabledModels: many(disabledModel),
}));

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
