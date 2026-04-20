import { Skeleton } from "@/components/ui/skeleton";
import {
  API_KEY_PROVIDER_ACCOUNT_DEFINITIONS,
  OAUTH_PROVIDER_ACCOUNT_DEFINITIONS,
} from "@/lib/provider-accounts";

function ProviderOverviewCardSkeleton() {
  return (
    <div className="flex h-full flex-col gap-6 rounded-xl border border-border bg-card py-6">
      <div className="space-y-1 px-6 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1">
            <Skeleton className="h-6 w-6 rounded-md" />
            <Skeleton className="h-5 w-28" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      </div>
      <div className="space-y-3 px-6">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-4 w-4" />
        </div>

        <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-14" />
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={`stat-${index}`}
                className="space-y-1 rounded border border-border/60 bg-background/70 px-2 py-1.5"
              >
                <Skeleton className="h-2.5 w-12" />
                <Skeleton className="h-4 w-10" />
              </div>
            ))}
          </div>

          <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
            <Skeleton className="h-6 w-full rounded-sm" />
            <div className="mt-0.5 grid grid-cols-3">
              <Skeleton className="mx-auto h-2 w-8" />
              <Skeleton className="mx-auto h-2 w-8" />
              <Skeleton className="mx-auto h-2 w-8" />
            </div>
          </div>

          <Skeleton className="h-8 w-full rounded-sm" />
        </div>
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-20 -mx-5 bg-background px-5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="border-b border-border pb-4 pt-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-9 w-full rounded-md sm:w-32" />
          </div>
        </div>
      </div>

      <section className="space-y-4 md:space-y-2">
        <div className="space-y-1">
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {OAUTH_PROVIDER_ACCOUNT_DEFINITIONS.map((provider) => (
            <ProviderOverviewCardSkeleton key={provider.key} />
          ))}
        </div>
      </section>

      <section className="space-y-4 md:space-y-2">
        <div className="space-y-1">
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {API_KEY_PROVIDER_ACCOUNT_DEFINITIONS.map((provider) => (
            <ProviderOverviewCardSkeleton key={provider.key} />
          ))}
        </div>
      </section>
    </div>
  );
}
