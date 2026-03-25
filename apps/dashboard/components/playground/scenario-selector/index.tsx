"use client";

import * as React from "react";
import {
  MessageSquareText,
  Wrench,
  Image,
  Brain,
  LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface Scenario {
  id: string;
  name: string;
  icon: LucideIcon;
  prompt: string;
  isReasoning: boolean;
  messages?: Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
  }>;
  requestOverrides?: Record<string, unknown>;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "text",
    name: "Text",
    icon: MessageSquareText,
    prompt: "Write a short poem about the ocean.",
    isReasoning: false,
    messages: [
      {
        role: "system",
        content: "You are a creative writing assistant. Write vivid, expressive text with a poetic tone. Keep responses concise.",
      },
      {
        role: "user",
        content: "Write a short poem about the ocean.",
      },
    ],
  },
  {
    id: "tool-call",
    name: "Tool Call",
    icon: Wrench,
    prompt:
      "Use available tools to get weather in Jakarta and convert 120 USD to IDR, then summarize in 3 bullets.",
    isReasoning: false,
    messages: [
      {
        role: "system",
        content:
          "You are a helpful assistant with access to external tools. When the user asks for real-time data such as weather or currency conversion, call the appropriate tool instead of guessing. After receiving tool results, summarize them clearly and concisely.",
      },
      {
        role: "user",
        content:
          "Use available tools to get weather in Jakarta and convert 120 USD to IDR, then summarize in 3 bullets.",
      },
    ],
    requestOverrides: {
      stream: false,
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather for a city",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" },
                unit: { type: "string", enum: ["celsius", "fahrenheit"] },
              },
              required: ["city"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "convert_currency",
            description: "Convert amount between currencies",
            parameters: {
              type: "object",
              properties: {
                amount: { type: "number" },
                from: { type: "string" },
                to: { type: "string" },
              },
              required: ["amount", "from", "to"],
            },
          },
        },
      ],
    },
  },
  {
    id: "vision",
    name: "Vision",
    icon: Image,
    prompt:
      "Describe the image, then list 3 visible objects and 1 possible scene context.",
    isReasoning: false,
    messages: [
      {
        role: "system",
        content:
          "You are a visual analysis assistant. When given an image, describe it concisely, identify key visible objects, and infer the likely context or setting of the scene.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Describe this image in short, list 3 visible objects, and infer one likely scene context.",
          },
          {
            type: "image_url",
            image_url: {
              url: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=640",
            },
          },
        ],
      },
    ],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    icon: Brain,
    prompt: "Think step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain your reasoning.",
    isReasoning: true,
    messages: [
      {
        role: "system",
        content:
          "You are a logical reasoning assistant. Think through problems step by step, showing your chain of thought clearly before giving a final answer. Focus on accuracy and clarity.",
      },
      {
        role: "user",
        content:
          "Think step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain your reasoning.",
      },
    ],
  },
];

interface ScenarioSelectorProps {
  selectedScenario: string | null;
  onSelect: (scenario: Scenario) => void;
  disabled?: boolean;
}

export function ScenarioSelector({
  selectedScenario,
  onSelect,
  disabled = false,
}: ScenarioSelectorProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {SCENARIOS.map((scenario) => {
        const Icon = scenario.icon;
        const isSelected = selectedScenario === scenario.id;

        return (
          <Button
            key={scenario.id}
            variant={isSelected ? "default" : "outline"}
            size="sm"
            onClick={() => onSelect(scenario)}
            disabled={disabled}
            className={cn(
              "h-auto py-2 px-3 flex flex-col items-center gap-1 min-w-[72px]",
              scenario.isReasoning && !isSelected && "border-dashed border-amber-400 hover:border-amber-500 dark:border-amber-700 dark:hover:border-amber-600",
              scenario.isReasoning && isSelected && "bg-amber-600 hover:bg-amber-700"
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="text-xs">{scenario.name}</span>
          </Button>
        );
      })}
    </div>
  );
}
