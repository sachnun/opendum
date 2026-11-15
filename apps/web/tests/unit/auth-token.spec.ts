import { beforeEach, describe, expect, test } from "bun:test";
import {
  accessToken,
  activeToken,
  clearTokens,
  impersonationToken,
  readClaims,
  sessionToken,
  setAccess,
  setImpersonation,
  setTokens,
} from "~/lib/auth-token";

function encodeSegment(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tokenWith(payload: Record<string, unknown>): string {
  return `header.${encodeSegment(payload)}.signature`;
}

describe("auth token storage", () => {
  beforeEach(() => {
    clearTokens();
  });

  test("stores and clears access and session tokens", () => {
    setTokens({ access: "access-1", session: "session-1" });

    expect(accessToken()).toBe("access-1");
    expect(sessionToken()).toBe("session-1");
    expect(activeToken()).toBe("session-1");

    clearTokens();
    expect(accessToken()).toBeNull();
    expect(sessionToken()).toBeNull();
  });

  test("prefers the impersonation token for active sessions", () => {
    setTokens({ access: "access-1", session: "session-1" });
    setImpersonation("impersonation-1");

    expect(impersonationToken()).toBe("impersonation-1");
    expect(activeToken()).toBe("impersonation-1");

    setImpersonation(null);
    expect(activeToken()).toBe("session-1");
  });

  test("setTokens clears any impersonation token", () => {
    setImpersonation("impersonation-1");
    setTokens({ access: "access-2", session: "session-2" });

    expect(impersonationToken()).toBeNull();
    expect(accessToken()).toBe("access-2");
  });

  test("setAccess only replaces the access token", () => {
    setTokens({ access: "access-1", session: "session-1" });
    setAccess("access-2");

    expect(accessToken()).toBe("access-2");
    expect(sessionToken()).toBe("session-1");
  });
});

describe("token claims", () => {
  test("decodes user claims from a JWT payload", () => {
    const token = tokenWith({ sub: "user-1", name: "Ada", email: "ada@example.com", image: "https://img" });

    expect(readClaims(token)).toEqual({
      user: { id: "user-1", name: "Ada", email: "ada@example.com", image: "https://img" },
      impersonatedBy: null,
    });
  });

  test("reads the impersonatedBy claim", () => {
    const token = tokenWith({ sub: "user-2", impersonatedBy: "admin-1" });

    expect(readClaims(token)?.impersonatedBy).toBe("admin-1");
  });

  test("returns null for missing or malformed tokens", () => {
    expect(readClaims(null)).toBeNull();
    expect(readClaims("")).toBeNull();
    expect(readClaims("no-payload")).toBeNull();
    expect(readClaims("header.not-base64-json.sig")).toBeNull();
    expect(readClaims(tokenWith({ name: "No id" }))).toBeNull();
  });
});
