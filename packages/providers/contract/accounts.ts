import { oc } from "@orpc/contract";
import { z } from "zod";

import { emptyInputSchema } from "@opendum/providers/contract/common";
import { DEVICE_PROVIDER_KEYS, OAUTH_PROVIDER_KEYS, QUOTA_PROVIDER_KEYS } from "@opendum/providers/provider-accounts";

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const QUOTA_BATCH_LIMIT = 100;

const accountIdSchema = z.string().trim().min(1);
const providerInputSchema = z.object({ provider: z.string().trim().toLowerCase().regex(PROVIDER_KEY_PATTERN, "Invalid provider") });
const detailSchema = providerInputSchema;
const overviewSchema = z.object({});
const statsSchema = z.object({
  accountIds: z.array(accountIdSchema).max(50),
});
const createSchema = z.object({
  provider: z.string(),
  name: z.string().optional(),
  token: z.string(),
  cfAccountId: z.string().optional(),
  platformKey: z.string().optional(),
});
const updateSchema = z.object({
  id: accountIdSchema,
  name: z.string().max(120).optional(),
  isActive: z.boolean().optional(),
  disabledUntil: z.coerce.date().nullable().optional(),
});
const deleteSchema = z.object({ id: accountIdSchema });
const pinToggleSchema = z.object({ providerKey: z.string().trim().min(1) });
const modelToggleSchema = z.object({ accountId: accountIdSchema, modelId: z.string().trim().min(1), enabled: z.boolean() });
const historySchema = z.object({ accountId: accountIdSchema, limit: z.coerce.number().int().min(1).max(200).optional() });
const historyBatchSchema = z.object({ accountIds: z.array(accountIdSchema).max(50), limit: z.coerce.number().int().min(1).max(200).optional() });
const resolveSchema = z.object({ accountId: accountIdSchema });
const sessionSchema = z.object({ id: accountIdSchema });
const authUrlSchema = z.object({ provider: z.enum([...OAUTH_PROVIDER_KEYS]) });
const oauthExchangeSchema = z.object({
  provider: z.enum([...OAUTH_PROVIDER_KEYS]),
  callbackUrl: z.string(),
  state: z.string().nullable().optional(),
  codeVerifier: z.string().nullable().optional(),
});
const deviceAuthSchema = z.object({ provider: z.enum([...DEVICE_PROVIDER_KEYS]), method: z.string().optional() });
const devicePollSchema = z.object({
  provider: z.enum([...DEVICE_PROVIDER_KEYS]),
  deviceCode: z.string(),
  userCode: z.string().optional(),
  codeVerifier: z.string().optional(),
  method: z.string().optional(),
  machineId: z.string().optional(),
});
const codexSessionSchema = z.object({ sessionJson: z.string().min(1, "Session JSON is required") });
const quotaSchema = z.object({
  provider: z.enum([...QUOTA_PROVIDER_KEYS]),
  accountId: accountIdSchema,
  forceRefresh: z.boolean().optional(),
});
const quotaBatchSchema = z.object({
  provider: z.enum([...QUOTA_PROVIDER_KEYS]),
  accountIds: z.array(accountIdSchema).min(1).max(QUOTA_BATCH_LIMIT),
  forceRefresh: z.boolean().optional(),
});

export const accountsContract = {
  list: oc.input(emptyInputSchema),
  overview: oc.input(overviewSchema),
  ping: oc.input(emptyInputSchema),
  provider: oc.input(providerInputSchema),
  detail: oc.input(detailSchema),
  stats: oc.input(statsSchema),
  create: oc.input(createSchema),
  update: oc.input(updateSchema),
  delete: oc.input(deleteSchema),
  pin: oc.input(pinToggleSchema),
  enable: oc.input(modelToggleSchema),
  error: oc.input(historySchema),
  errors: oc.input(historyBatchSchema),
  resolve: oc.input(resolveSchema),
  session: oc.input(sessionSchema),
  auth: oc.input(authUrlSchema),
  exchange: oc.input(oauthExchangeSchema),
  initiate: oc.input(deviceAuthSchema),
  poll: oc.input(devicePollSchema),
  codex: oc.input(codexSessionSchema),
  quota: oc.input(quotaSchema),
  quotas: oc.input(quotaBatchSchema),
};

export type ProviderInput = z.infer<typeof providerInputSchema>;
export type ProviderDetailInput = z.infer<typeof detailSchema>;
export type AccountOverviewInput = z.infer<typeof overviewSchema>;
export type AccountStatsInput = z.infer<typeof statsSchema>;
export type CreateAccountInput = z.infer<typeof createSchema>;
export type UpdateAccountInput = z.infer<typeof updateSchema>;
export type DeleteAccountInput = z.infer<typeof deleteSchema>;
export type PinToggleInput = z.infer<typeof pinToggleSchema>;
export type ModelToggleInput = z.infer<typeof modelToggleSchema>;
export type ErrorHistoryInput = z.infer<typeof historySchema>;
export type HistoryBatchInput = z.infer<typeof historyBatchSchema>;
export type ResolveErrorsInput = z.infer<typeof resolveSchema>;
export type AccountSessionInput = z.infer<typeof sessionSchema>;
export type AuthUrlInput = z.infer<typeof authUrlSchema>;
export type ExchangeInput = z.infer<typeof oauthExchangeSchema>;
export type DeviceAuthInput = z.infer<typeof deviceAuthSchema>;
export type DevicePollInput = z.infer<typeof devicePollSchema>;
export type CodexSessionInput = z.infer<typeof codexSessionSchema>;
export type AccountQuotaInput = z.infer<typeof quotaSchema>;
export type QuotaBatchInput = z.infer<typeof quotaBatchSchema>;
export type EmptyInput = z.infer<typeof emptyInputSchema>;
