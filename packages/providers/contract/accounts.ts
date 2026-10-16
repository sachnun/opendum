import { oc } from "@orpc/contract";
import { z } from "zod";

import { emptyInputSchema } from "./common.js";
import { DEVICE_PROVIDER_KEYS, OAUTH_PROVIDER_KEYS, QUOTA_PROVIDER_KEYS } from "../provider-accounts.js";

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_QUOTA_BATCH_ACCOUNTS = 100;

const accountIdSchema = z.string().trim().min(1);
const providerInputSchema = z.object({ provider: z.string().trim().toLowerCase().regex(PROVIDER_KEY_PATTERN, "Invalid provider") });
const providerDetailInputSchema = providerInputSchema.extend({ cursor: z.string().min(1).optional() });
const accountOverviewInputSchema = z.object({ cursor: z.string().min(1).optional() });
const accountStatsInputSchema = z.object({
  accountIds: z.array(accountIdSchema).max(50),
  cursors: z.record(z.string(), z.string()).optional(),
});
const createAccountInputSchema = z.object({
  provider: z.string(),
  name: z.string().optional(),
  token: z.string(),
  cfAccountId: z.string().optional(),
  platformKey: z.string().optional(),
});
const updateAccountInputSchema = z.object({
  id: accountIdSchema,
  name: z.string().max(120).optional(),
  isActive: z.boolean().optional(),
  disabledUntil: z.coerce.date().nullable().optional(),
});
const deleteAccountInputSchema = z.object({ id: accountIdSchema });
const togglePinnedProviderInputSchema = z.object({ providerKey: z.string().trim().min(1) });
const setAccountModelEnabledInputSchema = z.object({ accountId: accountIdSchema, modelId: z.string().trim().min(1), enabled: z.boolean() });
const errorHistoryInputSchema = z.object({ accountId: accountIdSchema, limit: z.coerce.number().int().min(1).max(200).optional() });
const errorHistoryBatchInputSchema = z.object({ accountIds: z.array(accountIdSchema).max(50), limit: z.coerce.number().int().min(1).max(200).optional() });
const resolveErrorsInputSchema = z.object({ accountId: accountIdSchema });
const accountSessionInputSchema = z.object({ id: accountIdSchema });
const getAuthUrlInputSchema = z.object({ provider: z.enum([...OAUTH_PROVIDER_KEYS]) });
const exchangeOAuthInputSchema = z.object({
  provider: z.enum([...OAUTH_PROVIDER_KEYS]),
  callbackUrl: z.string(),
  state: z.string().nullable().optional(),
  codeVerifier: z.string().nullable().optional(),
});
const initiateDeviceAuthInputSchema = z.object({ provider: z.enum([...DEVICE_PROVIDER_KEYS]), method: z.string().optional() });
const pollDeviceAuthInputSchema = z.object({
  provider: z.enum([...DEVICE_PROVIDER_KEYS]),
  deviceCode: z.string(),
  userCode: z.string().optional(),
  codeVerifier: z.string().optional(),
  method: z.string().optional(),
  machineId: z.string().optional(),
});
const connectCodexSessionInputSchema = z.object({ sessionJson: z.string().min(1, "Session JSON is required") });
const accountQuotaInputSchema = z.object({
  provider: z.enum([...QUOTA_PROVIDER_KEYS]),
  accountId: accountIdSchema,
  forceRefresh: z.boolean().optional(),
});
const accountQuotaBatchInputSchema = z.object({
  provider: z.enum([...QUOTA_PROVIDER_KEYS]),
  accountIds: z.array(accountIdSchema).min(1).max(MAX_QUOTA_BATCH_ACCOUNTS),
  forceRefresh: z.boolean().optional(),
});

export const accountsContract = {
  list: oc.input(emptyInputSchema),
  overview: oc.input(accountOverviewInputSchema),
  ping: oc.input(emptyInputSchema),
  provider: oc.input(providerInputSchema),
  detail: oc.input(providerDetailInputSchema),
  stats: oc.input(accountStatsInputSchema),
  create: oc.input(createAccountInputSchema),
  update: oc.input(updateAccountInputSchema),
  delete: oc.input(deleteAccountInputSchema),
  pin: oc.input(togglePinnedProviderInputSchema),
  enable: oc.input(setAccountModelEnabledInputSchema),
  error: oc.input(errorHistoryInputSchema),
  errors: oc.input(errorHistoryBatchInputSchema),
  resolve: oc.input(resolveErrorsInputSchema),
  session: oc.input(accountSessionInputSchema),
  auth: oc.input(getAuthUrlInputSchema),
  exchange: oc.input(exchangeOAuthInputSchema),
  initiate: oc.input(initiateDeviceAuthInputSchema),
  poll: oc.input(pollDeviceAuthInputSchema),
  codex: oc.input(connectCodexSessionInputSchema),
  quota: oc.input(accountQuotaInputSchema),
  quotas: oc.input(accountQuotaBatchInputSchema),
};

export type ProviderInput = z.infer<typeof providerInputSchema>;
export type ProviderDetailInput = z.infer<typeof providerDetailInputSchema>;
export type AccountOverviewInput = z.infer<typeof accountOverviewInputSchema>;
export type AccountStatsInput = z.infer<typeof accountStatsInputSchema>;
export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountInputSchema>;
export type DeleteAccountInput = z.infer<typeof deleteAccountInputSchema>;
export type TogglePinnedProviderInput = z.infer<typeof togglePinnedProviderInputSchema>;
export type SetAccountModelEnabledInput = z.infer<typeof setAccountModelEnabledInputSchema>;
export type ErrorHistoryInput = z.infer<typeof errorHistoryInputSchema>;
export type ErrorHistoryBatchInput = z.infer<typeof errorHistoryBatchInputSchema>;
export type ResolveErrorsInput = z.infer<typeof resolveErrorsInputSchema>;
export type AccountSessionInput = z.infer<typeof accountSessionInputSchema>;
export type GetAuthUrlInput = z.infer<typeof getAuthUrlInputSchema>;
export type ExchangeOAuthInput = z.infer<typeof exchangeOAuthInputSchema>;
export type InitiateDeviceAuthInput = z.infer<typeof initiateDeviceAuthInputSchema>;
export type PollDeviceAuthInput = z.infer<typeof pollDeviceAuthInputSchema>;
export type ConnectCodexSessionInput = z.infer<typeof connectCodexSessionInputSchema>;
export type AccountQuotaInput = z.infer<typeof accountQuotaInputSchema>;
export type AccountQuotaBatchInput = z.infer<typeof accountQuotaBatchInputSchema>;
export type EmptyInput = z.infer<typeof emptyInputSchema>;
