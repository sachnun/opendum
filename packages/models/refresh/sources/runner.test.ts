import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import { raise } from "@opendum/models/refresh/sources/raise";
import { runSources } from "@opendum/models/refresh/sources/runner";
import { sourceOf, type ModelSource, type SourceContext, type SourceResult } from "@opendum/models/refresh/sources/types";

const ctx = (modelsDir = "/tmp/opendum-models-test"): SourceContext => ({
  modelsDir,
  repoRoot: "/tmp",
  flags: { dryRun: true, verbose: false, summaryPath: null },
});

const source = (
  provider: string,
  overrides: Partial<ModelSource> = {}
): ModelSource => ({
  provider,
  label: provider,
  order: 1,
  phase: "fetch",
  fetch: () => Effect.succeed(sourceOf(new Map([["model-a", "upstream-a"]])) as SourceResult),
  ...overrides,
});

describe("model source runner", () => {
  test("runs sources in order and reports failures without aborting", async () => {
    const ran = await Effect.runPromise(Ref.make<string[]>([]));
    const ordered = ["first", "second", "third"].map((provider, index) =>
      source(provider, {
        order: index,
        fetch: () =>
          Effect.sync(() => {
            Effect.runSync(Ref.update(ran, (current) => [...current, provider]));
          }).pipe(
            Effect.andThen(
              provider === "second"
                ? Effect.fail({ provider, message: "boom" })
                : Effect.succeed(sourceOf(new Map()))
            )
          ),
      })
    );

    const report = await Effect.runPromise(runSources(ordered, ctx()));

    expect(Effect.runSync(Ref.get(ran))).toEqual(["first", "second", "third"]);
    expect(report.failures.length).toBe(1);
    expect(report.failures[0]?.message).toBe("boom");
  });

  test("sorts fetch phase before tail phase", async () => {
    const seen: string[] = [];
    const track = (provider: string, phase: "fetch" | "tail", order: number): ModelSource =>
      source(provider, {
        phase,
        order,
        fetch: () =>
          Effect.sync(() => {
            seen.push(provider);
            return sourceOf(new Map());
          }),
      });

    await Effect.runPromise(
      runSources([track("tail-a", "tail", 0), track("fetch-b", "fetch", 2), track("fetch-a", "fetch", 1)], ctx())
    );

    expect(seen).toEqual(["fetch-a", "fetch-b", "tail-a"]);
  });

  test("reports a defect as a failure without aborting the remaining sources", async () => {
    const seen: string[] = [];
    const defective = source("broken", {
      order: 1,
      fetch: () =>
        Effect.sync(() => {
          seen.push("broken");
          raise(new Error("upstream exploded"));
          return sourceOf(new Map());
        }),
    });
    const healthy = source("healthy", {
      order: 2,
      fetch: () =>
        Effect.sync(() => {
          seen.push("healthy");
          return sourceOf(new Map());
        }),
    });

    const report = await Effect.runPromise(runSources([defective, healthy], ctx()));

    expect(seen).toEqual(["broken", "healthy"]);
    expect(report.failures).toEqual([{ provider: "broken", message: "upstream exploded" }]);
  });

  test("reports providers whose models vanished", async () => {
    const result = await Effect.runPromise(runSources([], ctx("/nonexistent-dir")));
    expect(result.failures).toEqual([]);
    expect(result.outcomes).toEqual([]);
  });
});
