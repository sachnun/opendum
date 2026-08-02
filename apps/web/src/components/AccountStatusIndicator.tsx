import { cn } from "../lib/utils";

export interface AccountStatusIndicatorProps {
  accountCount?: number;
  activeAccountCount?: number;
  indicator?: "normal" | "warning" | "error";
  className?: string;
}

export function AccountStatusIndicator({ accountCount = 0, activeAccountCount = 0, indicator = "normal", className }: AccountStatusIndicatorProps) {
  return (
    <span className={cn("flex items-center gap-1.5", className)}>
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          indicator === "error" ? "bg-destructive" : indicator === "warning" ? "bg-amber-400" : activeAccountCount > 0 ? "bg-emerald-400" : "bg-muted-foreground/40",
        )}
      />
      <span className="text-[10px] tabular-nums text-muted-foreground">
        {accountCount}
        {activeAccountCount !== accountCount ? `/${activeAccountCount}` : ""}
      </span>
    </span>
  );
}
