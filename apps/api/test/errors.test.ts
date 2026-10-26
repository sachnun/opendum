import { describe, expect, it } from "bun:test";
import {
  isTransientUpstreamStatus,
  isWorkbuddyRequestFault,
  workbuddyRestrictionDisabledUntil,
  workbuddyUsageLimitResetAt,
} from "../core/errors.js";

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

describe("isTransientUpstreamStatus", () => {
  it("treats server faults and timeouts as transient", () => {
    for (const status of [408, 500, 502, 503, 504]) expect(isTransientUpstreamStatus(status)).toBe(true);
  });

  it("leaves account and request level statuses alone", () => {
    for (const status of [400, 401, 402, 403, 404, 429]) expect(isTransientUpstreamStatus(status)).toBe(false);
  });
});

describe("isWorkbuddyRequestFault", () => {
  it("matches the illegal request code", () => {
    expect(isWorkbuddyRequestFault("workbuddy", JSON.stringify({ code: 11128, msg: "request illegal" }))).toBe(true);
  });

  it("does not match usage limits, restrictions or other providers", () => {
    expect(isWorkbuddyRequestFault("workbuddy", JSON.stringify({ code: 6004 }))).toBe(false);
    expect(isWorkbuddyRequestFault("workbuddy", JSON.stringify({ code: 11140 }))).toBe(false);
    expect(isWorkbuddyRequestFault("codex", JSON.stringify({ code: 11128 }))).toBe(false);
    expect(isWorkbuddyRequestFault("workbuddy", "request illegal")).toBe(false);
  });
});

describe("workbuddyUsageLimitResetAt", () => {
  const body = (msg: string) => JSON.stringify({ code: 6004, msg, requestId: "01a16c516848752f86ea4543b9d3b046" });

  it("parses the reset timestamp with its UTC offset", () => {
    const until = workbuddyUsageLimitResetAt(
      "workbuddy",
      body("usage exceeds frequency limit, but don't worry, your usage will reset at 2026-10-24 13:34:16 UTC+8, alternatively, you can switch to the other models to continue using it."),
      NOW
    );
    expect(until?.toISOString()).toBe("2026-10-24T05:34:16.000Z");
  });

  it("falls back to a short cooldown when the reset is missing or already past", () => {
    const missing = workbuddyUsageLimitResetAt("workbuddy", body("usage exceeds frequency limit"), NOW);
    expect(missing?.getTime()).toBe(NOW.getTime() + 5 * 60 * 1000);
    const past = workbuddyUsageLimitResetAt(
      "workbuddy",
      body("usage exceeds frequency limit, reset at 2026-10-15 13:34:16 UTC+8"),
      NOW
    );
    expect(past?.getTime()).toBe(NOW.getTime() + 5 * 60 * 1000);
  });

  it("ignores other codes and providers", () => {
    expect(workbuddyUsageLimitResetAt("workbuddy", JSON.stringify({ code: 11148 }), NOW)).toBeNull();
    expect(workbuddyUsageLimitResetAt("codex", body("reset at 2026-10-24 13:34:16 UTC+8"), NOW)).toBeNull();
  });
});
