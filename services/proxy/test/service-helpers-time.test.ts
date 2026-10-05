import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ProviderAccount } from "@opendum/providers";
import {
  extractSessionId,
  firstUserText,
  normalizeAccountTierAlias,
  nullableTimeBefore,
  proxyAccessRuleRestrictsTier,
  proxyTierSatisfiesRule,
  quotaFallbackTierLocal,
  sessionTextContent,
  withTimeout,
} from "../src/core/transport/service-helpers.ts";


function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "acct-1",
    userId: "user-1",
    provider: "antigravity",
    ...overrides,
  };
}

describe("time helpers", () => {
  it("compares nullable times", () => {
    assert.equal(nullableTimeBefore(null, null), false);
    assert.equal(nullableTimeBefore(null, new Date()), true);
    assert.equal(nullableTimeBefore(new Date(), null), false);
    assert.equal(nullableTimeBefore(new Date(0), new Date(1)), true);
    assert.equal(nullableTimeBefore(new Date(1), new Date(0)), false);
  });

  it("resolves withTimeout results and rejects on timeout", async () => {
    assert.equal(await withTimeout(Promise.resolve("ok"), 1000), "ok");
    await assert.rejects(withTimeout(new Promise(() => undefined), 5), /timed out/);
    await assert.rejects(withTimeout(Promise.reject(new Error("upstream failed")), 1000), /upstream failed/);
  });
});

describe("tier rule helpers", () => {
  it("normalizes tier aliases", () => {
    assert.equal(normalizeAccountTierAlias("pro_plus"), "pro+");
    assert.equal(normalizeAccountTierAlias("ProPlus"), "pro+");
    assert.equal(normalizeAccountTierAlias("free-tier"), "free");
    assert.equal(normalizeAccountTierAlias("Education"), "student");
    assert.equal(normalizeAccountTierAlias("  PRO  "), "pro");
  });

  it("evaluates tier rules", () => {
    assert.equal(proxyTierSatisfiesRule("pro_plus", "pro+", undefined), true);
    assert.equal(proxyTierSatisfiesRule("free", "free", undefined), true);
    assert.equal(proxyTierSatisfiesRule("free", "pro", undefined), false);
    assert.equal(proxyTierSatisfiesRule("student", undefined, ["education"]), true);
    assert.equal(proxyTierSatisfiesRule("free", undefined, ["pro"]), false);
  });

  it("detects restricting rules", () => {
    assert.equal(proxyAccessRuleRestrictsTier(undefined, undefined), false);
    assert.equal(proxyAccessRuleRestrictsTier("free", undefined), false);
    assert.equal(proxyAccessRuleRestrictsTier("pro", undefined), true);
    assert.equal(proxyAccessRuleRestrictsTier(undefined, ["free"]), true);
  });

  it("falls back to free when a tier is blank", () => {
    assert.equal(quotaFallbackTierLocal(account({ tier: "  " })), "free");
    assert.equal(quotaFallbackTierLocal(account({ tier: " Pro " })), "Pro");
    assert.equal(quotaFallbackTierLocal(account({ tier: null })), "free");
  });
});

describe("session extraction", () => {
  it("prefers session headers", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-claude-code-session-id": " header-session " },
    });
    assert.equal(extractSessionId(request, {}), "header-session");
  });

  it("reads well-known body keys", () => {
    assert.equal(extractSessionId(new Request("http://localhost/"), { prompt_cache_key: " body-1 " }), "body-1");
    assert.equal(extractSessionId(new Request("http://localhost/"), { sessionId: "body-2" }), "body-2");
  });

  it("derives claude session ids from metadata", () => {
    const body = { metadata: { user_id: "user_abc_session_deadbeef" } };
    assert.equal(extractSessionId(new Request("http://localhost/"), body), "claude:deadbeef");
    assert.equal(
      extractSessionId(new Request("http://localhost/"), { metadata: { user_id: "plain-user" } }),
      "plain-user"
    );
  });

  it("hashes long first user text", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(40) }] };
    const session = extractSessionId(new Request("http://localhost/"), body);
    assert.match(session, /^prompt:[0-9a-f]{16}$/);
  });

  it("returns empty when nothing matches", () => {
    assert.equal(extractSessionId(new Request("http://localhost/"), {}), "");
    assert.equal(extractSessionId(new Request("http://localhost/"), { messages: [{ role: "user", content: "short" }] }), "");
  });
});

describe("message text extraction", () => {
  it("flattens text content parts", () => {
    assert.equal(sessionTextContent("hello"), "hello");
    assert.equal(sessionTextContent([{ text: "a" }, { text: " b " }, { notText: 1 }]), "a\nb");
    assert.equal(sessionTextContent(42), "");
  });

  it("returns the first user text from chat messages", () => {
    assert.equal(
      firstUserText({ messages: [{ role: "assistant", content: "no" }, { role: "user", content: "yes" }] }),
      "yes"
    );
  });

  it("returns the first user text from responses input", () => {
    assert.equal(firstUserText({ input: [{ role: "user", content: [{ text: "input text" }] }] }), "input text");
  });

  it("returns empty when there is no user text", () => {
    assert.equal(firstUserText({}), "");
    assert.equal(firstUserText({ messages: [{ role: "user", content: [] }] }), "");
  });
});
