import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderModelConfig, Registry } from "@opendum/models/runtime";
import {
  providerConfig,
  providerConfigBool,
  providerConfigString,
  providerMaxOutputTokens,
} from "#providers/model/model-config.ts";

function registry(configs: Record<string, unknown>): Registry {
  return {
    providerModelConfig: (model: string, provider: string) => (configs[`${provider}:${model}`] ?? null) as ProviderModelConfig | null,
  } as unknown as Registry;
}

describe("model config helpers", () => {
  it("reads top-level flags and strings", () => {
    const reg = registry({ "kiro:claude": { flag: true, name: "  hi  " } });
    assert.equal(providerConfigBool(reg, "claude", "kiro", "flag"), true);
    assert.equal(providerConfigBool(reg, "claude", "kiro", "missing"), false);
    assert.equal(providerConfigString(reg, "claude", "kiro", "name"), "hi");
    assert.equal(providerConfigString(reg, "claude", "kiro", "flag"), "");
  });

  it("reads nested custom values", () => {
    const reg = registry({ "kiro:claude": { custom: { flag: true, name: "x" } } });
    assert.equal(providerConfigBool(reg, "claude", "kiro", "flag"), true);
    assert.equal(providerConfigString(reg, "claude", "kiro", "name"), "x");
  });

  it("handles missing configs", () => {
    const reg = registry({});
    assert.equal(providerConfigBool(reg, "claude", "kiro", "flag"), false);
    assert.equal(providerConfigString(reg, "claude", "kiro", "name"), "");
    assert.equal(providerConfig(reg, "claude", "kiro"), null);
    assert.equal(providerMaxOutputTokens(reg, "claude", "kiro"), 0);
  });

  it("returns configs and output limits", () => {
    const reg = registry({ "kiro:claude": { maxOutputTokens: 4096 } });
    assert.deepEqual(providerConfig(reg, "claude", "kiro"), { maxOutputTokens: 4096 });
    assert.equal(providerMaxOutputTokens(reg, "claude", "kiro"), 4096);
  });
});
