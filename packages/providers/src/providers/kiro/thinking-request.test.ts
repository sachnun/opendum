import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import {
  kiroExplicitThinkingBudget,
  kiroIncludeThoughtsFalse,
  kiroReasoningEffort,
  kiroThinkingBudget,
  kiroThinkingRequested,
} from "#providers/providers/kiro/thinking-request.ts";

type Json = Record<string, unknown>;

function registry(): Registry {
  return { isReasoningModel: (model: string) => model === "smart" } as unknown as Registry;
}

describe("kiroExplicitThinkingBudget", () => {
  it("reads direct and nested budgets", () => {
    assert.equal(kiroExplicitThinkingBudget({ thinking_budget: 42 }), 42);
    assert.equal(kiroExplicitThinkingBudget({ reasoning: { max_tokens: 7 } }), 7);
    assert.equal(kiroExplicitThinkingBudget({ reasoning: { budget_tokens: 8 } }), 8);
    assert.equal(kiroExplicitThinkingBudget({ reasoning: { thinking_budget: 9 } }), 9);
  });

  it("returns zero for missing or invalid budgets", () => {
    assert.equal(kiroExplicitThinkingBudget({} as Json), 0);
    assert.equal(kiroExplicitThinkingBudget({ reasoning: "x" }), 0);
    assert.equal(kiroExplicitThinkingBudget({ thinking_budget: -1 }), 0);
  });
});

describe("kiroReasoningEffort", () => {
  it("prefers nested effort then flat", () => {
    assert.equal(kiroReasoningEffort({ reasoning: { effort: "high" } }), "high");
    assert.equal(kiroReasoningEffort({ reasoning_effort: "low" }), "low");
    assert.equal(kiroReasoningEffort({} as Json), "");
  });
});

describe("kiroIncludeThoughtsFalse", () => {
  it("detects explicit false flags", () => {
    assert.equal(kiroIncludeThoughtsFalse({ include_thoughts: false }), true);
    assert.equal(kiroIncludeThoughtsFalse({ reasoning: { include_thoughts: false } }), true);
    assert.equal(kiroIncludeThoughtsFalse({ reasoning: { includeThoughts: false } }), true);
    assert.equal(kiroIncludeThoughtsFalse({ include_thoughts: true }), false);
    assert.equal(kiroIncludeThoughtsFalse({} as Json), false);
  });
});

describe("kiroThinkingRequested", () => {
  it("honours explicit opt-outs", () => {
    assert.equal(kiroThinkingRequested(registry(), { model: "x", include_thoughts: false }), false);
    assert.equal(kiroThinkingRequested(registry(), { model: "x", reasoning: { effort: "none" } }), false);
  });

  it("detects requested thinking from many signals", () => {
    assert.equal(kiroThinkingRequested(registry(), { model: "x", thinking_budget: 100 }), true);
    assert.equal(kiroThinkingRequested(registry(), { model: "x", reasoning: { effort: "high" } }), true);
    assert.equal(kiroThinkingRequested(registry(), { model: "x", reasoning_effort: "low" }), true);
    assert.equal(kiroThinkingRequested(registry(), { model: "x", include_thoughts: true }), true);
    assert.equal(kiroThinkingRequested(registry(), { model: "x", _includeReasoning: true }), true);
    assert.equal(kiroThinkingRequested(registry(), { model: "claude-x-thinking" }), true);
    assert.equal(kiroThinkingRequested(registry(), { model: "smart" }), true);
    assert.equal(kiroThinkingRequested(registry(), { model: "x", reasoning: { effort: "bogus" } }), false);
    assert.equal(kiroThinkingRequested(registry(), { model: "x", reasoning: {} }), true);
  });

  it("defaults to false", () => {
    assert.equal(kiroThinkingRequested(registry(), { model: "plain" }), false);
  });
});

describe("kiroThinkingBudget", () => {
  it("resolves explicit, effort and default budgets", () => {
    assert.equal(kiroThinkingBudget({ thinking_budget: 5 }), 5);
    assert.equal(kiroThinkingBudget({ reasoning: { effort: "high" } }), 32000);
    assert.equal(kiroThinkingBudget({ reasoning: { effort: "low" } }), 1024);
    assert.equal(kiroThinkingBudget({} as Json), 20000);
  });
});
