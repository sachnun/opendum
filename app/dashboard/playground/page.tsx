import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { MODEL_REGISTRY } from "@/lib/proxy/models";
import { PlaygroundClient } from "@/components/playground/client";
import type { ModelOption } from "@/components/playground/chat-panel";

// Get all models - one entry per provider
// Format: provider/model (e.g. "iflow/qwen3-coder-plus")
function getModelsWithProviders(disabledModels: Set<string>): ModelOption[] {
  const models: ModelOption[] = [];

  for (const [modelName, info] of Object.entries(MODEL_REGISTRY)) {
    if (disabledModels.has(modelName)) {
      continue;
    }

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

export default async function PlaygroundPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  const disabledModels = await prisma.disabledModel.findMany({
    where: { userId: session.user.id },
    select: { model: true },
  });
  const disabledModelSet = new Set<string>(
    disabledModels.map((entry: { model: string }) => entry.model)
  );

  const models = getModelsWithProviders(disabledModelSet);

  return <PlaygroundClient models={models} />;
}
