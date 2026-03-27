import { Skeleton } from "@/components/ui/skeleton";

const OAUTH_CARDS = Array.from({ length: 7 });
const API_KEY_CARDS = Array.from({ length: 3 });

function SummaryCardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="space-y-1 p-4 pb-3 sm:p-5 sm:pb-3">
        <div className="flex items-start justify-between gap-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      </div>
      <div className="px-4 pb-4 sm:px-5 sm:pb-5 flex items-center justify-between">
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
          {OAUTH_CARDS.map((_, index) => (
            <SummaryCardSkeleton key={`oauth-${index}`} />
          ))}
        </div>
      </section>

      <section className="space-y-4 md:space-y-2">
        <div className="space-y-1">
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {API_KEY_CARDS.map((_, index) => (
            <SummaryCardSkeleton key={`api-${index}`} />
          ))}
        </div>
      </section>
    </div>
  );
}
