import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "./registry.ts";
import { OpenAIModelSerializer } from "./serializer.ts";

function serializerOf(models: Record<string, ModelInfo>): OpenAIModelSerializer {
  return new OpenAIModelSerializer({
    models: () => Object.keys(models).sort((a, b) => a.localeCompare(b)),
    info: (model) => models[model] ?? null,
  });
}

describe("OpenAIModelSerializer", () => {
  it("formats models for the OpenAI models endpoint", () => {
    const serializer = serializerOf({
      "gpt-4o": {
        providers: ["openai"],
        owner: "openai",
        reasoning: true,
        reasoning_effort: ["low", "high"],
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128000, output: 16384 },
      },
    });

    expect(serializer.format()).toEqual([
      {
        id: "gpt-4o",
        object: "model",
        providers: ["openai"],
        owner: "openai",
        reasoning: true,
        reasoning_effort: ["low", "high"],
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128000, output: 16384 },
      },
    ]);
  });

  it("omits effort and empty limits", () => {
    const serializer = serializerOf({
      m: { providers: ["p"], reasoning: false, reasoning_effort: ["high"], limit: { context: 0, output: 0 } },
    });

    expect(serializer.format()).toEqual([{ id: "m", object: "model", providers: ["p"], reasoning: false }]);
  });

  it("defaults reasoning and vision to true without metadata", () => {
    const serializer = serializerOf({ m: { providers: ["p"] } });

    expect(serializer.isReasoning("m")).toBe(true);
    expect(serializer.isVision("m")).toBe(true);
    expect(serializer.isReasoning("missing")).toBe(false);
    expect(serializer.isVision("missing")).toBe(false);
  });

  it("reads vision from the input modalities", () => {
    const serializer = serializerOf({
      textOnly: { providers: ["p"], modalities: { input: ["text"], output: ["text"] } },
      image: { providers: ["p"], modalities: { input: ["text", "image"], output: ["text"] } },
    });

    expect(serializer.isVision("textOnly")).toBe(false);
    expect(serializer.isVision("image")).toBe(true);
  });
});
