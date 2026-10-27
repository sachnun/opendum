import { describe, expect, it } from "bun:test";
import { toExpJWT } from "better-auth/plugins";
import { Effect } from "effect";

process.env.BETTER_AUTH_SECRET ??= "test-secret";

const { ACCESS_TOKEN_TTL, roleOf } = await import("@opendum/api/web/auth");
const { claimsOf, authUser } = await import("@opendum/api/web/lib/claims");
const { handoffUrl, webOrigin, safePath, loginUrl } = await import("@opendum/api/web/lib/handoff");

describe("access token claims", () => {
  it("maps a jwt payload to user claims", () => {
    const claims = claimsOf({
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
    const claims = claimsOf({ sub: "user-1", name: "Ada", email: null, image: null });

    expect(claims).toEqual({ user: { id: "user-1", name: "Ada", email: null, image: null }, impersonatedBy: null });
  });

  it("rejects payloads without a subject", () => {
    expect(claimsOf({ email: "ada@example.com" })).toBeNull();
    expect(claimsOf(null)).toBeNull();
    expect(claimsOf("not-a-payload")).toBeNull();
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

    Effect.runSync(
      Effect.ensuring(
        Effect.sync(() => {
          expect(roleOf("ada@example.com")).toBe("admin");
          expect(roleOf("grace@example.com")).toBe("user");
          expect(roleOf(null)).toBe("user");
        }),
        Effect.sync(() => {
          process.env.MAINTAINERS = previous;
        })
      )
    );
  });
});

describe("auth users", () => {
  it("normalizes optional profile fields", () => {
    expect(authUser({ id: "user-1" })).toEqual({ id: "user-1", name: null, email: null, image: null });
  });
});

describe("sign in handoff", () => {
  it("keeps relative redirects only", () => {
    expect(safePath("/keys?tab=models")).toBe("/keys?tab=models");
    expect(safePath("//evil.example.com")).toBeNull();
    expect(safePath("https://evil.example.com")).toBeNull();
    expect(safePath(undefined)).toBeNull();
  });

  it("accepts any absolute web origin", () => {
    expect(webOrigin("https://app.example.com/")).toBe("https://app.example.com");
    expect(webOrigin("http://localhost:3000/auth/callback?tab=models")).toBe("http://localhost:3000");
    expect(webOrigin("https://app.example.com:8443/keys")).toBe("https://app.example.com:8443");
    expect(webOrigin("javascript:alert(1)")).toBeNull();
    expect(webOrigin("not-a-url")).toBeNull();
    expect(webOrigin(undefined)).toBeNull();
  });

  it("builds the oauth callback url", () => {
    const url = new URL(handoffUrl("https://api.example.com", { to: "https://app.example.com", redirect: "/keys" }));

    expect(url.origin).toBe("https://api.example.com");
    expect(url.pathname).toBe("/api/auth/handoff");
    expect(url.searchParams.get("to")).toBe("https://app.example.com");
    expect(url.searchParams.get("redirect")).toBe("/keys");
  });

  it("hands tokens to the app in the url fragment", () => {
    const url = loginUrl("https://app.example.com", { token: "access", session: "session", redirect: "/keys" });

    expect(url.startsWith("https://app.example.com/auth/callback#")).toBe(true);

    const fragment = new URLSearchParams(url.split("#")[1]);
    expect(fragment.get("token")).toBe("access");
    expect(fragment.get("session")).toBe("session");
    expect(fragment.get("redirect")).toBe("/keys");
  });

  it("sends errors back to the login screen", () => {
    expect(loginUrl("https://app.example.com", { error: "AccessDenied" })).toBe("https://app.example.com/?error=AccessDenied");
  });
});
