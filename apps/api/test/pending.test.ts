import { describe, expect, it } from "bun:test";
import { Effect } from "effect";

import { pendingCount, settleTasks, trackPending, trackWork } from "../core/pending.js";

describe("pending task tracker", () => {
  it("tracks work until it settles", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = pendingCount();
    trackPending(gate);
    expect(pendingCount()).toBe(before + 1);
    release?.();
    expect(await settleTasks(1_000)).toBe(true);
    expect(pendingCount()).toBe(before);
  });

  it("drains a task that settles while another is added", async () => {
    let added = false;
    trackPending(
      (async () => {
        await Promise.resolve();
        if (added) return;
        added = true;
        trackPending(Effect.runPromise(Effect.sleep("1 millis")));
      })()
    );
    expect(await settleTasks(2_000)).toBe(true);
    expect(pendingCount()).toBe(0);
  });

  it("reports a timeout without throwing", async () => {
    let release: (() => void) | undefined;
    trackPending(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    expect(await settleTasks(10)).toBe(false);
    release?.();
    expect(await settleTasks(1_000)).toBe(true);
  });

  it("swallows failures so shutdown never rejects", async () => {
    trackWork(Effect.die(new Error("boom")));
    expect(await settleTasks(1_000)).toBe(true);
    expect(pendingCount()).toBe(0);
  });
});
