import { beforeEach, describe, expect, it } from "bun:test";

import {
  clearAuthTokens,
  getAccessToken,
  getActiveSessionToken,
  getImpersonationToken,
  getSessionToken,
  readAccessClaims,
  setAccessToken,
  setAuthTokens,
  setImpersonationToken,
} from "~~/lib/auth-token";

function createToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

const user = { sub: "user-1", name: "Ada", email: "ada@example.com", image: null };

describe("auth tokens", () => {
  beforeEach(() => {
    clearAuthTokens();
  });

  it("stores access and session tokens", () => {
    setAuthTokens({ access: "access-token", session: "session-token" });

    expect(getAccessToken()).toBe("access-token");
    expect(getSessionToken()).toBe("session-token");
  });

  it("replaces only the access token", () => {
    setAuthTokens({ access: "access-token", session: "session-token" });
    setAccessToken("next-access-token");

    expect(getAccessToken()).toBe("next-access-token");
    expect(getSessionToken()).toBe("session-token");
  });

  it("clears stored tokens", () => {
    setAuthTokens({ access: "access-token", session: "session-token" });
    setImpersonationToken("impersonation-token");
    clearAuthTokens();

    expect(getAccessToken()).toBeNull();
    expect(getSessionToken()).toBeNull();
    expect(getImpersonationToken()).toBeNull();
  });

  it("prefers the impersonation session token while auditing", () => {
    setAuthTokens({ access: "access-token", session: "session-token" });

    expect(getActiveSessionToken()).toBe("session-token");

    setImpersonationToken("impersonation-token");
    expect(getActiveSessionToken()).toBe("impersonation-token");

    setImpersonationToken(null);
    expect(getActiveSessionToken()).toBe("session-token");
  });

  it("drops the impersonation token on a fresh sign in", () => {
    setImpersonationToken("impersonation-token");
    setAuthTokens({ access: "access-token", session: "session-token" });

    expect(getImpersonationToken()).toBeNull();
  });

  it("reads claims from the access token", () => {
    const token = createToken(user);

    expect(readAccessClaims(token)).toEqual({
      user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null },
      impersonatedBy: null,
    });
  });

  it("reads the impersonation claim", () => {
    const token = createToken({ ...user, impersonatedBy: "maintainer-1" });

    expect(readAccessClaims(token)).toEqual({
      user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null },
      impersonatedBy: "maintainer-1",
    });
  });

  it("ignores tokens without a subject", () => {
    expect(readAccessClaims(createToken({ email: "ada@example.com" }))).toBeNull();
  });

  it("ignores malformed tokens", () => {
    expect(readAccessClaims("not-a-token")).toBeNull();
    expect(readAccessClaims("a.???c.signature")).toBeNull();
    expect(readAccessClaims(null)).toBeNull();
  });

  it("reads claims from storage by default", () => {
    setAuthTokens({ access: createToken(user), session: "session-token" });

    expect(readAccessClaims()?.user.id).toBe("user-1");
  });
});
