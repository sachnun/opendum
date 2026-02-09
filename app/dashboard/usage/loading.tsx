import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <Skeleton className="h-9 w-24" />
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-6">
        <Skeleton className="h-6 w-52" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-6">
        <Skeleton className="h-6 w-60" />
        <Skeleton className="h-36 w-full rounded-xl" />
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-6">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </div>
  );
}
