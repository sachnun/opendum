"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
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
        <ChartContainer config={chartConfig} className="h-[200px] w-full">
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
              tick={{ fontSize: 12 }}
              tickLine={false}
              axisLine={false}
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
            <Legend />
            <Line
              type="monotone"
              dataKey="input"
              stroke="var(--color-input)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="output"
              stroke="var(--color-output)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}