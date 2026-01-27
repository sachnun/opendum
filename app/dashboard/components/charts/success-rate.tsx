"use client";

import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ChartCard, EmptyChart } from "./chart-card";
import type { SuccessRateData } from "@/lib/actions/analytics";

interface Props {
  data: SuccessRateData[];
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

export function SuccessRateChart({ data }: Props) {
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