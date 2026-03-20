"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface UsageSparklineProps {
  values: number[];
  color: string;
  ariaLabel: string;
  className?: string;
  emptyLabel?: string;
  height?: number;
}

function buildSparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return "";
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  if (max === min) {
    const y = max === 0 ? height : height / 2;
    return values
      .map((_, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)},${y.toFixed(2)}`)
      .join(" ");
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

function buildSparklineArea(path: string, width: number, height: number): string {
  if (!path) {
    return "";
  }

  return `${path} L${width},${height} L0,${height} Z`;
}

export function UsageSparkline({
  values,
  color,
  ariaLabel,
  className,
  emptyLabel = "No activity yet",
  height = 32,
}: UsageSparklineProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [chartWidth, setChartWidth] = useState(120);
  const hasUsage = values.some((value) => value > 0);
  const sparklinePath = buildSparklinePath(values, chartWidth, height);
  const areaPath = buildSparklineArea(sparklinePath, chartWidth, height);

  useEffect(() => {
    const element = containerRef.current;

    if (!element) {
      return;
    }

    const updateChartWidth = () => {
      const nextWidth = Math.max(1, Math.round(element.getBoundingClientRect().width));
      setChartWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };

    updateChartWidth();

    const observer = new ResizeObserver(updateChartWidth);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className={cn("relative h-8 w-full", className)}>
      <svg viewBox={`0 0 ${chartWidth} ${height}`} className="h-full w-full" role="img" aria-label={ariaLabel}>
        <path d={`M0,${height} L${chartWidth},${height}`} stroke="var(--border)" strokeWidth="1" fill="none" />
        {hasUsage && areaPath ? <path d={areaPath} fill={color} fillOpacity="0.18" stroke="none" /> : null}
        {hasUsage && sparklinePath ? (
          <path
            d={sparklinePath}
            stroke={color}
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
      {!hasUsage ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
          {emptyLabel}
        </span>
      ) : null}
    </div>
  );
}
