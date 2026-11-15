import { expect, test } from "bun:test";
import { Effect } from "effect";

import { deepaiSource } from "@opendum/models/refresh/providers/deepai";
import type { SourceContext, SourceFailure, SourceResult } from "@opendum/models/refresh/core/types";

const CONTEXT: SourceContext = {
  modelsDir: "packages/models/data",
  repoRoot: ".",
  flags: { dryRun: true, verbose: false, summaryPath: null },
};

const PAGE = `
  <ul>
    <li><span class="mn">GLM 5.3 Flash</span><code>deepai/glm-5.3-flash</code><span class="th">Thinking</span></li>
    <li><span class="mn">DeepSeek V4.1 Flash 1017</span><code>deepai/deepseek-v4.1-flash-1017</code><span class="th">Thinking</span></li>
    <li><span class="mn">DeepAI Cyber</span><code>deepai/deepai-cyber</code><span class="th">Thinking</span></li>
    <li><span class="mn">GLM 5.3</span><code>deepai/glm-5.3</code><span class="th">Thinking</span></li>
    <li><span class="mn">GPT-6 Astra</span><code>deepai/gpt-6-astra</code><span class="th">Thinking</span></li>
  </ul>
  <table>
    <tr><th scope="row"><span class="dc-mn">GLM 5.3 Flash</span> <span class="dc-mp">Z.ai</span></th><td><span class="dc-mv">0 Theos/request</span></td></tr>
    <tr><th scope="row"><span class="dc-mn">DeepSeek V4.1 Flash 1017</span> <span class="dc-mp">DeepSeek</span></th><td><span class="dc-mv">0 Theos/request</span></td></tr>
    <tr><th scope="row"><span class="dc-mn">DeepAI Cyber</span> <span class="dc-mp">DeepAI</span></th><td><span class="dc-mv">0 Theos/request</span></td></tr>
  </table>
  <table>
    <tr><th scope="row"><span class="dc-mn">GLM 5.3</span> <span class="dc-mp">Z.ai</span></th><td><span class="dc-mv">~3 Theos/request</span></td></tr>
    <tr><th scope="row"><span class="dc-mn">GPT-6 Astra</span> <span class="dc-mp">OpenAI</span></th><td><span class="dc-mv">~50 Theos/request</span></td></tr>
  </table>
`;

const STALE_PAGE = `${PAGE}
  <ul><li><span class="mn">GPT OSS</span><code>deepai/gpt-oss-120b</code><span class="th">Thinking</span></li></ul>
  <table>
    <tr><th scope="row"><span class="dc-mn">GPT OSS</span> <span class="dc-mp">Stealth</span></th><td><span class="dc-mv">~2 Theos/request</span></td></tr>
  </table>
`;

const pageResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html" } });

async function withFetch<T>(stub: (url: string, init?: RequestInit) => Response, run: () => Promise<T>): Promise<T> {
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
    provider: "deepai",
    message: cause instanceof Error ? cause.message : String(cause),
  }));

test("deepai source scrapes the public catalog page", async () => {
  let url = "";
  const result = await withFetch(
    (requested) => {
      url = requested;
      return pageResponse(PAGE);
    },
    () => Effect.runPromise(deepaiSource.fetch(CONTEXT))
  );

  expect(url).toBe("https://deepai.org/chat/ai-code");
  expect([...result.models.keys()]).toEqual([
    "deepai-cyber",
    "deepseek-v4.1-flash",
    "glm-5.3",
    "glm-5.3-flash",
    "gpt-6-astra",
  ]);
  expect(result.providerConfig?.get("glm-5.3-flash")).toEqual({ free: true });
  expect(result.providerConfig?.get("deepseek-v4.1-flash")).toEqual({ free: true });
  expect(result.providerConfig?.get("deepai-cyber")).toEqual({ free: true });
  expect(result.providerConfig?.get("glm-5.3")).toBeUndefined();
  expect(result.providerConfig?.get("gpt-6-astra")).toBeUndefined();
  expect(result.managedKeys).toEqual(["free"]);
});

test("deepai source fails on an empty catalog page", async () => {
  const failure = await withFetch(
    () => pageResponse("<p>nothing here</p>"),
    () => failureOf(deepaiSource.fetch(CONTEXT))
  );

  expect(failure?.provider).toBe("deepai");
  expect(failure?.message).toContain("unexpected DeepAI catalog page");
});

test("deepai source fails on a page whose tables disagree with the picker", async () => {
  const failure = await withFetch(
    () => pageResponse(STALE_PAGE),
    () => failureOf(deepaiSource.fetch(CONTEXT))
  );

  expect(failure?.provider).toBe("deepai");
  expect(failure?.message).toContain("unexpected DeepAI catalog page layout");
});
