import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-7 w-28" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-36 rounded-md" />
            <Skeleton className="h-9 w-20 rounded-md" />
            <Skeleton className="h-9 w-9 rounded-md" />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-4 w-16" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton
              key={`scenario-${index}`}
              className="h-[52px] min-w-[72px] rounded-md"
            />
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton
              key={`preset-${index}`}
              className="h-[52px] min-w-[92px] rounded-md"
            />
          ))}
        </div>
      </div>

      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
        <div className="flex h-[400px] flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b px-3 py-2">
            <Skeleton className="h-8 w-full max-w-56 rounded-md" />
          </div>
          <div className="flex flex-1 items-center justify-center p-3">
            <div className="space-y-2 text-center">
              <Skeleton className="mx-auto h-4 w-36" />
              <Skeleton className="mx-auto h-3 w-24" />
            </div>
          </div>
        </div>

        <div className="flex h-[400px] flex-col items-center justify-center rounded-xl border-2 border-dashed border-border/80 bg-background">
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="mt-2 h-4 w-28" />
        </div>
      </div>
    </div>
  );
}
