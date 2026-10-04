import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { quotaPercentRemaining } from "./quota-display";

describe("quota display helpers", () => {
  it("clamps the remaining percentage", () => {
    assert.equal(quotaPercentRemaining({ remainingFraction: 0.5 } as unknown as Parameters<typeof quotaPercentRemaining>[0]), 50);
    assert.equal(quotaPercentRemaining({ remainingFraction: 2 } as unknown as Parameters<typeof quotaPercentRemaining>[0]), 100);
    assert.equal(quotaPercentRemaining({ remainingFraction: -1 } as unknown as Parameters<typeof quotaPercentRemaining>[0]), 0);
  });
});
