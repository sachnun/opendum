import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ensureToolConfig,
  normalizeCachedContent,
  normalizeClaudeTools,
  normalizedThinkingMap,
  sanitizeToolBlocks,
  scrubConversationArtifacts,
  scrubToolTranscriptArtifacts,
  sortFunctionDeclarations,
  stripTrailingModelTurns,
} from "#providers/providers/antigravity/payload.ts";

type Json = Record<string, unknown>;

describe("normalizedThinkingMap", () => {
  it("normalizes budget, level and include thoughts", () => {
    assert.deepEqual(normalizedThinkingMap({ thinkingBudget: 1024 }), { thinkingBudget: 1024 });
    assert.deepEqual(normalizedThinkingMap({ thinking_budget: "2048" }), { thinkingBudget: 2048 });
    assert.deepEqual(normalizedThinkingMap({ thinkingLevel: "HIGH" }), { thinkingLevel: "high" });
    assert.deepEqual(normalizedThinkingMap({ includeThoughts: true }), { include_thoughts: true });
    assert.deepEqual(normalizedThinkingMap({ include_thoughts: false }), { include_thoughts: false });
  });

  it("returns null for empty or invalid input", () => {
    assert.equal(normalizedThinkingMap({}), null);
    assert.equal(normalizedThinkingMap([]), null);
    assert.equal(normalizedThinkingMap("x"), null);
    assert.equal(normalizedThinkingMap(null), null);
  });
});

describe("normalizeCachedContent", () => {
  it("strips cached content from extra_body and keeps other keys", () => {
    const payload: Json = { extra_body: { cached_content: "c1", other: 1 } };
    normalizeCachedContent(payload);
    assert.deepEqual(payload, { extra_body: { other: 1 } });
  });

  it("drops an emptied extra_body", () => {
    const payload: Json = { extra_body: { cachedContent: "c2" } };
    normalizeCachedContent(payload);
    assert.deepEqual(payload, {});
  });

  it("removes a top-level snake_case field", () => {
    const payload: Json = { cached_content: "c3" };
    normalizeCachedContent(payload);
    assert.deepEqual(payload, {});
  });
});

describe("stripTrailingModelTurns", () => {
  it("removes trailing model turns but keeps the last content", () => {
    const payload: Json = { contents: [{ role: "user" }, { role: "model" }, { role: "model" }] };
    stripTrailingModelTurns(payload);
    assert.deepEqual(payload.contents, [{ role: "user" }]);

    const single: Json = { contents: [{ role: "model" }] };
    stripTrailingModelTurns(single);
    assert.deepEqual(single.contents, [{ role: "model" }]);
  });

  it("leaves a trailing user turn alone", () => {
    const payload: Json = { contents: [{ role: "model" }, { role: "user" }] };
    stripTrailingModelTurns(payload);
    assert.deepEqual(payload.contents, [{ role: "model" }, { role: "user" }]);
  });
});

describe("sortFunctionDeclarations", () => {
  it("sorts declarations by name", () => {
    const payload: Json = { tools: [{ functionDeclarations: [{ name: "b" }, { name: "a" }, { name: "c" }] }] };
    sortFunctionDeclarations(payload);
    assert.deepEqual(
      ((payload.tools as Json[])[0]!.functionDeclarations as Json[]).map((decl) => decl.name),
      ["a", "b", "c"]
    );
  });

  it("skips single declarations", () => {
    const payload: Json = { tools: [{ functionDeclarations: [{ name: "a" }] }] };
    sortFunctionDeclarations(payload);
    assert.deepEqual((payload.tools as Json[])[0]!.functionDeclarations, [{ name: "a" }]);
  });
});

describe("ensureToolConfig", () => {
  it("creates a validated function calling config", () => {
    const payload: Json = {};
    ensureToolConfig(payload);
    assert.deepEqual(payload.toolConfig, { functionCallingConfig: { mode: "VALIDATED" } });
  });

  it("replaces non-object function calling configs", () => {
    const payload: Json = { toolConfig: { functionCallingConfig: "nope" } };
    ensureToolConfig(payload);
    assert.deepEqual((payload.toolConfig as Json).functionCallingConfig, { mode: "VALIDATED" });
  });

  it("normalizes claude tool declarations", () => {
    const payload: Json = {
      tools: [
        {
          functionDeclarations: [
            { name: "f", parametersJsonSchema: { type: "object", properties: { a: { type: "string" } } } },
            { name: "g", parameters: { type: "object", properties: { b: { type: "number" } } } },
          ],
        },
      ],
    };
    normalizeClaudeTools(payload);
    const declarations = ((payload.tools as Json[])[0]!.functionDeclarations as Json[]);
    assert.deepEqual(declarations[0]!.parameters, { type: "object", properties: { a: { type: "string" } }, required: [] });
    assert.deepEqual(declarations[1]!.parameters, { type: "object", properties: { b: { type: "number" } }, required: [] });
  });

  it("preserves existing config fields", () => {
    const payload: Json = { toolConfig: { functionCallingConfig: { allowedFunctionNames: ["a"] } } };
    ensureToolConfig(payload);
    assert.deepEqual(payload.toolConfig, {
      functionCallingConfig: { allowedFunctionNames: ["a"], mode: "VALIDATED" },
    });
  });
});

describe("scrubToolTranscriptArtifacts", () => {
  it("removes tool or thought transcript lines", () => {
    assert.equal(scrubToolTranscriptArtifacts("hello\nTool: foo\nworld"), "hello\nworld");
    assert.equal(scrubToolTranscriptArtifacts("thought: hidden\nkeep"), "keep");
    assert.equal(scrubToolTranscriptArtifacts("Think: hidden\nkeep"), "keep");
  });

  it("keeps fence content but strips marker lines", () => {
    assert.equal(
      scrubToolTranscriptArtifacts("```\nTool: foo\ncode\n```"),
      "```\ncode\n```"
    );
  });

  it("drops a fence that only contains markers", () => {
    assert.equal(scrubToolTranscriptArtifacts("```\nTool: foo\n```"), "");
  });

  it("collapses excessive blank lines", () => {
    assert.equal(scrubToolTranscriptArtifacts("a\n\n\n\nb"), "a\n\n\nb");
  });
});

describe("scrubConversationArtifacts", () => {
  it("scrubs text parts of a content block", () => {
    const content: Json = { parts: [{ text: "keep\nTool: drop" }, { text: "" }] };
    scrubConversationArtifacts(content);
    assert.deepEqual(content.parts, [{ text: "keep" }, { text: "" }]);
  });
});

describe("sanitizeToolBlocks", () => {
  it("keeps matched call and response pairs", () => {
    const contents = [
      {
        role: "model",
        parts: [
          { functionCall: { id: "1", name: "f" } },
          { functionResponse: { id: "1", name: "f" } },
          { text: "hi" },
        ],
      },
    ];
    const result = sanitizeToolBlocks(contents) as Json[];
    assert.deepEqual(result, contents);
  });

  it("drops unmatched calls and responses and empty contents", () => {
    const result = sanitizeToolBlocks([
      { role: "model", parts: [{ functionCall: { id: "1", name: "f" } }] },
      { role: "user", parts: [{ functionResponse: { id: "2", name: "f" } }] },
      { role: "user", parts: [{ text: "ok" }] },
    ]) as Json[];
    assert.deepEqual(result, [{ role: "user", parts: [{ text: "ok" }] }]);
  });
});
