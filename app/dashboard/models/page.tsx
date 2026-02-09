import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  MODEL_REGISTRY,
  getModelsForProvider,
  resolveModelAlias,
} from "@/lib/proxy/models";
import { ProviderName } from "@/lib/proxy/providers/types";
import { ModelsList } from "@/components/dashboard/models/models-list";

const MODEL_STATS_DAYS = 30;

interface ModelStats {
  totalRequests: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
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
    default:
      return provider;
  }
}

export default async function ModelsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  // Get all models
  const allModels = Object.keys(MODEL_REGISTRY);

  const disabledModels = await prisma.disabledModel.findMany({
    where: { userId: session.user.id },
    select: { model: true },
  });
  const disabledModelSet = new Set(
    disabledModels.map((entry: { model: string }) => entry.model)
  );

  const dayKeys = buildDayKeys(MODEL_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);

  const usageLogs = await prisma.usageLog.findMany({
    where: {
      userId: session.user.id,
      createdAt: { gte: statsStartDate },
    },
    select: {
      model: true,
      statusCode: true,
      createdAt: true,
    },
  });

  const statsByModel = new Map<
    string,
    {
      totalRequests: number;
      successfulRequests: number;
      dailyCounts: Map<string, number>;
    }
  >();

  for (const log of usageLogs) {
    const modelId = normalizeLoggedModel(log.model);
    if (!(modelId in MODEL_REGISTRY)) {
      continue;
    }

    const dayKey = log.createdAt.toISOString().split("T")[0];
    if (!dayKeySet.has(dayKey)) {
      continue;
    }

    const current =
      statsByModel.get(modelId) ??
      {
        totalRequests: 0,
        successfulRequests: 0,
        dailyCounts: new Map<string, number>(),
      };

    current.totalRequests += 1;

    if (log.statusCode !== null && log.statusCode >= 200 && log.statusCode < 400) {
      current.successfulRequests += 1;
    }

    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + 1);
    statsByModel.set(modelId, current);
  }

  // Get models per provider to determine which providers have models
  const iflowModels = getModelsForProvider(ProviderName.IFLOW);
  const antigravityModels = getModelsForProvider(ProviderName.ANTIGRAVITY);
  const qwenCodeModels = getModelsForProvider(ProviderName.QWEN_CODE);
  const geminiCliModels = getModelsForProvider(ProviderName.GEMINI_CLI);
  const codexModels = getModelsForProvider(ProviderName.CODEX);

  // Build available providers list (only those with models)
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

  // Create models with provider info
  const modelsWithProviders = allModels.map((model) => {
    const info = MODEL_REGISTRY[model];
    const modelStats = statsByModel.get(model);
    const totalRequests = modelStats?.totalRequests ?? 0;
    const successfulRequests = modelStats?.successfulRequests ?? 0;
    const stats: ModelStats = {
      totalRequests,
      successRate:
        totalRequests > 0
          ? Math.round((successfulRequests / totalRequests) * 100)
          : null,
      dailyRequests: dayKeys.map((day) => ({
        date: day,
        count: modelStats?.dailyCounts.get(day) ?? 0,
      })),
    };

    return {
      id: model,
      providers: info.providers,
      providerLabels: info.providers.map(getProviderLabel),
      meta: info.meta,
      isEnabled: !disabledModelSet.has(model),
      stats,
    };
  });

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">Available Models</h2>
          <span className="text-sm text-muted-foreground">
            {allModels.length} models
          </span>
        </div>
      </div>

      <ModelsList models={modelsWithProviders} availableProviders={availableProviders} />
    </div>
  );
}
