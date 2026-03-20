import { Skeleton } from "@/components/ui/skeleton";

export function HeaderSkeleton() {
  return (
    <header className="sticky top-0 z-30 h-16 border-b border-border bg-background px-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex h-full w-full max-w-7xl items-center gap-3 md:gap-0">
        {/* Mobile nav placeholder */}
        <div className="flex min-w-0 items-center md:hidden">
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
        {/* Search bar placeholder */}
        <div className="min-w-0 flex-1">
          <Skeleton className="mx-auto h-9 w-full max-w-xl rounded-md" />
        </div>
        {/* Theme toggle + avatar placeholder */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
      </div>
    </header>
  );
}
