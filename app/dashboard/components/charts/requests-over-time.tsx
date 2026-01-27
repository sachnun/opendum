"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ChartCard, EmptyChart } from "./chart-card";
import type { RequestsOverTimeData } from "@/lib/actions/analytics";

interface Props {
  data: RequestsOverTimeData[];
}

const chartConfig = {
  count: {
    label: "Requests",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

export function RequestsOverTimeChart({ data }: Props) {
  const hasData = data.some((d) => d.count > 0);

  return (
    <ChartCard title="Requests Over Time">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={chartConfig} className="h-[200px] w-full">
          <LineChart accessibilityLayer data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12 }}
              tickFormatter={(value) => {
                const date = new Date(value);
                return `${date.getMonth() + 1}/${date.getDate()}`;
              }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <ChartTooltip
              content={<ChartTooltipContent />}
              labelFormatter={(value) => {
                const date = new Date(value);
                return date.toLocaleDateString();
              }}
            />
            <Line
              type="monotone"
              dataKey="count"
              stroke="var(--color-count)"
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