import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpendumRedis } from "@opendum/redis";
import {
  applyAntigravitySystemInstruction,
  normalizeAntigravityContents,
  transformAntigravityPayload,
} from "#providers/providers/antigravity/contents-normalize.ts";
import type { AntigravityRuntime } from "#providers/providers/antigravity/runtime.ts";

type Json = Record<string, unknown>;

function runtime(configs: Record<string, Json> = {}, redis: OpendumRedis | null = null): AntigravityRuntime {
  return {
    name: "antigravity",
    registry: {
      providerModelConfig: (model: string) => configs[model] ?? null,
      upstreamModelName: (model: string) => model,
    },
    redis,
    transport: { direct: async () => new Response("{}"), egress: null, egressReady: () => false },
  } as unknown as AntigravityRuntime;
}

function redisWith(getValue: string | null): OpendumRedis {
  return {
    get: async () => getValue,
    set: async () => undefined,
  } as unknown as OpendumRedis;
}

describe("applyAntigravitySystemInstruction", () => {
  it("injects the antigravity prompt for claude models", () => {
    const payload: Json = { systemInstruction: "existing" };
    applyAntigravitySystemInstruction(runtime(), payload, "claude-sonnet");
    const instruction = payload.systemInstruction as Json;
    assert.equal(instruction.role, "user");
    assert.equal((instruction.parts as unknown[]).length, 2);
  });

  it("keeps authored system instructions from the registry", () => {
    const payload: Json = {};
    applyAntigravitySystemInstruction(runtime({ m: { note: 1 } }), payload, "m");
    assert.equal("systemInstruction" in payload, false);
  });

  it("extends object instructions", () => {
    const payload: Json = { systemInstruction: { parts: [{ text: "keep" }] } };
    applyAntigravitySystemInstruction(runtime(), payload, "claude-sonnet");
    const parts = (payload.systemInstruction as Json).parts as Json[];
    assert.equal(parts.length, 2);
    assert.equal(parts[1]!.text, "keep");
  });
});

describe("normalizeAntigravityContents", () => {
  it("reuses cached thought signatures in non-strict mode", async () => {
    const payload: Json = { contents: [{ role: "user", parts: [{ thought: true, text: "t" }] }] };
    await normalizeAntigravityContents(runtime({}, redisWith(JSON.stringify({ signature: "sig" }))), payload, "gemini-2-flash", "s1");
    const part = ((payload.contents as Json[])[0]!.parts as Json[])[0]!;
    assert.equal(part.thoughtSignature, "sig");
  });

  it("drops thoughts without cached signatures", async () => {
    const payload: Json = { contents: [{ role: "user", parts: [{ thought: true, text: "t" }] }] };
    await normalizeAntigravityContents(runtime(), payload, "gemini-2-flash", "s1");
    assert.deepEqual(payload.contents, []);
  });

  it("injects placeholder signatures for function calls", async () => {
    const payload: Json = { contents: [{ role: "model", parts: [{ functionCall: { name: "f", args: {} } }] }] };
    await normalizeAntigravityContents(runtime(), payload, "gemini-2-flash", "s1");
    const part = ((payload.contents as Json[])[0]!.parts as Json[])[0]!;
    assert.equal(part.thoughtSignature, "skip_thought_signature_validator");
    assert.equal(typeof (part.functionCall as Json).id, "string");
  });

  it("pairs strict function calls and responses", async () => {
    const payload: Json = {
      contents: [
        { role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "f", response: { result: "ok" } } }] },
      ],
    };
    await normalizeAntigravityContents(runtime(), payload, "claude-sonnet", "s1");
    const contents = payload.contents as Json[];
    const callId = ((contents[0]!.parts as Json[])[0]!.functionCall as Json).id;
    const responseId = ((contents[1]!.parts as Json[])[0]!.functionResponse as Json).id;
    assert.equal(callId, responseId);
  });

  it("scrubs model artifacts and drops empty parts", async () => {
    const payload: Json = {
      contents: [{ role: "model", parts: [{ text: "" }, { text: "hi" }] }],
    };
    await normalizeAntigravityContents(runtime(), payload, "claude-sonnet", "s1");
    const parts = ((payload.contents as Json[])[0]!.parts as Json[]);
    assert.deepEqual(parts, [{ text: "hi" }]);
  });
});

describe("transformAntigravityPayload", () => {
  it("normalizes payload keys and thinking config", async () => {
    const payload: Json = {
      model: "claude-sonnet",
      safetySettings: [],
      system_instruction: "sys",
      extra_body: { cached_content: "c2", other: 1 },
      generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 5000 } },
      contents: [],
    };
    await transformAntigravityPayload(runtime(), payload, "claude-sonnet", "s1");
    assert.equal("safetySettings" in payload, false);
    assert.equal("model" in payload, false);
    assert.equal("system_instruction" in payload, false);
    assert.equal("cachedContent" in payload, false);
    assert.deepEqual(payload.extra_body, { other: 1 });
    assert.equal(payload.sessionId, "s1");
    const instruction = payload.systemInstruction as Json;
    assert.equal((instruction.parts as unknown[]).length, 2);
  });
});
