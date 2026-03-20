import { Suspense } from "react";
import { ModelsList } from "@/components/dashboard/models/models-list";
import { getSession } from "@/lib/auth";
import { getCachedModelStats, setCachedModelStats } from "@/lib/cache/models-cache";
import { db } from "@opendum/shared/db";
import { disabledModel, usageLog } from "@opendum/shared/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  MODEL_REGISTRY,
  getAllModels,
  getModelsForProvider,
  getProvidersForModel,
  resolveModelAlias,
} from "@opendum/shared/proxy/models";
import { ProviderName } from "@opendum/shared/proxy/providers/types";
import ModelsLoading from "./loading";

const MODEL_STATS_DAYS = 30;
const MODEL_DURATION_LOOKBACK_HOURS = 24;

interface ModelStats {
  totalRequests: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
  avgDurationLastDay: number | null;
  durationLast24Hours: Array<{ time: string; avgDuration: number | null }>;
}

interface CachedModelStatsPayload {
  statsByModel: Record<string, ModelStats>;
}

interface RawModelStats {
  totalRequests: number;
  successfulRequests: number;
  dailyCounts: Map<string, number>;
  durationByHour: Map<string, { total: number; count: number }>;
}

function buildDayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0];
  });
}

function buildHourKeys(hours: number): string[] {
  const now = new Date();
  const currentHourUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())
  );

  return Array.from({ length: hours }, (_, index) => {
    const date = new Date(currentHourUtc);
    date.setUTCHours(currentHourUtc.getUTCHours() - (hours - 1 - index));
    return date.toISOString();
  });
}

function normalizeLoggedModel(model: string): string {
  const slashIndex = model.indexOf("/");
  const baseModel = slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
  return resolveModelAlias(baseModel);
}

function getProviderLabel(provider: string): string {
  switch (provider) {
    case ProviderName.IFLOW:
      return "Iflow";
    case ProviderName.ANTIGRAVITY:
      return "Antigravity";
    case ProviderName.QWEN_CODE:
      return "Qwen Code";
    case ProviderName.GEMINI_CLI:
      return "Gemini CLI";
    case ProviderName.CODEX:
      return "Codex";
    case ProviderName.COPILOT:
      return "Copilot";
    case ProviderName.KIRO:
      return "Kiro";
    case ProviderName.NVIDIA_NIM:
      return "Nvidia";
    case ProviderName.OLLAMA_CLOUD:
      return "Ollama Cloud";
    case ProviderName.OPENROUTER:
      return "OpenRouter";
    default:
      return provider;
  }
}

function buildEmptyModelStats(dayKeys: string[], hourKeys: string[]): ModelStats {
  return {
    totalRequests: 0,
    successRate: null,
    dailyRequests: dayKeys.map((day) => ({ date: day, count: 0 })),
    avgDurationLastDay: null,
    durationLast24Hours: hourKeys.map((time) => ({ time, avgDuration: null })),
  };
}

async function computeModelStatsByModel(
  userId: string,
  allModels: string[]
): Promise<Record<string, ModelStats>> {
  const dayKeys = buildDayKeys(MODEL_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const hourKeys = buildHourKeys(MODEL_DURATION_LOOKBACK_HOURS);
  const hourKeySet = new Set(hourKeys);
  const durationStartDate = new Date(hourKeys[0]);
  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const supportedModelSet = new Set(allModels);

  const normalizedModelExpression = sql<string>`case
    when strpos(${usageLog.model}, '/') > 0 then split_part(${usageLog.model}, '/', 2)
    else ${usageLog.model}
  end`;
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;
  const hourBucketExpression = sql<Date>`date_trunc('hour', ${usageLog.createdAt})`;

  const [dailyRows, durationRows] = await Promise.all([
    db
      .select({
        model: normalizedModelExpression,
        dayBucket: dayBucketExpression,
        requestCount: sql<number>`count(*)`,
        successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`,
      })
      .from(usageLog)
      .where(and(eq(usageLog.userId, userId), gte(usageLog.createdAt, statsStartDate)))
      .groupBy(normalizedModelExpression, dayBucketExpression),
    db
      .select({
        model: normalizedModelExpression,
        hourBucket: hourBucketExpression,
        durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`,
        durationCount: sql<number>`count(${usageLog.duration})`,
      })
      .from(usageLog)
      .where(and(eq(usageLog.userId, userId), gte(usageLog.createdAt, durationStartDate)))
      .groupBy(normalizedModelExpression, hourBucketExpression),
  ]);

  const rawStatsByModel = new Map<string, RawModelStats>();

  for (const row of dailyRows) {
    const modelId = normalizeLoggedModel(row.model);
    if (!supportedModelSet.has(modelId)) {
      continue;
    }

    const dayDate = row.dayBucket instanceof Date ? row.dayBucket : new Date(row.dayBucket);
    if (Number.isNaN(dayDate.getTime())) {
      continue;
    }

    const dayKey = dayDate.toISOString().split("T")[0];
    if (!dayKeySet.has(dayKey)) {
      continue;
    }

    const current =
      rawStatsByModel.get(modelId) ??
      {
        totalRequests: 0,
        successfulRequests: 0,
        dailyCounts: new Map<string, number>(),
        durationByHour: new Map<string, { total: number; count: number }>(),
      };

    const requestCount = Number(row.requestCount) || 0;
    const successCount = Number(row.successCount) || 0;

    current.totalRequests += requestCount;
    current.successfulRequests += successCount;
    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    rawStatsByModel.set(modelId, current);
  }

  for (const row of durationRows) {
    const modelId = normalizeLoggedModel(row.model);
    if (!supportedModelSet.has(modelId)) {
      continue;
    }

    const hourDate = row.hourBucket instanceof Date ? row.hourBucket : new Date(row.hourBucket);
    if (Number.isNaN(hourDate.getTime())) {
      continue;
    }

    const hourKey = hourDate.toISOString();
    if (!hourKeySet.has(hourKey)) {
      continue;
    }

    const durationCount = Number(row.durationCount) || 0;
    const durationTotal = Number(row.durationTotal) || 0;
    if (durationCount <= 0) {
      continue;
    }

    const current =
      rawStatsByModel.get(modelId) ??
      {
        totalRequests: 0,
        successfulRequests: 0,
        dailyCounts: new Map<string, number>(),
        durationByHour: new Map<string, { total: number; count: number }>(),
      };

    const durationBucket = current.durationByHour.get(hourKey) ?? { total: 0, count: 0 };
    durationBucket.total += durationTotal;
    durationBucket.count += durationCount;
    current.durationByHour.set(hourKey, durationBucket);
    rawStatsByModel.set(modelId, current);
  }

  return Object.fromEntries(
    allModels.map((model) => {
      const modelStats = rawStatsByModel.get(model);
      if (!modelStats) {
        return [model, buildEmptyModelStats(dayKeys, hourKeys)];
      }

      const durationLast24Hours = hourKeys.map((time) => {
        const durationBucket = modelStats.durationByHour.get(time);
        return {
          time,
          avgDuration:
            durationBucket && durationBucket.count > 0
              ? Math.round(durationBucket.total / durationBucket.count)
              : null,
        };
      });

      const durationTotalLastDay = Array.from(modelStats.durationByHour.values()).reduce(
        (sum, durationBucket) => sum + durationBucket.total,
        0
      );
      const durationCountLastDay = Array.from(modelStats.durationByHour.values()).reduce(
        (sum, durationBucket) => sum + durationBucket.count,
        0
      );

      const stats: ModelStats = {
        totalRequests: modelStats.totalRequests,
        successRate:
          modelStats.totalRequests > 0
            ? Math.round((modelStats.successfulRequests / modelStats.totalRequests) * 100)
            : null,
        dailyRequests: dayKeys.map((day) => ({
          date: day,
          count: modelStats.dailyCounts.get(day) ?? 0,
        })),
        avgDurationLastDay:
          durationCountLastDay > 0
            ? Math.round(durationTotalLastDay / durationCountLastDay)
            : null,
        durationLast24Hours,
      };

      return [model, stats];
    })
  );
}

async function getModelStatsByModel(
  userId: string,
  allModels: string[]
): Promise<Record<string, ModelStats>> {
  const cachedPayload = await getCachedModelStats<CachedModelStatsPayload>(userId);
  if (cachedPayload?.statsByModel) {
    return cachedPayload.statsByModel;
  }

  const statsByModel = await computeModelStatsByModel(userId, allModels);
  await setCachedModelStats<CachedModelStatsPayload>(userId, { statsByModel });
  return statsByModel;
}

async function ModelsContent() {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  const allModels = getAllModels();

  const disabledModels = await db
    .select({ model: disabledModel.model })
    .from(disabledModel)
    .where(eq(disabledModel.userId, session.user.id));
  const disabledModelSet = new Set(
    disabledModels.map((entry: { model: string }) => resolveModelAlias(entry.model))
  );

  const statsByModel = await getModelStatsByModel(session.user.id, allModels);

  const iflowModels = getModelsForProvider(ProviderName.IFLOW);
  const antigravityModels = getModelsForProvider(ProviderName.ANTIGRAVITY);
  const qwenCodeModels = getModelsForProvider(ProviderName.QWEN_CODE);
  const geminiCliModels = getModelsForProvider(ProviderName.GEMINI_CLI);
  const codexModels = getModelsForProvider(ProviderName.CODEX);
  const copilotModels = getModelsForProvider(ProviderName.COPILOT);
  const kiroModels = getModelsForProvider(ProviderName.KIRO);
  const nvidiaNimModels = getModelsForProvider(ProviderName.NVIDIA_NIM);
  const ollamaCloudModels = getModelsForProvider(ProviderName.OLLAMA_CLOUD);
  const openRouterModels = getModelsForProvider(ProviderName.OPENROUTER);

  const availableProviders: { id: string; label: string }[] = [];
  if (iflowModels.length > 0) {
    availableProviders.push({ id: ProviderName.IFLOW, label: "Iflow" });
  }
  if (antigravityModels.length > 0) {
    availableProviders.push({ id: ProviderName.ANTIGRAVITY, label: "Antigravity" });
  }
  if (geminiCliModels.length > 0) {
    availableProviders.push({ id: ProviderName.GEMINI_CLI, label: "Gemini CLI" });
  }
  if (qwenCodeModels.length > 0) {
    availableProviders.push({ id: ProviderName.QWEN_CODE, label: "Qwen Code" });
  }
  if (codexModels.length > 0) {
    availableProviders.push({ id: ProviderName.CODEX, label: "Codex" });
  }
  if (copilotModels.length > 0) {
    availableProviders.push({ id: ProviderName.COPILOT, label: "Copilot" });
  }
  if (kiroModels.length > 0) {
    availableProviders.push({ id: ProviderName.KIRO, label: "Kiro" });
  }
  if (nvidiaNimModels.length > 0) {
    availableProviders.push({ id: ProviderName.NVIDIA_NIM, label: "Nvidia" });
  }
  if (ollamaCloudModels.length > 0) {
    availableProviders.push({ id: ProviderName.OLLAMA_CLOUD, label: "Ollama Cloud" });
  }
  if (openRouterModels.length > 0) {
    availableProviders.push({ id: ProviderName.OPENROUTER, label: "OpenRouter" });
  }

  const fallbackDayKeys = buildDayKeys(MODEL_STATS_DAYS);
  const fallbackHourKeys = buildHourKeys(MODEL_DURATION_LOOKBACK_HOURS);

  const modelsWithProviders = allModels.map((model) => {
    const info = MODEL_REGISTRY[model];
    const providers = getProvidersForModel(model);

    return {
      id: model,
      providers,
      providerLabels: providers.map(getProviderLabel),
      meta: info?.meta,
      isEnabled: !disabledModelSet.has(model),
      stats: statsByModel[model] ?? buildEmptyModelStats(fallbackDayKeys, fallbackHourKeys),
    };
  });

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">Available Models</h2>
          <span className="text-sm text-muted-foreground">{allModels.length} models</span>
        </div>
      </div>

      <ModelsList models={modelsWithProviders} availableProviders={availableProviders} />
    </div>
  );
}

export default function ModelsPage() {
  return (
    <Suspense fallback={<ModelsLoading />}>
      <ModelsContent />
    </Suspense>
  );
}
