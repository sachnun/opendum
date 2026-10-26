import { describe, expect, it } from "bun:test";

import { percentRemaining } from "~~/lib/quota-display";

describe("quota display helpers", () => {
  it("clamps the remaining percentage", () => {
    expect(percentRemaining({ remainingFraction: 0.5 } as unknown as Parameters<typeof percentRemaining>[0])).toBe(50);
    expect(percentRemaining({ remainingFraction: 2 } as unknown as Parameters<typeof percentRemaining>[0])).toBe(100);
    expect(percentRemaining({ remainingFraction: -1 } as unknown as Parameters<typeof percentRemaining>[0])).toBe(0);
  });
});
