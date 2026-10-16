import { describe, expect, it } from "bun:test";
import { workbuddyRestrictionDisabledUntil } from "../core/errors.js";

const NOW = new Date("2026-10-16T00:00:00.000Z");
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

describe("workbuddyRestrictionDisabledUntil", () => {
  it("returns a cooldown for risk restricted account codes", () => {
    const until = workbuddyRestrictionDisabledUntil(
      "workbuddy",
      JSON.stringify({ code: 11140, msg: "request illegal" }),
      NOW
    );
    expect(until?.getTime()).toBe(NOW.getTime() + THIRTY_MINUTES_MS);
  });

  it("accepts every code the desktop client treats as an account state failure", () => {
    for (const code of [11140, 11141, 11142, 17271, 17272, 17273, 17274, 17275, 17276]) {
      const until = workbuddyRestrictionDisabledUntil("workbuddy", JSON.stringify({ code }), NOW);
      expect(until).not.toBeNull();
    }
  });

  it("ignores other providers and ordinary error codes", () => {
    expect(workbuddyRestrictionDisabledUntil("codex", JSON.stringify({ code: 11140 }), NOW)).toBeNull();
    expect(workbuddyRestrictionDisabledUntil("workbuddy", JSON.stringify({ code: 400 }), NOW)).toBeNull();
    expect(workbuddyRestrictionDisabledUntil("workbuddy", JSON.stringify({ error: "boom" }), NOW)).toBeNull();
  });

  it("ignores bodies that are not a JSON object", () => {
    expect(workbuddyRestrictionDisabledUntil("workbuddy", "request illegal", NOW)).toBeNull();
    expect(workbuddyRestrictionDisabledUntil("workbuddy", "", NOW)).toBeNull();
    expect(workbuddyRestrictionDisabledUntil("workbuddy", "[11140]", NOW)).toBeNull();
  });
});
