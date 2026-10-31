import { describe, expect, it } from "bun:test";
import { Effect } from "effect";

import { pendingCount, settleTasks, trackPending, trackWork } from "@opendum/api/proxy/pending";

describe("pending task tracker", () => {
  it("tracks work until it settles", async () => {
    const gate = Effect.runPromise(Effect.sleep("50 millis"));
    const before = pendingCount();
    trackPending(gate);
    expect(pendingCount()).toBe(before + 1);
    expect(await settleTasks(1_000)).toBe(true);
    expect(pendingCount()).toBe(before);
  });

  it("drains a task that settles while another is added", async () => {
    let added = false;
    trackPending(
      Effect.runPromise(
        Effect.sync(() => {
          if (added) return;
          added = true;
          trackPending(Effect.runPromise(Effect.sleep("1 millis")));
        })
      )
    );
    expect(await settleTasks(2_000)).toBe(true);
    expect(pendingCount()).toBe(0);
  });

  it("reports a timeout without throwing", async () => {
    trackPending(Effect.runPromise(Effect.sleep("50 millis")));
    expect(await settleTasks(10)).toBe(false);
    expect(await settleTasks(1_000)).toBe(true);
  });

  it("swallows failures so shutdown never rejects", async () => {
    trackWork(Effect.die(new Error("boom")));
    expect(await settleTasks(1_000)).toBe(true);
    expect(pendingCount()).toBe(0);
  });
});
