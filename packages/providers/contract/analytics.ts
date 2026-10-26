import { oc } from "@orpc/contract";
import { z } from "zod";

const periodSchema = z.enum(["5m", "15m", "30m", "1h", "6h", "24h", "7d", "30d", "90d"]);
const analyticsFilterSchema = z.union([periodSchema, z.object({ from: z.string().min(1), to: z.string().min(1) })]);
const baseInput = z.object({ filter: analyticsFilterSchema.optional(), apiKeyId: z.string().trim().min(1).optional() });
const dataInput = baseInput.extend({ includeSeries: z.boolean().optional() }).optional();
const seriesInput = baseInput.optional();
const usageInput = z.object({ range: periodSchema.default("30d") }).optional();
const emptyInputSchema = z.object({});

export const analyticsContract = {
  data: oc.input(dataInput),
  series: oc.input(seriesInput),
  overview: oc.input(emptyInputSchema),
  usage: oc.input(usageInput),
};

export type AnalyticsPeriod = z.infer<typeof periodSchema>;
export type AnalyticsFilterInput = z.infer<typeof analyticsFilterSchema>;
export type AnalyticsDataInput = z.infer<typeof dataInput>;
export type AnalyticsSeriesInput = z.infer<typeof seriesInput>;
export type AnalyticsUsageInput = z.infer<typeof usageInput>;
