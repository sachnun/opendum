import { expect, test } from "bun:test";
import { Effect } from "effect";

import { harborSource } from "@opendum/models/refresh/providers/harbor";
import type { SourceContext, SourceFailure, SourceResult } from "@opendum/models/refresh/sources/types";

const CONTEXT: SourceContext = {
  modelsDir: "packages/models/data",
  repoRoot: ".",
  flags: { dryRun: true, verbose: false, summaryPath: null },
};

const PAGE = `
  <div data-config='{"models":[
    {"surface":"glm-5.3-flash","isFree":true,"inputModalities":["text","image"],"outputModalities":["text"]},
    {"surface":"glm-5.3","isFree":false,"inputModalities":["text"],"outputModalities":["text"]},
    {"surface":"cyber:free","isFree":false,"inputModalities":["text"],"outputModalities":["text"]},
    {"surface":"vision-only","isFree":true,"inputModalities":["image"],"outputModalities":["image"]}
  ]}'></div>
`;

async function withFetch<T>(
  stub: (url: string, init?: RequestInit) => Response,
  run: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => stub(url, init)) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const failureOf = (effect: Effect.Effect<SourceResult, unknown>): Promise<SourceFailure | null> =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => null),
      Effect.catch((cause) => Effect.succeed(cause as SourceFailure))
    )
  ).catch((cause: unknown) => ({
    provider: "harbor",
    message: cause instanceof Error ? cause.message : String(cause),
  }));

test("harbor source parses free text-capable models from the catalog page", async () => {
  const result = await withFetch(
    () => new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } }),
    () => Effect.runPromise(harborSource.fetch(CONTEXT))
  );

  expect([...result.models.keys()]).toEqual(["cyber", "glm-5.3-flash"]);
  expect(result.managedKeys).toBeUndefined();
});

test("harbor source fails on a page without the embedded catalog", async () => {
  const failure = await withFetch(
    () => new Response("<p>maintenance</p>", { status: 200 }),
    () => failureOf(harborSource.fetch(CONTEXT))
  );

  expect(failure?.provider).toBe("harbor");
  expect(failure?.message).toContain("unexpected Harbor /models page payload");
});
