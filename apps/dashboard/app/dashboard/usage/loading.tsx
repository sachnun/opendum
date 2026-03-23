import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </div>

      {/* Card 1: "Start in 3 steps" */}
      <div className="rounded-xl border border-border bg-card">
        <div className="p-6 pb-0">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="p-6 space-y-4">
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={`step-${index}`} className="flex gap-3">
                <Skeleton className="mt-0.5 h-5 w-5 shrink-0 rounded-full" />
                <Skeleton className="h-4 w-72" />
              </div>
            ))}
          </div>
          {/* Alert skeleton */}
          <div className="rounded-lg border border-border p-4 flex gap-3">
            <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
            <div className="space-y-1.5 flex-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3.5 w-80" />
            </div>
          </div>
        </div>
      </div>

      {/* Card 2: "Compatibility reference" */}
      <div className="rounded-xl border border-border bg-card">
        <div className="p-6 pb-0">
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="p-6 grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={`ref-${index}`}
              className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/30 p-4"
            >
              <Skeleton className="h-5 w-36 rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-4 w-full" />
              </div>
              <div className="space-y-1">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
