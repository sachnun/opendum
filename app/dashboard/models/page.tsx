import { auth } from "@/lib/auth";
import { MODEL_REGISTRY, getModelsForProvider } from "@/lib/proxy/models";
import { ProviderName } from "@/lib/proxy/providers/types";
import { ModelsList } from "@/components/dashboard/models/models-list";

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
    return {
      id: model,
      providers: info.providers,
      providerLabels: info.providers.map(getProviderLabel),
      meta: info.meta,
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
