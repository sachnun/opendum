import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-9 rounded-lg" />
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4 sm:p-5">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-[400px] w-full rounded-lg" />
        <Skeleton className="h-[400px] w-full rounded-lg" />
        <Skeleton className="h-[400px] w-full rounded-lg" />
      </div>
    </div>
  );
}
