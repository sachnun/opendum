"use client";

import * as React from "react";
import {
  Lightbulb,
  Code,
  FileText,
  Languages,
  Sparkles,
  BarChart3,
  Brain,
  Calculator,
  Puzzle,
  SearchCode,
  Zap,
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
    prompt: "Summarize the following text in 3 bullet points:\n\n[Paste your text here]",
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
    id: "creative",
    name: "Creative",
    icon: Sparkles,
    prompt: "Write a short, engaging product description for a smart water bottle that tracks hydration.",
    isReasoning: false,
  },
  {
    id: "analyze",
    name: "Analyze",
    icon: BarChart3,
    prompt: "Analyze the pros and cons of remote work vs office work. Provide a balanced perspective.",
    isReasoning: false,
  },
  {
    id: "brainstorm",
    name: "Brainstorm",
    icon: Zap,
    prompt: "Generate 5 creative startup ideas in the AI/ML space for 2025. For each idea, include: name, one-line description, target market, and unique value proposition.",
    isReasoning: false,
  },
  {
    id: "reasoning",
    name: "Reasoning",
    icon: Brain,
    prompt: "Think step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain your reasoning.",
    isReasoning: true,
  },
  {
    id: "math",
    name: "Math",
    icon: Calculator,
    prompt: "Solve step by step:\n\nA train travels at 60 mph for 2.5 hours, then at 80 mph for 1.5 hours. What is the total distance traveled and the average speed for the entire journey?",
    isReasoning: true,
  },
  {
    id: "logic",
    name: "Logic",
    icon: Puzzle,
    prompt: "Solve this logic puzzle step by step:\n\nAlice, Bob, and Carol each have a different pet (cat, dog, fish). Alice doesn't have a dog. Carol doesn't have a cat. Bob has the fish. Who has which pet?",
    isReasoning: true,
  },
  {
    id: "code-review",
    name: "Code Review",
    icon: SearchCode,
    prompt: `Review this code for bugs, security issues, and suggest improvements:\n\n\`\`\`python\ndef login(user, pwd):\n    if user == 'admin' and pwd == 'password123':\n        return True\n    return False\n\`\`\``,
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
              scenario.isReasoning && !isSelected && "border-dashed border-amber-500/50 hover:border-amber-500",
              scenario.isReasoning && isSelected && "bg-amber-600 hover:bg-amber-600/90"
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
