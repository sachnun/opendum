"use client";

import * as React from "react";
import {
  Lightbulb,
  Code,
  FileText,
  Languages,
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
}

export const SCENARIOS: Scenario[] = [
  {
    id: "explain",
    name: "Explain",
    icon: Lightbulb,
    prompt: "Explain quantum computing in simple terms that a 10 year old could understand.",
    isReasoning: false,
  },
  {
    id: "code",
    name: "Code",
    icon: Code,
    prompt: "Write a Python function that validates an email address using regex. Include error handling and docstring.",
    isReasoning: false,
  },
  {
    id: "summarize",
    name: "Summarize",
    icon: FileText,
    prompt: "Summarize the following text in 3 bullet points:\n\nThe city opened a new community library that offers free Wi-Fi, study rooms, and weekend workshops. Residents can borrow up to 10 books at a time, and children under 12 can join a reading club. The mayor said the goal is to improve literacy and provide a safe space for learning. The library is open daily from 8am to 8pm.",
    isReasoning: false,
  },
  {
    id: "translate",
    name: "Translate",
    icon: Languages,
    prompt: "Translate the following text to Indonesian:\n\n[Paste your text here]",
    isReasoning: false,
  },
  {
    id: "reasoning",
    name: "Reasoning",
    icon: Brain,
    prompt: "Think step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain your reasoning.",
    isReasoning: true,
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
