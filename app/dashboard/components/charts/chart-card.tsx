"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ChartCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

export function ChartCard({ title, children, className = "" }: ChartCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}

interface EmptyChartProps {
  height?: number;
}

export function EmptyChart({ height = 200 }: EmptyChartProps) {
  return (
    <div
      className="flex items-center justify-center text-muted-foreground text-sm"
      style={{ height }}
    >
      No data yet
    </div>
  );
}
