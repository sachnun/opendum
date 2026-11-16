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
  oauthAccessToken,
  oauthClient,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
} from "@opendum/database/schema/index";

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
  oauthClients: many(oauthClient),
  oauthAccessTokens: many(oauthAccessToken),
  oauthRefreshTokens: many(oauthRefreshToken),
  oauthConsents: many(oauthConsent),
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

export const sessionRelations = relations(session, ({ one, many }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
  oauthAccessTokens: many(oauthAccessToken),
  oauthRefreshTokens: many(oauthRefreshToken),
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

export const oauthClientRelations = relations(oauthClient, ({ one, many }) => ({
  user: one(user, {
    fields: [oauthClient.userId],
    references: [user.id],
  }),
  resources: many(oauthClientResource),
  accessTokens: many(oauthAccessToken),
  refreshTokens: many(oauthRefreshToken),
  consents: many(oauthConsent),
}));

export const oauthResourceRelations = relations(oauthResource, ({ many }) => ({
  clients: many(oauthClientResource),
}));

export const oauthClientResourceRelations = relations(
  oauthClientResource,
  ({ one }) => ({
    client: one(oauthClient, {
      fields: [oauthClientResource.clientId],
      references: [oauthClient.clientId],
    }),
    resource: one(oauthResource, {
      fields: [oauthClientResource.resourceId],
      references: [oauthResource.identifier],
    }),
  }),
);

export const oauthRefreshTokenRelations = relations(oauthRefreshToken, ({ one, many }) => ({
  client: one(oauthClient, {
    fields: [oauthRefreshToken.clientId],
    references: [oauthClient.clientId],
  }),
  session: one(session, {
    fields: [oauthRefreshToken.sessionId],
    references: [session.id],
  }),
  user: one(user, {
    fields: [oauthRefreshToken.userId],
    references: [user.id],
  }),
  accessTokens: many(oauthAccessToken),
}));

export const oauthAccessTokenRelations = relations(oauthAccessToken, ({ one }) => ({
  client: one(oauthClient, {
    fields: [oauthAccessToken.clientId],
    references: [oauthClient.clientId],
  }),
  session: one(session, {
    fields: [oauthAccessToken.sessionId],
    references: [session.id],
  }),
  user: one(user, {
    fields: [oauthAccessToken.userId],
    references: [user.id],
  }),
  refreshToken: one(oauthRefreshToken, {
    fields: [oauthAccessToken.refreshId],
    references: [oauthRefreshToken.id],
  }),
}));

export const oauthConsentRelations = relations(oauthConsent, ({ one }) => ({
  client: one(oauthClient, {
    fields: [oauthConsent.clientId],
    references: [oauthClient.clientId],
  }),
  user: one(user, {
    fields: [oauthConsent.userId],
    references: [user.id],
  }),
}));
