import { Skeleton } from "@/components/ui/skeleton";

const ACCOUNT_CARDS = Array.from({ length: 3 });

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="relative">
        <div className="md:fixed md:inset-x-0 md:top-16 md:z-20 md:left-60 md:bg-background md:pt-5">
          <div className="mx-auto w-full max-w-7xl px-5 sm:px-6 lg:px-8">
            <div className="bg-background">
              <div className="pb-4 border-b border-border">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Skeleton className="h-6 w-44" />
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-9 w-32 rounded-md" />
                    <Skeleton className="h-9 w-32 rounded-md" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="hidden h-[76px] md:block" />
      </div>

      <div className="space-y-8">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>

        <div className="grid gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ACCOUNT_CARDS.map((_, index) => (
            <div
              key={`account-${index}`}
              className="rounded-xl border border-border bg-card p-4 sm:p-5"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>

              <div className="mt-4 space-y-3">
                <Skeleton className="h-16 w-full rounded-md" />
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>

              <div className="mt-4 flex gap-2">
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-8 w-8 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
