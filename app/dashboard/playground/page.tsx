import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { disabledModel, providerAccount } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { getAllModels, getProvidersForModel, resolveModelAlias } from "@/lib/proxy/models";
import { PlaygroundClient } from "@/components/playground/client";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  ModelOption,
  ProviderAccountOption,
} from "@/components/playground/chat-panel";

const SCENARIO_CHIPS = Array.from({ length: 4 });
const PANEL_CARDS = Array.from({ length: 3 });

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

function PlaygroundSkeleton() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-6 w-28" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-4 w-20" />
        <div className="flex flex-wrap gap-2">
          {SCENARIO_CHIPS.map((_, index) => (
            <Skeleton key={`scenario-${index}`} className="h-10 w-20 rounded-md" />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {PANEL_CARDS.map((_, index) => (
          <div
            key={`panel-${index}`}
            className="flex h-[400px] flex-col rounded-xl border border-border bg-card p-3"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-7 w-36" />
              <Skeleton className="h-7 w-7 rounded-full" />
            </div>
            <div className="mt-4 flex-1 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <div className="mt-4 space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-12" />
              </div>
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface PlaygroundContentProps {
  userId: string;
}

async function PlaygroundContent({ userId }: PlaygroundContentProps) {
  const [disabledModels, providerAccounts] = await Promise.all([
    db
      .select({ model: disabledModel.model })
      .from(disabledModel)
      .where(eq(disabledModel.userId, userId)),
    db
      .select({
        id: providerAccount.id,
        provider: providerAccount.provider,
        name: providerAccount.name,
        email: providerAccount.email,
      })
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.isActive, true)))
      .orderBy(asc(providerAccount.provider), asc(providerAccount.createdAt)),
  ]);

  const disabledModelSet = new Set<string>(
    disabledModels.map((entry: { model: string }) => resolveModelAlias(entry.model))
  );

  const models = getModels(disabledModelSet);

  return (
    <PlaygroundClient
      models={models}
      providerAccounts={getProviderAccounts(providerAccounts)}
    />
  );
}

export default async function PlaygroundPage() {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  return (
    <Suspense fallback={<PlaygroundSkeleton />}>
      <PlaygroundContent userId={session.user.id} />
    </Suspense>
  );
}
