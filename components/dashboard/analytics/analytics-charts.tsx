"use client";

import { useEffect, useRef, useState } from "react";
import { endOfDay, format, startOfDay } from "date-fns";
import type { LucideIcon } from "lucide-react";
import { CheckCircle, ChevronDown, Clock3, KeyRound, RefreshCw, TrendingUp, Zap } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  getAnalyticsData,
  type AnalyticsData,
  type CustomDateRange,
  type Period,
} from "@/lib/actions/analytics";
import { RequestsOverTimeChart } from "./charts/requests-over-time";
import { TokenUsageChart } from "./charts/token-usage";
import { RequestsByModelChart } from "./charts/requests-by-model";
import { ModelDistributionChart } from "./charts/model-distribution";
import { SuccessRateChart } from "./charts/success-rate";

const PERIODS: { value: Period; label: string }[] = [
  { value: "5m", label: "Last 5 minutes" },
  { value: "15m", label: "Last 15 minutes" },
  { value: "30m", label: "Last 30 minutes" },
  { value: "1h", label: "Last 1 hour" },
  { value: "6h", label: "Last 6 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

const QUICK_PERIODS: { value: Period; label: string }[] = [
  { value: "15m", label: "Last 15 minutes" },
  { value: "1h", label: "Last 1 hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

function toCustomDateRange(range: DateRange | undefined): CustomDateRange | null {
  if (!range?.from || !range?.to) {
    return null;
  }

  return {
    from: startOfDay(range.from).toISOString(),
    to: endOfDay(range.to).toISOString(),
  };
}

interface StatCard {
  title: string;
  value: string;
  detail?: string;
  icon: LucideIcon;
}

interface AnalyticsChartsProps {
  initialData: AnalyticsData | null;
  initialApiKeyId: string;
  apiKeys: {
    id: string;
    name: string | null;
    keyPreview: string;
  }[];
}

export function AnalyticsCharts({
  initialData,
  initialApiKeyId,
  apiKeys,
}: AnalyticsChartsProps) {
  const [period, setPeriod] = useState<Period>("24h");
  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string>(initialApiKeyId);
  const [customRange, setCustomRange] = useState<DateRange | undefined>(undefined);
  const [draftCustomRange, setDraftCustomRange] = useState<DateRange | undefined>(undefined);
  const [isCustomRangeActive, setIsCustomRangeActive] = useState(false);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isApiKeyFilterOpen, setIsApiKeyFilterOpen] = useState(false);
  const [data, setData] = useState<AnalyticsData | null>(initialData);
  const [isLoading, setIsLoading] = useState(!initialData);
  const [isFetching, setIsFetching] = useState(false);
  const isFirstLoad = useRef(true);
  const selectedPeriod = PERIODS.find((item) => item.value === period) ?? PERIODS[5];
  const customRangeLabel =
    customRange?.from && customRange?.to
      ? `${format(customRange.from, "dd MMM yyyy")} - ${format(customRange.to, "dd MMM yyyy")}`
      : "Custom range";
  const activeFilterLabel = isCustomRangeActive ? customRangeLabel : selectedPeriod.label;
  const selectedApiKey = apiKeys.find((apiKey) => apiKey.id === selectedApiKeyId) ?? null;
  const selectedApiKeyLabel = selectedApiKey
    ? `${selectedApiKey.name ?? "Unnamed key"} (${selectedApiKey.keyPreview})`
    : "All API keys";

  const fetchData = async (
    selectedPeriod: Period,
    selectedApiKey: string,
    selectedCustomRange?: CustomDateRange
  ) => {
    setIsFetching(true);

    try {
      const apiKeyId = selectedApiKey === "all" ? undefined : selectedApiKey;
      const result = selectedCustomRange
        ? await getAnalyticsData(selectedCustomRange, apiKeyId)
        : await getAnalyticsData(selectedPeriod, apiKeyId);

      if (result.success) {
        setData(result.data);
        return true;
      }

      toast.error(result.error);
      return false;
    } finally {
      setIsLoading(false);
      setIsFetching(false);
    }
  };

  useEffect(() => {
    const selectedCustomRange = isCustomRangeActive ? toCustomDateRange(customRange) : null;

    if (isCustomRangeActive && !selectedCustomRange) {
      return;
    }

    if (isFirstLoad.current) {
      isFirstLoad.current = false;

      if (initialData) {
        return;
      }
    }

    void fetchData(period, selectedApiKeyId, selectedCustomRange ?? undefined);
  }, [period, customRange, isCustomRangeActive, selectedApiKeyId, initialData]);

  useEffect(() => {
    if (isFilterOpen) {
      setDraftCustomRange(customRange);
    }
  }, [isFilterOpen, customRange]);

  const handlePeriodChange = (newPeriod: Period) => {
    setPeriod(newPeriod);
    setIsCustomRangeActive(false);
    setIsFilterOpen(false);
  };

  const handleApiKeyChange = (apiKeyId: string) => {
    setSelectedApiKeyId(apiKeyId);
    setIsApiKeyFilterOpen(false);
  };

  const handleApplyCustomRange = () => {
    if (!draftCustomRange?.from || !draftCustomRange?.to) {
      toast.error("Select a start and end date");
      return;
    }

    setCustomRange(draftCustomRange);
    setIsCustomRangeActive(true);
    setIsFilterOpen(false);
  };

  const handleClearCustomRange = () => {
    setDraftCustomRange(undefined);
    setCustomRange(undefined);
    setIsCustomRangeActive(false);
  };

  const handleRefresh = async () => {
    const selectedCustomRange = isCustomRangeActive ? toCustomDateRange(customRange) : null;

    if (isCustomRangeActive && !selectedCustomRange) {
      toast.error("Select a valid custom date range");
      return;
    }

    await fetchData(period, selectedApiKeyId, selectedCustomRange ?? undefined);
  };

  const statCards: StatCard[] = data
    ? [
        {
          title: "Total Requests",
          value: data.totals.totalRequests.toLocaleString(),
          icon: TrendingUp,
        },
        {
          title: "Total Tokens",
          value: (data.totals.totalInputTokens + data.totals.totalOutputTokens).toLocaleString(),
          detail: `${data.totals.totalInputTokens.toLocaleString()} in / ${data.totals.totalOutputTokens.toLocaleString()} out`,
          icon: Zap,
        },
        {
          title: "Avg Duration",
          value: data.totals.avgDuration > 0 ? `${data.totals.avgDuration}ms` : "-",
          icon: Clock3,
        },
        {
          title: "Success Rate",
          value: data.totals.totalRequests > 0 ? `${data.totals.successRate}%` : "-",
          icon: CheckCircle,
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <h3 className="text-sm font-semibold tracking-tight sm:text-base">Analytics</h3>
        <div className="flex items-center gap-2">
          <Popover open={isApiKeyFilterOpen} onOpenChange={setIsApiKeyFilterOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={isFetching || apiKeys.length === 0}
                className="h-8 min-w-36 justify-between rounded-lg border-border bg-background px-2.5 text-xs sm:h-9 sm:min-w-48 sm:text-sm"
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="truncate">{selectedApiKeyLabel}</span>
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-2">
              <div className="space-y-1">
                <Button
                  variant={selectedApiKeyId === "all" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 w-full justify-start rounded-md px-2.5 text-xs"
                  onClick={() => handleApiKeyChange("all")}
                  disabled={isFetching}
                >
                  All API keys
                </Button>

                {apiKeys.map((apiKey) => (
                  <Button
                    key={apiKey.id}
                    variant={selectedApiKeyId === apiKey.id ? "secondary" : "ghost"}
                    size="sm"
                    className="h-8 w-full justify-start rounded-md px-2.5 text-xs"
                    onClick={() => handleApiKeyChange(apiKey.id)}
                    disabled={isFetching}
                  >
                    <span className="truncate">{apiKey.name ?? "Unnamed key"}</span>
                    <span className="ml-1 truncate text-[11px] text-muted-foreground">
                      {apiKey.keyPreview}
                    </span>
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Popover open={isFilterOpen} onOpenChange={setIsFilterOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={isFetching}
                className="h-8 min-w-36 justify-between rounded-lg border-border bg-background px-2.5 text-xs sm:h-9 sm:min-w-48 sm:text-sm"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Clock3 className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="hidden sm:inline">{activeFilterLabel}</span>
                  <span className="sm:hidden">{isCustomRangeActive ? "custom" : selectedPeriod.value}</span>
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="p-0">
              <div className="space-y-2 p-3">
                <p className="text-xs font-medium text-muted-foreground">Quick ranges</p>
                <div className="grid grid-cols-1 gap-1">
                  {QUICK_PERIODS.map((item) => (
                    <Button
                      key={item.value}
                      variant={!isCustomRangeActive && period === item.value ? "secondary" : "ghost"}
                      size="sm"
                      className="h-8 justify-start rounded-md px-2.5 text-xs"
                      onClick={() => handlePeriodChange(item.value)}
                      disabled={isFetching}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
              </div>
              <Separator />
              <div className="space-y-2 p-3">
                <p className="text-xs font-medium text-muted-foreground">Custom range</p>
                <Calendar
                  mode="range"
                  selected={draftCustomRange}
                  onSelect={setDraftCustomRange}
                  defaultMonth={draftCustomRange?.from ?? customRange?.from ?? new Date()}
                  disabled={(date) => date > new Date()}
                  className="rounded-md border border-border p-2 [--cell-size:--spacing(7)]"
                />
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2.5 text-xs"
                    onClick={handleClearCustomRange}
                    disabled={
                      isFetching ||
                      (!isCustomRangeActive && !draftCustomRange?.from && !draftCustomRange?.to)
                    }
                  >
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 px-2.5 text-xs"
                    onClick={handleApplyCustomRange}
                    disabled={isFetching || !draftCustomRange?.from || !draftCustomRange?.to}
                  >
                    Apply range
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={handleRefresh}
            disabled={isFetching}
            className="h-8 w-8 rounded-lg border-border bg-background sm:h-9 sm:w-9"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {statCards.map((item) => (
            <Card key={item.title} className="border-border bg-card py-4">
              <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 pb-2 sm:px-5">
                <CardTitle className="text-sm text-muted-foreground">
                  {item.title}
                </CardTitle>
                <item.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="space-y-1 px-4 sm:px-5">
                <p className="text-2xl font-semibold tracking-tight sm:text-3xl">{item.value}</p>
                {item.detail && <p className="text-xs text-muted-foreground">{item.detail}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!isLoading &&
        (data ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RequestsOverTimeChart data={data.requestsOverTime} granularity={data.granularity} />
            <TokenUsageChart data={data.tokenUsage} granularity={data.granularity} />
            <RequestsByModelChart data={data.requestsByModel} />
            <ModelDistributionChart data={data.modelDistribution} />
            <SuccessRateChart data={data.successRate} granularity={data.granularity} />
          </div>
        ) : (
          <Card className="border-border bg-card py-8">
            <CardContent className="px-5 text-sm text-muted-foreground sm:text-base">
              No data in the selected time range.
            </CardContent>
          </Card>
        ))}
    </div>
  );
}
