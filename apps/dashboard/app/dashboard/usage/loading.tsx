import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-4">
        <Skeleton className="h-7 w-16" />
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="p-6 pb-0">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="p-6 space-y-4">
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={`step-${index}`} className="flex gap-3">
                <Skeleton className="mt-0.5 h-5 w-5 shrink-0 rounded-full" />
                <Skeleton
                  className={`h-4 ${index === 0 ? "w-full max-w-80" : index === 1 ? "w-full max-w-64" : "w-full max-w-[30rem]"}`}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

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
