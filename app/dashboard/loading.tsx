import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Skeleton className="h-5 w-24 rounded-md" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-36 rounded-lg sm:h-9 sm:w-48" />
          <Skeleton className="h-8 w-8 rounded-lg sm:h-9 sm:w-9" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    </div>
  );
}
