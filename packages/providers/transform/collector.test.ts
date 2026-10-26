import { describe, expect, it } from "bun:test";
import { Collector } from "@opendum/providers/transform/collector";

type Json = Record<string, unknown>;

function completionOf(collector: Collector): {
  id: string;
  model: string;
  message: Json;
  finishReason: string;
  usage: Json;
} {
  const completion = collector.toCompletion();
  const choice = (completion.choices as Json[])[0] as Json;
  return {
    id: completion.id as string,
    model: completion.model as string,
    message: choice.message as Json,
    finishReason: choice.finish_reason as string,
    usage: completion.usage as Json,
  };
}

describe("Collector", () => {
  it("aggregates text and usage into a chat completion", () => {
    const collector = new Collector({ model: "m-1" });
    collector.addContent("hello");
    collector.addContent(" world");
    collector.setUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });

    const { model, message, finishReason, usage } = completionOf(collector);
    expect(model).toBe("m-1");
    expect(message).toEqual({ role: "assistant", content: "hello world" });
    expect(finishReason).toBe("stop");
    expect(usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });

  it("appends tool call fragments and upgrades a stop finish reason", () => {
    const collector = new Collector({ model: "m" });
    collector.addToolCall({
      key: 0,
      id: "call_a",
      type: "function",
      name: "sea",
      nameMode: "append",
      arguments: '{"q":',
    });
    collector.addToolCall({ key: 0, name: "rch", nameMode: "append", arguments: '"x"}' });

    const { message, finishReason } = completionOf(collector);
    expect(message.tool_calls).toEqual([
      { id: "call_a", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
    ]);
    expect(finishReason).toBe("tool_calls");
  });

  it("keeps a non-stop finish reason and falls back for missing tool ids", () => {
    const collector = new Collector({ model: "m" });
    collector.setFinish("length");
    collector.addToolCall({ key: 2, arguments: "{}" });

    const { message, finishReason } = completionOf(collector);
    expect(finishReason).toBe("length");
    expect((message.tool_calls as Json[])[0]).toEqual({
      id: "call_2",
      type: "function",
      function: { name: "", arguments: "{}" },
    });
  });

  it("forces the tool finish reason when configured", () => {
    const collector = new Collector({ model: "m", forceFinish: true });
    collector.setFinish("length");
    collector.addToolCall({ key: 2, arguments: "{}" });

    expect(completionOf(collector).finishReason).toBe("tool_calls");
  });

  it("keeps tool call insertion order", () => {
    const collector = new Collector({ model: "m" });
    collector.addToolCall({ key: 5, id: "b" });
    collector.addToolCall({ key: 1, id: "a" });

    const ids = ((completionOf(collector).message.tool_calls ?? []) as Json[]).map((call) => call.id);
    expect(ids).toEqual(["b", "a"]);
  });

  it("honors the configured completion id and tool id fallback", () => {
    const collector = new Collector({
      model: "m",
      id: "chatcmpl-fixed",
      toolIdFallback: (key) => `tool-${key}`,
    });
    collector.addToolCall({ key: 7 });

    const { id, message } = completionOf(collector);
    expect(id).toBe("chatcmpl-fixed");
    expect((message.tool_calls as Json[])[0]?.id).toBe("tool-7");
  });

  it("ignores empty finish reasons", () => {
    const collector = new Collector({ model: "m" });
    collector.setFinish("");
    expect(completionOf(collector).finishReason).toBe("stop");
  });

  it("keeps the first tool call name by default", () => {
    const collector = new Collector({ model: "m" });
    collector.addToolCall({ key: 0, name: "sea" });
    collector.addToolCall({ key: 0, name: "rch" });

    const call = ((completionOf(collector).message.tool_calls ?? []) as Json[])[0] as Json;
    expect((call.function as Json).name).toBe("sea");
  });

  it("replaces accumulated arguments for sealed tool calls", () => {
    const collector = new Collector({ model: "m" });
    collector.addToolCall({ key: "call_a", arguments: '{"q":' });
    collector.addToolCall({ key: "call_a", arguments: '{"q":"x"}', replaceArgs: true });

    const call = ((completionOf(collector).message.tool_calls ?? []) as Json[])[0] as Json;
    expect((call.function as Json).arguments).toBe('{"q":"x"}');
  });

  it("emits reasoning content unless disabled", () => {
    const collector = new Collector({ model: "m" });
    collector.addReasoning("think");
    collector.addReasoning("ing");
    expect(completionOf(collector).message.reasoning_content).toBe("thinking");

    const hidden = new Collector({ model: "m", includeReasoning: false });
    hidden.addReasoning("think");
    expect(completionOf(hidden).message.reasoning_content).toBeUndefined();
  });

  it("emits null content for empty text when nullable", () => {
    const collector = new Collector({ model: "m", nullContent: true });
    expect(completionOf(collector).message.content).toBeNull();
    collector.addContent("hi");
    expect(completionOf(collector).message.content).toBe("hi");
  });

  it("normalizes tool arguments before emitting", () => {
    const collector = new Collector({
      model: "m",
      normalizeArgs: (args) => args.trim() || "{}",
    });
    collector.addToolCall({ key: "call_a", arguments: "  " });

    const call = ((completionOf(collector).message.tool_calls ?? []) as Json[])[0] as Json;
    expect((call.function as Json).arguments).toBe("{}");
  });

  it("falls back to the configured usage when the stream carried none", () => {
    const fallback = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const collector = new Collector({ model: "m", usageFallback: fallback });
    expect(completionOf(collector).usage).toEqual(fallback);

    collector.setUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    expect(completionOf(collector).usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  });
});
