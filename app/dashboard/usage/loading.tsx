import { Skeleton } from "@/components/ui/skeleton";

const GUIDE_CARDS = Array.from({ length: 3 });

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </div>

      {GUIDE_CARDS.map((_, index) => (
        <div key={`guide-${index}`} className="rounded-xl border border-border bg-card p-5">
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="mt-4 space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
