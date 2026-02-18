import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { disabledModel, providerAccount } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
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

    const providers = getProvidersForModel(modelName);

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
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  const disabledModels = await db
    .select({ model: disabledModel.model })
    .from(disabledModel)
    .where(eq(disabledModel.userId, session.user.id));
  const disabledModelSet = new Set<string>(
    disabledModels.map((entry: { model: string }) => resolveModelAlias(entry.model))
  );

  const models = getModels(disabledModelSet);
  const providerAccounts = await db
    .select({
      id: providerAccount.id,
      provider: providerAccount.provider,
      name: providerAccount.name,
      email: providerAccount.email,
    })
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.userId, session.user.id),
        eq(providerAccount.isActive, true),
      ),
    )
    .orderBy(asc(providerAccount.provider), asc(providerAccount.createdAt));

  return (
    <PlaygroundClient
      models={models}
      providerAccounts={getProviderAccounts(providerAccounts)}
    />
  );
}
