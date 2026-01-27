import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { MODEL_REGISTRY, getModelsForProvider } from "@/lib/proxy/models";
import { ProviderName } from "@/lib/proxy/providers/types";
import { ModelCard } from "./model-card";

type ModelCategory = "Chat" | "Thinking" | "Coding" | "Vision" | "Large" | "Other";

function getModelCategory(modelId: string): ModelCategory {
  if (modelId.includes("thinking")) return "Thinking";
  if (modelId.includes("coder") || modelId.includes("code")) return "Coding";
  if (modelId.includes("vl") || modelId.includes("vision")) return "Vision";
  if (modelId.includes("235b")) return "Large";
  if (modelId.includes("-chat") || modelId.startsWith("glm-") || modelId === "qwen3-max") return "Chat";
  return "Other";
}

function getProviderLabel(provider: string): string {
  switch (provider) {
    case ProviderName.IFLOW:
      return "iFlow";
    case ProviderName.ANTIGRAVITY:
      return "Antigravity";
    default:
      return provider;
  }
}

export default async function ModelsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  // Get all models grouped by provider
  const iflowModels = getModelsForProvider(ProviderName.IFLOW);
  const antigravityModels = getModelsForProvider(ProviderName.ANTIGRAVITY);
  const allModels = Object.keys(MODEL_REGISTRY);

  const usageStats = await prisma.usageLog.groupBy({
    by: ["model"],
    where: { userId: session.user.id },
    _count: { id: true },
  });

  const usageMap = new Map(usageStats.map((stat) => [stat.model, stat._count.id]));

  // Create models with stats and provider info
  const modelsWithStats = allModels.map((model) => {
    const info = MODEL_REGISTRY[model];
    return {
      id: model,
      category: getModelCategory(model),
      usage: usageMap.get(model) || 0,
      providers: info.providers,
      providerLabel: info.providers.map(getProviderLabel).join(", "),
    };
  }).sort((a, b) => b.usage - a.usage);

  const iflowModelsWithStats = modelsWithStats.filter(m => m.providers.includes(ProviderName.IFLOW));
  const antigravityModelsWithStats = modelsWithStats.filter(m => m.providers.includes(ProviderName.ANTIGRAVITY));

  return (
    <div className="space-y-6 md:space-y-8">
      <div>
        <h2 className="text-xl md:text-2xl font-bold tracking-tight">Available Models</h2>
        <p className="text-sm md:text-base text-muted-foreground">
          Browse all {allModels.length} available models across {iflowModels.length > 0 && antigravityModels.length > 0 ? "2 providers" : "1 provider"}
        </p>
      </div>

      {/* iFlow Models */}
      {iflowModelsWithStats.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">iFlow Models</h3>
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {iflowModels.length}
            </span>
          </div>
          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {iflowModelsWithStats.map((model) => (
              <ModelCard
                key={model.id}
                id={model.id}
                category={model.category}
                usage={model.usage}
              />
            ))}
          </div>
        </div>
      )}

      {/* Antigravity Models */}
      {antigravityModelsWithStats.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">Antigravity Models</h3>
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {antigravityModels.length}
            </span>
          </div>
          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {antigravityModelsWithStats.map((model) => (
              <ModelCard
                key={model.id}
                id={model.id}
                category={model.category}
                usage={model.usage}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
