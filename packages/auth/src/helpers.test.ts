import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import type { CustomProviderModelRecord } from "#auth/custom-store.ts";
import {
  accessRuleRestrictsTier,
  bearerToken,
  defaultString,
  disabled,
  invalid,
  isAuthlessProvider,
  isAuthlessProviderAccountId,
  normalizeAccessMode,
  normalizeAccountList,
  normalizeDisabledModelList,
  parseModelParam,
  tierSatisfiesRule,
  uniqueSorted,
  valid,
  visionForCustomModel,
} from "#auth/helpers.ts";

function fakeRegistry(options: {
  aliases?: Record<string, string>;
  supported?: string[];
  models?: Record<string, { modalities?: { input?: string[] } | null }>;
} = {}): Registry {
  const aliases = options.aliases ?? {};
  const supported = new Set(options.supported ?? []);
  const models = options.models ?? {};
  return {
    resolveAlias: (model: string) => aliases[model] ?? model,
    isSupported: (model: string) => supported.has(model),
    modelInfo: (model: string) => models[model] ?? null,
  } as unknown as Registry;
}

function customModel(overrides: Partial<CustomProviderModelRecord> = {}): CustomProviderModelRecord {
  return {
    id: "row-1",
    providerId: "provider-1",
    modelId: "custom-model",
    upstream: null,
    aliased: false,
    authless: false,
    minTier: null,
    allowedTiers: null,
    customFlags: null,
    ...overrides,
  };
}

describe("auth helpers", () => {
  it("detects authless providers", () => {
    assert.equal(isAuthlessProvider("opencode"), true);
    assert.equal(isAuthlessProvider("antigravity"), false);
    assert.equal(isAuthlessProviderAccountId("opencode"), true);
    assert.equal(isAuthlessProviderAccountId("authless:hyper"), true);
    assert.equal(isAuthlessProviderAccountId("acct-1"), false);
  });

  it("parses a model param without a provider", () => {
    assert.deepEqual(parseModelParam("gpt-4o"), [null, "gpt-4o"]);
  });

  it("parses and normalizes a provider-qualified model param", () => {
    assert.deepEqual(parseModelParam("OpenCode/Claude-Sonnet"), ["opencode", "Claude-Sonnet"]);
    assert.deepEqual(parseModelParam("  ANTIGRAVITY /gemini"), ["antigravity", "gemini"]);
  });

  it("keeps the remainder after the first slash", () => {
    assert.deepEqual(parseModelParam("provider/a/b"), ["provider", "a/b"]);
  });

  it("normalizes access modes", () => {
    assert.equal(normalizeAccessMode("whitelist"), "whitelist");
    assert.equal(normalizeAccessMode("blacklist"), "blacklist");
    assert.equal(normalizeAccessMode("all"), "all");
    assert.equal(normalizeAccessMode("nonsense"), "all");
  });

  it("trims, dedupes and sorts account lists", () => {
    assert.deepEqual(normalizeAccountList([" b ", "a", "", "a", "  "]), ["a", "b"]);
    assert.deepEqual(uniqueSorted(["z", "a", "z", ""]), ["a", "z"]);
  });

  it("resolves aliases and drops unsupported disabled models where possible", () => {
    const registry = fakeRegistry({
      aliases: { "sonnet-latest": "claude-sonnet" },
      supported: ["claude-sonnet", "gpt-4o", "ghost"],
    });
    assert.deepEqual(
      normalizeDisabledModelList(registry, ["sonnet-latest", "gpt-4o", "ghost", "unknown", " gpt-4o "]),
      ["claude-sonnet", "ghost", "gpt-4o", "unknown"]
    );
  });

  it("extracts bearer tokens case-insensitively", () => {
    assert.equal(bearerToken("Bearer abc.def"), "abc.def");
    assert.equal(bearerToken("  bearer   spaced  "), "spaced");
    assert.equal(bearerToken("Token abc"), "Token abc");
    assert.equal(bearerToken(""), "");
  });

  it("falls back to a default string", () => {
    assert.equal(defaultString("", "fallback"), "fallback");
    assert.equal(defaultString("value", "fallback"), "value");
  });
});

describe("tier rules", () => {
  it("honours allowed tiers before min tier", () => {
    assert.equal(tierSatisfiesRule("pro", "free", ["pro", "pro+"]), true);
    assert.equal(tierSatisfiesRule("free", "free", ["pro"]), false);
  });

  it("normalizes tier aliases", () => {
    assert.equal(tierSatisfiesRule("pro_plus", undefined, undefined), true);
    assert.equal(tierSatisfiesRule("PROPLUS", "pro+", undefined), true);
    assert.equal(tierSatisfiesRule("education", undefined, ["student"]), true);
    assert.equal(tierSatisfiesRule("free-tier", "free", undefined), true);
  });

  it("treats an empty or free minimum as unrestricted", () => {
    assert.equal(tierSatisfiesRule("anything", undefined, undefined), true);
    assert.equal(tierSatisfiesRule("anything", "  ", undefined), true);
    assert.equal(tierSatisfiesRule("anything", "free", undefined), true);
    assert.equal(tierSatisfiesRule("pro", "pro", undefined), true);
    assert.equal(tierSatisfiesRule("free", "pro", undefined), false);
  });

  it("detects when a rule restricts tiers", () => {
    assert.equal(accessRuleRestrictsTier(undefined, undefined), false);
    assert.equal(accessRuleRestrictsTier("free", undefined), false);
    assert.equal(accessRuleRestrictsTier("pro", undefined), true);
    assert.equal(accessRuleRestrictsTier(undefined, ["free"]), true);
  });
});

describe("custom model vision", () => {
  it("returns true when no modality info is known", () => {
    assert.equal(visionForCustomModel(fakeRegistry(), customModel()), true);
  });

  it("reads vision from the upstream id first", () => {
    const registry = fakeRegistry({
      models: {
        "upstream-id": { modalities: { input: ["text", "image"] } },
        "custom-model": { modalities: { input: ["text"] } },
      },
    });
    assert.equal(visionForCustomModel(registry, customModel({ upstream: "upstream-id" })), true);
  });

  it("falls back to the model id and reports text-only models", () => {
    const registry = fakeRegistry({
      models: { "custom-model": { modalities: { input: ["text"] } } },
    });
    assert.equal(visionForCustomModel(registry, customModel()), false);
  });
});

describe("validation results", () => {
  it("builds a valid result", () => {
    assert.deepEqual(valid("opencode", "gpt-4o"), {
      valid: true,
      provider: "opencode",
      model: "gpt-4o",
      alias: "",
      vision: null,
      error: "",
      param: "",
      code: "",
    });
  });

  it("builds an invalid result", () => {
    assert.deepEqual(invalid(null, "gpt-4o", "bad", "model", "bad_model"), {
      valid: false,
      provider: null,
      model: "gpt-4o",
      alias: "",
      vision: null,
      error: "bad",
      param: "model",
      code: "bad_model",
    });
  });

  it("builds a disabled result with a message", () => {
    const result = disabled("opencode", "gpt-4o");
    assert.equal(result.valid, false);
    assert.equal(result.code, "model_disabled");
    assert.equal(result.param, "model");
    assert.match(result.error, /gpt-4o/);
  });
});
