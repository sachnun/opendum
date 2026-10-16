import { describe, expect, it } from "bun:test";
import { Suggester } from "./suggester.ts";

const suggester = Suggester.fromModels([
  { value: "gpt-4o", providers: ["openai"] },
  { value: "gpt-4o-mini", providers: ["openai"] },
  { value: "claude-sonnet-4-6", providers: ["anthropic"] },
]);

describe("Suggester", () => {
  it("prefers the provider pool and prefixes results", () => {
    expect(suggester.suggest("gpt4o", "openai", null, 5)).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
  });

  it("falls back to every model when the provider has no candidates", () => {
    expect(suggester.suggest("gpt4o", "unknown", null, 5)).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
      "claude-sonnet-4-6",
    ]);
  });

  it("restricts scoring to the provided candidates", () => {
    expect(suggester.suggest("gpt4o", "openai", ["gpt-4o-mini"], 5)).toEqual(["openai/gpt-4o-mini"]);
  });

  it("honors the limit and rejects weak terms", () => {
    expect(suggester.suggest("gpt4o", "openai", null, 1)).toEqual(["openai/gpt-4o"]);
    expect(suggester.suggest("zzz", "openai", null, 5)).toEqual([]);
    expect(suggester.suggest("", "openai", null, 5)).toEqual([]);
    expect(suggester.suggest("gpt-4o", "openai", null, 0)).toEqual([]);
  });
});
