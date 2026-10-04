import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGuardedFetch } from "./guard.js";

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} ${cause.message}` : error.message;
}

describe("createGuardedFetch", () => {
  it("rejects literal loopback addresses before connecting", async () => {
    const guard = createGuardedFetch({ connectTimeout: 1000 });
    try {
      await assert.rejects(guard.fetch("http://127.0.0.1:8080/"), (error: unknown) => {
        return /private/.test(messageOf(error));
      });
    } finally {
      await guard.close();
    }
  });
});
