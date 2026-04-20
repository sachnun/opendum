"use client";

import { useParams } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getProviderFromSlug,
  PROVIDER_ACCOUNT_BY_KEY,
  type ProviderAccountKey,
} from "@/lib/provider-accounts";

const ACCOUNT_CARDS = Array.from({ length: 3 });
const ACCOUNT_STAT_CARDS = Array.from({ length: 3 });
const ACCOUNT_MODEL_CHIPS = Array.from({ length: 5 });
const QUOTA_PROVIDER_KEYS = new Set<ProviderAccountKey>([
  "antigravity",
  "codex",
  "copilot",
  "gemini_cli",
  "kiro",
  "openrouter",
]);

function AccountCardSkeleton({
  showTier,
  supportsQuota,
}: {
  showTier: boolean;
  supportsQuota: boolean;
}) {
  return (
    <div className="h-full">
      <div className="flex h-full flex-col rounded-xl border border-border bg-card">
        <div className="space-y-2 p-6 pb-2">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <Skeleton className="h-6 w-36" />
            <div className="flex flex-wrap gap-1">
              {showTier && <Skeleton className="h-5 w-14 rounded-full" />}
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1">
            <Skeleton className="h-4 w-full max-w-48" />
            <Skeleton className="h-7 w-7 rounded-md" />
          </div>
        </div>

        <div className="flex flex-1 flex-col p-6 pt-0">
          <div className="flex-1 space-y-2 text-sm">
            <div className="mb-3 rounded-md border border-border/70 bg-muted/20 p-2.5">
              <div className="mb-2 flex items-center justify-between">
                <Skeleton className="h-3 w-10" />
                <Skeleton className="h-3 w-14" />
              </div>

              <div className="mb-2 grid grid-cols-3 gap-1.5">
                {ACCOUNT_STAT_CARDS.map((_, index) => (
                  <div
                    key={`stat-${index}`}
                    className="space-y-1 rounded border border-border/60 bg-background/70 px-2 py-1.5"
                  >
                    <Skeleton className="h-2.5 w-12" />
                    <Skeleton className="h-4 w-10" />
                  </div>
                ))}
              </div>

              <div className="mb-2 rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <Skeleton className="h-6 w-full rounded-sm" />
                <div className="mt-0.5 grid grid-cols-3">
                  <Skeleton className="mx-auto h-2 w-8" />
                  <Skeleton className="mx-auto h-2 w-8" />
                  <Skeleton className="mx-auto h-2 w-8" />
                </div>
              </div>

              <Skeleton className="h-8 w-full rounded-sm" />
            </div>

            <div className="flex justify-between gap-4">
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3.5 w-20" />
            </div>
            <div className="flex justify-between gap-4">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-8" />
            </div>
            <div className="flex justify-between gap-4">
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3.5 w-12" />
            </div>

            <div className="min-h-[3.25rem] border-t pt-2 space-y-1">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3 w-full max-w-40" />
            </div>

            {supportsQuota && (
              <div className="mt-3 space-y-2 border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-6 w-6 rounded-md" />
                </div>
                <Skeleton className="h-1.5 w-full rounded-full" />
                <Skeleton className="h-1.5 w-full rounded-full" />
              </div>
            )}

            <div className="mt-3 space-y-2 border-t pt-3">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-10" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ACCOUNT_MODEL_CHIPS.map((_, index) => (
                  <Skeleton
                    key={`chip-${index}`}
                    className={`h-5 rounded-md ${index % 2 === 0 ? "w-20" : "w-24"}`}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 w-9 rounded-md" />
              <Skeleton className="h-9 w-9 rounded-md" />
              <Skeleton className="h-9 w-9 rounded-md" />
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Skeleton className="h-3 w-5" />
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Loading() {
  const params = useParams<{ provider: string }>();
  const providerKey =
    typeof params.provider === "string" ? getProviderFromSlug(params.provider) : null;
  const providerMeta = providerKey ? PROVIDER_ACCOUNT_BY_KEY[providerKey] : null;
  const supportsQuota = providerKey ? QUOTA_PROVIDER_KEYS.has(providerKey) : false;

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-20 -mx-5 bg-background px-5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="border-b border-border pb-4 pt-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-7 w-40" />
            </div>
            <Skeleton className="h-9 w-full rounded-md sm:w-32" />
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div className="pt-1">
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
            {ACCOUNT_CARDS.map((_, index) => (
              <AccountCardSkeleton
                key={`account-${index}`}
                showTier={providerMeta?.showTier ?? false}
                supportsQuota={supportsQuota}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
