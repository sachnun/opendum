import { Suspense } from "react";
import { ModelsList } from "@/components/dashboard/models/models-list";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { disabledModel } from "@opendum/shared/db/schema";
import { eq } from "drizzle-orm";
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
