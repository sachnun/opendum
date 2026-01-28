import { MODEL_REGISTRY } from "@/lib/proxy/models";
import { PlaygroundClient } from "@/components/playground/playground-client";
import type { ModelOption } from "@/components/playground/chat-panel";

// Get all models - one entry per provider
// Format: provider/model (e.g. "iflow/qwen3-coder-plus")
function getModelsWithProviders(): ModelOption[] {
  const models: ModelOption[] = [];

  for (const [modelName, info] of Object.entries(MODEL_REGISTRY)) {
    // Create one entry per provider
    for (const provider of info.providers) {
      models.push({
        id: `${provider}/${modelName}`,
        name: modelName,
        provider: provider,
      });
    }
  }

  // Sort by provider, then by model name
  models.sort((a, b) => {
    if (a.provider !== b.provider) {
      return a.provider.localeCompare(b.provider);
    }
    return a.name.localeCompare(b.name);
  });

  return models;
}

export default function PlaygroundPage() {
  const models = getModelsWithProviders();

  return <PlaygroundClient models={models} />;
}
