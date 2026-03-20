import { Skeleton } from "@/components/ui/skeleton";

const SCENARIO_CHIPS = Array.from({ length: 4 });
const PANEL_CARDS = Array.from({ length: 3 });

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-6 w-28" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-4 w-20" />
        <div className="flex flex-wrap gap-2">
          {SCENARIO_CHIPS.map((_, index) => (
            <Skeleton key={`scenario-${index}`} className="h-10 w-20 rounded-md" />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {PANEL_CARDS.map((_, index) => (
          <div
            key={`panel-${index}`}
            className="flex h-[400px] flex-col rounded-xl border border-border bg-card p-3"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-7 w-36" />
              <Skeleton className="h-7 w-7 rounded-full" />
            </div>
            <div className="mt-4 flex-1 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <div className="mt-4 space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-12" />
              </div>
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
