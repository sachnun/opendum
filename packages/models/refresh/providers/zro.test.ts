import { expect, test } from "bun:test";
import { Effect } from "effect";

import { zroSource } from "@opendum/models/refresh/providers/zro";
import type { SourceContext } from "@opendum/models/refresh/core/types";

const CONTEXT: SourceContext = {
  modelsDir: "packages/models/data",
  repoRoot: ".",
  flags: { dryRun: true, verbose: false, summaryPath: null },
};

const CATALOG = {
  version: 1,
  default: "deepseek-v4.1-flash",
  models: [
    {
      id: "deepseek-v4.1-flash",
      displayName: "DeepSeek V4.1 Flash",
      contextWindow: 1048576,
      maxOutputTokens: 64000,
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: { levels: [{ id: "none" }, { id: "high" }] },
    },
    {
      id: "glm-5.3-flash",
      displayName: "GLM-5.3 Flash",
      contextWindow: 1048576,
      maxOutputTokens: 64000,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: { levels: [{ id: "high" }] },
    },
    {
      id: "glm-5.3",
      displayName: "GLM-5.3",
      contextWindow: 1048576,
      maxOutputTokens: 131000,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: { levels: [{ id: "high" }] },
    },
    {
      id: "image-only",
      displayName: "Image Only",
      contextWindow: 1048576,
      maxOutputTokens: 64000,
      modalities: { input: ["text"], output: ["image"] },
      reasoning: { levels: [] },
    },
  ],
};

async function withFetch<T>(stub: (url: string) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => stub(url)) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("zro source maps the public catalog and marks free plan models", async () => {
  const result = await withFetch(
    () => new Response(JSON.stringify(CATALOG), { status: 200 }),
    () => Effect.runPromise(zroSource.fetch(CONTEXT))
  );

  expect([...result.models.keys()]).toEqual(["deepseek-v4.1-flash", "glm-5.3", "glm-5.3-flash"]);
  expect(result.models.get("deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash");
  expect(result.providerConfig?.get("deepseek-v4.1-flash")).toEqual({
    contextWindow: 1048576,
    maxOutputTokens: 64000,
    free: true,
  });
  expect(result.providerConfig?.get("glm-5.3-flash")?.free).toBe(true);
  expect(result.providerConfig?.get("glm-5.3")?.free).toBeUndefined();
  expect(result.managedKeys).toEqual(["contextWindow", "maxOutputTokens", "free"]);

  const capabilities = result.extra?.get("capabilities") as Map<string, { reasoning: boolean; modalities: unknown }>;
  expect(capabilities.get("deepseek-v4.1-flash")?.reasoning).toBe(true);
  expect(capabilities.get("deepseek-v4.1-flash")?.modalities).toEqual({
    input: ["image", "text"],
    output: ["text"],
  });
});

test("zro source fails on an unexpected payload", async () => {
  const failure = await withFetch(
    () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
    () =>
      Effect.runPromise(
        zroSource.fetch(CONTEXT).pipe(
          Effect.map(() => null),
          Effect.catch((cause) => Effect.succeed(cause))
        )
      )
  );

  expect(failure?.provider).toBe("zro");
  expect(failure?.message).toContain("unexpected Zro model catalog payload");
});
