"use client";

import * as React from "react";
import { AlertCircle, Copy, Check, ChevronDown } from "lucide-react";

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
  id: string;       // unique: "modelName:provider"
  name: string;     // model name
  provider: string; // provider name
}

export interface ResponseData {
  content: string;
  reasoning?: string;
  isLoading: boolean;
  error?: string;
}

interface ChatPanelProps {
  panelId: string;
  models: ModelOption[];
  selectedModel: string | null;
  onModelChange: (model: string) => void;
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
  };
  return names[provider] || provider;
}

export function ChatPanel({
  models,
  selectedModel,
  onModelChange,
  response,
  disabled = false,
}: ChatPanelProps) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const groupedModels = React.useMemo(() => groupModelsByFamily(models), [models]);
  const sortedFamilies = React.useMemo(() => getSortedFamilies(groupedModels), [groupedModels]);

  const selectedModelData = models.find((m) => m.id === selectedModel);
  const { content = "", reasoning = "", isLoading = false, error } = response || {};

  React.useEffect(() => {
    if (isLoading && scrollRef.current) {
      const viewport = scrollRef.current.querySelector("[data-slot='scroll-area-viewport']");
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }
  }, [content, reasoning, isLoading]);

  const handleCopy = async () => {
    const textToCopy =
      reasoning && content
        ? `Reasoning:\n${reasoning}\n\nAnswer:\n${content}`
        : reasoning || content;

    if (!textToCopy) return;

    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <Card className="flex flex-col h-[400px] py-0 gap-0">
      {/* Header with Model Selector */}
      <CardHeader className="flex-none border-b py-2 px-3 gap-0">
        <div className="flex items-center gap-1">
          {/* Model Selector */}
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                role="combobox"
                aria-expanded={open}
                className="flex-1 justify-between h-8 px-2 font-normal"
                disabled={disabled || isLoading}
              >
                {selectedModelData ? (
                  <div className="flex items-center gap-2 truncate">
                    <span className="truncate">{selectedModelData.name}</span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                      {formatProviderName(selectedModelData.provider)}
                    </Badge>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Select model...</span>
                )}
                <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[280px] p-0" align="start">
              <Command>
                <CommandInput placeholder="Search models..." />
                <CommandList>
                  <CommandEmpty>No model found.</CommandEmpty>
                  {sortedFamilies.map((family) => (
                    <CommandGroup key={family} heading={family}>
                      {groupedModels[family].map((model) => (
                        <CommandItem
                          key={model.id}
                          value={`${model.name} ${model.provider}`}
                          onSelect={() => {
                            onModelChange(model.id);
                            setOpen(false);
                          }}
                          className={cn(
                            selectedModel === model.id && "bg-accent"
                          )}
                        >
                          <span className="flex-1 truncate">{model.name}</span>
                          <Badge variant="outline" className="text-[10px] ml-2">
                            {formatProviderName(model.provider)}
                          </Badge>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {/* Copy Button */}
          {(content || reasoning) && !isLoading && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleCopy}
              title="Copy response"
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          )}
        </div>
      </CardHeader>

      {/* Content */}
      <CardContent className="flex-1 p-0 overflow-hidden">
        <ScrollArea ref={scrollRef} className="h-full">
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
      </CardContent>
    </Card>
  );
}
