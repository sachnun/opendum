"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { ChartCard, EmptyChart } from "./chart-card";
import type { RequestsByModelData } from "@/lib/actions/analytics";

interface Props {
  data: RequestsByModelData[];
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

export function RequestsByModelChart({ data }: Props) {
  const hasData = data.length > 0;

  return (
    <ChartCard title="Requests by Model">
      {!hasData ? (
        <EmptyChart />
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 12 }} className="text-muted-foreground" />
            <YAxis
              type="category"
              dataKey="model"
              tick={{ fontSize: 11 }}
              width={100}
              className="text-muted-foreground"
              tickFormatter={(value) => {
                // Truncate long model names
                return value.length > 15 ? value.substring(0, 15) + "..." : value;
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "6px",
              }}
              formatter={(value) => [(value as number).toLocaleString(), "Requests"]}
            />
            <Bar dataKey="count" radius={[0, 4, 4, 0]}>
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
