import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function UiSkeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-accent", className)} {...props} />;
}
