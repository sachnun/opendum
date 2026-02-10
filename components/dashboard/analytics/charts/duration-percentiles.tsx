"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { ChartCard, EmptyChart } from "./chart-card";
import type { DurationOverTimeData, Granularity } from "@/lib/actions/analytics";

interface Props {
  data: DurationOverTimeData[];
  granularity: Granularity;
}

const chartConfig = {
  avg: {
    label: "Avg Duration",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

const percentileKeys = [
  { key: "p50", label: "P50" },
  { key: "p95", label: "P95" },
  { key: "p99", label: "P99" },
] as const;

function formatTick(value: string, granularity: Granularity): string {
  const date = new Date(value);

  switch (granularity) {
    case "10s":
    case "1m":
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    case "5m":
    case "15m":
    case "1h":
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    case "1d":
      return `${date.getMonth() + 1}/${date.getDate()}`;
  }
}

function formatTooltipLabel(value: string, granularity: Granularity): string {
  const date = new Date(value);

  if (granularity === "1d") {
    return date.toLocaleDateString();
  }

  return date.toLocaleString();
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return "-";
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }

  return `${value}ms`;
}

interface DurationTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: DurationOverTimeData }>;
  label?: string;
  granularity: Granularity;
}

function DurationTooltip({ active, payload, label, granularity }: DurationTooltipProps) {
  if (!active || !payload?.length) {
    return null;
  }

  const point = payload[0]?.payload;

  if (!point) {
    return null;
  }

  return (
    <div className="border-border/50 bg-background grid min-w-[11rem] gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{formatTooltipLabel(label || point.date, granularity)}</div>
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Average</span>
          <span className="text-foreground font-mono font-medium tabular-nums">
            {formatDuration(point.avg)}
          </span>
        </div>
        {percentileKeys.map(({ key, label: percentileLabel }) => (
          <div key={percentileLabel} className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{percentileLabel}</span>
            <span className="text-foreground font-mono font-medium tabular-nums">
              {formatDuration(point[key])}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DurationPercentilesChart({ data, granularity }: Props) {
  const hasData = data.some((item) => item.avg !== null);

  return (
    <ChartCard title="Average Duration Over Time" className="col-span-full">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={chartConfig} className="h-[230px] w-full sm:h-[250px]">
          <LineChart accessibilityLayer data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10 }}
              tickFormatter={(value) => formatTick(value, granularity)}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12 }}
              tickFormatter={(value) => {
                if (value >= 1000) {
                  return `${(value / 1000).toFixed(1)}s`;
                }

                return `${value}ms`;
              }}
            />
            <ChartTooltip content={<DurationTooltip granularity={granularity} />} />
            <Line
              type="monotone"
              dataKey="avg"
              stroke="var(--color-avg)"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
