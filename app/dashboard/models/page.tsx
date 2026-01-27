import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { IFLOW_MODELS } from "@/lib/proxy/constants";
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

export default async function ModelsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  const models = Array.from(IFLOW_MODELS).sort();

  const usageStats = await prisma.usageLog.groupBy({
    by: ["model"],
    where: { userId: session.user.id },
    _count: { id: true },
  });

  const usageMap = new Map(usageStats.map((stat) => [stat.model, stat._count.id]));

  const modelsWithStats = models.map((model) => ({
    id: model,
    category: getModelCategory(model),
    usage: usageMap.get(model) || 0,
  })).sort((a, b) => b.usage - a.usage);

  return (
    <div className="space-y-4 md:space-y-6">
      <div>
        <h2 className="text-xl md:text-2xl font-bold tracking-tight">Available Models</h2>
        <p className="text-sm md:text-base text-muted-foreground">
          Browse all {models.length} available iFlow AI models and their usage statistics
        </p>
      </div>

      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {modelsWithStats.map((model) => (
          <ModelCard
            key={model.id}
            id={model.id}
            category={model.category}
            usage={model.usage}
          />
        ))}
      </div>
    </div>
  );
}