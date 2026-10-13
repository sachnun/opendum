import { describe, expect, it } from "bun:test";

import { quotaPercentRemaining } from "./quota-display";

describe("quota display helpers", () => {
  it("clamps the remaining percentage", () => {
    expect(quotaPercentRemaining({ remainingFraction: 0.5 } as unknown as Parameters<typeof quotaPercentRemaining>[0])).toBe(50);
    expect(quotaPercentRemaining({ remainingFraction: 2 } as unknown as Parameters<typeof quotaPercentRemaining>[0])).toBe(100);
    expect(quotaPercentRemaining({ remainingFraction: -1 } as unknown as Parameters<typeof quotaPercentRemaining>[0])).toBe(0);
  });
});
