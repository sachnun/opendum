import { oc } from "@orpc/contract";
import { z } from "zod";

const MAX_USER_SEARCH_LIMIT = 30;

export const quotaInputSchema = z.object({
  userId: z.string().optional(),
  provider: z.string().optional(),
  accountId: z.string().optional(),
  forceRefresh: z.boolean().optional(),
});

export const quotaResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), data: z.unknown() }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

export const relayInputSchema = z.object({
  url: z.string().optional(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});

export const relayResultSchema = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

export const userSearchInputSchema = z.object({
  q: z.string().trim().max(120).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(MAX_USER_SEARCH_LIMIT).default(12),
});

export const adminContract = {
  quota: oc.input(quotaInputSchema).output(quotaResultSchema),
  relay: oc.input(relayInputSchema).output(relayResultSchema),
  users: oc.input(userSearchInputSchema),
};

export type QuotaInput = z.infer<typeof quotaInputSchema>;
export type QuotaResult = z.infer<typeof quotaResultSchema>;
export type RelayInput = z.infer<typeof relayInputSchema>;
export type RelayResult = z.infer<typeof relayResultSchema>;
export type AdminUserSearchInput = z.infer<typeof userSearchInputSchema>;
