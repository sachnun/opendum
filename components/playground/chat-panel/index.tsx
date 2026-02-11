"use client";

import * as React from "react";
import { AlertCircle, ChevronDown, ChevronLeft, X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface ModelOption {
  id: string; // unique: "model"
  name: string;
  providers: string[];
}

export interface ProviderAccountOption {
  id: string;
  provider: string;
  name: string;
  email: string | null;
}

export interface ResponseMetrics {
  waitMs: number | null;
  firstResponseMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ResponseData {
  content: string;
  reasoning?: string;
  isLoading: boolean;
  error?: string;
  metrics?: ResponseMetrics;
}

interface ChatPanelProps {
  panelId: string;
  models: ModelOption[];
  accountOptions?: ProviderAccountOption[];
  selectedModel: string | null;
  selectedAccountId?: string | null;
  onModelChange: (modelId: string, accountId: string | null) => void;
  onRemove?: () => void;
  response?: ResponseData;
  disabled?: boolean;
}

const FAMILY_ORDER = [
  "Qwen",
  "DeepSeek",
  "Gemini",
  "Claude",
  "Kimi",
  "GLM",
  "MiniMax",
  "GPT-OSS",
  "Other",
];

function getModelFamily(modelName: string): string {
  if (modelName.startsWith("qwen")) return "Qwen";
  if (modelName.startsWith("deepseek-")) return "DeepSeek";
  if (modelName.startsWith("gemini-")) return "Gemini";
  if (modelName.startsWith("claude-")) return "Claude";
  if (modelName.startsWith("kimi-")) return "Kimi";
  if (modelName.startsWith("glm-")) return "GLM";
  if (modelName.startsWith("minimax-")) return "MiniMax";
  if (modelName.startsWith("gpt-oss-")) return "GPT-OSS";
  return "Other";
}

function groupModelsByFamily(models: ModelOption[]) {
  const groups: Record<string, ModelOption[]> = {};

  for (const model of models) {
    const family = getModelFamily(model.name);
    if (!groups[family]) {
      groups[family] = [];
    }
    groups[family].push(model);
  }

  return groups;
}

function getSortedFamilies(groups: Record<string, ModelOption[]>): string[] {
  return Object.keys(groups).sort(
    (a, b) => FAMILY_ORDER.indexOf(a) - FAMILY_ORDER.indexOf(b)
  );
}

function formatProviderName(provider: string): string {
  const names: Record<string, string> = {
    iflow: "Iflow",
    antigravity: "Antigravity",
    qwen_code: "Qwen Code",
    gemini_cli: "Gemini CLI",
    codex: "Codex",
    nvidia_nim: "Nvidia",
    ollama_cloud: "Ollama Cloud",
    openrouter: "OpenRouter",
  };
  return names[provider] || provider;
}

function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "-";
  }

  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }

  const seconds = value / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
}

function getAccountLabel(account: ProviderAccountOption): string {
  const name = account.name.trim();
  const email = account.email?.trim();

  if (!email) {
    return name;
  }

  if (!name || name.toLowerCase() === email.toLowerCase()) {
    return email;
  }

  return `${name} (${email})`;
}

export function ChatPanel({
  models,
  accountOptions = [],
  selectedModel,
  selectedAccountId = null,
  onModelChange,
  onRemove,
  response,
  disabled = false,
}: ChatPanelProps) {
  const [open, setOpen] = React.useState(false);
  const [selectionStep, setSelectionStep] = React.useState<"model" | "routing">("model");
  const [pendingModelId, setPendingModelId] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [loadingStartedAt, setLoadingStartedAt] = React.useState<number | null>(null);
  const [nowMs, setNowMs] = React.useState<number | null>(null);

  const groupedModels = React.useMemo(() => groupModelsByFamily(models), [models]);
  const sortedFamilies = React.useMemo(() => getSortedFamilies(groupedModels), [groupedModels]);

  const selectedModelData = models.find((m) => m.id === selectedModel);
  const selectedAccountData = accountOptions.find((account) => account.id === selectedAccountId);
  const pendingModelData = models.find((model) => model.id === pendingModelId) ?? null;
  const pendingModelAccounts = pendingModelData
    ? accountOptions.filter((account) =>
        pendingModelData.providers.includes(account.provider)
      )
    : [];

  const selectedRouteLabel = selectedAccountData
    ? `${getAccountLabel(selectedAccountData)} (${formatProviderName(selectedAccountData.provider)})`
    : selectedModelData
      ? "Auto (load balancer)"
      : "-";

  const handlePopoverOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);

    if (!nextOpen) {
      setSelectionStep("model");
      setPendingModelId(null);
    }
  };

  const handleSelectModel = (modelId: string) => {
    setPendingModelId(modelId);
    setSelectionStep("routing");
  };

  const handleSelectRoute = (accountId: string | null) => {
    if (!pendingModelData) {
      return;
    }

    onModelChange(pendingModelData.id, accountId);
    setOpen(false);
    setSelectionStep("model");
    setPendingModelId(null);
  };

  const {
    content = "",
    reasoning = "",
    isLoading = false,
    error,
    metrics,
  } = response || {};

  const liveWaitMs =
    isLoading && loadingStartedAt !== null && nowMs !== null
      ? nowMs - loadingStartedAt
      : metrics?.waitMs;
  const waitLabel = formatDurationMs(liveWaitMs);

  React.useEffect(() => {
    if (!isLoading) {
      setLoadingStartedAt(null);
      setNowMs(null);
      return;
    }

    setLoadingStartedAt((current) => current ?? Date.now());

    setNowMs(Date.now());

    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 100);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isLoading]);

  React.useEffect(() => {
    if (isLoading && scrollRef.current) {
      const viewport = scrollRef.current.querySelector("[data-slot='scroll-area-viewport']");
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }
  }, [content, reasoning, isLoading]);

  return (
    <Card className="relative flex h-[400px] flex-col gap-0 overflow-hidden py-0">
      {onRemove && (
        <Button
          variant="outline"
          size="icon-xs"
          onClick={onRemove}
          title="Remove card"
          aria-label="Remove comparison card"
          disabled={disabled || isLoading}
          className="absolute right-2 top-2 z-10 h-7 w-7 rounded-full border bg-background/95"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}

      {/* Header with Model Selector */}
      <CardHeader className="flex-none gap-0 border-b py-2 pl-3 pr-11">
        <div className="flex items-center gap-1">
          {/* Model Selector */}
          <Popover open={open} onOpenChange={handlePopoverOpenChange}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                role="combobox"
                aria-expanded={open}
                className="flex-1 justify-between h-8 px-2 font-normal"
                disabled={disabled || isLoading}
              >
                {selectedModelData ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{selectedModelData.name}</span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                      {selectedAccountData
                        ? formatProviderName(selectedAccountData.provider)
                        : "Auto"}
                    </Badge>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Select model...</span>
                )}
                <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[340px] p-0" align="start">
              {selectionStep === "model" && (
                <Command>
                  <CommandInput placeholder="Search models..." />
                  <CommandList>
                    <CommandEmpty>No model found.</CommandEmpty>
                    {sortedFamilies.map((family) => (
                      <CommandGroup key={family} heading={family}>
                        {groupedModels[family].map((model) => (
                          <CommandItem
                            key={model.id}
                            value={`${model.name} ${model.providers.join(" ")}`}
                            onSelect={() => handleSelectModel(model.id)}
                            className={cn(selectedModel === model.id && "bg-accent")}
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium">{model.name}</p>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {model.providers.map((provider) => (
                                  <Badge
                                    key={`${model.id}-${provider}`}
                                    variant="outline"
                                    className="h-4 px-1.5 text-[9px]"
                                  >
                                    {formatProviderName(provider)}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ))}
                  </CommandList>
                </Command>
              )}

              {selectionStep === "routing" && pendingModelData && (
                <>
                  <div className="flex items-center justify-between border-b px-2 py-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() => {
                        setSelectionStep("model");
                        setPendingModelId(null);
                      }}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      Models
                    </Button>

                    <p className="max-w-[220px] truncate text-xs font-medium">
                      {pendingModelData.name}
                    </p>
                  </div>

                  <Command>
                    <CommandInput placeholder="Search provider or account..." />
                    <CommandList>
                      <CommandEmpty>No account found.</CommandEmpty>
                      <CommandGroup heading="Routing">
                        <CommandItem
                          value="auto load balancer"
                          onSelect={() => handleSelectRoute(null)}
                          className={cn(
                            selectedModel === pendingModelData.id &&
                              !selectedAccountId &&
                              "bg-accent"
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium">Auto (load balancer)</p>
                            <p className="truncate text-[10px] text-muted-foreground">
                              System chooses best provider account
                            </p>
                          </div>
                        </CommandItem>

                        {pendingModelAccounts.map((account) => (
                          <CommandItem
                            key={account.id}
                            value={`${account.provider} ${account.name} ${account.email ?? ""}`}
                            onSelect={() => handleSelectRoute(account.id)}
                            className={cn(
                              selectedModel === pendingModelData.id &&
                                selectedAccountId === account.id &&
                                "bg-accent"
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium">
                                {getAccountLabel(account)}
                              </p>
                              <p className="truncate text-[10px] text-muted-foreground">
                                {formatProviderName(account.provider)}
                              </p>
                            </div>
                            <Badge variant="outline" className="ml-2 text-[10px]">
                              {formatProviderName(account.provider)}
                            </Badge>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </CardHeader>

      {/* Content */}
      <CardContent className="flex min-h-0 flex-1 flex-col p-0 overflow-hidden">
        <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
          <div className="p-4">
            {/* No model selected */}
            {!selectedModel && !isLoading && !content && !reasoning && !error && (
              <p className="text-muted-foreground text-sm text-center py-8">
                Select a model to start
              </p>
            )}

            {/* Loading state - initial */}
            {isLoading && !content && !reasoning && (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            )}

            {/* Error state */}
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription className="text-sm">{error}</AlertDescription>
              </Alert>
            )}

            {/* Content with streaming cursor */}
            {(content || reasoning) && (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                {reasoning && (
                  <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 p-3">
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                      Reasoning
                    </p>
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                      {reasoning}
                      {isLoading && !content && (
                        <span className="animate-pulse text-primary">▌</span>
                      )}
                    </pre>
                  </div>
                )}

                {content && (
                  <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                    {content}
                    {isLoading && (
                      <span className="animate-pulse text-primary">▌</span>
                    )}
                  </pre>
                )}
              </div>
            )}

            {/* Empty state - model selected but no response yet */}
            {selectedModel && !isLoading && !content && !reasoning && !error && (
              <p className="text-muted-foreground text-sm text-center py-8">
                Response will appear here
              </p>
            )}
          </div>
        </ScrollArea>

        <div className="shrink-0 border-t bg-card px-3 py-2 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Wait</span>
            <span className="font-medium tabular-nums">{waitLabel}</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="shrink-0 whitespace-nowrap text-muted-foreground">
              Provider account
            </span>
            <span className="min-w-0 truncate text-right font-medium">{selectedRouteLabel}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
