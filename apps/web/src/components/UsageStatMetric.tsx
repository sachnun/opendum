import { cn } from "../lib/utils";

export interface UsageStatMetricProps {
  label: string;
  value: string | number;
  variant?: "plain" | "card";
  compact?: boolean;
  delta?: string;
  deltaKey?: string | number;
  deltaTone?: "positive" | "negative" | "neutral";
}

export function UsageStatMetric({ label, value, variant = "plain", compact, delta, deltaKey, deltaTone = "positive" }: UsageStatMetricProps) {
  return (
    <div className={variant === "card" ? "rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5" : ""}>
      <p className="truncate text-[10px] text-muted-foreground">{label}</p>
      <div className="relative inline-block max-w-full">
        <p className={cn("truncate font-semibold tabular-nums text-foreground", compact ? "text-xs sm:text-sm" : "text-sm")}>{value}</p>
        {delta ? (
          <span
            key={deltaKey}
            className={cn(
              "pointer-events-none absolute left-full top-1/2 ml-1 -translate-y-1/2 whitespace-nowrap text-[10px] font-black tabular-nums animate-[stat-hit_1800ms_ease-in-out_both]",
              deltaTone === "negative" ? "text-red-500" : deltaTone === "neutral" ? "text-blue-500" : "text-emerald-500",
            )}
          >
            {delta}
          </span>
        ) : null}
      </div>
    </div>
  );
}
