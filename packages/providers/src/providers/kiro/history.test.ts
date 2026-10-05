import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import {
  buildKiroRequest,
  convertKiroMessageToHistoryItem,
  dedupeKiroToolResults,
  filterKiroAssistantToolUses,
  findOriginalKiroToolCall,
  injectKiroSystemPrompt,
  kiroAssistantContentAndToolUses,
  kiroAssistantToolUseIds,
  kiroHistoryToolUseIds,
  kiroToolResult,
  kiroToolResultText,
  kiroToolResultsFromContent,
  kiroToolUseFromOpenAICall,
  kiroUserContentAndToolResults,
  kiroUserInputHasToolResults,
  reconcileKiroCurrentToolResults,
  sanitizeKiroToolPairing,
  sanitizeKiroUserToolResults,
  setKiroCurrentToolResults,
} from "#providers/providers/kiro/history.ts";

type Json = Record<string, unknown>;

function registry(): Registry {
  return {
    isSupportedByProvider: () => false,
    upstreamModelName: (model: string) => model,
    isReasoningModel: () => false,
  } as unknown as Registry;
}

describe("kiroToolUseFromOpenAICall", () => {
  it("converts valid and invalid calls", () => {
    assert.deepEqual(kiroToolUseFromOpenAICall({ id: "t1", function: { name: "f", arguments: '{"a":1}' } }), {
      toolUseId: "t1",
      name: "f",
      input: { a: 1 },
    });
    assert.deepEqual(kiroToolUseFromOpenAICall({ id: "t1", function: { name: "f", arguments: "not json" } }), {
      toolUseId: "t1",
      name: "f",
      input: {},
    });
    assert.deepEqual(kiroToolUseFromOpenAICall({ id: "t1", function: { name: "f" } }), { toolUseId: "t1", name: "f", input: {} });
    assert.equal(kiroToolUseFromOpenAICall({ function: { name: "f" } }), null);
    assert.equal(kiroToolUseFromOpenAICall({ id: "t1" }), null);
  });
});

describe("kiroAssistantContentAndToolUses", () => {
  it("combines content parts, thinking and tool calls", () => {
    const result = kiroAssistantContentAndToolUses({
      content: [
        { type: "text", text: "hello " },
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", id: "t1", name: "f", input: { a: 1 } },
      ],
      tool_calls: [{ id: "t2", function: { name: "g", arguments: '{"b":2}' } }],
    });
    assert.equal(result.content, "<thinking>hmm</thinking>\n\nhello ");
    assert.deepEqual(result.toolUses, [
      { toolUseId: "t1", name: "f", input: { a: 1 } },
      { toolUseId: "t2", name: "g", input: { b: 2 } },
    ]);
  });

  it("handles plain string content", () => {
    const result = kiroAssistantContentAndToolUses({ content: "plain" });
    assert.equal(result.content, "plain");
    assert.deepEqual(result.toolUses, []);
  });
});

describe("kiro tool results", () => {
  it("extracts tool results from content", () => {
    const results = kiroToolResultsFromContent([
      { type: "tool_result", tool_use_id: "a", content: "ok" },
      { type: "tool_result", tool_call_id: "b", content: [{ text: "ok2" }] },
      { type: "text", text: "ignored" },
      { type: "tool_result", content: "no id" },
    ]);
    assert.deepEqual(results, [
      { toolUseId: "a", status: "success", content: [{ text: "ok" }] },
      { toolUseId: "b", status: "success", content: [{ text: "ok2" }] },
    ]);
    assert.deepEqual(kiroToolResultsFromContent("nope"), []);
  });

  it("dedupes results by id", () => {
    assert.deepEqual(dedupeKiroToolResults([{ toolUseId: "a" }, { toolUseId: "a" }, { toolUseId: "b" }, {}]), [
      { toolUseId: "a" },
      { toolUseId: "b" },
    ]);
  });

  it("reads result text", () => {
    assert.equal(kiroToolResultText(kiroToolResult("a", "hello")), "hello");
  });
});

describe("kiroUserContentAndToolResults", () => {
  it("handles strings, objects and empty arrays", () => {
    assert.deepEqual(kiroUserContentAndToolResults("hi"), { text: "hi", toolResults: [] });
    assert.deepEqual(kiroUserContentAndToolResults({ text: "hi" }), { text: "hi", toolResults: [] });
    assert.deepEqual(kiroUserContentAndToolResults([]), { text: "", toolResults: [] });
  });

  it("splits text and tool results with dedupe", () => {
    const result = kiroUserContentAndToolResults([
      { type: "text", text: "q" },
      { type: "tool_result", tool_use_id: "a", content: "r" },
      { type: "tool_result", tool_use_id: "a", content: "r2" },
    ]);
    assert.equal(result.text, "q");
    assert.deepEqual(result.toolResults, [{ toolUseId: "a", status: "success", content: [{ text: "r" }] }]);
  });
});

describe("convertKiroMessageToHistoryItem", () => {
  it("converts assistant messages", () => {
    assert.deepEqual(convertKiroMessageToHistoryItem({ role: "assistant", content: "hi" }, "m"), {
      assistantResponseMessage: { content: "hi" },
    });
  });

  it("drops empty assistant messages", () => {
    assert.equal(convertKiroMessageToHistoryItem({ role: "assistant", content: "" }, "m"), null);
  });

  it("converts tool messages", () => {
    const item = convertKiroMessageToHistoryItem({ role: "tool", content: "result" }, "m") as Json;
    const userInput = item.userInputMessage as Json;
    assert.equal(userInput.content, "Tool results provided.");
    assert.equal(userInput.modelId, "m");
    assert.ok(kiroUserInputHasToolResults(userInput));
  });

  it("converts user messages and falls back to Continue", () => {
    assert.deepEqual(convertKiroMessageToHistoryItem({ role: "user", content: "hey" }, "m"), {
      userInputMessage: { content: "hey", modelId: "m", origin: "AI_EDITOR" },
    });
    const empty = convertKiroMessageToHistoryItem({ role: "user", content: "" }, "m") as Json;
    assert.equal((empty.userInputMessage as Json).content, "Continue");
    assert.equal(convertKiroMessageToHistoryItem({ role: "system", content: "x" }, "m"), null);
  });
});

describe("kiro history helpers", () => {
  it("tracks tool use ids in history", () => {
    const ids = kiroHistoryToolUseIds([
      { assistantResponseMessage: { toolUses: [{ toolUseId: "a" }, { toolUseId: "b" }] } },
      { userInputMessage: { content: "x" } },
    ]);
    assert.deepEqual(ids, { a: true, b: true });
  });

  it("finds original tool calls", () => {
    const messages = [
      { role: "assistant", tool_calls: [{ id: "t1", function: { name: "f", arguments: "{}" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "g", input: { x: 1 } }] },
    ];
    assert.deepEqual(findOriginalKiroToolCall(messages, "t1"), { toolUseId: "t1", name: "f", input: {} });
    assert.deepEqual(findOriginalKiroToolCall(messages, "t2"), { toolUseId: "t2", name: "g", input: { x: 1 } });
    assert.equal(findOriginalKiroToolCall(messages, "missing"), null);
  });

  it("sets and clears current tool results", () => {
    const userInput: Json = { userInputMessageContext: { other: 1 } };
    setKiroCurrentToolResults(userInput, [{ toolUseId: "a" }]);
    assert.deepEqual(userInput.userInputMessageContext, { other: 1, toolResults: [{ toolUseId: "a" }] });
    setKiroCurrentToolResults(userInput, []);
    assert.deepEqual(userInput.userInputMessageContext, { other: 1 });

    const empty: Json = {};
    setKiroCurrentToolResults(empty, []);
    assert.equal("userInputMessageContext" in empty, false);
  });

  it("injects the system prompt into the first safe user message", () => {
    const history: Json[] = [{ userInputMessage: { content: "hi" } }];
    assert.equal(injectKiroSystemPrompt(history, "sys"), true);
    assert.equal((history[0]!.userInputMessage as Json).content, "sys\n\nhi");
    assert.equal(injectKiroSystemPrompt([{ userInputMessage: { content: "x", userInputMessageContext: { toolResults: [{}] } } }], "s"), false);
  });

  it("filters assistant tool uses to confirmed results", () => {
    const assistant: Json = { toolUses: [{ toolUseId: "a" }, { toolUseId: "b" }] };
    assert.deepEqual(kiroAssistantToolUseIds(assistant), { a: true, b: true });
    assert.equal(kiroAssistantToolUseIds({}), null);

    const user: Json = { content: "", userInputMessageContext: { toolResults: [{ toolUseId: "a" }, { toolUseId: "z" }] } };
    assert.deepEqual(sanitizeKiroUserToolResults(user, { a: true }), { a: true });
    filterKiroAssistantToolUses(assistant, { a: true });
    assert.deepEqual(assistant.toolUses, [{ toolUseId: "a" }]);

    assert.equal(sanitizeKiroUserToolResults({}, null), null);
  });

  it("drops assistant tool uses with no confirmed results", () => {
    const assistant: Json = { toolUses: [{ toolUseId: "a" }] };
    filterKiroAssistantToolUses(assistant, null);
    assert.equal("toolUses" in assistant, false);
    filterKiroAssistantToolUses(null, null);
  });
});

describe("reconcileKiroCurrentToolResults", () => {
  it("links results, promotes orphans and inlines unknown outputs", () => {
    const history: Json[] = [
      { assistantResponseMessage: { content: "c", toolUses: [{ toolUseId: "known", name: "f", input: {} }] } },
    ];
    const rawMessages: Json[] = [{ role: "assistant", tool_calls: [{ id: "orphan", function: { name: "g", arguments: "{}" } }] }];
    const userInput: Json = {
      content: "go",
      userInputMessageContext: {
        toolResults: [
          { toolUseId: "known", content: [{ text: "k" }] },
          { toolUseId: "orphan", content: [{ text: "o" }] },
          { toolUseId: "missing", content: [{ text: "m" }] },
        ],
      },
    };

    const result = reconcileKiroCurrentToolResults(history, rawMessages, userInput, "m");
    assert.equal(result.length, 3);
    const last = result[2] as Json;
    assert.deepEqual((last.assistantResponseMessage as Json).toolUses, [{ toolUseId: "orphan", name: "g", input: {} }]);
    assert.match(String(userInput.content), /\[Output for tool call missing\]:\nm/);
    assert.deepEqual((userInput.userInputMessageContext as Json).toolResults, [
      { toolUseId: "known", content: [{ text: "k" }] },
      { toolUseId: "orphan", content: [{ text: "o" }] },
    ]);
  });

  it("returns history unchanged without results", () => {
    const history: Json[] = [{ userInputMessage: { content: "x" } }];
    assert.equal(reconcileKiroCurrentToolResults(history, [], { content: "x" }, "m"), history);
  });
});

describe("sanitizeKiroToolPairing", () => {
  it("keeps only paired tool uses", () => {
    const history: Json[] = [
      { assistantResponseMessage: { content: "c", toolUses: [{ toolUseId: "a" }, { toolUseId: "b" }] } },
      { userInputMessage: { content: "", userInputMessageContext: { toolResults: [{ toolUseId: "a", content: [{ text: "r" }] }] } } },
    ];
    const currentUser: Json = { content: "go" };
    const result = sanitizeKiroToolPairing(history, currentUser);
    assert.equal(result.length, 2);
    assert.deepEqual((history[0]!.assistantResponseMessage as Json).toolUses, [{ toolUseId: "a" }]);
  });
});

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
