import { describe, expect, it } from "bun:test";
import { toExpJWT } from "better-auth/plugins";

process.env.BETTER_AUTH_SECRET ??= "test-secret";

const { ACCESS_TOKEN_TTL, authRoleForEmail } = await import("../web/auth.js");
const { claimsFromPayload, toAuthUser } = await import("../web/lib/claims.js");
const { handoffUrl, resolveWebOrigin, sanitizeRedirectPath, signInRedirectUrl } = await import("../web/lib/handoff.js");

describe("access token claims", () => {
  it("maps a jwt payload to user claims", () => {
    const claims = claimsFromPayload({
      sub: "user-1",
      name: "Ada",
      email: "ada@example.com",
      image: "https://example.com/ada.png",
      impersonatedBy: "maintainer-1",
    });

    expect(claims).toEqual({
      user: { id: "user-1", name: "Ada", email: "ada@example.com", image: "https://example.com/ada.png" },
      impersonatedBy: "maintainer-1",
    });
  });

  it("omits the impersonation claim when the session is not impersonated", () => {
    const claims = claimsFromPayload({ sub: "user-1", name: "Ada", email: null, image: null });

    expect(claims).toEqual({ user: { id: "user-1", name: "Ada", email: null, image: null }, impersonatedBy: null });
  });

  it("rejects payloads without a subject", () => {
    expect(claimsFromPayload({ email: "ada@example.com" })).toBeNull();
    expect(claimsFromPayload(null)).toBeNull();
    expect(claimsFromPayload("not-a-payload")).toBeNull();
  });

  it("keeps access tokens valid for one week", () => {
    expect(ACCESS_TOKEN_TTL).toBe("7d");
    expect(toExpJWT(ACCESS_TOKEN_TTL, 0)).toBe(7 * 24 * 60 * 60);
  });
});

describe("auth roles", () => {
  it("maps maintainer emails to the admin role", () => {
    const previous = process.env.MAINTAINERS;
    process.env.MAINTAINERS = JSON.stringify(["Ada@Example.com"]);

    try {
      expect(authRoleForEmail("ada@example.com")).toBe("admin");
      expect(authRoleForEmail("grace@example.com")).toBe("user");
      expect(authRoleForEmail(null)).toBe("user");
    } finally {
      process.env.MAINTAINERS = previous;
    }
  });
});

describe("auth users", () => {
  it("normalizes optional profile fields", () => {
    expect(toAuthUser({ id: "user-1" })).toEqual({ id: "user-1", name: null, email: null, image: null });
  });
});

describe("sign in handoff", () => {
  it("keeps relative redirects only", () => {
    expect(sanitizeRedirectPath("/keys?tab=models")).toBe("/keys?tab=models");
    expect(sanitizeRedirectPath("//evil.example.com")).toBeNull();
    expect(sanitizeRedirectPath("https://evil.example.com")).toBeNull();
    expect(sanitizeRedirectPath(undefined)).toBeNull();
  });

  it("accepts any absolute web origin", () => {
    expect(resolveWebOrigin("https://app.example.com/")).toBe("https://app.example.com");
    expect(resolveWebOrigin("http://localhost:3000/auth/callback?tab=models")).toBe("http://localhost:3000");
    expect(resolveWebOrigin("https://app.example.com:8443/keys")).toBe("https://app.example.com:8443");
    expect(resolveWebOrigin("javascript:alert(1)")).toBeNull();
    expect(resolveWebOrigin("not-a-url")).toBeNull();
    expect(resolveWebOrigin(undefined)).toBeNull();
  });

  it("builds the oauth callback url", () => {
    const url = new URL(handoffUrl("https://api.example.com", { to: "https://app.example.com", redirect: "/keys" }));

    expect(url.origin).toBe("https://api.example.com");
    expect(url.pathname).toBe("/api/auth/handoff");
    expect(url.searchParams.get("to")).toBe("https://app.example.com");
    expect(url.searchParams.get("redirect")).toBe("/keys");
  });

  it("hands tokens to the app in the url fragment", () => {
    const url = signInRedirectUrl("https://app.example.com", { token: "access", session: "session", redirect: "/keys" });

    expect(url.startsWith("https://app.example.com/auth/callback#")).toBe(true);

    const fragment = new URLSearchParams(url.split("#")[1]);
    expect(fragment.get("token")).toBe("access");
    expect(fragment.get("session")).toBe("session");
    expect(fragment.get("redirect")).toBe("/keys");
  });

  it("sends errors back to the login screen", () => {
    expect(signInRedirectUrl("https://app.example.com", { error: "AccessDenied" })).toBe("https://app.example.com/?error=AccessDenied");
  });
});
