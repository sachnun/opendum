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

export function PlaygroundClient({ models }: PlaygroundClientProps) {
  // Panels state - start with 3 panels for side-by-side comparison
  const [panels, setPanels] = React.useState<PanelState[]>([
    { id: generateId(), modelId: null },
    { id: generateId(), modelId: null },
    { id: generateId(), modelId: null },
  ]);

  // Scenario selection
  const [selectedScenario, setSelectedScenario] = React.useState<Scenario | null>(null);

  // Settings
  const [settings, setSettings] = React.useState<PlaygroundSettings>(DEFAULT_SETTINGS);

  // Response state - keyed by panel id
  const [responses, setResponses] = React.useState<Record<string, ResponseData>>({});
  const [isAnyLoading, setIsAnyLoading] = React.useState(false);

  // Update panel's model
  const updatePanelModel = (panelId: string, modelId: string) => {
    setPanels((prev) =>
      prev.map((p) => (p.id === panelId ? { ...p, modelId } : p))
    );
  };

  // Handle scenario selection - auto-enable reasoning and immediately run
  const handleScenarioSelect = async (scenario: Scenario) => {
    setSelectedScenario(scenario);

    // Auto-enable reasoning for reasoning scenarios
    let currentSettings = settings;
    if (scenario.isReasoning && settings.reasoningEffort === "none") {
      currentSettings = { ...settings, reasoningEffort: "medium" };
      setSettings(currentSettings);
    }

    // Immediately run the test with current panels
    const panelsWithModels = panels.filter((p) => p.modelId);
    if (panelsWithModels.length === 0) return;

    setIsAnyLoading(true);

    // Clear previous responses
    const clearedResponses: Record<string, ResponseData> = {};
    panelsWithModels.forEach((panel) => {
      clearedResponses[panel.id] = { content: "", isLoading: true };
    });
    setResponses(clearedResponses);

    // Start fetching from all panels in parallel
    const promises = panelsWithModels.map((panel) =>
      fetchFromModel(panel.id, panel.modelId!, scenario.prompt, currentSettings)
    );

    await Promise.all(promises);
    setIsAnyLoading(false);
  };

  // Fetch response from a single model (non-streaming)
  // modelId format: "provider/model" (e.g. "iflow/qwen3-coder-plus")
  const fetchFromModel = async (
    panelId: string,
    modelId: string,
    prompt: string,
    currentSettings: PlaygroundSettings = settings
  ) => {
    // Initialize response state
    setResponses((prev) => ({
      ...prev,
      [panelId]: { content: "", isLoading: true },
    }));

    try {
      // modelId is already in "provider/model" format, send directly
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

      // Add reasoning_effort only if not "none"
      if (currentSettings.reasoningEffort !== "none") {
        requestBody.reasoning_effort = currentSettings.reasoningEffort;
      }

      const response = await fetch("/api/playground/chat", {
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

      // Set response
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
