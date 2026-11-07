import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { writeText } from "@opendum/models/fs";
import { join } from "@opendum/models/paths";
import { makeDir, removeDir } from "@opendum/models/test-support";
import { opencodeSource } from "@opendum/models/refresh/providers/opencode";
import type { SourceContext, SourceResult } from "@opendum/models/refresh/core/types";

const DOCS = [
  "| Model | Model ID | Endpoint |",
  "| --- | --- | --- |",
  "| Big Pickle | big-pickle | `https://opencode.ai/inference/openai/v1/chat/completions` |",
  "| Crouton Alpha Free | crouton-alpha-free | `https://opencode.ai/inference/openai/v1/responses` |",
  "",
  "| Model | Input | Output | Cached Read |",
  "| --- | --- | --- | --- |",
  "| Big Pickle | Free | Free | Free |",
  "| Crouton Alpha Free | Free | Free | Free |",
].join("\n");

const MODELS = JSON.stringify({ data: [{ id: "big-pickle" }, { id: "crouton-alpha-free" }] });

type Stub = (url: string, init?: RequestInit) => Promise<Response>;

const context = (modelsDir: string): SourceContext => ({
  modelsDir,
  repoRoot: "/tmp",
  flags: { dryRun: true, verbose: false, summaryPath: null },
});

const withFetch = <A>(stub: Stub, run: () => Promise<A>): Promise<A> => {
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  return Effect.runPromise(
    Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
      Effect.ensuring(Effect.sync(() => {
        globalThis.fetch = original;
      }))
    )
  );
};

const run = (modelsDir: string): Promise<SourceResult> =>
  Effect.runPromise(opencodeSource.fetch(context(modelsDir)));

const docsResponder =
  (failPrimary: boolean): Stub =>
  async (url) => {
    if (url.includes("/zen/v1/models")) return new Response(MODELS, { status: 200 });
    if (failPrimary && url.startsWith("https://opencode.ai/docs/")) {
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }
    return new Response(DOCS, { status: 200 });
  };

const inWorkspace = <A>(body: (modelsDir: string) => Promise<A>): Promise<A> => {
  const root = makeDir("opencode-refresh-");
  return Effect.runPromise(
    Effect.tryPromise({ try: () => body(join(root, "data")), catch: (cause) => cause }).pipe(
      Effect.ensuring(Effect.sync(() => removeDir(root)))
    )
  );
};

describe("opencode model source", () => {
  test("falls back to the docs mirror when the primary page is missing", async () => {
    const result = await withFetch(docsResponder(true), () => run("/tmp/opencode-missing"));
    expect([...result.models.entries()]).toEqual([
      ["big-pickle", "big-pickle"],
      ["crouton-alpha", "crouton-alpha-free"],
    ]);
    expect(result.providerConfig?.get("crouton-alpha")).toEqual({ responses_api: true });
  });

  test("keeps the registered models when every docs source is unavailable", async () => {
    const result = await inWorkspace(async (modelsDir) => {
      await writeText(
        join(modelsDir, "crouton-alpha.json"),
        `${JSON.stringify({ providers: ["opencode"], providerConfig: { opencode: { upstream: "crouton-alpha-free" } } })}\n`
      );
      return withFetch(
        async () => new Response("not found", { status: 404, statusText: "Not Found" }),
        () => run(modelsDir)
      );
    });

    expect([...result.models.entries()]).toEqual([["crouton-alpha", "crouton-alpha-free"]]);
  });

  test("returns an empty pool when the docs are unavailable and nothing is registered", async () => {
    const result = await inWorkspace((modelsDir) =>
      withFetch(
        async () => new Response("not found", { status: 404, statusText: "Not Found" }),
        () => run(modelsDir)
      )
    );

    expect(result.models.size).toBe(0);
  });
});
