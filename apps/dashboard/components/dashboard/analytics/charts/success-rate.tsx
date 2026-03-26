"use client";

import { AreaChart, Area, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, type ChartConfig } from "@/components/ui/chart";
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
    <ChartCard title="Success / Error Rate">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={chartConfig} className="h-[220px] w-full sm:h-[250px]">
          <AreaChart accessibilityLayer data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id="fillSuccess" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-success)" stopOpacity={0.2} />
                <stop offset="95%" stopColor="var(--color-success)" stopOpacity={0.01} />
              </linearGradient>
              <linearGradient id="fillError" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-error)" stopOpacity={0.2} />
                <stop offset="95%" stopColor="var(--color-error)" stopOpacity={0.01} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10 }}
              tickFormatter={(value) => formatTick(value, granularity)}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <ChartTooltip
              content={<ChartTooltipContent />}
              labelFormatter={(value) => formatTooltipLabel(value, granularity)}
            />
            <Area
              type="natural"
              dataKey="success"
              stackId="1"
              stroke="var(--color-success)"
              strokeWidth={1.5}
              fill="url(#fillSuccess)"
              fillOpacity={1}
            />
            <Area
              type="natural"
              dataKey="error"
              stackId="1"
              stroke="var(--color-error)"
              strokeWidth={1.5}
              fill="url(#fillError)"
              fillOpacity={1}
            />
            <ChartLegend content={<ChartLegendContent />} />
          </AreaChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
