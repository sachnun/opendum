"use client";

import * as React from "react";

import { Separator } from "@/components/ui/separator";
import { ChatPanel, type ModelOption, type ResponseData } from "./chat-panel";
import { ScenarioSelector, type Scenario } from "./scenario-selector";
import {
  SettingsSheet,
  DEFAULT_SETTINGS,
  type PlaygroundSettings,
} from "./settings-sheet";

interface PlaygroundClientProps {
  models: ModelOption[];
}

interface PanelState {
  id: string;
  modelId: string | null;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

// Default recommended models for the playground
const DEFAULT_MODELS = [
  "antigravity/claude-opus-4-5",
  "iflow/glm-4.7",
  "antigravity/gemini-3-pro-high",
];

export function PlaygroundClient({ models }: PlaygroundClientProps) {
  const [panels, setPanels] = React.useState<PanelState[]>([
    { id: generateId(), modelId: DEFAULT_MODELS[0] },
    { id: generateId(), modelId: DEFAULT_MODELS[1] },
    { id: generateId(), modelId: DEFAULT_MODELS[2] },
  ]);

  const [selectedScenario, setSelectedScenario] = React.useState<Scenario | null>(null);
  const [settings, setSettings] = React.useState<PlaygroundSettings>(DEFAULT_SETTINGS);
  const [responses, setResponses] = React.useState<Record<string, ResponseData>>({});
  const [isAnyLoading, setIsAnyLoading] = React.useState(false);

  const updatePanelModel = (panelId: string, modelId: string) => {
    setPanels((prev) =>
      prev.map((p) => (p.id === panelId ? { ...p, modelId } : p))
    );
  };

  const handleScenarioSelect = async (scenario: Scenario) => {
    setSelectedScenario(scenario);

    let currentSettings = settings;
    if (scenario.isReasoning && settings.reasoningEffort === "none") {
      currentSettings = { ...settings, reasoningEffort: "medium" };
      setSettings(currentSettings);
    }

    const panelsWithModels = panels.filter((p) => p.modelId);
    if (panelsWithModels.length === 0) return;

    setIsAnyLoading(true);

    const clearedResponses: Record<string, ResponseData> = {};
    panelsWithModels.forEach((panel) => {
      clearedResponses[panel.id] = { content: "", isLoading: true };
    });
    setResponses(clearedResponses);

    const promises = panelsWithModels.map((panel) =>
      fetchFromModel(panel.id, panel.modelId!, scenario.prompt, currentSettings)
    );

    await Promise.all(promises);
    setIsAnyLoading(false);
  };

  const fetchFromModel = async (
    panelId: string,
    modelId: string,
    prompt: string,
    currentSettings: PlaygroundSettings = settings
  ) => {
    setResponses((prev) => ({
      ...prev,
      [panelId]: { content: "", isLoading: true },
    }));

    try {
      const requestBody: Record<string, unknown> = {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        temperature: currentSettings.temperature,
        top_p: currentSettings.topP,
        max_tokens: currentSettings.maxTokens,
        presence_penalty: currentSettings.presencePenalty,
        frequency_penalty: currentSettings.frequencyPenalty,
      };

      if (currentSettings.reasoningEffort !== "none") {
        requestBody.reasoning_effort = currentSettings.reasoningEffort;
      }

      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "Request failed");
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "";

      setResponses((prev) => ({
        ...prev,
        [panelId]: { content, isLoading: false },
      }));
    } catch (error) {
      setResponses((prev) => ({
        ...prev,
        [panelId]: {
          content: "",
          isLoading: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      }));
    }
  };

  return (
    <div className="space-y-6">
      {/* Header with Settings */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Playground</h1>
          <p className="text-muted-foreground">
            Compare AI model responses side by side
          </p>
        </div>
        <SettingsSheet
          settings={settings}
          onSettingsChange={setSettings}
          disabled={isAnyLoading}
        />
      </div>

      <Separator />

      {/* Scenario Selector - at top */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Choose a Test Scenario</h2>
        <ScenarioSelector
          selectedScenario={selectedScenario?.id || null}
          onSelect={handleScenarioSelect}
          disabled={isAnyLoading}
        />
      </div>

      <Separator />

      {/* Panels Grid - always 3 columns */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {panels.map((panel) => (
          <ChatPanel
            key={panel.id}
            panelId={panel.id}
            models={models}
            selectedModel={panel.modelId}
            onModelChange={(modelId) => updatePanelModel(panel.id, modelId)}
            response={responses[panel.id]}
            disabled={isAnyLoading}
          />
        ))}
      </div>
    </div>
  );
}
