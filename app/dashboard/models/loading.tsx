import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <Skeleton className="h-9 w-56" />
      </div>

      <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-muted p-1.5">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>

      <Skeleton className="h-4 w-24" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-36 w-full rounded-lg" />
      </div>
    </div>
  );
}
