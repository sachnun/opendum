"use client";

import { cn } from "@/lib/utils";

interface ChartCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

export function ChartCard({ title, children, className = "" }: ChartCardProps) {
  return (
    <div className={cn("rounded-xl border border-border/50 bg-card/50 py-4", className)}>
      <div className="px-4 pb-3 sm:px-5">
        <h4 className="text-sm font-medium text-muted-foreground">{title}</h4>
      </div>
      <div className="px-4 pt-0 sm:px-5">{children}</div>
    </div>
  );
}

interface EmptyChartProps {
  height?: number;
}

export function EmptyChart({ height = 200 }: EmptyChartProps) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-border/50 text-sm text-muted-foreground"
      style={{ height }}
    >
      No data yet
    </div>
  );
}
