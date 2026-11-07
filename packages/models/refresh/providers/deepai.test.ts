import { expect, test } from "bun:test";
import { Effect } from "effect";

import { deepaiSource } from "@opendum/models/refresh/providers/deepai";
import type { SourceContext } from "@opendum/models/refresh/core/types";

const CONTEXT: SourceContext = {
  modelsDir: "packages/models/data",
  repoRoot: ".",
  flags: { dryRun: true, verbose: false, summaryPath: null },
};

const CATALOG = {
  models: [
    {
      id: "glm-5.3-flash",
      name: "GLM 5.3 Flash",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 131072,
      premier: false,
      theosPerRequest: "0",
    },
    {
      id: "glm-5.3",
      name: "GLM 5.3",
      reasoning: true,
      input: ["text"],
      contextWindow: 1048576,
      maxTokens: 131072,
      premier: true,
      theosPerRequest: "3",
    },
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 128000,
      api: "openai-responses",
      premier: true,
      theosPerRequest: "50",
    },
    {
      id: "gpt-oss-120b",
      name: "GPT OSS",
      reasoning: true,
      input: ["text"],
      contextWindow: 131072,
      maxTokens: 32768,
      premier: false,
      theosPerRequest: "0",
    },
  ],
};

async function withFetch<T>(stub: (url: string, init?: RequestInit) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => stub(url, init)) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("deepai source maps the lane catalog and marks free models", async () => {
  let lane = "";
  const result = await withFetch(
    (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      lane = headers["X-DeepAI-Code-Theos"] ?? "";
      return new Response(JSON.stringify(CATALOG), { status: 200 });
    },
    () => Effect.runPromise(deepaiSource.fetch(CONTEXT))
  );

  expect(lane).toBe("4");
  expect([...result.models.keys()]).toEqual(["glm-5.3", "glm-5.3-flash", "gpt-6-astra"]);
  expect(result.providerConfig?.get("glm-5.3-flash")).toEqual({
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    free: true,
  });
  expect(result.providerConfig?.get("glm-5.3")?.free).toBeUndefined();
  expect(result.providerConfig?.get("gpt-6-astra")?.responses_api).toBe(true);
  expect(result.managedKeys).toEqual(["contextWindow", "maxOutputTokens", "responses_api", "free"]);

  const capabilities = result.extra?.get("capabilities") as Map<string, { reasoning: boolean; modalities: unknown }>;
  expect(capabilities.get("glm-5.3-flash")?.reasoning).toBe(true);
  expect(capabilities.get("glm-5.3-flash")?.modalities).toEqual({
    input: ["image", "text"],
    output: ["text"],
  });
});

test("deepai source fails on an unexpected payload", async () => {
  const failure = await withFetch(
    () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    () =>
      Effect.runPromise(
        deepaiSource.fetch(CONTEXT).pipe(
          Effect.map(() => null),
          Effect.catch((cause) => Effect.succeed(cause))
        )
      )
  );

  expect(failure?.provider).toBe("deepai");
  expect(failure?.message).toContain("unexpected DeepAI model catalog payload");
});
