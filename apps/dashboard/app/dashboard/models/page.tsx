import { Suspense } from "react";
import { ModelsList } from "@/components/dashboard/models/models-list";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { disabledModel, providerAccount } from "@opendum/shared/db/schema";
import { eq, and } from "drizzle-orm";
import {
  MODEL_REGISTRY,
  getAllModels,
  getModelFamily,
  getModelsForProvider,
  getProvidersForModel,
  resolveModelAlias,
} from "@opendum/shared/proxy/models";
import { ProviderName } from "@opendum/shared/proxy/providers/types";
import {
  type ModelStats,
  MODEL_STATS_DAYS,
  MODEL_DURATION_LOOKBACK_HOURS,
  buildDayKeys,
  buildHourKeys,
  buildEmptyModelStats,
  getModelStatsByModel,
} from "@/lib/model-stats";
import ModelsLoading from "./loading";

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

async function ModelsContent() {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  // Get providers where the user has at least one active account
  const userAccounts = await db
    .selectDistinct({ provider: providerAccount.provider })
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.userId, session.user.id),
        eq(providerAccount.isActive, true)
      )
    );
  const userProviders = new Set(userAccounts.map((a) => a.provider));

  // Only include models whose provider(s) the user has an account for
  const allModels = getAllModels().filter((model) =>
    getProvidersForModel(model).some((p) => userProviders.has(p))
  );

  const disabledModels = await db
    .select({ model: disabledModel.model })
    .from(disabledModel)
    .where(eq(disabledModel.userId, session.user.id));
  const disabledModelSet = new Set(
    disabledModels.map((entry: { model: string }) => resolveModelAlias(entry.model))
  );

  const statsByModel = await getModelStatsByModel(session.user.id, allModels);

  const providerEntries: { id: string; label: string }[] = [
    { id: ProviderName.IFLOW, label: "Iflow" },
    { id: ProviderName.ANTIGRAVITY, label: "Antigravity" },
    { id: ProviderName.GEMINI_CLI, label: "Gemini CLI" },
    { id: ProviderName.QWEN_CODE, label: "Qwen Code" },
    { id: ProviderName.CODEX, label: "Codex" },
    { id: ProviderName.COPILOT, label: "Copilot" },
    { id: ProviderName.KIRO, label: "Kiro" },
    { id: ProviderName.NVIDIA_NIM, label: "Nvidia" },
    { id: ProviderName.OLLAMA_CLOUD, label: "Ollama Cloud" },
    { id: ProviderName.OPENROUTER, label: "OpenRouter" },
  ];

  // Only show providers the user has an account for
  const availableProviders = providerEntries.filter(
    (p) => userProviders.has(p.id) && getModelsForProvider(p.id).length > 0
  );

  const fallbackDayKeys = buildDayKeys(MODEL_STATS_DAYS);
  const fallbackHourKeys = buildHourKeys(MODEL_DURATION_LOOKBACK_HOURS);

  const modelsWithProviders = allModels.map((model) => {
    const info = MODEL_REGISTRY[model];
    const providers = getProvidersForModel(model).filter((p) => userProviders.has(p));

    return {
      id: model,
      providers,
      providerLabels: providers.map(getProviderLabel),
      family: getModelFamily(model),
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
