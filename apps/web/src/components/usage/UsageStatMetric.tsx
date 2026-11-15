import { Show, type JSX } from "solid-js";
import { cn } from "~/lib/utils";

export interface UsageStatMetricProps {
  label: string;
  value: string | number;
  variant?: "plain" | "card";
  compact?: boolean;
  delta?: string;
  deltaKey?: string | number;
  deltaTone?: "positive" | "negative" | "neutral";
}

export function UsageStatMetric(props: UsageStatMetricProps): JSX.Element {
  const rootClass = () =>
    props.variant === "card" ? "rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5" : "";
  const valueClass = () => (props.compact ? "text-xs sm:text-sm" : "text-sm");

  return (
    <div class={rootClass()}>
      <p class="truncate text-[10px] text-muted-foreground">{props.label}</p>
      <div class="relative inline-block max-w-full">
        <p class={cn("truncate font-semibold tabular-nums text-foreground", valueClass())}>{props.value}</p>
        <Show when={props.delta}>
          <span
            class={`pointer-events-none absolute left-full top-1/2 ml-1 -translate-y-1/2 whitespace-nowrap text-[10px] font-black tabular-nums animate-[stat-hit_1800ms_ease-in-out_both] ${
              props.deltaTone === "negative"
                ? "text-red-500"
                : props.deltaTone === "neutral"
                  ? "text-blue-500"
                  : "text-emerald-500"
            }`}
          >
            {props.delta}
          </span>
        </Show>
      </div>
    </div>
  );
}

