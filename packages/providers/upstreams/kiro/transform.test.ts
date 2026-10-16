import { describe, expect, it } from "bun:test";
import { Parser, convertKiroEventsToCompletion } from "./transform.js";

type Json = Record<string, unknown>;

function choiceOf(completion: Json): { message: Json; finishReason: string } {
  const choice = (completion.choices as Json[])[0] as Json;
  return { message: choice.message as Json, finishReason: choice.finish_reason as string };
}

describe("convertKiroEventsToCompletion", () => {
  it("aggregates content, reasoning and tool calls", () => {
    const completion = convertKiroEventsToCompletion(
      [
        { content: "he" },
        { content: "llo" },
        { reasoningContentEvent: { text: "think" } },
        { name: "search", toolUseId: "toolu_1", input: '{"q":' },
        { input: '"x"}' },
        { stop: true },
        { usage: { inputTokens: 3, outputTokens: 4 } },
      ],
      "claude-sonnet-4.5"
    );

    expect(completion.id).toMatch(/^chatcmpl/);
    expect(completion.object).toBe("chat.completion");
    expect(completion.model).toBe("claude-sonnet-4.5");
    const { message, finishReason } = choiceOf(completion);
    expect(message.content).toBe("hello");
    expect(message.reasoning_content).toBe("think");
    expect(message.tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
    ]);
    expect(finishReason).toBe("tool_calls");
    expect(completion.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it("extracts bracket tool calls out of the content", () => {
    const completion = convertKiroEventsToCompletion(
      [{ content: 'sure [Called search with args:{"q":"x"}] done' }, { usage: { inputTokens: 1, outputTokens: 2 } }],
      "m"
    );

    const { message, finishReason } = choiceOf(completion);
    expect(message.content).toBe("sure done");
    const call = (message.tool_calls as Json[])[0] as Json;
    expect(String(call.id)).toMatch(/^toolu/);
    expect(call.function).toEqual({ name: "search", arguments: '{"q":"x"}' });
    expect(finishReason).toBe("tool_calls");
  });

  it("nulls empty content, defaults blank arguments and derives usage from context", () => {
    const completion = convertKiroEventsToCompletion([{ name: "f", toolUseId: "toolu_2" }, { stop: true }], "m");

    const { message, finishReason } = choiceOf(completion);
    expect(message.content).toBeNull();
    expect(message.reasoning_content).toBeUndefined();
    expect(message.tool_calls).toEqual([
      { id: "toolu_2", type: "function", function: { name: "f", arguments: "{}" } },
    ]);
    expect(finishReason).toBe("tool_calls");
    expect(completion.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe("Parser", () => {
  it("frames json events across chunk boundaries", () => {
    const parser = new Parser();
    expect(parser.feed('{"con')).toEqual([]);
    expect(parser.feed('tent":"hel')).toEqual([]);
    expect(parser.feed('lo"}')).toEqual([{ content: "hello" }]);
    expect(parser.feed('{"toolUseEvent":{"name":"search","toolUseId":"t1","input":"{}"}}')).toEqual([
      { name: "search", toolUseId: "t1", input: "{}", type: "toolUseEvent" },
    ]);
    expect(parser.finish()).toEqual([]);
  });

  it("keeps an unterminated json tail without emitting on finish", () => {
    const parser = new Parser();
    expect(parser.feed('{"content":"unterminated')).toEqual([]);
    expect(parser.finish()).toEqual([]);
  });

  it("extracts thinking across chunks and holds back a partial tag", () => {
    const parser = new Parser();
    expect(parser.processContent("hi <thin")).toEqual(["", ""]);
    expect(parser.processContent("king>because</thinking> ok")).toEqual(["hi  ok", "because"]);
    expect(parser.flushContent()).toEqual(["", ""]);
  });

  it("holds back a tail while waiting for a possible tag start", () => {
    const parser = new Parser();
    expect(parser.processContent("0123456789abc")).toEqual(["01", ""]);
    expect(parser.flushContent()).toEqual(["23456789abc", ""]);
  });
});
