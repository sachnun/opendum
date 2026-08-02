import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function UiCard({ className, children, ...props }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm", className)} {...props}>
      {children}
    </div>
  );
}

export function UiCardHeader({ className, children, ...props }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn("grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6", className)} {...props}>
      {children}
    </div>
  );
}

export function UiCardTitle({ className, children, ...props }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn("font-semibold leading-none", className)} {...props}>
      {children}
    </div>
  );
}

export function UiCardContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn("px-6", className)} {...props}>
      {children}
    </div>
  );
}
