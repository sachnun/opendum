import { Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { cn } from "~/lib/utils";

export interface UsageSparklineProps {
  values: number[];
  color: string;
  ariaLabel?: string;
  class?: string | string[];
  height?: number;
}

function sparkPath(values: number[], width: number, height: number): string {
  if (values.length === 0) return `M0,${height} L${width},${height}`;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  if (max === min) {
    const y = max === 0 ? height : height / 2;
    return values.map((_, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)},${y.toFixed(2)}`).join(" ");
  }

  const range = max - min;
  return values
    .map((value, index) => {
      const x = index * step;
      const normalized = (value - min) / range;
      const y = height - normalized * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function UsageSparkline(props: UsageSparklineProps): JSX.Element {
  const [chartWidth, setChartWidth] = createSignal(120);
  let container: HTMLDivElement | undefined;
  let observer: ResizeObserver | null = null;

  onMount(() => {
    if (!container) return;
    const element = container;
    observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.getBoundingClientRect().width;
      setChartWidth(Math.max(1, Math.round(width)));
    });
    observer.observe(element);
  });

  onCleanup(() => observer?.disconnect());

  const height = () => props.height ?? 32;
  const path = createMemo(() => sparkPath(props.values, chartWidth(), height()));
  const areaPath = createMemo(() => (path() ? `${path()} L${chartWidth()},${height()} L0,${height()} Z` : ""));

  return (
    <div ref={container} class={cn("relative h-8 w-full", props.class)}>
      <svg
        viewBox={`0 0 ${chartWidth()} ${height()}`}
        class="h-full w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={props.ariaLabel ?? "Usage trend"}
      >
        <path d={`M0,${height()} L${chartWidth()},${height()}`} stroke="var(--border)" stroke-width="1" fill="none" vector-effect="non-scaling-stroke" />
        <Show when={areaPath()}>
          <path d={areaPath()} fill={props.color} fill-opacity="0.18" stroke="none" />
        </Show>
        <Show when={path()}>
          <path
            d={path()}
            stroke={props.color}
            stroke-width="2"
            vector-effect="non-scaling-stroke"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </Show>
      </svg>
    </div>
  );
}
