import { relations } from "drizzle-orm";
import {
  user,
  session,
  account,
  providerAccount,
  proxyApiKey,
  usageLog,
  disabledModel,
} from "./schema";

// ---------------------------------------------------------------------------
// User relations
// ---------------------------------------------------------------------------

export const userRelations = relations(user, ({ many }) => ({
  accounts: many(account),
  sessions: many(session),
  providerAccounts: many(providerAccount),
  proxyApiKeys: many(proxyApiKey),
  usageLogs: many(usageLog),
  disabledModels: many(disabledModel),
}));

// ---------------------------------------------------------------------------
// Better Auth table relations
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Application table relations
// ---------------------------------------------------------------------------

export const providerAccountRelations = relations(
  providerAccount,
  ({ one, many }) => ({
    user: one(user, {
      fields: [providerAccount.userId],
      references: [user.id],
    }),
    usageLogs: many(usageLog),
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
