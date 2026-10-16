import { oc } from "@orpc/contract";
import { z } from "zod";

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

export const opsContract = {
  accountQuota: oc.input(quotaInputSchema).output(quotaResultSchema),
  relay: oc.input(relayInputSchema).output(relayResultSchema),
};

export type QuotaInput = z.infer<typeof quotaInputSchema>;
export type QuotaResult = z.infer<typeof quotaResultSchema>;
export type RelayInput = z.infer<typeof relayInputSchema>;
export type RelayResult = z.infer<typeof relayResultSchema>;
