import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { disabledModel, providerAccount, proxyApiKey } from "@opendum/shared/db/schema";
import { eq, and, asc, desc } from "drizzle-orm";
import { decrypt } from "@opendum/shared/encryption";
import { getAllModels, getProvidersForModel, resolveModelAlias } from "@opendum/shared/proxy/models";
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

export default async function PlaygroundPage({
  searchParams,
}: {
  searchParams: Promise<{ model?: string }>;
}) {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  const { model: initialModelId } = await searchParams;

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

  // Get the user's most recently used API key for playground proxy calls
  let playgroundApiKey: string | undefined;
  if (process.env.NEXT_PUBLIC_PROXY_URL) {
    const [apiKey] = await db
      .select({ encryptedKey: proxyApiKey.encryptedKey })
      .from(proxyApiKey)
      .where(
        and(
          eq(proxyApiKey.userId, session.user.id),
          eq(proxyApiKey.isActive, true),
        ),
      )
      .orderBy(desc(proxyApiKey.lastUsedAt))
      .limit(1);

    if (apiKey?.encryptedKey) {
      try {
        playgroundApiKey = decrypt(apiKey.encryptedKey);
      } catch {
        // Ignore decryption errors
      }
    }
  }

  return (
    <PlaygroundClient
      models={models}
      providerAccounts={getProviderAccounts(providerAccounts)}
      initialModelId={initialModelId}
      apiKey={playgroundApiKey}
    />
  );
}
