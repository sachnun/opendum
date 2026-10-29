import { describe, expect, test } from "bun:test";
import { report, slashedKey, standardKey, withoutFreeSuffix } from "@opendum/models/refresh/sources/keys";

describe("model key helpers", () => {
  test("strips provider prefixes, params and the free suffix", () => {
    expect(slashedKey("vendor/model-name:free")).toBe("model-name");
    expect(standardKey("vendor/model-name")).toBe("vendor-model-name");
    expect(slashedKey("vendor/model-2025-01-01")).toBe("model-2025-01-01");
  });

  test("keeps the free suffix removal idempotent", () => {
    expect(withoutFreeSuffix("model-free")).toBe("model");
    expect(withoutFreeSuffix("model")).toBe("model");
    expect(withoutFreeSuffix("model-free-free")).toBe("model-free");
  });
});

describe("sync report", () => {
  test("summarizes an unchanged provider", () => {
    expect(report("Demo", { added: [], removed: [], updated: [] }, 3)).toBe(
      "[Demo] models are already up to date (3 models)."
    );
  });

  test("lists changed keys", () => {
    const output = report("Demo", { added: ["a"], removed: ["b"], updated: ["c"] }, 3);
    expect(output).toContain("[Demo] synced 3 models (added 1, removed 1, updated 1).");
    expect(output).toContain("Added: a");
    expect(output).toContain("Removed: b");
    expect(output).toContain("Updated: c");
  });
});
