import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { buildKiroRequest } from "#providers/providers/kiro/history.ts";

type Json = Record<string, unknown>;

function registry(): Registry {
  return {
    isSupportedByProvider: () => false,
    upstreamModelName: (model: string) => model,
    isReasoningModel: () => false,
  } as unknown as Registry;
}

describe("buildKiroRequest", () => {
  it("injects the system prompt into a simple conversation", () => {
    const request = buildKiroRequest(registry(), {
      model: "kiro/claude",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
    const state = request.conversationState as Json;
    const userInput = ((state.currentMessage as Json).userInputMessage as Json);
    assert.equal(userInput.content, "sys\n\nhi");
    assert.equal(userInput.origin, "AI_EDITOR");
  });

  it("converts prior turns into history", () => {
    const request = buildKiroRequest(registry(), {
      model: "kiro/claude",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "next" },
      ],
    });
    const state = request.conversationState as Json;
    const history = state.history as Json[];
    assert.equal(history.length, 2);
    assert.equal((history[0]!.userInputMessage as Json).content, "hi");
    assert.equal((history[1]!.assistantResponseMessage as Json).content, "hello");
    assert.equal(((state.currentMessage as Json).userInputMessage as Json).content, "next");
  });

  it("enables thinking and forwards tools", () => {
    const request = buildKiroRequest(registry(), {
      model: "claude-x-thinking",
      include_thoughts: true,
      tools: [{ type: "function", function: { name: "lookup", description: "d", parameters: {} } }],
      messages: [{ role: "user", content: "hi" }],
    });
    const state = request.conversationState as Json;
    const userInput = ((state.currentMessage as Json).userInputMessage as Json);
    assert.match(String(userInput.content), /<thinking_mode>enabled<\/thinking_mode>/);
    const ctx = userInput.userInputMessageContext as Json;
    assert.equal((ctx.tools as Json[]).length, 1);
  });
});
