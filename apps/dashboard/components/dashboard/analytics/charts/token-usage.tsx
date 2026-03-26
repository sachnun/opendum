"use client";

import { AreaChart, Area, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, type ChartConfig } from "@/components/ui/chart";
import { ChartCard, EmptyChart } from "./chart-card";
import type { TokenUsageData, Granularity } from "@/lib/actions/analytics";

interface Props {
  data: TokenUsageData[];
  granularity: Granularity;
}

const chartConfig = {
  input: {
    label: "Input Tokens",
    color: "var(--chart-1)",
  },
  output: {
    label: "Output Tokens",
    color: "var(--chart-2)",
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

export function TokenUsageChart({ data, granularity }: Props) {
  const hasData = data.some((d) => d.input > 0 || d.output > 0);

  return (
    <ChartCard title="Token Usage">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={chartConfig} className="h-[220px] w-full sm:h-[250px]">
          <AreaChart accessibilityLayer data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id="fillInput" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-input)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="var(--color-input)" stopOpacity={0.01} />
              </linearGradient>
              <linearGradient id="fillOutput" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-output)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="var(--color-output)" stopOpacity={0.01} />
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
              width={48}
              tickFormatter={(value) => {
                if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
                if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
                return value;
              }}
            />
            <ChartTooltip
              content={<ChartTooltipContent />}
              labelFormatter={(value) => formatTooltipLabel(value, granularity)}
            />
            <Area
              type="natural"
              dataKey="input"
              stroke="var(--color-input)"
              strokeWidth={1.5}
              fill="url(#fillInput)"
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0 }}
            />
            <Area
              type="natural"
              dataKey="output"
              stroke="var(--color-output)"
              strokeWidth={1.5}
              fill="url(#fillOutput)"
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0 }}
            />
            <ChartLegend content={<ChartLegendContent />} />
          </AreaChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
