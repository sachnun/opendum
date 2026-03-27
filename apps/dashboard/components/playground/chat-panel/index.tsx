"use client";

import * as React from "react";
import { AlertCircle, Bot, ChevronDown, ChevronLeft, ChevronUp, RotateCw, Settings, User, Wrench, X } from "lucide-react";

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
import { MODEL_FAMILY_SORT_ORDER, categorizeModelFamily } from "@/lib/model-families";

export interface ModelOption {
  id: string; // unique: "model"
  name: string;
  providers: string[];
  /** Model family from TOML (e.g. "Claude", "OpenAI"). */
  family?: string;
}

export interface ProviderAccountOption {
  id: string;
  provider: string;
  name: string;
  email: string | null;
  disabledModels?: string[];
}

export interface ResponseMetrics {
  waitMs: number | null;
  firstResponseMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ToolCallData {
  name: string;
  arguments: string;
}

export interface ResponseData {
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallData[];
  isLoading: boolean;
  error?: string;
  metrics?: ResponseMetrics;
  usedAccountId?: string | null;
}

export interface ScenarioMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

interface ChatPanelProps {
  panelId: string;
  models: ModelOption[];
  accountOptions?: ProviderAccountOption[];
  selectedModel: string | null;
  selectedAccountId?: string | null;
  onModelChange: (modelId: string, accountId: string | null) => void;
  onRemove?: () => void;
  onRetry?: () => void;
  response?: ResponseData;
  disabled?: boolean;
  /** When set, only models whose ID is in this set are shown in the model picker. */
  allowedModelIds?: Set<string> | null;
  /** Scenario messages to display as conversation context. */
  scenarioMessages?: ScenarioMessage[];
}

const FAMILY_ORDER = MODEL_FAMILY_SORT_ORDER;

function groupModelsByFamily(models: ModelOption[]) {
  const groups: Record<string, ModelOption[]> = {};

  for (const model of models) {
    const family = categorizeModelFamily(model.family);
    if (!groups[family]) {
      groups[family] = [];
    }
    groups[family].push(model);
  }

  return groups;
}

function getSortedFamilies(groups: Record<string, ModelOption[]>): string[] {
  const order = new Map<string, number>(
    FAMILY_ORDER.map((family, index) => [family, index])
  );

  return Object.keys(groups).sort((a, b) => {
    const orderA = order.get(a) ?? Number.MAX_SAFE_INTEGER;
    const orderB = order.get(b) ?? Number.MAX_SAFE_INTEGER;

    if (orderA === orderB) {
      return a.localeCompare(b);
    }

    return orderA - orderB;
  });
}

function formatProviderName(provider: string): string {
  const names: Record<string, string> = {
    antigravity: "Antigravity",
    qwen_code: "Qwen Code",
    gemini_cli: "Gemini CLI",
    codex: "Codex",
    copilot: "Copilot",
    kiro: "Kiro",
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

function extractMessageText(content: ScenarioMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }

      const type = (part as { type?: unknown }).type;
      if (type === "text") {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }

      if (type === "image_url") {
        return "[image]";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractImageUrls(content: ScenarioMessage["content"]): string[] {
  if (typeof content === "string" || !Array.isArray(content)) {
    return [];
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return null;
      }

      const type = (part as { type?: unknown }).type;
      if (type !== "image_url") {
        return null;
      }

      const imageUrl = (part as { image_url?: unknown }).image_url;
      if (typeof imageUrl === "string") {
        return imageUrl;
      }

      if (imageUrl && typeof imageUrl === "object") {
        const url = (imageUrl as { url?: unknown }).url;
        return typeof url === "string" ? url : null;
      }

      return null;
    })
    .filter((url): url is string => typeof url === "string" && url.trim().length > 0);
}

function formatToolArguments(args: string): string {
  try {
    const parsed = JSON.parse(args);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return args;
  }
}

function SystemBubble({ content, collapsed, onToggle }: {
  content: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/80"
      >
        <Settings className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-[11px] font-medium text-muted-foreground">System</span>
        {collapsed ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
      </button>
      {!collapsed && (
        <div className="mt-1 rounded-md bg-muted/30 px-2.5 py-2">
          <pre className="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-muted-foreground">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

function UserBubble({ message }: { message: ScenarioMessage }) {
  const text = extractMessageText(message.content);
  const images = extractImageUrls(message.content);

  return (
    <div className="mb-2 flex gap-2">
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 mt-0.5">
        <User className="h-3 w-3 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] font-medium text-primary">User</p>
        <div className="rounded-lg bg-muted px-3 py-2">
          {text && (
            <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">
              {text}
            </pre>
          )}
          {images.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {images.map((url, i) => (
                <a
                  key={i}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block overflow-hidden rounded border border-border"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`Attached image ${i + 1}`}
                    className="h-16 w-auto object-cover"
                  />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({
  content,
  reasoning,
  toolCalls,
  isLoading,
}: {
  content: string;
  reasoning: string;
  toolCalls: ToolCallData[];
  isLoading: boolean;
}) {
  const hasContent = content.length > 0 || reasoning.length > 0 || toolCalls.length > 0;

  if (!hasContent && !isLoading) {
    return null;
  }

  return (
    <div className="mb-2 flex gap-2">
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary mt-0.5">
        <Bot className="h-3 w-3 text-secondary-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] font-medium text-muted-foreground">Assistant</p>
        <div className="space-y-2">
          {reasoning && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 px-3 py-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                Reasoning
              </p>
              <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                {reasoning}
                {isLoading && !content && (
                  <span className="animate-pulse text-primary">▌</span>
                )}
              </pre>
            </div>
          )}

          {content && (
            <div className="rounded-lg bg-card border border-border px-3 py-2">
              <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                {content}
                {isLoading && (
                  <span className="animate-pulse text-primary">▌</span>
                )}
              </pre>
            </div>
          )}

          {!content && !reasoning && isLoading && (
            <div className="rounded-lg bg-card border border-border px-3 py-2">
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            </div>
          )}

          {toolCalls.length > 0 && (
            <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
              <div className="mb-1.5 flex items-center gap-1.5">
                <Wrench className="h-3 w-3 text-muted-foreground" />
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Tool Calls
                </p>
              </div>
              <div className="space-y-1.5">
                {toolCalls.map((tc, i) => (
                  <div key={i} className="rounded border border-border bg-background px-2 py-1.5">
                    <p className="text-[11px] font-semibold text-foreground">{tc.name}</p>
                    <pre className="mt-0.5 whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">
                      {formatToolArguments(tc.arguments)}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ChatPanel({
  models,
  accountOptions = [],
  selectedModel,
  selectedAccountId = null,
  onModelChange,
  onRemove,
  onRetry,
  response,
  disabled = false,
  allowedModelIds = null,
  scenarioMessages = [],
}: ChatPanelProps) {
  const [open, setOpen] = React.useState(false);
  const [selectionStep, setSelectionStep] = React.useState<"model" | "routing">("model");
  const [pendingModelId, setPendingModelId] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [loadingStartedAt, setLoadingStartedAt] = React.useState<number | null>(null);
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  const [systemCollapsed, setSystemCollapsed] = React.useState(true);

  const systemMessages = React.useMemo(
    () => scenarioMessages.filter((m) => m.role === "system"),
    [scenarioMessages]
  );
  const userMessages = React.useMemo(
    () => scenarioMessages.filter((m) => m.role !== "system"),
    [scenarioMessages]
  );
  const systemPromptText = React.useMemo(
    () => systemMessages.map((m) => extractMessageText(m.content)).filter(Boolean).join("\n\n"),
    [systemMessages]
  );

  const filteredModels = React.useMemo(
    () => (allowedModelIds ? models.filter((m) => allowedModelIds.has(m.id)) : models),
    [models, allowedModelIds]
  );

  const selectedModelData = models.find((m) => m.id === selectedModel);
  const selectedAccountData = accountOptions.find((account) => account.id === selectedAccountId);
  const selectedAccountDisabledModels = React.useMemo(
    () => new Set(selectedAccountData?.disabledModels ?? []),
    [selectedAccountData]
  );
  const usedAccountData = response?.usedAccountId
    ? accountOptions.find((account) => account.id === response.usedAccountId) ?? null
    : null;
  const pendingModelData = models.find((model) => model.id === pendingModelId) ?? null;
  const pendingModelAccounts = pendingModelData
    ? accountOptions.filter((account) => {
        if (!pendingModelData.providers.includes(account.provider)) {
          return false;
        }
        // Exclude accounts that have disabled this model
        if (account.disabledModels?.includes(pendingModelData.id)) {
          return false;
        }
        return true;
      })
    : [];

  // When a specific account is selected on this panel, hide models that
  // the account has disabled so users don't pick an unusable combination.
  const accountFilteredModels = React.useMemo(() => {
    if (selectedAccountDisabledModels.size === 0) {
      return filteredModels;
    }
    return filteredModels.filter((m) => !selectedAccountDisabledModels.has(m.id));
  }, [filteredModels, selectedAccountDisabledModels]);

  const groupedModels = React.useMemo(() => groupModelsByFamily(accountFilteredModels), [accountFilteredModels]);
  const sortedFamilies = React.useMemo(() => getSortedFamilies(groupedModels), [groupedModels]);

  const isAutoMode = selectedModelData && !selectedAccountId;
  const selectedRouteLabel = selectedAccountData
    ? `${getAccountLabel(selectedAccountData)} (${formatProviderName(selectedAccountData.provider)})`
    : isAutoMode
      ? usedAccountData
        ? `Auto (${getAccountLabel(usedAccountData)} — ${formatProviderName(usedAccountData.provider)})`
        : "Auto (load balancer)"
      : "-";

  const handlePopoverOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);

    if (!nextOpen) {
      setSelectionStep("model");
      setPendingModelId(null);
      return;
    }

    if (selectedModelData) {
      setSelectionStep("routing");
      setPendingModelId(selectedModelData.id);
      return;
    }

    setSelectionStep("model");
    setPendingModelId(null);
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
    toolCalls = [],
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
  }, [content, reasoning, toolCalls, isLoading]);

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

      <CardHeader className="flex-none gap-0 border-b py-2 pl-3 pr-11">
        <div className="flex items-center gap-1">
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
                    <Badge variant="secondary" className="shrink-0 whitespace-nowrap text-[10px] px-1.5 py-0">
                      {selectedAccountData
                        ? formatProviderName(selectedAccountData.provider)
                        : usedAccountData
                          ? `Auto · ${formatProviderName(usedAccountData.provider)}`
                          : "Auto"}
                    </Badge>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Select model...</span>
                )}
                <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[340px] max-w-[calc(100vw-2rem)] p-0" align="start">
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

      <CardContent className="flex min-h-0 flex-1 flex-col p-0 overflow-hidden">
        <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
          <div className="p-3">
            {!selectedModel && !isLoading && !content && !reasoning && !error && (
              <p className="text-muted-foreground text-sm text-center py-8">
                Select a model to start
              </p>
            )}

            {selectedModel && scenarioMessages.length > 0 && (
              <>
                {systemPromptText && (
                  <SystemBubble
                    content={systemPromptText}
                    collapsed={systemCollapsed}
                    onToggle={() => setSystemCollapsed((prev) => !prev)}
                  />
                )}

                {userMessages.map((msg, i) => (
                  <UserBubble key={`user-${i}`} message={msg} />
                ))}
              </>
            )}

            {error && (
              <div className="space-y-2">
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription className="text-sm">{error}</AlertDescription>
                </Alert>
                {onRetry && selectedModel && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onRetry}
                    disabled={disabled || isLoading}
                    className="w-full gap-1.5"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                )}
              </div>
            )}

            {(content || reasoning || toolCalls.length > 0 || isLoading) && selectedModel && (
              <AssistantBubble
                content={content}
                reasoning={reasoning}
                toolCalls={toolCalls}
                isLoading={isLoading}
              />
            )}

            {selectedModel && !isLoading && !content && !reasoning && toolCalls.length === 0 && !error && scenarioMessages.length === 0 && (
              <p className="text-muted-foreground text-sm text-center py-8">
                Response will appear here
              </p>
            )}
          </div>
        </ScrollArea>

        <div className="shrink-0 border-t bg-card px-3 py-2 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Wait</span>
            <div className="flex items-center gap-2">
              <span className="font-medium tabular-nums">{waitLabel}</span>
              {onRetry && selectedModel && !isLoading && (content || reasoning || error) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={onRetry}
                  disabled={disabled}
                  title="Retry"
                  aria-label="Retry request"
                  className="h-5 w-5"
                >
                  <RotateCw className="h-3 w-3" />
                </Button>
              )}
            </div>
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
