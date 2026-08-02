import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

type Variant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";

const variantClasses: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive/60 text-white",
  outline: "border-border text-foreground",
  ghost: "",
  link: "text-primary underline-offset-4",
};

export interface UiBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
  children?: ReactNode;
}

export function UiBadge({ variant = "default", className, children, ...props }: UiBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border border-transparent px-2 py-0.5 text-xs font-medium transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-3",
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
