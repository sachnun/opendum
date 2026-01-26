"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from "recharts";
import { ChartCard, EmptyChart } from "./chart-card";
import type { ModelDistributionData } from "@/lib/actions/analytics";

interface Props {
  data: ModelDistributionData[];
}

const COLORS = [
  "hsl(var(--primary))",
  "hsl(142, 76%, 36%)",
  "hsl(221, 83%, 53%)",
  "hsl(262, 83%, 58%)",
  "hsl(24, 94%, 50%)",
  "hsl(174, 72%, 46%)",
  "hsl(340, 82%, 52%)",
  "hsl(47, 95%, 53%)",
  "hsl(199, 89%, 48%)",
  "hsl(0, 84%, 60%)",
];

export function ModelDistributionChart({ data }: Props) {
  const hasData = data.length > 0;

  return (
    <ChartCard title="Model Distribution">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={40}
              outerRadius={70}
              paddingAngle={2}
              dataKey="value"
              nameKey="model"
            >
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "6px",
              }}
              formatter={(value, name, props) => {
                const item = props.payload as ModelDistributionData;
                return [`${value} (${item.percentage}%)`, name];
              }}
            />
            <Legend
              layout="vertical"
              verticalAlign="middle"
              align="right"
              wrapperStyle={{ fontSize: "11px" }}
              formatter={(value) => {
                // Truncate long model names in legend
                return value.length > 12 ? value.substring(0, 12) + "..." : value;
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
