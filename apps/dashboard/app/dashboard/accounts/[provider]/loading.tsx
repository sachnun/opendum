import { Skeleton } from "@/components/ui/skeleton";

const ACCOUNT_CARDS = Array.from({ length: 3 });

function AccountCardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card flex flex-col h-full">
      {/* CardHeader: title + badges */}
      <div className="p-6 pb-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-4 w-48" />
      </div>

      {/* CardContent */}
      <div className="p-6 pt-0 flex flex-1 flex-col">
        <div className="space-y-2 text-sm flex-1">
          {/* Stats box */}
          <div className="mb-3 rounded-md border border-border/70 bg-muted/20 p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5 space-y-1">
                <Skeleton className="h-2.5 w-14" />
                <Skeleton className="h-4 w-10" />
              </div>
              <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5 space-y-1">
                <Skeleton className="h-2.5 w-14" />
                <Skeleton className="h-4 w-10" />
              </div>
            </div>
            {/* Sparkline placeholder */}
            <Skeleton className="h-8 w-full rounded" />
          </div>

          {/* Last used / Total Errors / Last Error rows */}
          <div className="flex justify-between">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3.5 w-20" />
          </div>
          <div className="flex justify-between">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3.5 w-8" />
          </div>
          <div className="flex justify-between">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3.5 w-12" />
          </div>

          {/* Last error message section */}
          <div className="min-h-14 border-t pt-2 space-y-1">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-16" />
          </div>

          {/* Quota section */}
          <div className="pt-3 mt-3 border-t space-y-2">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-1.5 w-full rounded-full" />
            <Skeleton className="h-1.5 w-full rounded-full" />
          </div>
        </div>

        {/* Action buttons */}
        <div className="mt-4 flex gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="relative">
        <div className="fixed inset-x-0 top-16 z-20 bg-background pt-3 md:left-60 md:pt-5">
          <div className="mx-auto w-full max-w-7xl px-5 sm:px-6 lg:px-8">
            <div className="bg-background">
              <div className="border-b border-border pb-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Skeleton className="h-7 w-52" />
                  <Skeleton className="h-9 w-full rounded-md sm:w-32" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="h-[88px] sm:h-[84px] md:h-[96px]" />
      </div>

      <div className="space-y-6">
        <div className="pt-1">
          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {ACCOUNT_CARDS.map((_, index) => (
              <AccountCardSkeleton key={`account-${index}`} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
