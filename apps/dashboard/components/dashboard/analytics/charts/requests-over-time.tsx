"use client";

import { AreaChart, Area, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ChartCard, EmptyChart } from "./chart-card";
import type { RequestsOverTimeData, Granularity } from "@/lib/actions/analytics";

interface Props {
  data: RequestsOverTimeData[];
  granularity: Granularity;
}

const chartConfig = {
  count: {
    label: "Requests",
    color: "var(--chart-1)",
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

export function RequestsOverTimeChart({ data, granularity }: Props) {
  const hasData = data.some((d) => d.count > 0);

  return (
    <ChartCard title="Requests Over Time">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={chartConfig} className="h-[220px] w-full sm:h-[250px]">
          <AreaChart accessibilityLayer data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id="fillRequests" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-count)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="var(--color-count)" stopOpacity={0.01} />
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
              dataKey="count"
              stroke="var(--color-count)"
              strokeWidth={1.5}
              fill="url(#fillRequests)"
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0 }}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
