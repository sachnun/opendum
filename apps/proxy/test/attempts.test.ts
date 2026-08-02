import { describe, expect, it } from "vitest";
import { executeAccountRotation, sessionID } from "../src/core/attempts.js";
import type { RotationRunner } from "../src/core/attempts.js";
import type { EndpointAdapter, ParsedEndpointRequest, RouteError } from "../src/core/types.js";
import type { ProviderAccount } from "../src/db/index.js";
import type { UpstreamResponse } from "../src/providers/types.js";
import { streamFromString } from "../src/providers/http.js";
import { failedCooldownUntil } from "../src/core/load-balancer.js";
import { roamingPointCost } from "../src/core/points.js";
import type { PointReservation } from "../src/core/points.js";

const antigravityResourceExhaustedBody = `{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}`;

function account(id: string, provider: string, userId = ""): ProviderAccount {
  return {
    id, userId, provider, name: id, accessToken: "", refreshToken: "", expiresAt: new Date(),
    apiKey: null, projectId: null, tier: null, accountId: null, email: null, isActive: true,
    disabledUntil: null, lastUsedAt: null, status: "active",
  } as ProviderAccount;
}

class TestRotationRunner implements RotationRunner {
  accounts: ProviderAccount[];
  sharedAccounts: ProviderAccount[];
  requested: string[] = [];
  responseBody = "";
  statusByProvider: Record<string, number> = {};
  usageLimitedAccountID = "";
  usageLimitedModel = "";
  usageLimitedUntil: Date | null = null;
  failedAccountIDs: string[] = [];
  reserved: Array<{ userId: string; debitID: string }> = [];
  refunded: string[] = [];
  insufficientPoints = false;

  constructor(options: { accounts?: ProviderAccount[]; sharedAccounts?: ProviderAccount[]; responseBody?: string; statusByProvider?: Record<string, number>; insufficientPoints?: boolean } = {}) {
    this.accounts = options.accounts ?? [];
    this.sharedAccounts = options.sharedAccounts ?? [];
    if (options.responseBody !== undefined) this.responseBody = options.responseBody;
    if (options.statusByProvider !== undefined) this.statusByProvider = options.statusByProvider;
    if (options.insufficientPoints !== undefined) this.insufficientPoints = options.insufficientPoints;
  }

  async getNextAvailableAccount(_userId: string, _model: string, _provider: string | null, exclude: string[], excludeProviders: string[], _accountAccess: { mode: string; accounts: string[] }, _sessionId: string): Promise<[ProviderAccount | null, boolean, Error | null]> {
    const excluded = new Set(exclude);
    const excludedProviderSet = new Set(excludeProviders);
    for (const account of this.accounts) {
      if (excluded.has(account.id)) continue;
      if (excludedProviderSet.has(account.provider)) continue;
      return [account, true, null];
    }
    return [null, false, null];
  }

  async getNextSharedAccount(_userId: string, _model: string, _provider: string | null, exclude: string[], excludeProviders: string[]): Promise<[ProviderAccount | null, boolean, Error | null]> {
    const excluded = new Set(exclude);
    const excludedProviderSet = new Set(excludeProviders);
    for (const account of this.sharedAccounts) {
      if (excluded.has(account.id)) continue;
      if (excludedProviderSet.has(account.provider)) continue;
      return [account, true, null];
    }
    return [null, this.sharedAccounts.length > 0, null];
  }

  async reserveRoamingPoint(userId: string): Promise<[PointReservation | null, boolean, Error | null]> {
    if (this.insufficientPoints) return [null, false, null];
    const reservation: PointReservation = { userId, amount: roamingPointCost, debitID: `debit_${this.reserved.length + 1}` };
    this.reserved.push(reservation);
    return [reservation, true, null];
  }

  async refundRoamingPoint(reservation: PointReservation | null): Promise<void> {
    if (!reservation) return;
    this.refunded.push(reservation.debitID);
  }

  async bumpAccountRequestCount(): Promise<void> {}

  async makeProviderRequest(acc: ProviderAccount, _payload: Record<string, unknown>, _stream: boolean, _ctx: Record<string, unknown>): Promise<UpstreamResponse> {
    this.requested.push(acc.id);
    const status = this.statusByProvider[acc.provider];
    if (status !== undefined) {
      return { status, headers: {}, body: this.responseBody ? streamFromString(this.responseBody) : null };
    }
    if (acc.provider === "provider_2") {
      return { status: 200, headers: {}, body: null };
    }
    return { status: 429, headers: {}, body: this.responseBody ? streamFromString(this.responseBody) : null };
  }

  async markAccountFailed(accountID: string, _model: string, _status: number, _message: string): Promise<Date> {
    this.failedAccountIDs.push(accountID);
    return new Date();
  }

  async markAccountUsageLimited(accountID: string, model: string, disabledUntil: Date, _failedAt: Date): Promise<void> {
    this.usageLimitedAccountID = accountID;
    this.usageLimitedModel = model;
    this.usageLimitedUntil = disabledUntil;
  }

  async logUsage(): Promise<void> {}

  isVisionModel(): boolean {
    return false;
  }

  isToolCallModel(): boolean {
    return true;
  }
}

function cfg(): EndpointAdapter {
  return {
    endpoint: "/v1/chat/completions",
    format: "openai",
    rateLimitStatusCode: 429,
    noAccountsStatusCode: 429,
    parse: () => [{ modelParam: "", stream: false, forcedAccountID: null, reasoningRequested: false, messagesForError: undefined, paramsForError: {}, routeData: {} }, null],
    build: (parsed: ParsedEndpointRequest, model: string, stream: boolean) => ({ model, stream }),
    handleStream: async () => {},
    handleNonStream: async () => {},
  };
}

function rotate(runner: TestRotationRunner, options: { roaming?: boolean; provider?: string | null; model?: string; forced?: ProviderAccount | null } = {}) {
  return executeAccountRotation(
    runner,
    cfg(),
    { modelParam: "", stream: false, forcedAccountID: null, reasoningRequested: false, messagesForError: undefined, paramsForError: {}, routeData: {} },
    { valid: true, userId: "user_1", apiKeyId: "", modelAccessMode: "all", modelAccessList: [], accountAccessMode: "all", accountAccessList: [], roamingEnabled: options.roaming ?? false, rateLimitRules: [], error: "" },
    { valid: true, provider: options.provider ?? null, model: options.model ?? "unit-model", error: "", param: "", code: "" },
    options.forced ?? null,
    Date.now(),
    "",
  );
}

describe("attempts (ported from attempts_test.go)", () => {
  it("continues past five failures to a working account", async () => {
    const runner = new TestRotationRunner({
      accounts: [
        account("p1-a1", "provider_1"), account("p1-a2", "provider_1"), account("p1-a3", "provider_1"),
        account("p1-a4", "provider_1"), account("p1-a5", "provider_1"), account("p2-a1", "provider_2"),
      ],
    });
    const result = await rotate(runner);
    expect(result.error).toBeNull();
    expect(result.account?.id).toBe("p2-a1");
    expect(result.response?.status).toBe(200);
    expect(result.rotationFailures).toHaveLength(5);
    expect(runner.requested).toHaveLength(6);
  });

  it("sessionID header precedence", () => {
    const request = new Request("http://localhost/v1/chat/completions", { headers: { "session_id": "primary", "x-session-id": "fallback" } });
    expect(sessionID(request)).toBe("primary");
  });

  it("sessionID falls back to x-session-id", () => {
    const request = new Request("http://localhost/v1/chat/completions", { headers: { "x-session-id": "fallback" } });
    expect(sessionID(request)).toBe("fallback");
  });

  it("failedCooldownUntil uses 10 minute cooldown", () => {
    const failedAt = new Date("2026-05-11T12:00:00Z");
    expect(failedCooldownUntil(failedAt).getTime()).toBe(failedAt.getTime() + 10 * 60 * 1000);
  });

  it("marks codex usage limit disabledUntil", async () => {
    const now = new Date();
    const resetAt = Math.floor(now.getTime() / 1000) + 2 * 3600;
    const runner = new TestRotationRunner({
      accounts: [account("codex-account", "codex")],
      responseBody: `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"free","resets_at":${resetAt},"resets_in_seconds":7200}}`,
    });
    const result = await rotate(runner, { provider: "codex", model: "gpt-5.5" });
    expect(result.error?.status).toBe(429);
    expect(runner.usageLimitedAccountID).toBe("codex-account");
    expect(runner.usageLimitedModel).toBe("gpt-5.5");
    expect(runner.usageLimitedUntil ? Math.floor(runner.usageLimitedUntil.getTime() / 1000) : null).toBe(resetAt);
  });

  it("delays antigravity resource exhausted failure on recovery", async () => {
    const runner = new TestRotationRunner({
      accounts: [account("ag-a1", "antigravity"), account("p2-a1", "provider_2")],
      responseBody: antigravityResourceExhaustedBody,
    });
    const result = await rotate(runner, { provider: "antigravity", model: "gemini-3-flash-preview" });
    expect(result.error).toBeNull();
    expect(result.account?.id).toBe("p2-a1");
    expect(result.response?.status).toBe(200);
    expect(runner.failedAccountIDs).toHaveLength(0);
  });

  it("records last antigravity resource exhausted failure", async () => {
    const runner = new TestRotationRunner({
      accounts: [account("ag-a1", "antigravity"), account("ag-a2", "antigravity")],
      responseBody: antigravityResourceExhaustedBody,
    });
    const result = await rotate(runner, { provider: "antigravity", model: "gemini-3-flash-preview" });
    expect(result.error?.status).toBe(429);
    expect(runner.failedAccountIDs).toEqual(["ag-a2"]);
  });

  it("uses shared account after own accounts fail", async () => {
    const runner = new TestRotationRunner({
      accounts: [account("own-a1", "provider_1", "user_1")],
      sharedAccounts: [account("shared-a1", "provider_2", "user_2")],
    });
    const result = await rotate(runner, { roaming: true });
    expect(result.error).toBeNull();
    expect(result.account?.id).toBe("shared-a1");
    expect(result.response?.status).toBe(200);
    expect(result.roaming?.debitID).toBe("debit_1");
    expect(runner.requested.join(",")).toBe("own-a1,shared-a1");
    expect(runner.reserved).toHaveLength(1);
    expect(runner.reserved[0]!.userId).toBe("user_1");
    expect(runner.refunded).toHaveLength(0);
  });

  it("falls back across providers on bad request", async () => {
    const runner = new TestRotationRunner({
      accounts: [account("p1-a1", "provider_1"), account("p1-a2", "provider_1"), account("p2-a1", "provider_2")],
      statusByProvider: { provider_1: 400 },
    });
    const result = await rotate(runner);
    expect(result.error).toBeNull();
    expect(result.account?.id).toBe("p2-a1");
    expect(result.response?.status).toBe(200);
    expect(runner.requested.join(",")).toBe("p1-a1,p2-a1");
    expect(runner.failedAccountIDs).toHaveLength(0);
    expect(result.rotationFailures).toHaveLength(0);
  });

  it("returns bad request after provider fallbacks exhausted", async () => {
    const runner = new TestRotationRunner({
      accounts: [account("p1-a1", "provider_1"), account("p1-a2", "provider_1"), account("p2-a1", "provider_2")],
      statusByProvider: { provider_1: 400, provider_2: 400 },
    });
    const result = await rotate(runner);
    expect(result.error?.status).toBe(400);
    expect(runner.requested.join(",")).toBe("p1-a1,p2-a1");
    expect(runner.failedAccountIDs).toHaveLength(0);
    expect(result.rotationFailures).toHaveLength(0);
  });

  it("does not fall back on bad request with forced provider", async () => {
    const runner = new TestRotationRunner({
      accounts: [account("p1-a1", "provider_1"), account("p2-a1", "provider_2")],
      statusByProvider: { provider_1: 400 },
    });
    const result = await rotate(runner, { provider: "provider_1" });
    expect(result.error?.status).toBe(400);
    expect(runner.requested.join(",")).toBe("p1-a1");
    expect(runner.failedAccountIDs).toHaveLength(0);
  });

  it("records last attempted account on error", async () => {
    const runner = new TestRotationRunner({
      accounts: [account("p1-a1", "provider_1"), account("p1-a2", "provider_1"), account("p2-a1", "provider_2")],
      statusByProvider: { provider_1: 429, provider_2: 429 },
    });
    const result = await rotate(runner);
    expect(result.error?.status).toBe(429);
    expect(result.error?.accountID).toBe("p2-a1");
  });

  it("omits account id when no account attempted", async () => {
    const runner = new TestRotationRunner({ accounts: [] });
    const result = await rotate(runner);
    expect(result.error).not.toBeNull();
    expect(result.error?.accountID).toBe("");
  });

  it("refunds failed shared attempt", async () => {
    const runner = new TestRotationRunner({
      accounts: [account("own-a1", "provider_1", "user_1")],
      sharedAccounts: [account("shared-a1", "provider_1", "user_2")],
    });
    const result = await rotate(runner, { roaming: true });
    expect(result.error?.status).toBe(429);
    expect(result.roaming).toBeNull();
    expect(runner.reserved).toHaveLength(1);
    expect(runner.reserved[0]!.debitID).toBe("debit_1");
    expect(runner.refunded).toEqual(["debit_1"]);
  });

  it("stops shared attempt without points", async () => {
    const runner = new TestRotationRunner({
      accounts: [account("own-a1", "provider_1", "user_1")],
      sharedAccounts: [account("shared-a1", "provider_2", "user_2")],
      insufficientPoints: true,
    });
    const result = await rotate(runner, { roaming: true });
    expect(result.error?.status).toBe(402);
    expect(result.error?.code).toBe("insufficient_points");
    expect(runner.requested.join(",")).toBe("own-a1");
    expect(runner.reserved).toHaveLength(0);
    expect(runner.refunded).toHaveLength(0);
  });
});
