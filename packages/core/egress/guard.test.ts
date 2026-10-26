import { describe, expect, it } from "bun:test";
import { guardedFetch } from "./guard.js";

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} ${cause.message}` : error.message;
}

describe("guardedFetch", () => {
  it("rejects literal loopback addresses before connecting", async () => {
    const guard = guardedFetch({ connectTimeout: 1000 });
    try {
      let caught: unknown;
      try {
        await guard.fetch("http://127.0.0.1:8080/");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(/private/.test(messageOf(caught))).toBe(true);
    } finally {
      await guard.close();
    }
  });
});
