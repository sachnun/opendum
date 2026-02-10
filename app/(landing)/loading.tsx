import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-4 px-4 text-center">
        <Skeleton className="mx-auto h-10 w-36" />
        <Skeleton className="mx-auto h-4 w-48" />
        <div className="mt-6 flex items-center justify-center gap-3">
          <Skeleton className="h-11 w-11 rounded-full" />
          <Skeleton className="h-11 w-11 rounded-full" />
        </div>
      </div>
    </div>
  );
}
