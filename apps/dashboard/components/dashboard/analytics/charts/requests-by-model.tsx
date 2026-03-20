"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ChartCard, EmptyChart } from "./chart-card";
import type { RequestsByModelData } from "@/lib/actions/analytics";

interface Props {
  data: RequestsByModelData[];
}

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
  "var(--chart-10)",
];

export function RequestsByModelChart({ data }: Props) {
  const hasData = data.length > 0;

  const chartConfig: ChartConfig = data.reduce((acc, item, index) => {
    return {
      ...acc,
      [`model${index}`]: {
        label: item.model,
        color: CHART_COLORS[index % CHART_COLORS.length],
      },
    };
  }, {} as ChartConfig);

  // Transform data to use indexed keys
  const transformedData = data.map((item, index) => ({
    ...item,
    modelKey: `model${index}`,
  }));

  return (
    <ChartCard title="Requests by Model">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={chartConfig} className="h-[230px] w-full sm:h-[250px]">
          <BarChart
            accessibilityLayer
            data={transformedData}
            layout="vertical"
            margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
          >
            <CartesianGrid horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="model"
              tick={{ fontSize: 11 }}
              width={100}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => {
                return value.length > 15 ? value.substring(0, 15) + "..." : value;
              }}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="count" radius={[0, 4, 4, 0]}>
              {transformedData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
