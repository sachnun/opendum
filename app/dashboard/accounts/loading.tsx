import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="relative">
        <div className="md:fixed md:inset-x-0 md:top-16 md:z-20 md:left-60 md:bg-background md:pt-5">
          <div className="mx-auto w-full max-w-7xl px-5 sm:px-6 lg:px-8">
            <div className="bg-background">
              <div className="pb-4 border-b border-border">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Skeleton className="h-9 w-56" />
                  <Skeleton className="h-10 w-36" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="hidden h-[76px] md:block" />
      </div>

      <div className="space-y-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    </div>
  );
}
