import { oc } from "@orpc/contract";
import { z } from "zod";

const MAX_API_KEY_ACCESS_ENTRIES = 500;
const MAX_API_KEY_RATE_LIMIT_RULES = 500;
const emptyInputSchema = z.object({});
const apiKeyIdSchema = z.string().trim().min(1);

const apiKeyIdInputSchema = z.object({ id: apiKeyIdSchema });
const createApiKeyInputSchema = z.object({ name: z.string().max(120).optional(), expiresAt: z.coerce.date().nullable().optional() }).optional();
const updateApiKeyNameInputSchema = z.object({ id: apiKeyIdSchema, name: z.string().max(120), key: z.string().optional() });
const updateApiKeyExpirationInputSchema = z.object({ id: apiKeyIdSchema, expiresAt: z.coerce.date().nullable() });
const updateApiKeyRoamingInputSchema = z.object({ id: apiKeyIdSchema, enabled: z.boolean() });
export const apiKeyAccessModeSchema = z.enum(["all", "whitelist", "blacklist"]);
const rateLimitRuleSchema = z.object({
  target: z.string().trim().min(1),
  targetType: z.enum(["model", "family"]),
  perMinute: z.number().int().nullable(),
  perHour: z.number().int().nullable(),
  perDay: z.number().int().nullable(),
});
const updateApiKeyModelAccessInputSchema = z.object({ id: apiKeyIdSchema, mode: apiKeyAccessModeSchema, models: z.array(z.string().trim().min(1)).max(MAX_API_KEY_ACCESS_ENTRIES) });
const updateApiKeyAccountAccessInputSchema = z.object({ id: apiKeyIdSchema, mode: apiKeyAccessModeSchema, accounts: z.array(z.string().trim().min(1)).max(MAX_API_KEY_ACCESS_ENTRIES) });
const updateApiKeyRateLimitsInputSchema = z.object({ id: apiKeyIdSchema, rules: z.array(rateLimitRuleSchema).max(MAX_API_KEY_RATE_LIMIT_RULES) });

export const apiKeysContract = {
  list: oc.input(emptyInputSchema),
  options: oc.input(emptyInputSchema),
  create: oc.input(createApiKeyInputSchema),
  remove: oc.input(apiKeyIdInputSchema),
  name: oc.input(updateApiKeyNameInputSchema),
  expiration: oc.input(updateApiKeyExpirationInputSchema),
  roaming: oc.input(updateApiKeyRoamingInputSchema),
  modelAccess: oc.input(updateApiKeyModelAccessInputSchema),
  accountAccess: oc.input(updateApiKeyAccountAccessInputSchema),
  rateLimits: oc.input(updateApiKeyRateLimitsInputSchema),
  reveal: oc.input(apiKeyIdInputSchema),
  toggle: oc.input(apiKeyIdInputSchema),
};

export type ApiKeyAccessMode = z.infer<typeof apiKeyAccessModeSchema>;
export type ApiKeyIdInput = z.infer<typeof apiKeyIdInputSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;
export type UpdateApiKeyNameInput = z.infer<typeof updateApiKeyNameInputSchema>;
export type UpdateApiKeyExpirationInput = z.infer<typeof updateApiKeyExpirationInputSchema>;
export type UpdateApiKeyRoamingInput = z.infer<typeof updateApiKeyRoamingInputSchema>;
export type UpdateApiKeyModelAccessInput = z.infer<typeof updateApiKeyModelAccessInputSchema>;
export type UpdateApiKeyAccountAccessInput = z.infer<typeof updateApiKeyAccountAccessInputSchema>;
export type UpdateApiKeyRateLimitsInput = z.infer<typeof updateApiKeyRateLimitsInputSchema>;
