import { Skeleton } from "@/components/ui/skeleton";

const FILTER_CHIPS = Array.from({ length: 6 });
const MODEL_CARDS = Array.from({ length: 6 });

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTER_CHIPS.map((_, index) => (
          <Skeleton key={`chip-${index}`} className="h-8 w-20 rounded-md" />
        ))}
      </div>

      <Skeleton className="h-4 w-40" />

      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3 w-14" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MODEL_CARDS.map((_, index) => (
            <div
              key={`model-${index}`}
              className="rounded-xl border border-border bg-card p-4 sm:p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-5 w-12 rounded-full" />
              </div>

              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                </div>
                <Skeleton className="h-12 w-full rounded-md" />
              </div>

              <Skeleton className="mt-4 h-9 w-full rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
