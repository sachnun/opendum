import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { ModelParseFailure } from "./errors.ts";
import {
  ModelDataSchema,
  ProviderConfigSchema,
  decodeModel,
  decodeSync,
  validateModel,
  validateConfig,
  validateRegistry,
} from "./schema.ts";

describe("model data schema", () => {
  test("keeps unknown keys while validating known ones", () => {
    const decoded = decodeSync(
      JSON.stringify({
        id: "gpt-5",
        providers: ["openai"],
        providerConfig: { openai: { upstream: "gpt-5", responses_api: true } },
        customNote: { nested: [1, 2] },
      }),
      "gpt-5.json"
    );

    expect(decoded.id).toBe("gpt-5");
    expect(decoded.providers).toEqual(["openai"]);
    expect(decoded.providerConfig?.["openai"]?.["responses_api"]).toBe(true);
    expect(decoded["customNote"]).toEqual({ nested: [1, 2] });
  });

  test("accepts the null shapes the generated files use", () => {
    const decoded = decodeSync(
      JSON.stringify({ reasoning: null, modalities: null, limit: null, cost: null, scores: null }),
      "nulls.json"
    );
    expect(decoded.reasoning).toBe(null);
    expect(decoded.modalities).toBe(null);
  });

  test("rejects a known key with the wrong type", () => {
    expect(() => decodeSync('{"id":5}', "bad.json")).toThrow(ModelParseFailure);
    expect(() => decodeSync('{"providers":"openai"}', "bad.json")).toThrow(ModelParseFailure);
    expect(() =>
      decodeSync('{"providerConfig":{"openai":{"contextWindow":"big"}}}', "bad.json")
    ).toThrow(ModelParseFailure);
  });

  test("reports invalid JSON as a parse failure on the effect channel", async () => {
    const exit = await Effect.runPromise(Effect.exit(decodeModel("{ oops", "bad.json")));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const option = Exit.findErrorOption(exit);
      expect(option._tag).toBe("Some");
      if (option._tag === "Some") {
        expect(option.value).toBeInstanceOf(ModelParseFailure);
        expect(option.value.path).toBe("bad.json");
      }
    }
  });

  test("validates an already parsed value before writing", async () => {
    const ok = await Effect.runPromise(validateModel({ providers: ["openai"] }, "inline"));
    expect(ok.providers).toEqual(["openai"]);

    const bad = await Effect.runPromise(
      Effect.exit(validateModel({ providers: [1] } as never, "inline"))
    );
    expect(Exit.isFailure(bad)).toBe(true);
  });

  test("validates provider configs and full registries", async () => {
    expect(validateConfig({ upstream: "x" })?.["upstream"]).toBe("x");
    expect(validateConfig({ contextWindow: "wide" })).toBe(null);

    const registry = await Effect.runPromise(validateRegistry([{ id: "a" }, { id: "b" }]));
    expect(registry.map((entry) => entry.id)).toEqual(["a", "b"]);

    const invalid = await Effect.runPromise(Effect.exit(validateRegistry([{ id: 1 }])));
    expect(Exit.isFailure(invalid)).toBe(true);
  });

  test("exposes reusable schemas", () => {
    expect(ModelDataSchema).toBeTruthy();
    expect(ProviderConfigSchema).toBeTruthy();
  });
});
