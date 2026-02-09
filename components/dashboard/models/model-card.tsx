"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Eye, Copy, Check, Brain, Wrench, Calendar, BarChart3 } from "lucide-react";
import type { ModelMeta } from "@/lib/proxy/models";

interface ModelStats {
  totalRequests: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
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

function buildSparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return "";
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  if (max === min) {
    const y = max === 0 ? height : height / 2;
    return values
      .map((_, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)},${y.toFixed(2)}`)
      .join(" ");
  }

  const range = max - min;

  return values
    .map((value, index) => {
      const x = index * step;
      const normalized = (value - min) / range;
      const y = height - normalized * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildSparklineArea(path: string, width: number, height: number): string {
  if (!path) {
    return "";
  }

  return `${path} L${width},${height} L0,${height} Z`;
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
  const chartWidth = 100;
  const chartHeight = 26;
  const dailyValues = stats.dailyRequests.map((point) => point.count);
  const hasUsage = dailyValues.some((value) => value > 0);
  const sparklinePath = buildSparklinePath(dailyValues, chartWidth, chartHeight);
  const areaPath = buildSparklineArea(sparklinePath, chartWidth, chartHeight);
  const maxDailyRequests = Math.max(...dailyValues, 0);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className={`flex flex-col bg-card py-4 ${!isEnabled ? "opacity-70" : ""}`}>
      <CardHeader className="px-4 pb-2 sm:px-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-mono truncate" title={id}>{id}</CardTitle>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {providers.map((provider) => (
                <Badge key={provider} variant="secondary" className="text-xs">
                  {provider}
                </Badge>
              ))}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            {meta?.pricing && (
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                ${meta.pricing.input} · ${meta.pricing.output}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">
                {isEnabled ? "Enabled" : "Disabled"}
              </span>
              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) => onEnabledChange(id, checked)}
                disabled={isUpdating}
                title={isEnabled ? "Disable model" : "Enable model"}
              />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col px-4 sm:px-5">
        {meta && (
          <div className="space-y-2 text-xs text-muted-foreground mb-3">
            {(meta.contextLength || meta.outputLimit) && (
              <div className="flex items-center gap-2 flex-wrap">
                {meta.contextLength && (
                  <span>{formatTokens(meta.contextLength)} in</span>
                )}
                {meta.contextLength && meta.outputLimit && <span>·</span>}
                {meta.outputLimit && (
                  <span>{formatTokens(meta.outputLimit)} out</span>
                )}
                {meta.knowledgeCutoff && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {formatDate(meta.knowledgeCutoff)}
                    </span>
                  </>
                )}
              </div>
            )}

            {(meta.reasoning || meta.toolCall || meta.vision) && (
              <div className="flex flex-wrap gap-1">
                {meta.reasoning && (
                  <Badge variant="outline" className="text-xs py-0 h-5">
                    <Brain className="h-3 w-3 mr-1" />
                    Reasoning
                  </Badge>
                )}
                {meta.toolCall && (
                  <Badge variant="outline" className="text-xs py-0 h-5">
                    <Wrench className="h-3 w-3 mr-1" />
                    Tools
                  </Badge>
                )}
                {meta.vision && (
                  <Badge variant="outline" className="text-xs py-0 h-5">
                    <Eye className="h-3 w-3 mr-1" />
                    Vision
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mb-3 rounded-md border border-border/70 bg-muted/20 p-2.5">
          <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <BarChart3 className="h-3 w-3" />
              Last 30 days
            </span>
            <span>{maxDailyRequests.toLocaleString()} peak/day</span>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-2">
            <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Requests</p>
              <p className="text-sm font-semibold text-foreground">{stats.totalRequests.toLocaleString()}</p>
            </div>
            <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Success</p>
              <p className="text-sm font-semibold text-foreground">
                {stats.successRate === null ? "-" : `${stats.successRate}%`}
              </p>
            </div>
          </div>

          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            className="h-8 w-full"
            role="img"
            aria-label={`Requests trend for ${id}`}
          >
            <path
              d={`M0,${chartHeight} L${chartWidth},${chartHeight}`}
              stroke="var(--border)"
              strokeWidth="1"
              fill="none"
            />
            {hasUsage && areaPath ? (
              <path d={areaPath} fill="var(--chart-1)" fillOpacity="0.18" stroke="none" />
            ) : null}
            {hasUsage && sparklinePath ? (
              <path
                d={sparklinePath}
                stroke="var(--chart-1)"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <text
                x={chartWidth / 2}
                y={chartHeight / 2 + 3}
                textAnchor="middle"
                className="fill-muted-foreground"
                style={{ fontSize: 7 }}
              >
                No activity yet
              </text>
            )}
          </svg>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="mt-auto w-full"
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <Check className="h-4 w-4 mr-2" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="h-4 w-4 mr-2" />
              Copy Model ID
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
