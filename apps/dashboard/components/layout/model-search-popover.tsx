"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { ChevronDown, Copy, Check, Search, FlaskConical, Brain, Wrench, Eye, Calendar, BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UsageSparkline } from "@/components/dashboard/shared/usage-sparkline";
import { cn } from "@/lib/utils";
import { setModelEnabled } from "@/lib/actions/models";
import type { ModelMeta } from "@opendum/shared/proxy/models";
import type { ModelStats } from "@/lib/model-stats";

interface ModelSearchItem {
  id: string;
  providers: string[];
  meta?: ModelMeta;
  isEnabled: boolean;
  stats: ModelStats;
}

interface ModelSearchPopoverProps {
  models: ModelSearchItem[];
  className?: string;
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

function ModelDetailContent({
  model,
  onClose,
}: {
  model: ModelSearchItem;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [isEnabled, setIsEnabled] = useState(model.isEnabled);
  const [isUpdating, setIsUpdating] = useState(false);
  const meta = model.meta;
  const stats = model.stats;

  const dailyValues = stats.dailyRequests.map((point) => point.count);
  const durationValues = stats.durationLast24Hours.map((point) => point.avgDuration ?? 0);
  const durationLabelPoints = [
    stats.durationLast24Hours[0],
    stats.durationLast24Hours[Math.floor(stats.durationLast24Hours.length / 2)],
    stats.durationLast24Hours[stats.durationLast24Hours.length - 1],
  ].filter((point): point is { time: string; avgDuration: number | null } => Boolean(point));
  const maxDailyRequests = Math.max(...dailyValues, 0);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(model.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy model ID");
    }
  };

  const handleEnabledChange = useCallback(async (checked: boolean) => {
    setIsEnabled(checked);
    setIsUpdating(true);

    try {
      const result = await setModelEnabled(model.id, checked);
      if (!result.success) {
        throw new Error(result.error);
      }
    } catch (error) {
      setIsEnabled(!checked);
      toast.error(
        error instanceof Error ? error.message : "Failed to update model status"
      );
    } finally {
      setIsUpdating(false);
    }
  }, [model.id]);

  return (
    <div className={`space-y-3 ${!isEnabled ? "opacity-70" : ""}`}>
      {/* Row 1: Model ID + Toggle */}
      <div className="flex items-start justify-between gap-2">
        <p
          className="flex-1 min-w-0 overflow-hidden text-sm font-mono font-semibold leading-5 whitespace-normal break-all [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
          title={model.id}
        >
          {model.id}
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[11px] text-muted-foreground">
            {isEnabled ? "On" : "Off"}
          </span>
          <Switch
            checked={isEnabled}
            onCheckedChange={handleEnabledChange}
            disabled={isUpdating}
            title={isEnabled ? "Disable model" : "Enable model"}
          />
        </div>
      </div>

      {/* Row 2: Provider badges + Copy/Play */}
      <div className="flex flex-wrap items-center gap-1">
        {model.providers.map((provider) => (
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
            asChild
            title="Try in Playground"
            onClick={onClose}
          >
            <Link href={`/dashboard/playground?model=${encodeURIComponent(model.id)}`}>
              <FlaskConical className="h-3 w-3" />
            </Link>
          </Button>
        )}
      </div>

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
            ariaLabel={`Average duration trend for ${model.id} over last 24 hours`}
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
          ariaLabel={`Requests trend for ${model.id}`}
        />
      </div>
    </div>
  );
}

export function ModelSearchPopover({ models, className }: ModelSearchPopoverProps) {
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [detailModel, setDetailModel] = useState<ModelSearchItem | null>(null);

  const handleSelect = (model: ModelSearchItem, closeSearch: () => void) => {
    closeSearch();
    setDetailModel(model);
  };

  const handleDetailClose = () => {
    setDetailModel(null);
  };

  const renderCommandContent = (close: () => void) => (
    <>
      <CommandInput placeholder="Search model ID or provider..." />
      <CommandList>
        <CommandEmpty>No model found.</CommandEmpty>
        <CommandGroup heading="Models">
          {models.map((model) => (
            <CommandItem
              key={model.id}
              value={`${model.id} ${model.providers.join(" ")}`}
              onSelect={() => {
                handleSelect(model, close);
              }}
              className="items-start gap-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs sm:text-sm">{model.id}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {model.providers.map((provider) => (
                    <Badge key={`${model.id}-${provider}`} variant="outline" className="text-[10px]">
                      {provider}
                    </Badge>
                  ))}
                </div>
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </>
  );

  const triggerClassName = cn(
    "h-9 w-full justify-between rounded-lg border-border bg-background px-2.5 text-xs font-normal sm:px-3 sm:text-sm",
    className
  );

  return (
    <>
      <div className="hidden md:block">
        <Popover open={desktopOpen} onOpenChange={setDesktopOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={desktopOpen}
              className={triggerClassName}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <span className="truncate text-muted-foreground">Search models...</span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(92vw,30rem)] p-0">
            <Command>{renderCommandContent(() => setDesktopOpen(false))}</Command>
          </PopoverContent>
        </Popover>
      </div>

      <div className="md:hidden">
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
          className={triggerClassName}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <span className="truncate text-muted-foreground">Search models...</span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
        <CommandDialog
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          title="Search Models"
          description="Find a model and tap to view details"
          className="p-0"
        >
          {renderCommandContent(() => setMobileOpen(false))}
        </CommandDialog>
      </div>

      <Dialog open={detailModel !== null} onOpenChange={(open) => { if (!open) handleDetailClose(); }}>
        <DialogContent className="sm:max-w-md gap-0">
          {detailModel && (
            <ModelDetailContent model={detailModel} onClose={handleDetailClose} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
