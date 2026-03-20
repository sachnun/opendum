"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ChartCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

export function ChartCard({ title, children, className = "" }: ChartCardProps) {
  return (
    <Card className={cn("border-border bg-card py-4", className)}>
      <CardHeader className="px-4 pb-3 sm:px-5">
        <CardTitle className="text-sm font-semibold tracking-tight">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pt-0 sm:px-5">{children}</CardContent>
    </Card>
  );
}

interface EmptyChartProps {
  height?: number;
}

export function EmptyChart({ height = 200 }: EmptyChartProps) {
  return (
    <div
      className="flex items-center justify-center rounded-xl border border-dashed border-border bg-muted text-sm text-muted-foreground"
      style={{ height }}
    >
      No data yet
    </div>
  );
}
