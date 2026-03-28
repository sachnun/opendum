"use client";

import { LineChart, Line, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, type ChartConfig } from "@/components/ui/chart";
import { ChartCard, EmptyChart } from "./chart-card";
import type { SuccessRateData, Granularity } from "@/lib/actions/analytics";

interface Props {
  data: SuccessRateData[];
  granularity: Granularity;
}

const chartConfig = {
  successRate: {
    label: "Success",
    color: "var(--chart-2)",
  },
  errorRate: {
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
  const chartData = data.map((point) => {
    const total = point.success + point.error;
    const successRate =
      point.successRate !== undefined
        ? point.successRate
        : total > 0
          ? Math.round((point.success / total) * 1000) / 10
          : 0;
    const errorRate =
      point.errorRate !== undefined
        ? point.errorRate
        : total > 0
          ? Math.round((point.error / total) * 1000) / 10
          : 0;

    return {
      ...point,
      successRate,
      errorRate,
    };
  });

  return (
    <ChartCard title="Success / Error Rate">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={chartConfig} className="h-[220px] w-full sm:h-[250px]">
          <LineChart accessibilityLayer data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
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
              width={44}
              domain={[0, 100]}
              tickFormatter={(value) => `${value}%`}
            />
            <ChartTooltip
              content={(
                <ChartTooltipContent
                  formatter={(value, name, item) => {
                    const numericValue = typeof value === "number" ? value : Number(value);
                    const formattedRate = `${numericValue.toFixed(1)}%`;
                    const successCount = Number(item.payload?.success ?? 0).toLocaleString();
                    const errorCount = Number(item.payload?.error ?? 0).toLocaleString();

                    if (item.dataKey === "successRate") {
                      return [formattedRate, `Success (${successCount})`];
                    }

                    return [formattedRate, `Error (${errorCount})`];
                  }}
                />
              )}
              labelFormatter={(value) => formatTooltipLabel(value, granularity)}
            />
            <Line
              type="monotone"
              dataKey="successRate"
              stroke="var(--color-successRate)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0 }}
            />
            <Line
              type="monotone"
              dataKey="errorRate"
              stroke="var(--color-errorRate)"
              strokeWidth={2}
              dot={false}
              strokeDasharray="4 3"
              activeDot={{ r: 3.5, strokeWidth: 0 }}
            />
            <ChartLegend content={<ChartLegendContent />} />
          </LineChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
