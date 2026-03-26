"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Eye, Copy, Check, Brain, Wrench, Calendar, BarChart3, Play } from "lucide-react";
import { UsageSparkline } from "@/components/dashboard/shared/usage-sparkline";
import { usePlaygroundPreset } from "@/lib/playground-preset-context";
import type { ModelMeta } from "@opendum/shared/proxy/models";

interface ModelStats {
  totalRequests: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
  avgDurationLastDay: number | null;
  durationLast24Hours: Array<{ time: string; avgDuration: number | null }>;
}

interface ModelCardProps {
  id: string;
  providers: string[];
  meta?: ModelMeta;
  stats: ModelStats;
  isEnabled: boolean;
  isUpdating: boolean;
  onEnabledChange: (modelId: string, enabled: boolean) => void;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return tokens.toString();
}

function formatDate(dateStr: string): string {
  // Format: "2025-04" or "2025-04-29"
  const parts = dateStr.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = parts[0];
  const month = months[parseInt(parts[1], 10) - 1];
  return `${month} ${year}`;
}

function formatDuration(duration: number | null): string {
  if (duration === null) {
    return "-";
  }

  if (duration >= 1000) {
    return `${(duration / 1000).toFixed(2)}s`;
  }

  return `${duration}ms`;
}

function formatHourLabel(time: string): string {
  const date = new Date(time);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ModelCard({
  id,
  providers,
  meta,
  stats,
  isEnabled,
  isUpdating,
  onEnabledChange,
}: ModelCardProps) {
  const [copied, setCopied] = useState(false);
  const router = useRouter();
  const { setPreset } = usePlaygroundPreset();
  const dailyValues = stats.dailyRequests.map((point) => point.count);
  const durationValues = stats.durationLast24Hours.map((point) => point.avgDuration ?? 0);
  const durationLabelPoints = [
    stats.durationLast24Hours[0],
    stats.durationLast24Hours[Math.floor(stats.durationLast24Hours.length / 2)],
    stats.durationLast24Hours[stats.durationLast24Hours.length - 1],
  ].filter((point): point is { time: string; avgDuration: number | null } => Boolean(point));
  const maxDailyRequests = Math.max(...dailyValues, 0);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className={`flex flex-col bg-card py-4 ${!isEnabled ? "opacity-70" : ""}`}>
      <CardHeader className="px-4 pb-2 sm:px-5">
        {/* Row 1: Model ID + Toggle */}
        <div className="flex items-start justify-between gap-2">
          <CardTitle
            className="flex-1 min-w-0 overflow-hidden text-sm font-mono leading-5 whitespace-normal break-all [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
            title={id}
          >
            {id}
          </CardTitle>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[11px] text-muted-foreground">
              {isEnabled ? "On" : "Off"}
            </span>
            <Switch
              checked={isEnabled}
              onCheckedChange={(checked) => onEnabledChange(id, checked)}
              disabled={isUpdating}
              title={isEnabled ? "Disable model" : "Enable model"}
            />
          </div>
        </div>

        {/* Row 2: Provider badges */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {providers.map((provider) => (
            <Badge key={provider} variant="secondary" className="text-xs">
              {provider}
            </Badge>
          ))}
          <span className="mx-0.5" />
          <Button
            variant={copied ? "secondary" : "ghost"}
            size="xs"
            className="h-5 px-1.5 text-[11px]"
            onClick={handleCopy}
            title="Copy model ID"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          {isEnabled && (
            <Button
              variant="ghost"
              size="xs"
              className="h-5 px-1.5 text-[11px]"
              title="Try in Playground"
              onClick={() => {
                setPreset({ modelId: id });
                router.push("/dashboard/playground");
              }}
            >
              <Play className="h-3 w-3" />
              Play
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col px-4 sm:px-5">
        <div className="mt-auto space-y-2.5">
          {/* Model metadata */}
          {meta && (
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 flex-wrap">
                {meta.pricing && (
                  <Badge variant="outline" className="text-[11px] py-0 h-5 font-normal tabular-nums">
                    ${meta.pricing.input} / ${meta.pricing.output}
                  </Badge>
                )}
                {meta.contextLength && (
                  <span className="tabular-nums">{formatTokens(meta.contextLength)} in</span>
                )}
                {meta.contextLength && meta.outputLimit && <span>·</span>}
                {meta.outputLimit && (
                  <span className="tabular-nums">{formatTokens(meta.outputLimit)} out</span>
                )}
                {meta.knowledgeCutoff && (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-3 w-3 shrink-0" />
                      {formatDate(meta.knowledgeCutoff)}
                    </span>
                  </>
                )}
              </div>

              {(meta.reasoning || meta.toolCall || meta.vision) && (
                <div className="flex flex-wrap gap-1">
                  {meta.reasoning && (
                    <Badge variant="outline" className="text-[11px] py-0 h-5">
                      <Brain className="h-3 w-3 mr-1" />
                      Reasoning
                    </Badge>
                  )}
                  {meta.toolCall && (
                    <Badge variant="outline" className="text-[11px] py-0 h-5">
                      <Wrench className="h-3 w-3 mr-1" />
                      Tools
                    </Badge>
                  )}
                  {meta.vision && (
                    <Badge variant="outline" className="text-[11px] py-0 h-5">
                      <Eye className="h-3 w-3 mr-1" />
                      Vision
                    </Badge>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Stats */}
          <div className="rounded-md border border-border/70 bg-muted/20 p-2 sm:p-2.5 space-y-2">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <BarChart3 className="h-3 w-3 shrink-0" />
                30d
              </span>
              <span className="tabular-nums">{maxDailyRequests.toLocaleString()} peak</span>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <div className="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
                <p className="text-[10px] text-muted-foreground truncate">Requests</p>
                <p className="text-xs sm:text-sm font-semibold text-foreground tabular-nums truncate">{stats.totalRequests.toLocaleString()}</p>
              </div>
              <div className="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
                <p className="text-[10px] text-muted-foreground truncate">Success</p>
                <p className="text-xs sm:text-sm font-semibold text-foreground tabular-nums truncate">
                  {stats.successRate === null ? "-" : `${stats.successRate}%`}
                </p>
              </div>
              <div className="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
                <p className="text-[10px] text-muted-foreground truncate">Latency</p>
                <p className="text-xs sm:text-sm font-semibold text-foreground tabular-nums truncate">{formatDuration(stats.avgDurationLastDay)}</p>
              </div>
            </div>

            <div className="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
              <UsageSparkline
                values={durationValues}
                color="var(--chart-2)"
                ariaLabel={`Average duration trend for ${id} over last 24 hours`}
                emptyLabel="No duration data"
                className="h-6"
                height={24}
              />
              <div className="mt-0.5 grid grid-cols-3 text-[9px] text-muted-foreground">
                {durationLabelPoints.map((point) => (
                  <span key={point.time} className="text-center truncate">
                    {formatHourLabel(point.time)}
                  </span>
                ))}
              </div>
            </div>

            <UsageSparkline
              values={dailyValues}
              color="var(--chart-1)"
              ariaLabel={`Requests trend for ${id}`}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
