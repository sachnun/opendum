import { beforeEach, describe, expect, it } from "bun:test";

import {
  clearTokens,
  accessToken,
  activeToken,
  impersonationToken,
  sessionToken,
  readClaims,
  setAccess,
  setTokens,
  setImpersonation,
} from "~~/lib/auth-token";

function createToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

const user = { sub: "user-1", name: "Ada", email: "ada@example.com", image: null };

describe("auth tokens", () => {
  beforeEach(() => {
    clearTokens();
  });

  it("stores access and session tokens", () => {
    setTokens({ access: "access-token", session: "session-token" });

    expect(accessToken()).toBe("access-token");
    expect(sessionToken()).toBe("session-token");
  });

  it("replaces only the access token", () => {
    setTokens({ access: "access-token", session: "session-token" });
    setAccess("next-access-token");

    expect(accessToken()).toBe("next-access-token");
    expect(sessionToken()).toBe("session-token");
  });

  it("clears stored tokens", () => {
    setTokens({ access: "access-token", session: "session-token" });
    setImpersonation("impersonation-token");
    clearTokens();

    expect(accessToken()).toBeNull();
    expect(sessionToken()).toBeNull();
    expect(impersonationToken()).toBeNull();
  });

  it("prefers the impersonation session token while auditing", () => {
    setTokens({ access: "access-token", session: "session-token" });

    expect(activeToken()).toBe("session-token");

    setImpersonation("impersonation-token");
    expect(activeToken()).toBe("impersonation-token");

    setImpersonation(null);
    expect(activeToken()).toBe("session-token");
  });

  it("drops the impersonation token on a fresh sign in", () => {
    setImpersonation("impersonation-token");
    setTokens({ access: "access-token", session: "session-token" });

    expect(impersonationToken()).toBeNull();
  });

  it("reads claims from the access token", () => {
    const token = createToken(user);

    expect(readClaims(token)).toEqual({
      user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null },
      impersonatedBy: null,
    });
  });

  it("reads the impersonation claim", () => {
    const token = createToken({ ...user, impersonatedBy: "maintainer-1" });

    expect(readClaims(token)).toEqual({
      user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null },
      impersonatedBy: "maintainer-1",
    });
  });

  it("ignores tokens without a subject", () => {
    expect(readClaims(createToken({ email: "ada@example.com" }))).toBeNull();
  });

  it("ignores malformed tokens", () => {
    expect(readClaims("not-a-token")).toBeNull();
    expect(readClaims("a.???c.signature")).toBeNull();
    expect(readClaims(null)).toBeNull();
  });

  it("reads claims from storage by default", () => {
    setTokens({ access: createToken(user), session: "session-token" });

    expect(readClaims()?.user.id).toBe("user-1");
  });
});
