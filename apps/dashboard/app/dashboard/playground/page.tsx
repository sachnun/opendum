import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { disabledModel, providerAccount, providerAccountDisabledModel, proxyApiKey } from "@opendum/shared/db/schema";
import { eq, and, asc, desc, inArray } from "drizzle-orm";
import { decrypt } from "@opendum/shared/encryption";
import { getAllModels, getProvidersForModel, resolveModelAlias, getModelFamily } from "@opendum/shared/proxy/models";
import { getAccountModelAvailability, isModelUsableByAccounts, type AccountModelAvailability } from "@opendum/shared/proxy/auth";
import { PlaygroundClient } from "@/components/playground/client";
import type {
  ModelOption,
  ProviderAccountOption,
} from "@/components/playground/chat-panel";
import type { ApiKeyOption, ApiKeyModelAccessMode } from "@/components/playground/client";

// Get all models - one entry per model, filtered to only include models with usable accounts
function getModels(disabledModels: Set<string>, availability: AccountModelAvailability): ModelOption[] {
  const models: ModelOption[] = [];

  for (const modelName of getAllModels()) {
    if (disabledModels.has(modelName)) {
      continue;
    }

    // Skip models where all accounts have disabled them (or no active account exists)
    if (!isModelUsableByAccounts(modelName, availability)) {
      continue;
    }

    const providers = getProvidersForModel(modelName).filter((p) => availability.activeProviders.has(p));

    models.push({
      id: modelName,
      name: modelName,
      providers,
      family: getModelFamily(modelName),
    });
  }

  models.sort((a, b) => a.name.localeCompare(b.name));

  return models;
}

function getProviderAccounts(
  accounts: Array<{
    id: string;
    provider: string;
    name: string;
    email: string | null;
  }>,
  disabledModelsByAccount: Map<string, string[]>
): ProviderAccountOption[] {
  return accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    name: account.name,
    email: account.email,
    disabledModels: disabledModelsByAccount.get(account.id),
  }));
}

export default async function PlaygroundPage() {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  const [disabledModels, availability] = await Promise.all([
    db
      .select({ model: disabledModel.model })
      .from(disabledModel)
      .where(eq(disabledModel.userId, session.user.id)),
    getAccountModelAvailability(session.user.id),
  ]);
  const disabledModelSet = new Set<string>(
    disabledModels.map((entry: { model: string }) => resolveModelAlias(entry.model))
  );

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

  // Fetch per-account disabled models so the playground can exclude them when
  // opening from a specific account preset.
  const disabledModelsByAccount = new Map<string, string[]>();
  if (providerAccounts.length > 0) {
    const accountIds = providerAccounts.map((a) => a.id);
    const perAccountDisabled = await db
      .select({
        providerAccountId: providerAccountDisabledModel.providerAccountId,
        model: providerAccountDisabledModel.model,
      })
      .from(providerAccountDisabledModel)
      .where(inArray(providerAccountDisabledModel.providerAccountId, accountIds));

    for (const entry of perAccountDisabled) {
      const canonical = resolveModelAlias(entry.model);
      const list = disabledModelsByAccount.get(entry.providerAccountId);
      if (list) {
        list.push(canonical);
      } else {
        disabledModelsByAccount.set(entry.providerAccountId, [canonical]);
      }
    }
  }

  const models = getModels(disabledModelSet, availability);

  // Get all active API keys for the playground key selector
  let apiKeyOptions: ApiKeyOption[] = [];
  if (process.env.NEXT_PUBLIC_PROXY_URL) {
    const activeKeys = await db
      .select({
        id: proxyApiKey.id,
        name: proxyApiKey.name,
        keyPreview: proxyApiKey.keyPreview,
        encryptedKey: proxyApiKey.encryptedKey,
        lastUsedAt: proxyApiKey.lastUsedAt,
        modelAccessMode: proxyApiKey.modelAccessMode,
        modelAccessList: proxyApiKey.modelAccessList,
      })
      .from(proxyApiKey)
      .where(
        and(
          eq(proxyApiKey.userId, session.user.id),
          eq(proxyApiKey.isActive, true),
        ),
      )
      .orderBy(desc(proxyApiKey.lastUsedAt));

    apiKeyOptions = activeKeys
      .map((key) => {
        if (!key.encryptedKey) return null;
        try {
          const mode = key.modelAccessMode;
          const validMode: ApiKeyModelAccessMode =
            mode === "whitelist" || mode === "blacklist" ? mode : "all";
          return {
            id: key.id,
            name: key.name,
            keyPreview: key.keyPreview,
            decryptedKey: decrypt(key.encryptedKey),
            modelAccessMode: validMode,
            modelAccessList: key.modelAccessList ?? [],
          };
        } catch {
          return null;
        }
      })
      .filter((k): k is ApiKeyOption => k !== null);
  }

  return (
    <PlaygroundClient
      models={models}
      providerAccounts={getProviderAccounts(providerAccounts, disabledModelsByAccount)}
      apiKeyOptions={apiKeyOptions}
    />
  );
}
