import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

import { modelListItemSchema, modelStatsSchema } from "./models.js";

const dateSchema = z.union([z.string(), z.date()]);
const nullableDateSchema = dateSchema.nullable();

export const liveTopicSchema = z.enum(["points", "accounts", "models", "usage"]);

export const providerStatsSchema = z.object({
  totalRequests: z.number(),
  totalTokens: z.number(),
  successRate: z.number().nullable(),
  dailyRequests: z.array(z.object({ date: z.string(), count: z.number() })),
  avgDurationLastDay: z.number().nullable(),
  durationLast24Hours: z.array(z.object({ time: z.string(), avgDuration: z.number() })),
});

export const accountOverviewSchema = z.object({
  summaries: z.record(z.string(), z.object({
    connected: z.number(),
    active: z.number(),
    indicator: z.enum(["normal", "warning", "error"]),
    stats: providerStatsSchema,
  })),
  pinnedProviders: z.array(z.string()),
});

export const accountModelHealthSchema = z.object({
  status: z.string(),
  consecutiveErrors: z.number(),
  lastErrorAt: nullableDateSchema,
  lastSuccessAt: nullableDateSchema,
});

export const providerAccountSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  isActive: z.boolean(),
  disabledUntil: nullableDateSchema,
  lastUsedAt: nullableDateSchema,
  expiresAt: dateSchema,
  requestCount: z.number(),
  tier: z.string().nullable(),
  status: z.string(),
  statusChangedAt: nullableDateSchema,
  errorCount: z.number(),
  consecutiveErrors: z.number(),
  lastErrorAt: nullableDateSchema,
  lastSuccessAt: nullableDateSchema,
  lastRecoveredByRotationAt: nullableDateSchema,
  lastErrorCode: z.number().nullable(),
  unhealthyCount: z.number(),
  successCount: z.number(),
  createdAt: dateSchema,
  stats: providerStatsSchema,
});

export const providerDetailSchema = z.object({
  accounts: z.array(providerAccountSchema),
  supportedModels: z.array(z.string()),
  freeSupportedModels: z.array(z.string()),
  supportedModelsByAccountId: z.record(z.string(), z.array(z.string())),
  disabledModelsByAccountId: z.record(z.string(), z.array(z.string())),
  modelHealthByAccountId: z.record(z.string(), z.record(z.string(), accountModelHealthSchema)),
  pinnedProviders: z.array(z.string()),
});

export const accountsDataSchema = z.object({
  overview: accountOverviewSchema,
  providers: z.record(z.string(), providerDetailSchema),
});

export const usageDataSchema = z.object({
  overview: accountOverviewSchema,
  accountStats: z.record(z.string(), providerStatsSchema),
  modelStats: z.record(z.string(), modelStatsSchema),
  roamingPointsByApiKeyId: z.record(z.string(), z.number()),
});

export const modelsDataSchema = z.object({
  list: z.array(modelListItemSchema),
  familyCounts: z.record(z.string(), z.number()),
});

export const pointsUpdateSchema = z.object({
  type: z.literal("update"),
  topic: z.literal("points"),
  at: z.string(),
  data: z.object({ balance: z.number() }),
});

export const accountsUpdateSchema = z.object({
  type: z.literal("update"),
  topic: z.literal("accounts"),
  at: z.string(),
  data: accountsDataSchema,
});

export const modelsUpdateSchema = z.object({
  type: z.literal("update"),
  topic: z.literal("models"),
  at: z.string(),
  data: modelsDataSchema,
});

export const usageUpdateSchema = z.object({
  type: z.literal("update"),
  topic: z.literal("usage"),
  at: z.string(),
  data: usageDataSchema,
});

export const pingSchema = z.object({
  type: z.literal("ping"),
  at: z.string(),
});

const updateEventSchema = z.discriminatedUnion("topic", [
  pointsUpdateSchema,
  accountsUpdateSchema,
  modelsUpdateSchema,
  usageUpdateSchema,
]);

export const serverEventSchema = z.discriminatedUnion("type", [
  updateEventSchema,
  pingSchema,
]);

export const subscribeInputSchema = z.object({
  topics: z.array(liveTopicSchema),
});

export const eventsContract = {
  subscribe: oc.input(subscribeInputSchema).output(eventIterator(serverEventSchema, z.void())),
};

export type LiveTopic = z.infer<typeof liveTopicSchema>;
export type AccountsData = z.infer<typeof accountsDataSchema>;
export type ModelsData = z.infer<typeof modelsDataSchema>;
export type UsageData = z.infer<typeof usageDataSchema>;
export type ProviderAccountPayload = z.infer<typeof providerAccountSchema>;
export type ProviderDetailPayload = z.infer<typeof providerDetailSchema>;
export type AccountOverviewPayload = z.infer<typeof accountOverviewSchema>;
export type PointsUpdate = z.infer<typeof pointsUpdateSchema>;
export type AccountsUpdate = z.infer<typeof accountsUpdateSchema>;
export type ModelsUpdate = z.infer<typeof modelsUpdateSchema>;
export type UsageUpdate = z.infer<typeof usageUpdateSchema>;
export type SubscribeInput = z.infer<typeof subscribeInputSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
