"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Copy, Check, Search, Play, Brain, Wrench, Eye, Calendar } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ModelMeta } from "@/lib/proxy/models";

interface ModelSearchItem {
  id: string;
  providers: string[];
  meta?: ModelMeta;
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

function ModelDetailContent({ model, onClose }: { model: ModelSearchItem; onClose: () => void }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const meta = model.meta;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(model.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success(`Model copied: ${model.id}`);
    } catch {
      toast.error("Failed to copy model ID");
    }
  };

  const handlePlayground = () => {
    onClose();
    router.push(`/dashboard/playground?model=${encodeURIComponent(model.id)}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold break-all">{model.id}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {model.providers.map((provider) => (
              <Badge key={provider} variant="secondary" className="text-xs">
                {provider}
              </Badge>
            ))}
          </div>
        </div>
        {meta?.pricing && (
          <div className="text-xs text-muted-foreground whitespace-nowrap text-right">
            <p>${meta.pricing.input}/in</p>
            <p>${meta.pricing.output}/out</p>
          </div>
        )}
      </div>

      {meta && (
        <div className="space-y-3">
          {(meta.contextLength || meta.outputLimit) && (
            <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
              {meta.contextLength && (
                <span className="rounded border border-border/60 bg-muted/30 px-2 py-0.5">
                  {formatTokens(meta.contextLength)} context
                </span>
              )}
              {meta.outputLimit && (
                <span className="rounded border border-border/60 bg-muted/30 px-2 py-0.5">
                  {formatTokens(meta.outputLimit)} output
                </span>
              )}
              {meta.knowledgeCutoff && (
                <span className="flex items-center gap-1 rounded border border-border/60 bg-muted/30 px-2 py-0.5">
                  <Calendar className="h-3 w-3" />
                  {formatDate(meta.knowledgeCutoff)}
                </span>
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

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="default"
          size="sm"
          className="flex-1"
          onClick={handlePlayground}
        >
          <Play className="h-3.5 w-3.5" />
          Try in Playground
        </Button>
        <Button
          variant={copied ? "secondary" : "outline"}
          size="sm"
          onClick={handleCopy}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy ID"}
        </Button>
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Model Details</DialogTitle>
            <DialogDescription>
              View model information or try it in the playground
            </DialogDescription>
          </DialogHeader>
          {detailModel && (
            <ModelDetailContent model={detailModel} onClose={handleDetailClose} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
