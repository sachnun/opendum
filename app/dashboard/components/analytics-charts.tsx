"use client";

import { useState, useEffect, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RefreshCw, TrendingUp, Zap, Clock, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { getAnalyticsData, type Period, type AnalyticsData, type Granularity } from "@/lib/actions/analytics";
import { RequestsOverTimeChart } from "./charts/requests-over-time";
import { TokenUsageChart } from "./charts/token-usage";
import { RequestsByModelChart } from "./charts/requests-by-model";
import { ModelDistributionChart } from "./charts/model-distribution";
import { SuccessRateChart } from "./charts/success-rate";

const PERIODS: { value: Period; label: string }[] = [
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
];

// Map period to granularity for chart formatting
const PERIOD_GRANULARITY: Record<Period, Granularity> = {
  "5m": "10s",
  "15m": "1m",
  "30m": "1m",
  "1h": "5m",
  "6h": "15m",
  "24h": "1h",
  "7d": "1d",
  "30d": "1d",
  "90d": "1d",
};

export function AnalyticsCharts() {
  const [period, setPeriod] = useState<Period>("7d");
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = async (selectedPeriod: Period) => {
    const result = await getAnalyticsData(selectedPeriod);
    if (result.success) {
      setData(result.data);
    } else {
      toast.error(result.error);
    }
    setIsLoading(false);
  };

  useEffect(() => {
    startTransition(() => {
      fetchData(period);
    });
  }, [period]);

  const handlePeriodChange = (newPeriod: Period) => {
    setPeriod(newPeriod);
    startTransition(() => {
      fetchData(newPeriod);
    });
  };

  const handleRefresh = () => {
    startTransition(() => {
      fetchData(period);
    });
    toast.success("Analytics refreshed");
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with period selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h3 className="text-base md:text-lg font-semibold">Analytics</h3>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border p-1 overflow-x-auto">
            {PERIODS.map((p) => (
              <Button
                key={p.value}
                variant={period === p.value ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 sm:px-3 text-xs whitespace-nowrap"
                onClick={() => handlePeriodChange(p.value)}
                disabled={isPending}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isPending}
            className="h-9"
          >
            <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Summary stats */}
      {data && (
        <div className="grid gap-3 sm:gap-4 grid-cols-2 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                Total Requests
              </CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-xl md:text-2xl font-bold">
                {data.totals.totalRequests.toLocaleString()}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                Total Tokens
              </CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-xl md:text-2xl font-bold">
                {(data.totals.totalInputTokens + data.totals.totalOutputTokens).toLocaleString()}
              </div>
              <p className="text-xs text-muted-foreground">
                {data.totals.totalInputTokens.toLocaleString()} in / {data.totals.totalOutputTokens.toLocaleString()} out
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                Avg Duration
              </CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-xl md:text-2xl font-bold">
                {data.totals.avgDuration > 0 ? `${data.totals.avgDuration}ms` : "-"}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                Success Rate
              </CardTitle>
              <CheckCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-xl md:text-2xl font-bold">
                {data.totals.totalRequests > 0 ? `${data.totals.successRate}%` : "-"}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Charts grid */}
      {data && (
        <div className="grid gap-3 sm:gap-4 grid-cols-1 md:grid-cols-2">
          <RequestsOverTimeChart data={data.requestsOverTime} granularity={PERIOD_GRANULARITY[period]} />
          <TokenUsageChart data={data.tokenUsage} granularity={PERIOD_GRANULARITY[period]} />
          <RequestsByModelChart data={data.requestsByModel} />
          <ModelDistributionChart data={data.modelDistribution} />
          <SuccessRateChart data={data.successRate} granularity={PERIOD_GRANULARITY[period]} />
        </div>
      )}
    </div>
  );
}
