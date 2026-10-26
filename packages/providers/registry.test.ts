import { describe, expect, it } from "bun:test";
import { ProviderRegistry } from "@opendum/providers/registry";
import type { Registry } from "@opendum/models/runtime";

const EXPECTED = [
  "antigravity",
  "cline",
  "codex",
  "harbor",
  "hyper",
  "kilo_code",
  "kiro",
  "nvidia_nim",
  "opencode",
  "openrouter",
  "perch",
  "workers_ai",
  "workbuddy",
  "zenmux",
];

describe("provider registry", () => {
  it("registers every expected provider", () => {
    const registry = new ProviderRegistry({
      models: {} as Registry,
      fallback: null,
    });
    const names = registry.names();
    for (const name of EXPECTED) {
      expect(names.includes(name), `missing provider: ${name}`).toBeTruthy();
    }
    expect(names.length).toBe(EXPECTED.length);
  });

  it("reports credential refreshers", () => {
    const registry = new ProviderRegistry({ models: {} as Registry, fallback: null });
    const refreshable = registry.refreshableProviderNames();
    for (const name of ["antigravity", "cline", "codex", "kiro", "perch", "workbuddy"]) {
      expect(refreshable.includes(name), `missing refresher: ${name}`).toBeTruthy();
    }
    expect(!refreshable.includes("openrouter")).toBeTruthy();
    expect(!refreshable.includes("opencode")).toBeTruthy();
  });
});
