import { Skeleton } from "@/components/ui/skeleton";

const KEY_CARDS = Array.from({ length: 2 });

function PanelSkeleton({ showList = true }: { showList?: boolean }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-full max-w-56" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <Skeleton className="h-[54px] rounded-lg" />
          <Skeleton className="h-[54px] rounded-lg" />
        </div>

        <div className="mt-4 space-y-3 flex-1">
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>

          {showList && (
            <>
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-28 w-full rounded-lg" />
            </>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-border/60 pt-3">
          <Skeleton className="h-9 w-20 rounded-md" />
          <Skeleton className="h-9 w-16 rounded-md" />
        </div>
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-9 w-32 rounded-md" />
        </div>
      </div>

      <div className="space-y-4">
        {KEY_CARDS.map((_, index) => (
          <div
            key={`key-${index}`}
            className="rounded-xl border border-border bg-card p-5 md:p-6"
          >
            <div className="space-y-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Skeleton className="h-6 w-36" />
                    <Skeleton className="h-7 w-7 rounded-md" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                  <Skeleton className="h-4 w-full max-w-80" />
                </div>

                <div className="w-full xl:min-w-[420px] xl:max-w-[480px]">
                  <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-2 lg:max-w-[260px]">
                        <Skeleton className="h-3 w-16" />
                        <Skeleton className="h-11 w-full rounded-lg" />
                      </div>

                      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                        <Skeleton className="h-9 w-9 rounded-md" />
                        <Skeleton className="h-9 w-9 rounded-md" />
                        <Skeleton className="h-9 w-[92px] rounded-full" />
                        <Skeleton className="h-9 w-9 rounded-md" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((__, metaIndex) => (
                  <div
                    key={`meta-${metaIndex}`}
                    className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3"
                  >
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="mt-2 h-4 w-28" />
                  </div>
                ))}
              </div>

              <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                <PanelSkeleton />
                <PanelSkeleton />
                <PanelSkeleton showList={false} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
