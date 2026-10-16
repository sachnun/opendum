import { oc } from "@orpc/contract";
import { z } from "zod";

export const modelModalitiesSchema = z.object({
  input: z.array(z.string()),
  output: z.array(z.string()),
});

export const modelCostSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
});

export const modelStatsSchema = z.object({
  totalRequests: z.number(),
  totalTokens: z.number(),
  successRate: z.number().nullable(),
  dailyRequests: z.array(z.object({ date: z.string(), count: z.number() })),
  avgDurationLastDay: z.number().nullable(),
  durationLast24Hours: z.array(z.object({ time: z.string(), avgDuration: z.number() })),
});

export const modelListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string(),
  providers: z.array(z.string()),
  reasoning: z.boolean().optional(),
  modalities: modelModalitiesSchema.optional(),
  cost: modelCostSchema.optional(),
  isEnabled: z.boolean(),
  available: z.boolean().optional(),
  custom: z.boolean().optional(),
  stats: modelStatsSchema.optional(),
});

export const modelSearchItemSchema = modelListItemSchema.omit({ name: true, family: true, stats: true });

export const modelStatsDataSchema = z.record(z.string(), modelStatsSchema);

export const modelFamilyCountsSchema = z.record(z.string(), z.number());
export const modelCatalogSchema = z.array(z.string());

export const setModelEnabledResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), data: z.object({ model: z.string(), enabled: z.boolean() }) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

export const listModelsInputSchema = z.object({ includeStats: z.boolean().optional() });
export const modelStatsInputSchema = z.object({
  models: z.array(z.string()),
});
export const setModelEnabledInputSchema = z.object({ modelId: z.string(), enabled: z.boolean() });

export const modelsContract = {
  list: oc.input(listModelsInputSchema.optional()).output(z.array(modelListItemSchema)),
  search: oc.output(z.array(modelSearchItemSchema)),
  catalog: oc.output(modelCatalogSchema),
  stats: oc.input(modelStatsInputSchema).output(modelStatsDataSchema),
  families: oc.output(modelFamilyCountsSchema),
  enable: oc.input(setModelEnabledInputSchema).output(setModelEnabledResultSchema),
};

export type ModelListItem = z.infer<typeof modelListItemSchema>;
export type ModelSearchItem = z.infer<typeof modelSearchItemSchema>;
export type ModelStats = z.infer<typeof modelStatsSchema>;
export type ModelStatsData = z.infer<typeof modelStatsDataSchema>;
export type SetModelEnabledResult = z.infer<typeof setModelEnabledResultSchema>;
export type SetModelEnabledInput = z.infer<typeof setModelEnabledInputSchema>;
export type ListModelsInput = z.infer<typeof listModelsInputSchema>;
export type ModelStatsInput = z.infer<typeof modelStatsInputSchema>;
