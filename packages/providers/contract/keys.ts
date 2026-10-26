import { oc } from "@orpc/contract";
import { z } from "zod";

import { emptyInputSchema } from "./common.js";

const ACCESS_ENTRY_LIMIT = 500;
const RATE_RULE_LIMIT = 500;
const keyIdSchema = z.string().trim().min(1);

const idInputSchema = z.object({ id: keyIdSchema });
const createSchema = z.object({ name: z.string().max(120).optional(), expiresAt: z.coerce.date().nullable().optional() }).optional();
const nameSchema = z.object({ id: keyIdSchema, name: z.string().max(120), key: z.string().optional() });
const expirationSchema = z.object({ id: keyIdSchema, expiresAt: z.coerce.date().nullable() });
const roamingSchema = z.object({ id: keyIdSchema, enabled: z.boolean() });
export const accessModeSchema = z.enum(["all", "whitelist", "blacklist"]);
const rateRuleSchema = z.object({
  target: z.string().trim().min(1),
  targetType: z.enum(["model", "family"]),
  perMinute: z.number().int().nullable(),
  perHour: z.number().int().nullable(),
  perDay: z.number().int().nullable(),
});
const modelAccessSchema = z.object({ id: keyIdSchema, mode: accessModeSchema, models: z.array(z.string().trim().min(1)).max(ACCESS_ENTRY_LIMIT) });
const accountAccessSchema = z.object({ id: keyIdSchema, mode: accessModeSchema, accounts: z.array(z.string().trim().min(1)).max(ACCESS_ENTRY_LIMIT) });
const rateLimitsSchema = z.object({ id: keyIdSchema, rules: z.array(rateRuleSchema).max(RATE_RULE_LIMIT) });

export const keysContract = {
  list: oc.input(emptyInputSchema),
  options: oc.input(emptyInputSchema),
  create: oc.input(createSchema),
  delete: oc.input(idInputSchema),
  rename: oc.input(nameSchema),
  expire: oc.input(expirationSchema),
  roaming: oc.input(roamingSchema),
  models: oc.input(modelAccessSchema),
  accounts: oc.input(accountAccessSchema),
  limits: oc.input(rateLimitsSchema),
  reveal: oc.input(idInputSchema),
  toggle: oc.input(idInputSchema),
};

export type AccessMode = z.infer<typeof accessModeSchema>;
export type KeyIdInput = z.infer<typeof idInputSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type NameInput = z.infer<typeof nameSchema>;
export type ExpirationInput = z.infer<typeof expirationSchema>;
export type RoamingInput = z.infer<typeof roamingSchema>;
export type ModelAccessInput = z.infer<typeof modelAccessSchema>;
export type AccountAccessInput = z.infer<typeof accountAccessSchema>;
export type RateLimitsInput = z.infer<typeof rateLimitsSchema>;
