import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getAllModels, getProvidersForModel, resolveModelAlias } from "@/lib/proxy/models";
import { PlaygroundClient } from "@/components/playground/client";
import type {
  ModelOption,
  ProviderAccountOption,
} from "@/components/playground/chat-panel";

// Get all models - one entry per model
function getModels(disabledModels: Set<string>): ModelOption[] {
  const models: ModelOption[] = [];

  for (const modelName of getAllModels()) {
    if (disabledModels.has(modelName)) {
      continue;
    }

    const providers = getProvidersForModel(modelName).sort((a, b) => a.localeCompare(b));

    models.push({
      id: modelName,
      name: modelName,
      providers,
    });
  }

  models.sort((a, b) => a.name.localeCompare(b.name));

  return models;
}

function getProviderAccounts(accounts: Array<{
  id: string;
  provider: string;
  name: string;
  email: string | null;
}>): ProviderAccountOption[] {
  return accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    name: account.name,
    email: account.email,
  }));
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
    disabledModels.map((entry: { model: string }) => resolveModelAlias(entry.model))
  );

  const models = getModels(disabledModelSet);
  const providerAccounts = await prisma.providerAccount.findMany({
    where: {
      userId: session.user.id,
      isActive: true,
    },
    select: {
      id: true,
      provider: true,
      name: true,
      email: true,
    },
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
  });

  return (
    <PlaygroundClient
      models={models}
      providerAccounts={getProviderAccounts(providerAccounts)}
    />
  );
}
