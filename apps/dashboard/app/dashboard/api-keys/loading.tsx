import { Skeleton } from "@/components/ui/skeleton";

const KEY_CARDS = Array.from({ length: 2 });

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-9 w-32 rounded-md" />
        </div>
      </div>

      <div className="space-y-4">
        {KEY_CARDS.map((_, index) => (
          <div
            key={`key-${index}`}
            className="rounded-xl border border-border bg-card px-5 py-3"
          >
            {/* Row 1: Name + Actions + Badge */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <Skeleton className="h-5 w-36" />
              <div className="flex shrink-0 items-center gap-2">
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
            </div>

            {/* Row 2: Metadata + Access controls + Analytics */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Skeleton className="h-3.5 w-52" />
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-7 w-28 rounded-md" />
                <Skeleton className="h-7 w-28 rounded-md" />
              </div>
              <Skeleton className="ml-auto h-3.5 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
