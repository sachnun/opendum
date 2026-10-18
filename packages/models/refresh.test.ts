import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ScraperFailure, orderScripts, runSteps } from "./refresh.ts";

describe("refresh orchestration", () => {
  test("orders provider scrapers before the metadata tail", () => {
    const ordered = orderScripts(
      ["enrich.ts", "zenmux.ts", "aa.ts", "cline.ts", "antigravity.ts"],
      ["aa.ts", "enrich.ts"]
    );
    expect(ordered).toEqual(["antigravity.ts", "cline.ts", "zenmux.ts", "aa.ts", "enrich.ts"]);
  });

  test("runs every step and records failures without aborting", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      runSteps(
        [
          { script: "a.ts", path: "/a.ts" },
          { script: "b.ts", path: "/b.ts" },
          { script: "c.ts", path: "/c.ts" },
        ],
        async (step) => {
          calls.push(step.script);
          return step.script === "b.ts" ? 1 : 0;
        }
      )
    );

    expect(calls).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(result.ran).toEqual(["a.ts", "c.ts"]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]).toBeInstanceOf(ScraperFailure);
    expect(result.failed[0]?.script).toBe("b.ts");
    expect(result.failed[0]?.exitCode).toBe(1);
  });

  test("reports a spawn error as a typed scraper failure", async () => {
    const result = await Effect.runPromise(
      runSteps([{ script: "boom.ts", path: "/boom.ts" }], async () => {
        throw new Error("cannot spawn");
      })
    );
    expect(result.ran).toEqual([]);
    expect(result.failed[0]?.message).toBe("cannot spawn");
  });

  test("keeps going when every step fails", async () => {
    const result = await Effect.runPromise(
      runSteps(
        [
          { script: "a.ts", path: "/a.ts" },
          { script: "b.ts", path: "/b.ts" },
        ],
        async () => 2
      )
    );
    expect(result.ran).toEqual([]);
    expect(result.failed.map((failure) => failure.exitCode)).toEqual([2, 2]);
  });
});
