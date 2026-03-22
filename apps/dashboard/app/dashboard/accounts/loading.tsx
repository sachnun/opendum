import { Skeleton } from "@/components/ui/skeleton";

const OAUTH_CARDS = Array.from({ length: 7 });
const API_KEY_CARDS = Array.from({ length: 3 });

function SummaryCardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="h-4 w-4" />
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
                  <Skeleton className="h-7 w-44" />
                  <Skeleton className="h-9 w-full rounded-md sm:w-32" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="h-[88px] sm:h-[84px] md:h-[96px]" />
      </div>

      <section className="space-y-4">
        <Skeleton className="h-5 w-48" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {OAUTH_CARDS.map((_, index) => (
            <SummaryCardSkeleton key={`oauth-${index}`} />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <Skeleton className="h-5 w-48" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {API_KEY_CARDS.map((_, index) => (
            <SummaryCardSkeleton key={`api-${index}`} />
          ))}
        </div>
      </section>
    </div>
  );
}
