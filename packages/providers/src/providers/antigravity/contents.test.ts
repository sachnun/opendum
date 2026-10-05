import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferMimeTypeFromUrl, openAiToGemini } from "#providers/providers/antigravity/contents.ts";

type Json = Record<string, unknown>;

describe("inferMimeTypeFromUrl", () => {
  it("maps known extensions", () => {
    assert.equal(inferMimeTypeFromUrl("https://x/a.png"), "image/png");
    assert.equal(inferMimeTypeFromUrl("a.PDF"), "application/pdf");
    assert.equal(inferMimeTypeFromUrl("https://x/movie.mp4"), "video/mp4");
    assert.equal(inferMimeTypeFromUrl("https://x/song.ogg"), "audio/ogg");
  });

  it("defaults unknown extensions to jpeg", () => {
    assert.equal(inferMimeTypeFromUrl("https://x/noext"), "image/jpeg");
    assert.equal(inferMimeTypeFromUrl("https://x/a.weird"), "image/jpeg");
  });
});

describe("openAiToGemini", () => {
  it("converts a tool conversation", () => {
    const payload = openAiToGemini({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", tool_calls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }] },
        { role: "tool", tool_call_id: "t1", content: "result" },
      ],
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 10,
      stop: ["S"],
      tools: [{ function: { name: "f", parameters: {} } }],
      thinking_budget: 5000,
      include_thoughts: true,
    });

    assert.equal((((payload.systemInstruction as Json).parts as Json[])[0] as Json).text, "sys");
    const contents = payload.contents as Json[];
    assert.equal(contents.length, 4);
    assert.equal(contents[0]!.role, "user");
    assert.equal(contents[1]!.role, "model");
    assert.equal(contents[2]!.role, "model");
    const call = (contents[2]!.parts as Json[])[0] as Json;
    assert.deepEqual(call.functionCall, { name: "f", args: { a: 1 }, id: "t1" });
    const response = (contents[3]!.parts as Json[])[0] as Json;
    assert.equal((response.functionResponse as Json).name, "f");
    assert.deepEqual((response.functionResponse as Json).response, { result: "result" });

    const generation = payload.generationConfig as Json;
    assert.deepEqual(generation, {
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 10,
      stopSequences: ["S"],
      thinkingConfig: { thinkingBudget: 5000, include_thoughts: true },
    });
    assert.equal((payload.tools as Json[])[0]!.functionDeclarations instanceof Array, true);
    assert.equal((payload.safetySettings as unknown[]).length, 4);
  });

  it("converts image content and passes cached content through", () => {
    const payload = openAiToGemini({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "t" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "image_url", image_url: { url: "https://x/y.jpg" } },
          ],
        },
      ],
      stop: "X",
      cached_content: "cache",
      reasoning_effort: "high",
    });
    const parts = ((payload.contents as Json[])[0]!.parts as Json[]);
    assert.deepEqual(parts[0], { text: "t" });
    assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: "AAAA" } });
    assert.deepEqual(parts[2], { fileData: { fileUri: "https://x/y.jpg", mimeType: "image/jpeg" } });
    assert.deepEqual((payload.generationConfig as Json).stopSequences, ["X"]);
    assert.equal(((payload.generationConfig as Json).thinkingConfig as Json).thinkingBudget, 32000);
    assert.equal(payload.cached_content, "cache");
  });

  it("drops orphaned tool results and empty content", () => {
    const payload = openAiToGemini({
      messages: [
        { role: "user", content: "" },
        { role: "tool", tool_call_id: "missing", content: "x" },
        { role: "assistant", content: "" },
      ],
    });
    assert.deepEqual(payload.contents, []);
    assert.equal("systemInstruction" in payload, false);
  });

  it("ignores reasoning configs without a budget", () => {
    const payload = openAiToGemini({ messages: [], reasoning_effort: "none" });
    assert.equal("generationConfig" in payload, false);
  });
});
