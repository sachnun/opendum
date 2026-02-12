"use client";

import * as React from "react";
import { Settings, RotateCcw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
} from "@/components/ui/sheet";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type PlaygroundEndpoint = "chat_completions" | "messages" | "responses";

export interface PlaygroundSettings {
  endpoint: PlaygroundEndpoint;
  streamResponses: boolean;
  temperature: number;
  topP: number;
  maxTokens: number;
  presencePenalty: number;
  frequencyPenalty: number;
  reasoningEffort: ReasoningEffort;
}

export const DEFAULT_SETTINGS: PlaygroundSettings = {
  endpoint: "chat_completions",
  streamResponses: true,
  temperature: 1.0,
  topP: 1.0,
  maxTokens: 4096,
  presencePenalty: 0,
  frequencyPenalty: 0,
  reasoningEffort: "none",
};

interface SettingsSheetProps {
  settings: PlaygroundSettings;
  onSettingsChange: (settings: PlaygroundSettings) => void;
  disabled?: boolean;
}

const REASONING_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

const ENDPOINT_OPTIONS: Array<{
  value: PlaygroundEndpoint;
  label: string;
  description: string;
}> = [
  {
    value: "chat_completions",
    label: "/v1/chat/completions",
    description: "OpenAI-compatible format",
  },
  {
    value: "messages",
    label: "/v1/messages",
    description: "Anthropic-compatible format",
  },
  {
    value: "responses",
    label: "/v1/responses",
    description: "OpenAI Responses API format",
  },
];

export function SettingsSheet({
  settings,
  onSettingsChange,
  disabled = false,
}: SettingsSheetProps) {
  const updateSetting = <K extends keyof PlaygroundSettings>(
    key: K,
    value: PlaygroundSettings[K]
  ) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  const handleReset = () => {
    onSettingsChange(DEFAULT_SETTINGS);
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon" disabled={disabled}>
          <Settings className="h-4 w-4" />
          <span className="sr-only">Settings</span>
        </Button>
      </SheetTrigger>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>
            Configure model parameters for generation
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 py-6">
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Endpoint
            </h3>

            <div className="space-y-2">
              <Label>API Endpoint</Label>
              <div className="grid grid-cols-1 gap-2">
                {ENDPOINT_OPTIONS.map((option) => {
                  const isSelected = settings.endpoint === option.value;

                  return (
                    <Button
                      key={option.value}
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      onClick={() => updateSetting("endpoint", option.value)}
                      disabled={disabled}
                      className={cn(
                        "h-auto items-start justify-start px-3 py-2 text-left",
                        isSelected && "ring-1 ring-primary/30"
                      )}
                    >
                      <span className="flex flex-col gap-0.5">
                        <span className="text-xs font-medium">{option.label}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {option.description}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Pick the API style you want to test in Playground.
              </p>
            </div>
          </div>

          <Separator />

          {/* Generation Section */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Generation
            </h3>

            {/* Stream Responses */}
            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-1">
                <Label htmlFor="stream-responses">Stream Responses</Label>
                <p className="text-xs text-muted-foreground">
                  Show tokens in real-time as they arrive
                </p>
              </div>
              <Switch
                id="stream-responses"
                checked={settings.streamResponses}
                onCheckedChange={(checked) =>
                  updateSetting("streamResponses", checked)
                }
                disabled={disabled}
              />
            </div>

            {/* Temperature */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="temperature">Temperature</Label>
                <span className="text-sm text-muted-foreground w-12 text-right">
                  {settings.temperature.toFixed(1)}
                </span>
              </div>
              <Slider
                id="temperature"
                min={0}
                max={2}
                step={0.1}
                value={[settings.temperature]}
                onValueChange={([value]) => updateSetting("temperature", value)}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                Higher values make output more creative and random
              </p>
            </div>

            {/* Top P */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="top-p">Top P</Label>
                <span className="text-sm text-muted-foreground w-12 text-right">
                  {settings.topP.toFixed(2)}
                </span>
              </div>
              <Slider
                id="top-p"
                min={0}
                max={1}
                step={0.05}
                value={[settings.topP]}
                onValueChange={([value]) => updateSetting("topP", value)}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                Nucleus sampling threshold (1.0 = consider all tokens)
              </p>
            </div>

            {/* Max Tokens */}
            <div className="space-y-2">
              <Label htmlFor="max-tokens">Max Tokens</Label>
              <Input
                id="max-tokens"
                type="number"
                min={1}
                max={128000}
                value={settings.maxTokens}
                onChange={(e) =>
                  updateSetting("maxTokens", parseInt(e.target.value) || 4096)
                }
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                Maximum number of tokens to generate
              </p>
            </div>
          </div>

          <Separator />

          {/* Penalties Section */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Penalties
            </h3>

            {/* Presence Penalty */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="presence-penalty">Presence Penalty</Label>
                <span className="text-sm text-muted-foreground w-12 text-right">
                  {settings.presencePenalty.toFixed(1)}
                </span>
              </div>
              <Slider
                id="presence-penalty"
                min={-2}
                max={2}
                step={0.1}
                value={[settings.presencePenalty]}
                onValueChange={([value]) =>
                  updateSetting("presencePenalty", value)
                }
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                Penalize tokens based on whether they appear in the text so far
              </p>
            </div>

            {/* Frequency Penalty */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="frequency-penalty">Frequency Penalty</Label>
                <span className="text-sm text-muted-foreground w-12 text-right">
                  {settings.frequencyPenalty.toFixed(1)}
                </span>
              </div>
              <Slider
                id="frequency-penalty"
                min={-2}
                max={2}
                step={0.1}
                value={[settings.frequencyPenalty]}
                onValueChange={([value]) =>
                  updateSetting("frequencyPenalty", value)
                }
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                Penalize tokens based on how frequently they appear
              </p>
            </div>
          </div>

          <Separator />

          {/* Reasoning Section */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Reasoning
            </h3>

            {/* Reasoning Effort */}
            <div className="space-y-2">
              <Label>Reasoning Effort</Label>
              <div className="flex gap-1">
                {REASONING_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    variant={
                      settings.reasoningEffort === option.value
                        ? "default"
                        : "outline"
                    }
                    size="sm"
                    onClick={() => updateSetting("reasoningEffort", option.value)}
                    disabled={disabled}
                    className={cn(
                      "flex-1",
                      settings.reasoningEffort === option.value &&
                        option.value !== "none" &&
                        "bg-amber-600 hover:bg-amber-700"
                    )}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Enable extended thinking for reasoning models (DeepSeek-R1, Qwen-thinking, etc.)
              </p>
            </div>
          </div>
        </div>

        <SheetFooter>
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={disabled}
            className="w-full"
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset to Defaults
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
