import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

export interface UsageSparklineProps {
  values: number[];
  color: string;
  ariaLabel?: string;
  className?: string;
  height?: number;
}

function buildSparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return `M0,${height} L${width},${height}`;
  }
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

export function UsageSparkline({ values, color, ariaLabel = "Usage trend", className, height = 32 }: UsageSparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(120);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateChartWidth = () => setChartWidth(Math.max(1, Math.round(element.getBoundingClientRect().width)));
    updateChartWidth();
    const observer = new ResizeObserver(updateChartWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const sparklinePath = buildSparklinePath(values, chartWidth, height);
  const areaPath = sparklinePath ? `${sparklinePath} L${chartWidth},${height} L0,${height} Z` : "";

  return (
    <div ref={containerRef} className={cn("relative h-8 w-full", className)}>
      <svg viewBox={`0 0 ${chartWidth} ${height}`} className="h-full w-full" preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        <path d={`M0,${height} L${chartWidth},${height}`} stroke="var(--border)" strokeWidth="1" fill="none" vectorEffect="non-scaling-stroke" />
        {areaPath ? <path d={areaPath} fill={color} fillOpacity="0.18" stroke="none" /> : null}
        {sparklinePath ? (
          <path d={sparklinePath} stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        ) : null}
      </svg>
    </div>
  );
}
