import { Skeleton } from "@/components/ui/skeleton";

const STAT_CARDS = Array.from({ length: 4 });
const CHART_CARDS = Array.from({ length: 4 });

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Skeleton className="h-5 w-24" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-36 rounded-lg sm:h-9 sm:w-48" />
          <Skeleton className="h-8 w-36 rounded-lg sm:h-9 sm:w-48" />
          <Skeleton className="h-8 w-8 rounded-lg sm:h-9 sm:w-9" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {STAT_CARDS.map((_, index) => (
          <div
            key={`stat-${index}`}
            className="rounded-xl border border-border bg-card p-4 sm:p-5"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4 rounded-full" />
            </div>
            <div className="mt-3 space-y-2">
              <Skeleton className="h-7 w-24" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {CHART_CARDS.map((_, index) => (
          <div
            key={`chart-${index}`}
            className="rounded-xl border border-border bg-card p-4 sm:p-5"
          >
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-4 h-52 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
