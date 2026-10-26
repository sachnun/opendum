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

export const modelItem = z.object({
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

export const searchItem = modelItem.omit({ name: true, family: true, stats: true });

export const statsData = z.record(z.string(), modelStatsSchema);

export const familyCounts = z.record(z.string(), z.number());
export const modelCatalogSchema = z.array(z.string());

export const enableModelResult = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), data: z.object({ model: z.string(), enabled: z.boolean() }) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

export const modelsInput = z.object({ includeStats: z.boolean().optional() });
export const statsInput = z.object({
  models: z.array(z.string()),
});
export const enableModelInput = z.object({ modelId: z.string(), enabled: z.boolean() });

export const modelsContract = {
  list: oc.input(modelsInput.optional()).output(z.array(modelItem)),
  search: oc.output(z.array(searchItem)),
  catalog: oc.output(modelCatalogSchema),
  stats: oc.input(statsInput).output(statsData),
  families: oc.output(familyCounts),
  enable: oc.input(enableModelInput).output(enableModelResult),
};

export type ModelListItem = z.infer<typeof modelItem>;
export type ModelSearchItem = z.infer<typeof searchItem>;
export type ModelStats = z.infer<typeof modelStatsSchema>;
export type ModelStatsData = z.infer<typeof statsData>;
export type EnableModelResult = z.infer<typeof enableModelResult>;
export type EnableModelInput = z.infer<typeof enableModelInput>;
export type ListModelsInput = z.infer<typeof modelsInput>;
export type ModelStatsInput = z.infer<typeof statsInput>;
