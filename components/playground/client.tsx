"use client";

import * as React from "react";

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

const PANEL_COUNT = 3;

function getInitialPanelModels(models: ModelOption[]): Array<string | null> {
  const availableModelIds = new Set(models.map((model) => model.id));
  const selectedModelIds: string[] = [];

  for (const modelId of DEFAULT_MODELS) {
    if (availableModelIds.has(modelId)) {
      selectedModelIds.push(modelId);
    }

    if (selectedModelIds.length === PANEL_COUNT) {
      break;
    }
  }

  if (selectedModelIds.length < PANEL_COUNT) {
    for (const model of models) {
      if (!selectedModelIds.includes(model.id)) {
        selectedModelIds.push(model.id);
      }

      if (selectedModelIds.length === PANEL_COUNT) {
        break;
      }
    }
  }

  while (selectedModelIds.length < PANEL_COUNT) {
    selectedModelIds.push("");
  }

  return selectedModelIds.map((modelId) => modelId || null);
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!part || typeof part !== "object") {
        return "";
      }

      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

interface ParsedCompletionData {
  content: string;
  reasoning: string;
}

function extractChatCompletionData(payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") {
    return { content: "", reasoning: "" };
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { content: "", reasoning: "" };
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    return { content: "", reasoning: "" };
  }

  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return { content: "", reasoning: "" };
  }

  return {
    content: extractTextContent((message as { content?: unknown }).content),
    reasoning: extractTextContent(
      (message as { reasoning_content?: unknown }).reasoning_content
    ),
  };
}

function extractStreamChunkData(payload: unknown): ParsedCompletionData {
  if (!payload || typeof payload !== "object") {
    return { content: "", reasoning: "" };
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { content: "", reasoning: "" };
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    return { content: "", reasoning: "" };
  }

  const delta = (firstChoice as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") {
    return { content: "", reasoning: "" };
  }

  return {
    content: extractTextContent((delta as { content?: unknown }).content),
    reasoning: extractTextContent(
      (delta as { reasoning_content?: unknown }).reasoning_content
    ),
  };
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return null;
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : null;
}

function processSseEvents(
  events: string[],
  onChunk: (chunk: ParsedCompletionData) => void
) {
  for (const event of events) {
    const lines = event.split(/\r?\n/);

    for (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }

      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const errorMessage = extractErrorMessage(parsed);
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      const chunk = extractStreamChunkData(parsed);
      if (chunk.content || chunk.reasoning) {
        onChunk(chunk);
      }
    }
  }
}

async function consumeChatCompletionStream(
  response: Response,
  onChunk: (chunk: ParsedCompletionData) => void
) {
  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    processSseEvents(events, onChunk);
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    processSseEvents([buffer], onChunk);
  }
}

export function PlaygroundClient({ models }: PlaygroundClientProps) {
  const [panels, setPanels] = React.useState<PanelState[]>(() => {
    const initialModelIds = getInitialPanelModels(models);

    return Array.from({ length: PANEL_COUNT }, (_, index) => ({
      id: generateId(),
      modelId: initialModelIds[index],
    }));
  });

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
      clearedResponses[panel.id] = { content: "", reasoning: "", isLoading: true };
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
      [panelId]: { content: "", reasoning: "", isLoading: true },
    }));

    try {
      const shouldStream = currentSettings.streamResponses;
      const requestBody: Record<string, unknown> = {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        stream: shouldStream,
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
        const clonedResponse = response.clone();
        let errorMessage = "Request failed";

        try {
          const errorData = await response.json();
          const apiError = extractErrorMessage(errorData);
          if (apiError) {
            errorMessage = apiError;
          }
        } catch {
          const errorText = await clonedResponse.text();
          if (errorText.trim()) {
            errorMessage = errorText;
          }
        }

        throw new Error(errorMessage);
      }

      const contentType = response.headers.get("content-type") || "";
      const isStreamingResponse =
        shouldStream && contentType.includes("text/event-stream");

      if (isStreamingResponse) {
        let streamedContent = "";
        let streamedReasoning = "";

        await consumeChatCompletionStream(response, (chunk) => {
          streamedContent += chunk.content;
          streamedReasoning += chunk.reasoning;

          setResponses((prev) => ({
            ...prev,
            [panelId]: {
              content: streamedContent,
              reasoning: streamedReasoning,
              isLoading: true,
            },
          }));
        });

        setResponses((prev) => ({
          ...prev,
          [panelId]: {
            content: streamedContent,
            reasoning: streamedReasoning,
            isLoading: false,
          },
        }));

        return;
      }

      const data = await response.json();
      const parsedData = extractChatCompletionData(data);

      setResponses((prev) => ({
        ...prev,
        [panelId]: {
          content: parsedData.content,
          reasoning: parsedData.reasoning,
          isLoading: false,
        },
      }));
    } catch (error) {
      setResponses((prev) => ({
        ...prev,
        [panelId]: {
          content: "",
          reasoning: "",
          isLoading: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      }));
    }
  };

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">Playground</h1>
          <SettingsSheet
            settings={settings}
            onSettingsChange={setSettings}
            disabled={isAnyLoading}
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-medium text-muted-foreground">Scenario</h2>
        <div className="mt-3">
          <ScenarioSelector
            selectedScenario={selectedScenario?.id || null}
            onSelect={handleScenarioSelect}
            disabled={isAnyLoading}
          />
        </div>
      </div>

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
