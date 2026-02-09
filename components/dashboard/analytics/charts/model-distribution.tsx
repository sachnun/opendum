"use client";

import { PieChart, Pie, Cell, Legend, Tooltip } from "recharts";
import { ChartContainer, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ChartCard, EmptyChart } from "./chart-card";
import type { ModelDistributionData } from "@/lib/actions/analytics";

interface Props {
  data: ModelDistributionData[];
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

export function ModelDistributionChart({ data }: Props) {
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

  // Transform data to include fill color directly
  const transformedData = data.map((item, index) => ({
    ...item,
    fill: CHART_COLORS[index % CHART_COLORS.length],
  }));

  return (
    <ChartCard title="Model Distribution">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={chartConfig} className="h-[230px] w-full sm:h-[250px]">
          <PieChart>
            <Pie
              data={transformedData}
              cx="50%"
              cy="50%"
              innerRadius={40}
              outerRadius={70}
              paddingAngle={2}
              dataKey="value"
              nameKey="model"
            >
              {transformedData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              content={<ChartTooltipContent />}
              formatter={(value, name) => {
                const item = data.find((d) => d.model === name);
                return [`${value} (${item?.percentage}%)`, name];
              }}
            />
            <Legend
              layout="horizontal"
              verticalAlign="bottom"
              align="center"
              wrapperStyle={{ fontSize: "11px", paddingTop: "10px" }}
              formatter={(value) => {
                return value.length > 12 ? value.substring(0, 12) + "..." : value;
              }}
            />
          </PieChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
