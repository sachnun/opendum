import { Effect } from "effect";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { raise } from "~~/lib/settle";
import { ref } from "vue";

import {
  clearTokens,
  accessToken,
  impersonationToken,
  sessionToken,
  setTokens,
  setImpersonation,
} from "~~/lib/auth-token";
import { stateKeys } from "~/utils/dataKeys";

const fetchMock = mock((..._args: unknown[]) => Effect.runPromise(Effect.succeed<unknown>({})));

(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ public: { apiUrl: "https://api.example.com" } });
(globalThis as Record<string, unknown>).useState = <T>(_key: string, init?: () => T) => ref<T | undefined>(init ? init() : undefined);
(globalThis as Record<string, unknown>).stateKeys = stateKeys;
(globalThis as Record<string, unknown>).clearNuxtData = mock(() => {});
(globalThis as Record<string, unknown>).$fetch = fetchMock;

type FetchCall = [string, { method?: string; headers: Record<string, string>; body?: unknown }];

const { useAuth } = await import("~/composables/useAuth");

function createToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(payload)}.signature`;
}

function callAt(index: number): FetchCall {
  return fetchMock.mock.calls[index] as FetchCall;
}

describe("useAuth", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    clearTokens();
    fetchMock.mockImplementation((..._args: unknown[]) => Effect.runPromise(Effect.succeed<unknown>({})));
  });

  it("keeps the handoff tokens", () => {
    const auth = useAuth();
    const token = createToken({ sub: "user-1", name: "Ada", email: "ada@example.com", image: null });

    auth.applyHandoff({ access: token, session: "session-token" });

    expect(accessToken()).toBe(token);
    expect(sessionToken()).toBe("session-token");
    expect(auth.isAuthenticated.value).toBe(true);
    expect(auth.user.value).toEqual({ id: "user-1", name: "Ada", email: "ada@example.com", image: null });
  });

  it("does not treat a stored session without claims as signed in", () => {
    setTokens({ access: "not-a-jwt", session: "session-token" });
    const auth = useAuth();

    expect(auth.isAuthenticated.value).toBe(true);
    expect(auth.user.value).toBeNull();
  });

  it("requests a fresh access token with the session token", async () => {
    const auth = useAuth();
    const next = createToken({ sub: "user-1", name: "Ada B", email: "ada@example.com", image: null, impersonatedBy: null });
    setTokens({ access: createToken({ sub: "user-1", name: "Ada" }), session: "session-token" });
    fetchMock.mockImplementation(async () => ({ token: next }));

    expect(await auth.refreshAccessToken()).toBe(true);

    const [url, options] = callAt(0);
    expect(url).toBe("https://api.example.com/api/auth/token");
    expect(options.method).toBeUndefined();
    expect(options.headers.authorization).toBe("Bearer session-token");
    expect(options.body).toBeUndefined();
    expect(accessToken()).toBe(next);
    expect(auth.claims.value?.user.name).toBe("Ada B");
  });

  it("falls back to the base session when the impersonation session is gone", async () => {
    const auth = useAuth();
    const base = createToken({ sub: "maintainer-1", name: "Grace", email: "grace@example.com", image: null });
    setTokens({ access: createToken({ sub: "user-2" }), session: "session-token" });
    setImpersonation("impersonation-token");
    fetchMock.mockImplementationOnce(async () => raise(Object.assign(new Error("401"), { status: 401 })));
    fetchMock.mockImplementationOnce(async () => ({ token: base }));

    expect(await auth.refreshAccessToken()).toBe(true);

    expect(callAt(0)[1].headers.authorization).toBe("Bearer impersonation-token");
    expect(callAt(1)[1].headers.authorization).toBe("Bearer session-token");
    expect(impersonationToken()).toBeNull();
    expect(accessToken()).toBe(base);
    expect(auth.claims.value?.user.id).toBe("maintainer-1");
  });

  it("fails the refresh without a session token", async () => {
    const auth = useAuth();
    setTokens({ access: createToken({ sub: "user-1" }), session: "" });

    expect(await auth.refreshAccessToken()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails the refresh when the response has no token", async () => {
    const auth = useAuth();
    setTokens({ access: createToken({ sub: "user-1" }), session: "session-token" });
    fetchMock.mockImplementation(async () => ({}));

    expect(await auth.refreshAccessToken()).toBe(false);
  });

  it("starts an audit with a framework impersonation session", async () => {
    const auth = useAuth();
    const target = { id: "user-2", name: "Grace", email: "grace@example.com", image: null };
    const auditToken = createToken({ sub: "user-2", name: "Grace", email: "grace@example.com", image: null, impersonatedBy: "user-1" });
    setTokens({ access: createToken({ sub: "user-1" }), session: "session-token" });
    fetchMock.mockImplementationOnce(async () => ({ session: { token: "impersonation-token" }, user: target }));
    fetchMock.mockImplementationOnce(async () => ({ token: auditToken }));

    expect(await auth.startAudit("user-2")).toEqual(target);

    const [url, options] = callAt(0);
    expect(url).toBe("https://api.example.com/api/auth/admin/impersonate-user");
    expect(options.method).toBe("POST");
    expect(options.headers.authorization).toBe("Bearer session-token");
    expect(options.body).toEqual({ userId: "user-2" });
    expect(callAt(1)[1].headers.authorization).toBe("Bearer impersonation-token");
    expect(sessionToken()).toBe("session-token");
    expect(impersonationToken()).toBe("impersonation-token");
    expect(auth.claims.value?.impersonatedBy).toBe("user-1");
  });

  it("reports impersonation failures", async () => {
    const auth = useAuth();
    setTokens({ access: createToken({ sub: "user-1" }), session: "session-token" });
    fetchMock.mockImplementation(async () =>
      raise(Object.assign(new Error("You cannot impersonate admins"), { status: 403, data: { message: "You cannot impersonate admins" } }))
    );

    await expect(auth.startAudit("user-2")).rejects.toThrow("You cannot impersonate admins");
    expect(impersonationToken()).toBeNull();
  });

  it("stops the audit by revoking the impersonation session", async () => {
    const auth = useAuth();
    const base = createToken({ sub: "user-1", name: "Ada", email: "ada@example.com", image: null });
    setTokens({ access: createToken({ sub: "user-2" }), session: "session-token" });
    setImpersonation("impersonation-token");
    fetchMock.mockImplementationOnce(async () => ({}));
    fetchMock.mockImplementationOnce(async () => ({ token: base }));

    expect(await auth.stopAudit()).toBe(true);

    const [url, options] = callAt(0);
    expect(url).toBe("https://api.example.com/api/auth/sign-out");
    expect(options.method).toBe("POST");
    expect(options.headers.authorization).toBe("Bearer impersonation-token");
    expect(callAt(1)[1].headers.authorization).toBe("Bearer session-token");
    expect(impersonationToken()).toBeNull();
    expect(auth.claims.value?.user.id).toBe("user-1");
  });

  it("signs out and clears the stored tokens", async () => {
    const auth = useAuth();
    setTokens({ access: createToken({ sub: "user-1" }), session: "session-token" });

    await auth.signOut();

    expect(accessToken()).toBeNull();
    expect(sessionToken()).toBeNull();
    expect(auth.isAuthenticated.value).toBe(false);
    const [url, options] = callAt(0);
    expect(url).toBe("https://api.example.com/api/auth/sign-out");
    expect(options.headers.authorization).toBe("Bearer session-token");
    expect(options.body).toEqual({});
  });

  it("builds the sign in url with a relative redirect only", () => {
    const auth = useAuth();

    const url = new URL(auth.loginUrl("github", "/keys?tab=models"));
    expect(url.origin + url.pathname).toBe("https://api.example.com/api/auth/start");
    expect(url.searchParams.get("provider")).toBe("github");
    expect(url.searchParams.get("to")).toBe(window.location.origin);
    expect(url.searchParams.get("redirect")).toBe("/keys?tab=models");

    expect(new URL(auth.loginUrl("google", "https://evil.example.com")).searchParams.get("redirect")).toBeNull();
  });
});
