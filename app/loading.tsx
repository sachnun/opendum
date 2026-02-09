import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-4 px-4">
        <Skeleton className="mx-auto h-10 w-40" />
        <Skeleton className="mx-auto h-4 w-56" />
        <Skeleton className="mx-auto h-11 w-56" />
      </div>
    </div>
  );
}
