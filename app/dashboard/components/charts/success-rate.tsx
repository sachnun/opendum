"use client";

import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ChartCard, EmptyChart } from "./chart-card";
import type { SuccessRateData, Granularity } from "@/lib/actions/analytics";

interface Props {
  data: SuccessRateData[];
  granularity: Granularity;
}

const chartConfig = {
  success: {
    label: "Success",
    color: "var(--chart-2)",
  },
  error: {
    label: "Error",
    color: "var(--destructive)",
  },
} satisfies ChartConfig;

// Format tick based on granularity
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

// Format tooltip label based on granularity
function formatTooltipLabel(value: string, granularity: Granularity): string {
  const date = new Date(value);
  
  if (granularity === "1d") {
    return date.toLocaleDateString();
  }
  return date.toLocaleString();
}

export function SuccessRateChart({ data, granularity }: Props) {
  const hasData = data.some((d) => d.success > 0 || d.error > 0);

  return (
    <ChartCard title="Success / Error Rate" className="col-span-full">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={chartConfig} className="h-[200px] w-full">
          <AreaChart accessibilityLayer data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
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
              tick={{ fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <ChartTooltip
              content={<ChartTooltipContent />}
              labelFormatter={(value) => formatTooltipLabel(value, granularity)}
            />
            <Legend />
            <Area
              type="monotone"
              dataKey="success"
              stackId="1"
              stroke="var(--color-success)"
              fill="var(--color-success)"
              fillOpacity={0.6}
            />
            <Area
              type="monotone"
              dataKey="error"
              stackId="1"
              stroke="var(--color-error)"
              fill="var(--color-error)"
              fillOpacity={0.6}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}