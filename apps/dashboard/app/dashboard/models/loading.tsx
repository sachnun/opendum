import { Skeleton } from "@/components/ui/skeleton";

const FILTER_CHIPS = Array.from({ length: 6 });
const MODEL_CARDS = Array.from({ length: 6 });

function ModelCardSkeleton() {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card py-4">
      {/* CardHeader */}
      <div className="px-4 pb-2 sm:px-5">
        {/* Row 1: Model ID + Switch */}
        <div className="flex items-start justify-between gap-2">
          <Skeleton className="h-5 w-36" />
          <div className="flex items-center gap-1.5 shrink-0">
            <Skeleton className="h-3 w-5" />
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        </div>
        {/* Row 2: Provider badges + Copy + Play */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
          <span className="mx-0.5" />
          <Skeleton className="h-5 w-12 rounded-sm" />
          <Skeleton className="h-5 w-10 rounded-sm" />
        </div>
      </div>

      {/* CardContent */}
      <div className="flex flex-1 flex-col px-4 sm:px-5">
        <div className="mt-auto space-y-2.5">
          {/* Model metadata */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-3.5 w-12" />
              <Skeleton className="h-3.5 w-12" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            <div className="flex flex-wrap gap-1">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
          </div>

          {/* Stats box */}
          <div className="rounded-md border border-border/70 bg-muted/20 p-2 sm:p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <div className="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5 space-y-1">
                <Skeleton className="h-2.5 w-12" />
                <Skeleton className="h-4 w-8" />
              </div>
              <div className="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5 space-y-1">
                <Skeleton className="h-2.5 w-12" />
                <Skeleton className="h-4 w-8" />
              </div>
              <div className="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5 space-y-1">
                <Skeleton className="h-2.5 w-12" />
                <Skeleton className="h-4 w-8" />
              </div>
            </div>
            {/* Duration sparkline area */}
            <div className="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
              <Skeleton className="h-6 w-full rounded-sm" />
              <div className="mt-0.5 grid grid-cols-3">
                <Skeleton className="mx-auto h-2 w-8" />
                <Skeleton className="mx-auto h-2 w-8" />
                <Skeleton className="mx-auto h-2 w-8" />
              </div>
            </div>
            {/* Usage sparkline */}
            <Skeleton className="h-8 w-full rounded-sm" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>

      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {FILTER_CHIPS.map((_, index) => (
            <Skeleton key={`chip-${index}`} className="h-8 w-20 rounded-md" />
          ))}
        </div>

        <Skeleton className="h-3.5 w-48" />

        <div className="space-y-8">
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-14" />
            </div>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {MODEL_CARDS.map((_, index) => (
                <ModelCardSkeleton key={`model-${index}`} />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
