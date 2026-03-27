import { Skeleton } from "@/components/ui/skeleton";

const STAT_CARDS = Array.from({ length: 6 });
const CHART_CARDS = Array.from({ length: 4 });

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Skeleton className="h-5 w-24" />
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="h-8 w-36 rounded-lg sm:h-9 sm:w-48" />
          <Skeleton className="h-8 w-36 rounded-lg sm:h-9 sm:w-48" />
          <Skeleton className="h-8 w-8 rounded-lg sm:h-9 sm:w-9" />
        </div>
      </div>

      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
        {STAT_CARDS.map((_, index) => (
          <div
            key={`stat-${index}`}
            className="rounded-xl bg-muted/40 px-4 py-4 sm:px-5"
          >
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="mt-2 h-8 w-20 sm:h-9" />
            <Skeleton className="mt-1 h-3 w-28" />
          </div>
        ))}
      </div>

      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(480px,1fr))]">
        {CHART_CARDS.map((_, index) => (
          <div
            key={`chart-${index}`}
            className="rounded-xl border border-border/50 bg-card/50 p-4 sm:p-5"
          >
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-4 h-52 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
